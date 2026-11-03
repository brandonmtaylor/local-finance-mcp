// Plaid adapter, tested against a payload captured from REAL sandbox output
// (test/fixtures/plaid-sync.json), not from the published API schema. The two
// differ in ways that break a naive mapper:
//   - the CLI emits the legacy `category` array, never personal_finance_category
//   - `authorized_date` is absent
//   - amounts are floats using Plaid's convention (positive = money OUT)

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  toLedgerCents, mapTransaction, mapAccount, mapBalance, mapRemoved, parseCliJson,
  normalizeSyncPayload, assertAccountsCoverTransactions,
  createPlaidProvider, type PlaidSyncPayload, type PlaidAccount,
} from '../src/providers/plaid/index.js';
import { mapPlaidCategory } from '../src/providers/plaid/categories.js';
import { spendGroupFor, countsAsSpending } from '../src/core/normalize.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const payload = JSON.parse(readFileSync(join(FIXTURES, 'plaid-sync.json'), 'utf8')) as PlaidSyncPayload;

const ctx = {
  providerId: 'plaid', stateDir: '/tmp', timezone: 'UTC',
  getSecret: (k: string) => (k === 'client_id' ? 'cid' : 'sec'),
};

describe('toLedgerCents', () => {
  it('inverts Plaid sign into the ledger convention', () => {
    // Plaid: positive = money out. Ledger: positive = money in.
    expect(toLedgerCents(12)).toBe(-1_200);      // a $12 purchase
    expect(toLedgerCents(-500)).toBe(50_000);    // a $500 refund
  });

  it('converts floats without rounding error', () => {
    expect(toLedgerCents(4.33)).toBe(-433);
    expect(toLedgerCents(89.4)).toBe(-8_940);
    expect(toLedgerCents(19.99)).toBe(-1_999);   // not -1998
    expect(toLedgerCents(0.07)).toBe(-7);
  });

  it('never produces negative zero', () => {
    expect(Object.is(toLedgerCents(0), -0)).toBe(false);
  });
});

describe('mapPlaidCategory', () => {
  it('maps a credit-card payment out of the spending total', () => {
    const { category } = mapPlaidCategory(['Payment', 'Credit Card'], -210_000);
    expect(category).toBe('credit_card_payment');
    expect(countsAsSpending(spendGroupFor(category))).toBe(false);
  });

  it('separates everyday transport from trip travel', () => {
    expect(mapPlaidCategory(['Travel', 'Taxi'], -600).category).toBe('transportation');
    expect(mapPlaidCategory(['Travel', 'Airlines and Aviation Services'], -50_000).category).toBe('travel');
  });

  it('splits Food and Drink into groceries vs dining', () => {
    expect(mapPlaidCategory(['Food and Drink', 'Groceries'], -8_432).category).toBe('groceries');
    expect(mapPlaidCategory(['Food and Drink', 'Restaurants'], -1_200).category).toBe('dining');
  });

  it('treats interest and dividends as income despite the Transfer prefix', () => {
    expect(mapPlaidCategory(['Transfer', 'Interest'], 422).category).toBe('income');
    expect(mapPlaidCategory(['Transfer', 'Deposit'], 50_000).category).toBe('transfer');
  });

  it('reads a bare "Payment" with money coming IN as a refund, not a card payment', () => {
    // Otherwise a refund gets excluded from spending as if it settled a balance.
    expect(mapPlaidCategory(['Payment'], 5_000).category).toBe('income');
    expect(mapPlaidCategory(['Payment'], -5_000).category).toBe('credit_card_payment');
  });

  it('falls back to the primary level for unknown detail', () => {
    const { category, source } = mapPlaidCategory(['Shops', 'Nonexistent Subcategory'], -1_000);
    expect(category).toBe('shopping');
    expect(source).toBe('provider');
  });

  it('marks a guess as inferred when the taxonomy is missing', () => {
    expect(mapPlaidCategory(null, -1_000)).toEqual({ category: 'other', source: 'inferred' });
    expect(mapPlaidCategory([], 1_000)).toEqual({ category: 'income', source: 'inferred' });
  });

  it('categorises every category present in the real sandbox payload', () => {
    // Guards against the PFC mistake: if the mapper were written against a field
    // the CLI does not send, everything would land on the inferred fallback.
    const mapped = (payload.added ?? []).map((t) => mapPlaidCategory(t.category, toLedgerCents(t.amount)));
    expect(mapped.every((m) => m.source === 'provider')).toBe(true);
    expect(mapped.some((m) => m.category === 'other')).toBe(false);
  });
});

