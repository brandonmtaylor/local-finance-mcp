// The direct-API link path, which exists because `plaid link` cannot request
// more than its default ~90 days of history.
//
// Every test here injects a fetcher: none of them reach the network. The store
// tests write to a temp file, never to the real Plaid CLI config — that file
// holds live access tokens for real bank connections.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createHostedLink, pollLinkSession, exchangePublicToken, verifyCredentials, type Fetcher,
} from '../src/providers/plaid/api.js';
import {
  readCliConfig, addItemToCliConfig, listCliItems, CliStoreError,
} from '../src/providers/plaid/cliStore.js';
import { createPlaidProvider } from '../src/providers/plaid/index.js';

const credentials = { clientId: 'cid', secret: 'sec', environment: 'production' as const };

/** A fetcher that replays canned responses and records what it was asked. */
function stubFetch(responses: Array<{ ok?: boolean; status?: number; body: unknown }>) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  let i = 0;
  const fetcher: Fetcher = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    const r = responses[Math.min(i, responses.length - 1)]!;
    i += 1;
    return {
      ok: r.ok ?? true,
      status: r.status ?? 200,
      json: async () => r.body,
    };
  };
  return { fetcher, calls };
}

describe('createHostedLink', () => {
  it('asks for the requested history and returns the hosted URL', async () => {
    const { fetcher, calls } = stubFetch([{
      body: { link_token: 'lt-1', expiration: '2026-08-12T12:00:00Z', hosted_link_url: 'https://link.plaid.com/x' },
    }]);

    const session = await createHostedLink(
      credentials, { daysRequested: 730, clientUserId: 'u1' }, fetcher,
    );

    expect(session).toEqual({
      linkToken: 'lt-1',
      hostedLinkUrl: 'https://link.plaid.com/x',
      expiration: '2026-08-12T12:00:00Z',
    });
    // The entire point of this code path.
    expect(calls[0]!.body.transactions).toEqual({ days_requested: 730 });
    expect(calls[0]!.body.hosted_link).toEqual({});
    expect(calls[0]!.url).toBe('https://production.plaid.com/link/token/create');
  });

  it('targets the sandbox host when configured for sandbox', async () => {
    const { fetcher, calls } = stubFetch([{
      body: { link_token: 'lt', expiration: 'x', hosted_link_url: 'https://u' },
    }]);
    await createHostedLink(
      { ...credentials, environment: 'sandbox' }, { daysRequested: 90, clientUserId: 'u' }, fetcher,
    );
    expect(calls[0]!.url).toContain('https://sandbox.plaid.com');
  });

  it('rejects a days value Plaid would refuse, before spending a call', async () => {
    const { fetcher, calls } = stubFetch([{ body: {} }]);
    for (const days of [0, -1, 731, 1.5]) {
      await expect(createHostedLink(credentials, { daysRequested: days, clientUserId: 'u' }, fetcher))
        .rejects.toThrow(/between 1 and 730/);
    }
    expect(calls).toHaveLength(0);
  });

  it('says Hosted Link may be disabled rather than failing on an undefined URL later', async () => {
    const { fetcher } = stubFetch([{ body: { link_token: 'lt', expiration: 'x' } }]);
    await expect(createHostedLink(credentials, { daysRequested: 730, clientUserId: 'u' }, fetcher))
      .rejects.toThrow(/Hosted Link may not be enabled/);
  });

  it("surfaces Plaid's error_code, which names the actual problem", async () => {
    const { fetcher } = stubFetch([{
      ok: false,
      status: 400,
      body: { error_code: 'INVALID_API_KEYS', error_message: 'client_id or secret is invalid' },
    }]);
    await expect(createHostedLink(credentials, { daysRequested: 730, clientUserId: 'u' }, fetcher))
      .rejects.toThrow(/INVALID_API_KEYS: client_id or secret is invalid/);
  });

  it('falls back to the status code when the error body is unreadable', async () => {
    const fetcher: Fetcher = async () => ({
      ok: false, status: 502, json: async () => { throw new Error('not json'); },
    });
    await expect(createHostedLink(credentials, { daysRequested: 730, clientUserId: 'u' }, fetcher))
      .rejects.toThrow(/HTTP 502/);
  });
});

describe('pollLinkSession', () => {
  it('returns null while the human is still in the browser', async () => {
    const { fetcher } = stubFetch([{ body: { link_sessions: [{ results: {} }] } }]);
    expect(await pollLinkSession(credentials, 'lt', fetcher)).toBeNull();
  });

  it('returns null for a session list that is entirely absent', async () => {
    const { fetcher } = stubFetch([{ body: {} }]);
    expect(await pollLinkSession(credentials, 'lt', fetcher)).toBeNull();
  });

  it('extracts the public token once the flow completes', async () => {
    const { fetcher } = stubFetch([{
      body: {
        link_sessions: [{
          results: { item_add_results: [{ public_token: 'pt-1', institution_id: 'ins_9' }] },
        }],
      },
    }]);
    expect(await pollLinkSession(credentials, 'lt', fetcher))
      .toEqual({ publicToken: 'pt-1', institutionId: 'ins_9' });
  });
});

describe('exchangePublicToken', () => {
  it('returns the durable access token and item id', async () => {
    const { fetcher, calls } = stubFetch([{ body: { access_token: 'at-1', item_id: 'item-1' } }]);
    const item = await exchangePublicToken(credentials, 'pt-1', 'ins_9', fetcher);

    expect(item).toEqual({ itemId: 'item-1', accessToken: 'at-1', institutionId: 'ins_9' });
    expect(calls[0]!.body.public_token).toBe('pt-1');
  });
});

// ── the CLI store ────────────────────────────────────────────────────────────

describe('the Plaid CLI store', () => {
  let dir: string;
  let path: string;

  const valid = () => ({
    client_id: 'cid',
    env: 'production',
    environments: {
      production: { secret: 's', items: [{ item_id: 'old', access_token: 'at-old' }] },
      sandbox: { secret: 's2', items: [] },
    },
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plaid-store-'));
    path = join(dir, 'config.json');
    writeFileSync(path, JSON.stringify(valid(), null, 2));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('adds an item without disturbing the ones already there', () => {
    const { replaced } = addItemToCliConfig(
      'production', { item_id: 'new', access_token: 'at-new', sync_cursor: '' }, path,
    );

    const items = listCliItems('production', path);
    expect(replaced).toBe(false);
    expect(items.map((i) => i.item_id)).toEqual(['old', 'new']);
    // The rest of the file must survive untouched — it holds other credentials.
    const after = JSON.parse(readFileSync(path, 'utf8'));
    expect(after.client_id).toBe('cid');
    expect(after.environments.sandbox.secret).toBe('s2');
  });

  it('updates in place rather than appending a second entry for one Item', () => {
    // Two entries for one Item would sync it twice and double every
    // transaction it carries.
    const { replaced } = addItemToCliConfig(
      'production', { item_id: 'old', access_token: 'at-rotated' }, path,
    );
    const items = listCliItems('production', path);

    expect(replaced).toBe(true);
    expect(items).toHaveLength(1);
    expect(items[0]!.access_token).toBe('at-rotated');
  });

  it('backs the file up before writing, because it holds every access token', () => {
    const { backupPath } = addItemToCliConfig(
      'production', { item_id: 'new', access_token: 'at' }, path,
    );
    expect(existsSync(backupPath)).toBe(true);
    expect(JSON.parse(readFileSync(backupPath, 'utf8')).environments.production.items)
      .toHaveLength(1); // the state from BEFORE the write
  });

  it('refuses to write when the format is unfamiliar rather than guessing', () => {
    // The format is undocumented and can change. Corrupting this file costs a
    // re-link of every account, so an unrecognised shape is a hard stop.
    writeFileSync(path, JSON.stringify({ something: 'else' }));
    expect(() => addItemToCliConfig('production', { item_id: 'x', access_token: 'y' }, path))
      .toThrow(CliStoreError);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ something: 'else' });
  });

  it('refuses on malformed JSON instead of overwriting it', () => {
    writeFileSync(path, '{ not json');
    expect(() => readCliConfig(path)).toThrow(/not valid JSON/);
  });

  it('names the fix when the config does not exist yet', () => {
    expect(() => readCliConfig(join(dir, 'absent.json'))).toThrow(/plaid login/);
  });

  it('refuses an environment the CLI has never logged into', () => {
    expect(() => addItemToCliConfig('development', { item_id: 'x', access_token: 'y' }, path))
      .toThrow(/no "development" environment/);
  });

  it('creates the items array when an environment has none yet', () => {
    writeFileSync(path, JSON.stringify({ environments: { production: { secret: 's' } } }));
    addItemToCliConfig('production', { item_id: 'first', access_token: 'at' }, path);
    expect(listCliItems('production', path).map((i) => i.item_id)).toEqual(['first']);
  });

  it('writes the token store readable only by its owner', () => {
    addItemToCliConfig('production', { item_id: 'new', access_token: 'at' }, path);
    const mode = statSync(path).mode & 0o777;
    expect(mode & 0o077).toBe(0); // no group or other access
  });
});