describe('mapTransaction against real sandbox data', () => {
  const rows = (payload.added ?? []).map(mapTransaction);

  it('maps every transaction without loss', () => {
    expect(rows.length).toBe(payload.added?.length);
    expect(rows.every((r) => r.externalId && r.accountExternalId && r.date)).toBe(true);
  });

  it('turns purchases negative and refunds positive', () => {
    const airline = rows.find((r) => r.description.includes('United Airlines'))!;
    const coffee = rows.find((r) => r.description.includes('Starbucks'))!;
    expect(airline.amountCents).toBeGreaterThan(0); // -500 in Plaid = money in
    expect(coffee.amountCents).toBeLessThan(0);
  });

  it('keeps every amount an integer', () => {
    expect(rows.every((r) => Number.isInteger(r.amountCents))).toBe(true);
  });

  it('tolerates the absent authorized_date rather than emitting undefined', () => {
    expect(rows.every((r) => r.authorizedDate === null)).toBe(true);
  });

  it('never files money arriving on a card as income', () => {
    // A refund on a credit card with no label Plaid can map: mapPlaidCategory
    // reads unlabelled money-in as income, which on a card it never is.
    const refund = { ...payload.added![0]!, name: 'QQQ MERCHANT CREDIT', amount: -54.2, category: null };
    expect(mapTransaction(refund, 'credit').category).not.toBe('income');
    expect(mapTransaction(refund, 'depository').category).toBe('income');
  });

  it('preserves the raw payload for fields not yet modelled', () => {
    expect(JSON.parse(rows[0]!.rawJson!)).toHaveProperty('transaction_id');
  });

  it('uses Plaid transaction ids directly, so re-sync is idempotent', () => {
    const ids = new Set(rows.map((r) => r.externalId));
    expect(ids.size).toBe(rows.length);
    expect(mapTransaction(payload.added![0]!).externalId).toBe(payload.added![0]!.transaction_id);
  });
});

describe('mapAccount / mapBalance', () => {
  const account: PlaidAccount = {
    account_id: 'acct-1',
    name: 'Plaid Checking',
    official_name: 'Plaid Gold Standard 0% Interest Checking',
    type: 'depository',
    subtype: 'checking',
    mask: '0000',
    balances: { available: 100, current: 110, limit: null, iso_currency_code: 'USD' },
  };

  it('keeps the mask and never a full account number', () => {
    const row = mapAccount(account, 'plaid');
    expect(row.mask).toBe('0000');
    expect(JSON.stringify(row)).not.toMatch(/account_number/);
  });

  it('converts balances to integer cents', () => {
    const balance = mapBalance(account, '2026-08-11T00:00:00Z')!;
    expect(balance.currentCents).toBe(11_000);
    expect(balance.availableCents).toBe(10_000);
    expect(balance.limitCents).toBeNull();
  });

  it('returns null when the account carries no balances', () => {
    expect(mapBalance({ account_id: 'x', name: 'y' }, '2026-08-11T00:00:00Z')).toBeNull();
  });
});

describe('mapRemoved', () => {
  it('accepts both bare ids and objects', () => {
    expect(mapRemoved(['a', { transaction_id: 'b' }])).toEqual(['a', 'b']);
  });

  it('drops malformed entries instead of writing undefined ids', () => {
    expect(mapRemoved([{ transaction_id: '' }, null as never, 'c'])).toEqual(['c']);
    expect(mapRemoved(undefined)).toEqual([]);
  });
});

describe('parseCliJson', () => {
  it('skips diagnostic lines and returns the real payload', () => {
    const stdout = [
      '{"diagnostic":{"code":"INFO","message":"working"}}',
      '{"added":[],"cursor":"abc"}',
    ].join('\n');
    expect(parseCliJson<PlaidSyncPayload>(stdout, 'added')).toMatchObject({ cursor: 'abc' });
  });

  it('ignores non-JSON chatter', () => {
    const stdout = 'Fetching…\n{"added":[],"cursor":"x"}\ndone';
    expect(parseCliJson<PlaidSyncPayload>(stdout, 'added')).toMatchObject({ cursor: 'x' });
  });

  it('returns null when the marker never appears', () => {
    expect(parseCliJson<PlaidSyncPayload>('{"diagnostic":{}}', 'added')).toBeNull();
  });
});