// ── the orchestrated flow ────────────────────────────────────────────────────

describe('link --days end to end', () => {
  const provider = (over: Record<string, unknown> = {}) => createPlaidProvider({
    id: 'plaid',
    environment: 'production',
    daysRequested: 730,
    onProgress: () => {},
    linkDeps: {
      sleep: async () => {},          // no real waiting
      // Never the real opener: on macOS it runs `open`, which pops a browser
      // tab on a desktop and can hang for its full 5s timeout on a headless
      // CI runner — enough to push a test past vitest's own 5s limit.
      openUrl: () => {},
      now: (() => { let t = 0; return () => { t += 1_000; return t; }; })(),
      ...over,
    },
  });

  const ctx = {
    providerId: 'plaid',
    stateDir: '/tmp',
    timezone: 'UTC',
    getSecret: (k: string) => ({ client_id: 'cid', secret: 'sec' }[k] ?? null),
  };

  const happyResponses = [
    { body: { link_token: 'lt', expiration: 'x', hosted_link_url: 'https://link/x' } },
    { body: { link_sessions: [{ results: {} }] } },                       // still waiting
    { body: { link_sessions: [{ results: { item_add_results: [{ public_token: 'pt', institution_id: 'ins_1' }] } }] } },
    { body: { access_token: 'at', item_id: 'item-1' } },
  ];

  it('links, then records the Item so the CLI can see it', async () => {
    const recorded: unknown[] = [];
    const { fetcher } = stubFetch(happyResponses);
    const p = provider({
      fetcher,
      addItem: (env: string, item: unknown) => {
        recorded.push({ env, item });
        return { backupPath: '/tmp/backup', replaced: false };
      },
    });

    const result = await p.link!(ctx);

    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/Requested 730 days/);
    expect(recorded).toEqual([{
      env: 'production',
      item: { item_id: 'item-1', access_token: 'at', sync_cursor: '', institution_id: 'ins_1' },
    }]);
  });

  it('does not spend a call when credentials are missing', async () => {
    const { fetcher, calls } = stubFetch(happyResponses);
    const p = provider({ fetcher });
    const result = await p.link!({ ...ctx, getSecret: () => null });

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/finance secret set plaid client_id/);
    expect(calls).toHaveLength(0);
  });

  it('hands back the item id when the Item exists at Plaid but cannot be recorded', async () => {
    // The dangerous case: the Item is live and billing monthly, but nothing
    // local knows about it — so it can be neither synced nor found to remove.
    const { fetcher } = stubFetch(happyResponses);
    const p = provider({
      fetcher,
      addItem: () => { throw new Error('config format changed'); },
    });

    const result = await p.link!(ctx);

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/item-1/);
    expect(result.message).toMatch(/live and billable/);
  });

  it('gives up rather than polling forever when nobody finishes the flow', async () => {
    const { fetcher } = stubFetch([
      { body: { link_token: 'lt', expiration: 'x', hosted_link_url: 'https://link/x' } },
      { body: { link_sessions: [{ results: {} }] } }, // never completes
    ]);
    // A clock that jumps straight past the deadline.
    const p = provider({ fetcher, now: (() => { let t = 0; return () => { t += 60 * 60 * 1000; return t; }; })() });

    const result = await p.link!(ctx);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Timed out/);
    // NOT "nothing was linked", which the old message claimed and which is
    // false: Link creates the Item the moment the browser flow completes, so a
    // timeout after a successful sign-in leaves a live Item that nothing local
    // can reach. Saying otherwise sent someone to re-link and orphan another.
    expect(result.message).not.toMatch(/Nothing was linked/);
    expect(result.message).toMatch(/finance link --resume/);
  });

  it('still uses the CLI when --days is not given', async () => {
    const calls: string[][] = [];
    const p = createPlaidProvider({
      id: 'plaid',
      environment: 'production',
      run: (args) => { calls.push(args); return { status: 0, stdout: '{}', stderr: '' }; },
    });

    await p.link!(ctx);
    expect(calls[0]).toEqual(['link', '--json']);
  });
});

describe('verifyCredentials', () => {
  const ok = { body: { institutions: [] } };
  const badKeys = {
    ok: false, status: 400,
    body: { error_code: 'INVALID_API_KEYS', error_message: 'client_id or secret is invalid' },
  };

  it('confirms working credentials with one call and no Item', async () => {
    const { fetcher, calls } = stubFetch([ok]);
    expect(await verifyCredentials(credentials, fetcher)).toEqual({ ok: true });

    // /institutions/get authenticates without touching an Item — nothing
    // created, nothing billed.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://production.plaid.com/institutions/get');
  });

  it('names the environment when the keys are for the other one', async () => {
    // The failure this exists to prevent: sandbox keys configured against
    // production surface later as a bare INVALID_API_KEYS that reads like a typo.
    const { fetcher, calls } = stubFetch([badKeys, ok]);
    const result = await verifyCredentials(credentials, fetcher);

    expect(result).toMatchObject({ ok: false, wrongEnvironment: 'sandbox' });
    expect((result as { reason: string }).reason).toMatch(/for sandbox, not production/);
    expect(calls[1]!.url).toContain('sandbox.plaid.com');
  });

  it('reports the original failure when the keys work nowhere', async () => {
    const { fetcher } = stubFetch([badKeys, badKeys]);
    const result = await verifyCredentials(credentials, fetcher);

    expect(result).toMatchObject({ ok: false });
    expect((result as { wrongEnvironment?: string }).wrongEnvironment).toBeUndefined();
    expect((result as { reason: string }).reason).toMatch(/INVALID_API_KEYS/);
  });

  it('does not probe the other environment on a network failure', async () => {
    // A connection error says nothing about which environment the keys belong
    // to, so a second call would be noise — and would double the wait.
    let calls = 0;
    const fetcher: Fetcher = async () => { calls += 1; throw new Error('ECONNREFUSED'); };
    const result = await verifyCredentials(credentials, fetcher);

    expect(calls).toBe(1);
    expect(result).toMatchObject({ ok: false });
  });
});

describe('opening the browser', () => {
  const ctx = {
    providerId: 'plaid', stateDir: '/tmp', timezone: 'UTC',
    getSecret: (k: string) => ({ client_id: 'cid', secret: 'sec' }[k] ?? null),
  };

  it('opens the hosted URL and still prints it', async () => {
    // Printed regardless: the browser that opens is whichever the OS considers
    // default, which may not be the one already signed in to the bank.
    const opened: string[] = [];
    const printed: string[] = [];
    const { fetcher } = stubFetch([
      { body: { link_token: 'lt', expiration: 'x', hosted_link_url: 'https://link/abc' } },
      { body: { link_sessions: [{ results: { item_add_results: [{ public_token: 'pt' }] } }] } },
      { body: { access_token: 'at', item_id: 'item-1' } },
    ]);

    const provider = createPlaidProvider({
      id: 'plaid', environment: 'production', daysRequested: 730,
      onProgress: (m) => printed.push(m),
      linkDeps: {
        fetcher,
        sleep: async () => {},
        now: (() => { let t = 0; return () => { t += 1_000; return t; }; })(),
        openUrl: (u) => opened.push(u),
        addItem: () => ({ backupPath: '/tmp/b', replaced: false }),
      },
    });

    await provider.link!(ctx);

    expect(opened).toEqual(['https://link/abc']);
    expect(printed.join(' ')).toContain('https://link/abc');
  });

  it('completes the link even when opening a browser fails', async () => {
    // Headless machines, unusual desktops, no window server. The URL is
    // already on screen, so this must never abandon the flow.
    const { fetcher } = stubFetch([
      { body: { link_token: 'lt', expiration: 'x', hosted_link_url: 'https://link/abc' } },
      { body: { link_sessions: [{ results: { item_add_results: [{ public_token: 'pt' }] } }] } },
      { body: { access_token: 'at', item_id: 'item-1' } },
    ]);
    const provider = createPlaidProvider({
      id: 'plaid', environment: 'production', daysRequested: 730,
      onProgress: () => {},
      linkDeps: {
        fetcher,
        sleep: async () => {},
        now: (() => { let t = 0; return () => { t += 1_000; return t; }; })(),
        openUrl: () => { throw new Error('no browser here'); },
        addItem: () => ({ backupPath: '/tmp/b', replaced: false }),
      },
    });

    const result = await provider.link!(ctx);
    expect(result.ok).toBe(true);
  });
});