describe('normalizeSyncPayload', () => {
  // `sync --all` wraps results per Item; a single-Item sync returns them flat.
  // Both shapes are real — found by running against the live sandbox, and the
  // adapter reads the wrapped one, so a fixture of only the flat shape misses it.
  const multi = JSON.parse(
    readFileSync(join(FIXTURES, 'plaid-sync-all.json'), 'utf8'),
  ) as { items: PlaidSyncPayload[] };

  it('unwraps the --all shape into per-Item payloads', () => {
    const items = normalizeSyncPayload(multi);
    expect(items).toHaveLength(2);
    expect(items.every((i) => 'added' in i)).toBe(true);
  });

  it('wraps a flat single-Item payload into a one-element list', () => {
    expect(normalizeSyncPayload(payload)).toEqual([payload]);
  });

  it('returns nothing for a payload with neither shape', () => {
    expect(normalizeSyncPayload({})).toEqual([]);
  });

  it('merges transactions across Items', () => {
    const total = normalizeSyncPayload(multi).reduce((n, i) => n + (i.added?.length ?? 0), 0);
    expect(total).toBeGreaterThan(0);
  });
});

describe('assertAccountsCoverTransactions', () => {
  // The check now compares the PROVIDER's ids — accounts as the connection
  // reported them, before the ledger maps them onto real accounts.
  const account = { externalId: 'a1' };
  const txnFor = (accountExternalId: string) => ({
    ...mapTransaction(payload.added![0]!), accountExternalId,
  });

  it('passes when every transaction has a reported account', () => {
    expect(() => assertAccountsCoverTransactions([account], [txnFor('a1')])).not.toThrow();
  });

  it('fails with a message naming the accounts, not a raw FK error', () => {
    expect(() => assertAccountsCoverTransactions([account], [txnFor('missing')]))
      .toThrow(/did not report.*missing/s);
  });
});