describe('institution_id on an API-created Item', () => {
  const ctx = {
    providerId: 'plaid', stateDir: '/tmp', timezone: 'UTC',
    getSecret: (k: string) => ({ client_id: 'cid', secret: 'sec' }[k] ?? null),
  };

  const linkWith = (responses: Array<{ body: unknown }>, recorded: unknown[]) => {
    const { fetcher } = stubFetch(responses);
    return createPlaidProvider({
      id: 'plaid', environment: 'production', daysRequested: 730, onProgress: () => {},
      linkDeps: {
        openUrl: () => {},   // never the real browser opener in a test
        fetcher,
        sleep: async () => {},
        now: (() => { let t = 0; return () => { t += 1_000; return t; }; })(),
        addItem: (_env: string, item: unknown) => {
          recorded.push(item);
          return { backupPath: '/tmp/b', replaced: false };
        },
      },
    });
  };

  it('asks Plaid when the Link session did not say', async () => {
    // The failure this prevents: without an institution the natural key is
    // "?|5555|credit", which does not match "ins_000001|5555|credit" — so a
    // re-link creates a SECOND copy of every account it should have joined.
    // Observed on a real re-link, with two credit cards both
    // duplicated and their totals doubling behind them.
    const recorded: unknown[] = [];
    const provider = linkWith([
      { body: { link_token: 'lt', expiration: 'x', hosted_link_url: 'https://u' } },
      { body: { link_sessions: [{ results: { item_add_results: [{ public_token: 'pt' }] } }] } },
      { body: { access_token: 'at', item_id: 'item-1' } },
      { body: { item: { institution_id: 'ins_000001' } } },   // /item/get
    ], recorded);

    const result = await provider.link!(ctx);

    expect(result.ok).toBe(true);
    expect(recorded[0]).toMatchObject({ item_id: 'item-1', institution_id: 'ins_000001' });
  });

  it('does not ask when the session already told us', async () => {
    const recorded: unknown[] = [];
    const provider = linkWith([
      { body: { link_token: 'lt', expiration: 'x', hosted_link_url: 'https://u' } },
      { body: { link_sessions: [{ results: { item_add_results: [{ public_token: 'pt', institution_id: 'ins_9' }] } }] } },
      { body: { access_token: 'at', item_id: 'item-1' } },
    ], recorded);

    await provider.link!(ctx);
    expect(recorded[0]).toMatchObject({ institution_id: 'ins_9' });
  });

  it('still links when the institution cannot be determined', async () => {
    // Weaker matching is not a reason to fail a link — the account still
    // resolves on mask and type, and doctor reports the ambiguity.
    const recorded: unknown[] = [];
    const provider = linkWith([
      { body: { link_token: 'lt', expiration: 'x', hosted_link_url: 'https://u' } },
      { body: { link_sessions: [{ results: { item_add_results: [{ public_token: 'pt' }] } }] } },
      { body: { access_token: 'at', item_id: 'item-1' } },
      { body: { item: {} } },
    ], recorded);

    const result = await provider.link!(ctx);
    expect(result.ok).toBe(true);
  });
});