describe('createPlaidProvider', () => {
  const runner = (responses: Record<string, { status: number; stdout: string; stderr: string }>) =>
    (args: string[]) => {
      // `item get` needs --item once several Items exist, so the adapter walks
      // `item list` first — key the stub on the subcommand pair.
      const key = args[0] === 'item' ? `item ${args[1]}` : args[0]!;
      return responses[key] ?? responses[args[0]!] ?? { status: 1, stdout: '', stderr: 'unexpected' };
    };

  // Accounts covering every account_id in the fixture, so the FK guard passes.
  const accountsPayload = {
    accounts: [...new Set((payload.added ?? []).map((t) => t.account_id))].map((id) => ({
      account_id: id, name: 'Plaid Checking', type: 'depository', mask: '0000',
      balances: { current: 110, available: 100, limit: null, iso_currency_code: 'USD' },
    })),
  };
  const FIXTURE_ITEM = 'QN787DovwViQ4ovbeoVXIe55yRDw7lIkB7wQR';
  const itemStubs = {
    'item list': { status: 0, stdout: JSON.stringify({ items: [{ item_id: FIXTURE_ITEM }] }), stderr: '' },
    'item get': { status: 0, stdout: JSON.stringify(accountsPayload), stderr: '' },
  };

  it('syncs transactions, accounts and balances in one pass', async () => {
    const provider = createPlaidProvider({
      id: 'plaid',
      environment: 'sandbox',
      run: runner({
        transactions: { status: 0, stdout: JSON.stringify(payload), stderr: '' },
        ...itemStubs,
      }),
    });

    const result = await provider.sync(ctx, null);
    expect(result.connections[0]!.added.length).toBe(payload.added?.length);
    expect(result.connections[0]!.accounts.length).toBeGreaterThan(0);
    expect(result.connections[0]!.balances.length).toBeGreaterThan(0);
    // One cursor, belonging to this Item. It used to be a JSON map of every
    // Item's cursor crammed into one field, because the schema had a single
    // cursor per provider.
    expect(result.connections[0]!.externalId).toBe(FIXTURE_ITEM);
    expect(result.connections[0]!.cursor).toBe(payload.cursor);
  });

  it('refuses to write when Plaid reports transactions for unreported accounts', async () => {
    // The live failure mode: `item get` needs --item once several Items exist,
    // so a naive call returns nothing and every transaction orphans.
    const provider = createPlaidProvider({
      id: 'plaid',
      environment: 'sandbox',
      run: runner({
        transactions: { status: 0, stdout: JSON.stringify(payload), stderr: '' },
        'item list': { status: 0, stdout: JSON.stringify({ items: [{ item_id: FIXTURE_ITEM }] }), stderr: '' },
        'item get': { status: 0, stdout: JSON.stringify({ accounts: [] }), stderr: '' },
      }),
    });
    await expect(provider.sync(ctx, null)).rejects.toThrow(/did not report/);
  });

  it('pages through every transaction rather than stopping at the first page', async () => {
    // `transactions list` caps at --count (default 100) and pages via --offset.
    // Taking one page silently truncates history to the newest N rows while
    // reporting success — the failure mode that makes every historical total
    // quietly wrong.
    const TOTAL = 1_150;
    const txn = payload.added![0]!;
    const calls: string[][] = [];

    const provider = createPlaidProvider({
      id: 'plaid',
      environment: 'production',
      run: (args) => {
        calls.push(args);
        if (args[0] === 'item') {
          return { status: 0, stdout: JSON.stringify({ items: [{ item_id: 'i' }] }), stderr: '' };
        }
        const offset = Number(args[args.indexOf('--offset') + 1]);
        const count = Number(args[args.indexOf('--count') + 1]);
        const remaining = Math.max(0, TOTAL - offset);
        const transactions = Array.from({ length: Math.min(count, remaining) }, (_, i) => ({
          ...txn, transaction_id: `t-${offset + i}`, account_id: 'acct-1',
        }));
        return {
          status: 0,
          stdout: JSON.stringify({
            transactions,
            accounts: [{ account_id: 'acct-1', name: 'A', type: 'depository' }],
            total_transactions: TOTAL,
          }),
          stderr: '',
        };
      },
    });

    const result = await provider.backfill!(ctx, '2024-08-01', '2026-08-01');

    expect(result.connections[0]!.added).toHaveLength(TOTAL);
    expect(new Set(result.connections[0]!.added.map((t) => t.externalId)).size).toBe(TOTAL); // no repeats
    // Accounts repeat on every page but must be collected once.
    expect(result.connections[0]!.accounts).toHaveLength(1);

    const offsets = calls.filter((c) => c[0] === 'transactions')
      .map((c) => Number(c[c.indexOf('--offset') + 1]));
    expect(offsets).toEqual([0, 500, 1000]);
  });

  it('gives up rather than looping forever on a bad total', async () => {
    const txn = payload.added![0]!;
    const provider = createPlaidProvider({
      id: 'plaid',
      environment: 'production',
      run: (args) => {
        if (args[0] === 'item') {
          return { status: 0, stdout: JSON.stringify({ items: [{ item_id: 'i' }] }), stderr: '' };
        }
        // Always a full page, and a total that is never reached.
        return {
          status: 0,
          stdout: JSON.stringify({
            transactions: Array.from({ length: 500 }, (_, i) => ({ ...txn, transaction_id: `x-${i}` })),
            accounts: [],
            total_transactions: Number.MAX_SAFE_INTEGER,
          }),
          stderr: '',
        };
      },
    });

    await expect(provider.backfill!(ctx, '2024-08-01', '2026-08-01'))
      .rejects.toThrow(/refusing to loop indefinitely/);
  });

  it('backfills a date range without advancing the cursor', async () => {
    // Recovery path: the CLI owns the sync cursor and advances it on its own
    // success, so a failed write would otherwise lose those records forever.
    const provider = createPlaidProvider({
      id: 'plaid',
      environment: 'sandbox',
      run: runner({
        'item list': { status: 0, stdout: JSON.stringify({ items: [{ item_id: FIXTURE_ITEM }] }), stderr: '' },
        transactions: {
          status: 0,
          stdout: JSON.stringify({ transactions: payload.added, accounts: accountsPayload.accounts }),
          stderr: '',
        },
      }),
    });

    const result = await provider.backfill!(ctx, '2026-05-01', '2026-08-11');
    expect(result.connections[0]!.added.length).toBe(payload.added?.length);
    expect(result.connections[0]!.cursor).toBeNull();
    // A date-range fetch says nothing about rows outside it.
    expect(result.connections[0]!.removed).toEqual([]);
  });

  it('refuses to run without credentials, naming the fix', async () => {
    const provider = createPlaidProvider({ id: 'plaid', environment: 'sandbox', run: runner({}) });
    await expect(
      provider.sync({ ...ctx, getSecret: () => null }, null),
    ).rejects.toThrow(/finance secret set plaid client_id/);
  });

  it('surfaces a CLI failure instead of silently reporting an empty sync', async () => {
    // A provider that "succeeds" with zero transactions would look like a quiet
    // month rather than a broken integration.
    const provider = createPlaidProvider({
      id: 'plaid',
      environment: 'sandbox',
      run: runner({ transactions: { status: 1, stdout: '', stderr: 'INVALID_ACCESS_TOKEN' } }),
    });
    await expect(provider.sync(ctx, null)).rejects.toThrow(/INVALID_ACCESS_TOKEN/);
  });

  it('reports nothing rather than orphans when the item list fails', async () => {
    // Without `item list` there are no connections to attach anything to. The
    // old contract could return transactions with no accounts and fail later
    // on a foreign key; per-connection results make that unrepresentable —
    // there is simply nowhere for an orphan to go.
    const provider = createPlaidProvider({
      id: 'plaid',
      environment: 'sandbox',
      run: runner({
        transactions: { status: 0, stdout: JSON.stringify(payload), stderr: '' },
        'item list': { status: 1, stdout: '', stderr: 'boom' },
      }),
    });
    const result = await provider.sync(ctx, null);
    expect(result.connections).toEqual([]);
  });

  it('declares itself automatic so the scheduler includes it', () => {
    const provider = createPlaidProvider({ id: 'plaid', environment: 'sandbox', run: runner({}) });
    expect(provider.capabilities.automatic).toBe(true);
    expect(provider.capabilities.balances).toBe(true);
  });
});

describe('awaitHistory', () => {
  // Plaid fetches history asynchronously after a link, so a backfill run
  // immediately returns ~90 days however much was requested — which reads as
  // the request being ignored rather than as being early. This is what makes
  // `finance link --days 730` deliver in one command.
  const counting = (counts: number[]) => {
    let i = 0;
    return createPlaidProvider({
      id: 'plaid',
      environment: 'sandbox',
      run: (args) => {
        if (args[0] === 'item') {
          return { status: 0, stdout: JSON.stringify({ items: [{ item_id: 'i' }] }), stderr: '' };
        }
        const total = counts[Math.min(i, counts.length - 1)] ?? 0;
        i += 1;
        return {
          status: 0,
          stdout: JSON.stringify({ transactions: [], total_transactions: total }),
          stderr: '',
        };
      },
      // No real waiting, and a clock the test controls.
      linkDeps: {
        sleep: async () => {},
        now: (() => { let t = 0; return () => { t += 1_000; return t; }; })(),
      },
    });
  };

  const opts = { startDate: '2024-08-12', endDate: '2026-08-12', timeoutMs: 60_000 };

  it('settles once the count stops growing', async () => {
    const p = counting([100, 400, 1203, 1203, 1203]);
    const result = await p.awaitHistory!(ctx, opts);

    expect(result.settled).toBe(true);
    expect(result.transactions).toBe(1203);
  });

  it('does not settle on a single unchanged reading', async () => {
    // A provider can pause between pages and look finished mid-fetch, so one
    // repeat is not evidence — two consecutive are.
    const p = counting([500, 500, 900, 1203, 1203, 1203]);
    const result = await p.awaitHistory!(ctx, opts);
    expect(result.transactions).toBe(1203);
  });

  it('gives up at the deadline and says it did not settle', async () => {
    // Reporting a shortfall as final would be the original bug in reverse.
    let counter = 1;
    const forever = createPlaidProvider({
      id: 'plaid',
      environment: 'sandbox',
      run: (args) => (args[0] === 'item'
        ? { status: 0, stdout: JSON.stringify({ items: [{ item_id: 'i' }] }), stderr: '' }
        : { status: 0, stdout: JSON.stringify({ total_transactions: counter++ }), stderr: '' }),
      linkDeps: {
        sleep: async () => {},
        now: (() => { let t = 0; return () => { t += 10_000; return t; }; })(),
      },
    });

    const result = await forever.awaitHistory!(ctx, { ...opts, timeoutMs: 1 });
    expect(result.settled).toBe(false);
  });
});
