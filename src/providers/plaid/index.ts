// Plaid provider — automatic bank sync via the official Plaid CLI.
//
// Shells out to `plaid` rather than calling the REST API directly, because the
// CLI already owns the parts that are genuinely hard: the hosted Link flow, item
// storage, and cursor management.
//
// Everything below is written against REAL sandbox output, not the published API
// schema — the two differ in ways that matter. Notably the CLI emits the legacy
// `category` array and NOT `personal_finance_category`, and omits
// `authorized_date`. See categories.ts.
//
// Credential handling: client_id and secret come from the OS keystore and are
// passed to the child process via its environment, never written to disk by us.
// Access tokens are held by the CLI in its own config directory — see the note
// on `capabilities` below.

import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync, unlinkSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingAccount, IncomingTransaction } from '../../core/ledger.js';
import {
  createHostedLink, pollLinkSession, exchangePublicToken, getItemInstitution, type Fetcher,
  type LinkExited,
} from './api.js';
import { addItemToCliConfig } from './cliStore.js';
import type {
  Provider, ProviderContext, SyncResult, LinkResult, ConnectionSync,
} from '../types.js';
import { mapPlaidCategory } from './categories.js';
import { inferCategory, creditNotIncome } from '../../core/normalize.js';

export interface PlaidTransaction {
  transaction_id: string;
  account_id: string;
  amount: number;
  date: string;
  name: string;
  merchant_name?: string | null;
  category?: string[] | null;
  pending?: boolean;
  iso_currency_code?: string | null;
  payment_channel?: string | null;
  authorized_date?: string | null;
}

export interface PlaidAccount {
  account_id: string;
  name: string;
  official_name?: string | null;
  type?: string | null;
  subtype?: string | null;
  mask?: string | null;
  balances?: {
    available?: number | null;
    current?: number | null;
    limit?: number | null;
    iso_currency_code?: string | null;
  } | null;
}

export interface PlaidSyncPayload {
  added?: PlaidTransaction[];
  modified?: PlaidTransaction[];
  removed?: Array<string | { transaction_id: string }>;
  cursor?: string | null;
  item?: { item_id?: string; institution_id?: string };
}

/**
 * `plaid transactions sync --all` wraps per-Item results in an `items` array,
 * while a single-Item sync returns the flat shape above. Both are real — this
 * was caught by running against the live sandbox, not by reading the docs.
 */
export interface PlaidMultiSyncPayload {
  items?: PlaidSyncPayload[];
}

/** Normalize either shape to a list of per-Item payloads. */
export function normalizeSyncPayload(
  payload: PlaidSyncPayload & PlaidMultiSyncPayload,
): PlaidSyncPayload[] {
  if (Array.isArray(payload.items)) return payload.items;
  if (payload.added || payload.modified || payload.removed || payload.cursor) return [payload];
  return [];
}

/**
 * Convert a Plaid amount to ledger cents.
 *
 * TWO transformations, both essential:
 *   - Plaid: positive = money OUT. Ledger: positive = money IN. So negate.
 *     Verified against sandbox data (McDonald's +12 is a purchase; interest
 *     -4.22 is money in).
 *   - Plaid sends a float. Rounding rather than truncating avoids 19.99 → 1998.
 */
export function toLedgerCents(plaidAmount: number): number {
  const cents = Math.round(plaidAmount * 100);
  // `|| 0` normalizes -0, which would otherwise render as "-$0.00".
  return -cents || 0;
}

/**
 * Map one Plaid transaction.
 *
 * `accountType` matters for the same reason it does in the CSV path: a payment
 * is money OUT of the account that sends it and IN to the card that receives it.
 *
 * Category resolution runs merchant patterns BEFORE Plaid's taxonomy, matching
 * the CSV provider. Plaid's legacy categories are coarse — it files Instacart
 * and DoorDash under "Service", which maps to professional_services and lands
 * groceries and dining in the wrong bucket. A merchant match is specific; the
 * provider label is the fallback for everything no pattern knows.
 */
export function mapTransaction(
  txn: PlaidTransaction,
  accountType?: string,
): IncomingTransaction & { accountExternalId: string } {
  const amountCents = toLedgerCents(txn.amount);
  const inferred = inferCategory(txn.name, amountCents, accountType);
  const mapped = inferred !== 'other'
    ? { category: inferred, source: 'inferred' as const }
    : mapPlaidCategory(txn.category, amountCents);
  // mapPlaidCategory reads unlabelled money-in as income; on a card it is a refund.
  const category = creditNotIncome(mapped.category, amountCents, accountType);
  const { source } = mapped;
  return {
    externalId: txn.transaction_id,
    accountExternalId: txn.account_id,
    date: txn.date,
    // Absent from CLI output today; carried through in case it appears later.
    authorizedDate: txn.authorized_date ?? null,
    amountCents,
    currency: txn.iso_currency_code ?? 'USD',
    merchantName: txn.merchant_name ?? null,
    description: txn.name,
    category,
    categorySource: source,
    pending: txn.pending === true,
    rawJson: JSON.stringify(txn),
  };
}

export function mapAccount(account: PlaidAccount, institutionId?: string | null): IncomingAccount {
  return {
    // Plaid mints this per Item, so it names the CONNECTION's view of the
    // account, not the account. The ledger matches it to a real one.
    externalId: account.account_id,
    institutionId: institutionId ?? null,
    // official_name is more useful ("Plaid Gold Standard 0% Interest Checking")
    // but name is what the user recognises.
    name: account.name || account.official_name || account.account_id,
    // Plaid returns only the mask; full numbers require the Auth product, which
    // this provider deliberately does not request.
    mask: account.mask ?? null,
    type: account.type ?? null,
    subtype: account.subtype ?? null,
    currency: account.balances?.iso_currency_code ?? 'USD',
  };
}

export function mapBalance(account: PlaidAccount, asOf: string) {
  const balances = account.balances;
  if (!balances) return null;
  const cents = (v: number | null | undefined) =>
    v === null || v === undefined ? null : Math.round(v * 100);
  return {
    accountExternalId: account.account_id,
    asOf,
    currentCents: cents(balances.current),
    availableCents: cents(balances.available),
    limitCents: cents(balances.limit),
  };
}

/** Removed entries arrive as bare ids or as objects, depending on the call. */
export function mapRemoved(removed: PlaidSyncPayload['removed']): string[] {
  if (!removed) return [];
  return removed
    .map((r) => (typeof r === 'string' ? r : r?.transaction_id))
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
}

/**
 * Parse the CLI's output.
 *
 * It emits newline-delimited JSON and interleaves `diagnostic` objects with the
 * real payload, so take the last object carrying the field we want rather than
 * assuming the payload is the only line.
 */
export function parseCliJson<T extends object>(
  stdout: string,
  markers: keyof T | Array<keyof T>,
): T | null {
  const wanted = Array.isArray(markers) ? markers : [markers];
  let found: T | null = null;
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(trimmed) as T;
      if (wanted.some((m) => m in parsed)) found = parsed;
    } catch {
      // Not JSON — the CLI also prints human-readable lines. Skip.
    }
  }
  return found;
}

/** Rows requested per `transactions list` page. Plaid caps /transactions/get at 500. */
const PAGE_SIZE = 500;

/** Backstop against a bad `total_transactions` spinning the pager forever. */
const MAX_PAGES = 200;

type CliRunner = (args: string[], env: NodeJS.ProcessEnv) => { status: number; stdout: string; stderr: string };

/**
 * Enumerate linked Item ids.
 *
 * `item get` has no --all and REQUIRES --item once more than one Item exists,
 * so anything needing per-Item data has to walk this list first.
 */
function listItemIds(run: CliRunner, env: NodeJS.ProcessEnv): string[] {
  const res = run(['item', 'list', '--json'], env);
  if (res.status !== 0) return [];
  const payload = parseCliJson<{ items?: Array<{ item_id?: string }> }>(res.stdout, 'items');
  return (payload?.items ?? [])
    .map((i) => i.item_id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
}

/**
 * The institution behind an Item.
 *
 * Part of the natural key that recognises an account across a re-link, and the
 * one piece of it the transaction payload never carries. Cached per run: this
 * shells out, and every account of an Item asks the same question.
 */
const institutionCache = new Map<string, string | null>();
function institutionOf(run: CliRunner, env: NodeJS.ProcessEnv, itemId: string): string | null {
  if (institutionCache.has(itemId)) return institutionCache.get(itemId)!;
  const res = run(['item', 'list', '--json'], env);
  let found: string | null = null;
  if (res.status === 0) {
    const payload = parseCliJson<{
      items?: Array<{ item_id?: string; institution_id?: string }>;
    }>(res.stdout, 'items');
    found = (payload?.items ?? []).find((i) => i.item_id === itemId)?.institution_id ?? null;
  }
  institutionCache.set(itemId, found);
  return found;
}

/**
 * Refuse to write transactions whose account was not reported.
 *
 * The ledger's foreign key would reject them anyway, but with an error that
 * names neither the cause nor the accounts involved.
 */
export function assertAccountsCoverTransactions(
  accounts: ReadonlyArray<{ externalId: string }>,
  transactions: ReadonlyArray<{ accountExternalId: string }>,
): void {
  const known = new Set(accounts.map((a) => a.externalId));
  const orphaned = new Set(
    transactions.map((t) => t.accountExternalId).filter((id) => !known.has(id)),
  );
  if (orphaned.size === 0) return;
  throw new Error(
    `Plaid returned transactions for ${orphaned.size} account(s) it did not report ` +
    `(${[...orphaned].slice(0, 3).join(', ')}). Refusing to write a partial sync.`,
  );
}

type ProgressFn = (message: string) => void;

/**
 * Hand a URL to the OS to open, and never let that failure matter.
 *
 * Best-effort by design: the URL has already been printed, so a machine with
 * no browser, no window server, or an unusual desktop loses nothing. Throwing
 * here would abandon a link flow over a convenience.
 */
function defaultOpenUrl(url: string): void {
  const [command, args] = process.platform === 'darwin'
    ? ['open', [url]]
    : process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : ['xdg-open', [url]];
  spawnSync(command as string, args as string[], { stdio: 'ignore', timeout: 5_000 });
}

export interface PlaidProviderOptions {
  /**
   * History to request when creating an Item, in days (max 730).
   *
   * Set only when linking, and only reachable through the direct API path —
   * `plaid link` has no flag for it and always takes Plaid's ~90 day default.
   */
  daysRequested?: number;
  /** Plaid products to request when linking. Defaults to transactions. */
  linkProducts?: string[];
  /** Claim a session whose wait timed out, rather than starting a new one. */
  resume?: boolean;
  id: string;
  environment: 'sandbox' | 'production';
  /** Path to the `plaid` binary. Override when it is not on PATH. */
  binary?: string;
  /** account_ids to drop — see config.providers.plaid.ignoreAccounts. */
  ignoreAccounts?: string[];
  /** Injected for tests. */
  run?: (args: string[], env: NodeJS.ProcessEnv) => { status: number; stdout: string; stderr: string };
  /** Progress for the interactive link flow — it involves waiting on a human. */
  onProgress?: ProgressFn;
  /** Injected in tests so the link flow never reaches the network or sleeps. */
  linkDeps?: {
    fetcher?: Fetcher;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    openUrl?: (url: string) => void;
    addItem?: typeof addItemToCliConfig;
  };
}

/** How long to wait for the human to finish in the browser before giving up. */
// 20 minutes, not 10. Measured against a real brokerage link: its OAuth
// stacks an institution login, 2FA, an account-selection screen and a consent
// agreement, and ten minutes expired mid-flow. The wait costs nothing to
// extend — it is one human doing one thing — while expiring early strands an
// Item that no local state can reach.
const LINK_TIMEOUT_MS = 20 * 60 * 1000;
const LINK_POLL_MS = 3_000;

/**
 * Create an Item through Plaid's API rather than the CLI, so the amount of
 * history can be requested.
 *
 * The resulting Item is written into the CLI's store, because every other
 * operation here still goes through the CLI and it only sees Items it knows
 * about. An Item that exists at Plaid but not in that file is invisible
 * locally and still bills monthly, so the write is not optional.
 */
async function linkViaApi(
  ctx: ProviderContext,
  options: PlaidProviderOptions,
  onProgress: ProgressFn,
): Promise<LinkResult> {
  const clientId = ctx.getSecret('client_id');
  const secret = ctx.getSecret('secret');
  if (!clientId || !secret) {
    return {
      ok: false,
      message: 'Plaid credentials are not set. Run `finance secret set plaid client_id` and '
        + '`finance secret set plaid secret`.',
    };
  }

  const deps = options.linkDeps ?? {};
  const fetcher = deps.fetcher ?? (globalThis.fetch as unknown as Fetcher);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => { setTimeout(r, ms); }));
  const now = deps.now ?? (() => Date.now());
  const addItem = deps.addItem ?? addItemToCliConfig;
  const credentials = { clientId, secret, environment: options.environment };

  // Resume a session whose wait timed out. The Item already exists at Plaid;
  // this claims the public token that was never exchanged.
  const pendingPathEarly = join(ctx.stateDir, 'pending-link.json');
  if (options.resume) {
    if (!existsSync(pendingPathEarly)) {
      return {
        ok: false,
        message: 'No pending link to resume. Run `finance link` to start one.',
      };
    }
    const pending = JSON.parse(readFileSync(pendingPathEarly, 'utf8')) as {
      linkToken: string; expiration: string;
    };

    onProgress(`Resuming the link started earlier (expires ${pending.expiration})…`);
    let completedNow: { publicToken: string; institutionId: string | null } | LinkExited | null = null;
    try {
      completedNow = await pollLinkSession(credentials, pending.linkToken, fetcher);
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
    if (!completedNow || 'exited' in completedNow) {
      return {
        ok: false,
        message: 'That session has nothing to claim — either the sign-in was never '
          + 'finished, or the session has expired. Run `finance link` to start again.',
      };
    }
    return finishLink(ctx, options, credentials, completedNow, fetcher, pendingPathEarly);
  }

  let session;
  try {
    session = await createHostedLink(credentials, {
      daysRequested: options.daysRequested!,
      clientUserId: `finance-mcp-${options.id}`,
      ...(options.linkProducts ? { products: options.linkProducts } : {}),
    }, fetcher);
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }

  // Persist the session BEFORE waiting on a human.
  //
  // The wait is bounded and a person is not. When it timed out on a real link
  // the Item ALREADY existed at Plaid — Link creates it the moment the browser
  // flow completes — but the public token had never been exchanged, so nothing
  // local could reach it, remove it, or retry. Plaid has no endpoint listing
  // Items by client_id, so an unexchanged Item is unreachable by construction.
  // The link token is the only handle back to it, and it lives a few hours.
  const pendingPath = join(ctx.stateDir, 'pending-link.json');
  try {
    mkdirSync(ctx.stateDir, { recursive: true });
    writeFileSync(pendingPath, JSON.stringify({
      linkToken: session.linkToken,
      expiration: session.expiration,
      daysRequested: options.daysRequested,
      startedAt: new Date().toISOString(),
    }, null, 2), { mode: 0o600 });
  } catch {
    // Not worth failing the link over; it costs only the resume path.
  }

  onProgress(`
Open this link and sign in to your bank:

  ${session.hostedLinkUrl}
`);
  onProgress(`Requesting ${options.daysRequested} days of history. Waiting…`);

  // Open it, but print it regardless. The browser that opens is whichever the
  // OS considers default, which may not be the one already signed in to the
  // bank — and on a headless machine nothing opens at all. A URL that is only
  // in a browser you did not want is worse than one you can copy.
  // Guarded at the CALL, not inside the default: any opener can throw, and
  // abandoning a link flow over a convenience would be absurd — worse here
  // than elsewhere, because the next step creates something that bills.
  try {
    (deps.openUrl ?? defaultOpenUrl)(session.hostedLinkUrl);
  } catch {
    // The URL is already printed.
  }

  const deadline = now() + LINK_TIMEOUT_MS;
  let completed: { publicToken: string; institutionId: string | null } | null = null;
  while (now() < deadline) {
    await sleep(LINK_POLL_MS);
    let polled;
    try {
      polled = await pollLinkSession(credentials, session.linkToken, fetcher);
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
    if (polled && 'exited' in polled) {
      return {
        ok: false,
        message: `Link was closed before a bank was connected${polled.reason ? `: ${polled.reason}` : '.'}`
          + '\n  Nothing was created. Run it again whenever you are ready.',
      };
    }
    if (polled) { completed = polled; break; }
  }

  if (!completed) {
    return {
      ok: false,
      message: 'Timed out waiting for the browser flow.\n\n'
        + '  If you DID finish signing in, the connection exists at the provider even\n'
        + '  though nothing local knows about it yet. Recover it with:\n\n'
        + '    finance link --resume\n\n'
        + `  That works until the link session expires (${session.expiration}).\n`
        + '  If you did not finish, just run `finance link` again.',
    };
  }

  return finishLink(ctx, options, credentials, completed, fetcher, pendingPath);

}

function defaultRun(binary: string) {
  return (args: string[], env: NodeJS.ProcessEnv) => {
    const res = spawnSync(binary, args, {
      encoding: 'utf8',
      env: { ...process.env, ...env },
      // Sandbox syncs are fast; a production first sync pulling 24 months is not.
      timeout: 180_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    if (res.error) {
      const err = res.error as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') {
        throw new Error(
          `the \`${binary}\` CLI was not found. Install it with ` +
          '`brew install plaid/plaid-cli/plaid`, or set providers.plaid.binary in the config.',
        );
      }
      throw res.error;
    }
    return { status: res.status ?? 1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
  };
}

export function createPlaidProvider(options: PlaidProviderOptions): Provider {
  const binary = options.binary ?? 'plaid';
  const run = options.run ?? defaultRun(binary);
  const ignored = new Set(options.ignoreAccounts ?? []);

  // Applied to accounts AND their transactions. Dropping the account alone
  // would leave its transactions orphaned and trip the foreign-key guard.
  const keepAccount = (a: PlaidAccount) => !ignored.has(a.account_id);
  const keepTxn = (t: PlaidTransaction) => !ignored.has(t.account_id);

  const envFor = (ctx: ProviderContext): NodeJS.ProcessEnv => {
    const clientId = ctx.getSecret('client_id');
    const secret = ctx.getSecret('secret');
    if (!clientId || !secret) {
      throw new Error(
        'Plaid credentials are not set. Run `finance secret set plaid client_id` and ' +
        '`finance secret set plaid secret`.',
      );
    }
    // Passed through the child's environment only — never persisted by us.
    return { PLAID_CLIENT_ID: clientId, PLAID_SECRET: secret, PLAID_ENV: options.environment };
  };

  return {
    id: options.id,
    kind: 'plaid',
    capabilities: {
      transactions: true,
      balances: true,
      investments: false,
      automatic: true,
    },

    async link(ctx: ProviderContext): Promise<LinkResult> {
      // Asking for more history than the CLI's fixed default means creating the
      // link token ourselves — days_requested exists only at token creation,
      // and `plaid link` exposes no flag for it.
      // Anything beyond a bare link belongs to the API path. The CLI flow
      // shells out to `plaid link`, which persists no link token (so a
      // timeout strands the Item), records no institution_id (so a re-link
      // duplicates accounts), and opens a browser unconditionally regardless
      // of --open. --products was falling through to it, which is the one
      // flag most likely to be used on a slow brokerage OAuth.
      if (options.daysRequested !== undefined || options.resume
          || (options.linkProducts?.length ?? 0) > 0) {
        return linkViaApi(ctx, options, options.onProgress ?? (() => {}));
      }

      const args = options.environment === 'sandbox'
        ? ['sandbox', 'link', '--products', 'transactions', '--json']
        : ['link', '--json'];
      const res = run(args, envFor(ctx));
      if (res.status !== 0) {
        return { ok: false, message: `plaid ${args[0]} failed: ${res.stderr.trim() || res.stdout.trim()}` };
      }
      return {
        ok: true,
        message: options.environment === 'sandbox'
          ? 'Created a sandbox Item. Run `finance sync` to pull its transactions.'
          : 'Linked. Run `finance sync` to pull transactions.',
      };
    },

    /**
     * Date-range fetch via `transactions list`, which is NOT cursor-based.
     *
     * This exists because the Plaid CLI owns the sync cursor and advances it as
     * soon as its own API call succeeds. If this adapter then fails while
     * writing, those transactions are gone from every future `sync` — verified
     * against the live sandbox, not theoretical. This is the recovery path, and
     * the way to load history for an Item linked before the ledger existed.
     *
     * `transactions list` returns accounts in the same payload, so unlike sync
     * it needs no separate item walk.
     */
    async backfill(ctx: ProviderContext, startDate: string, endDate: string): Promise<SyncResult> {
      const env = envFor(ctx);
      const asOf = new Date().toISOString();
      const connections: ConnectionSync[] = [];
      const issues: string[] = [];

      for (const itemId of listItemIds(run, env)) {
        let failed = false;
        // One connection per Item: that is the unit Plaid authenticates, and
        // the unit a cursor belongs to.
        const accounts: IncomingAccount[] = [];
        const balances: ConnectionSync['balances'] = [];
        const added: ConnectionSync['added'] = [];
        const seenAccounts = new Set<string>();
        // `transactions list` returns at most --count rows (default 100) and
        // pages via --offset. Fetching one page and stopping silently truncates
        // history to the newest 100 transactions while reporting success —
        // every historical total would then be quietly wrong. Page until the
        // item's `total_transactions` is satisfied.
        let offset = 0;
        let total = Number.POSITIVE_INFINITY;

        for (let page = 0; offset < total; page++) {
          if (page >= MAX_PAGES) {
            throw new Error(
              `plaid transactions list exceeded ${MAX_PAGES} pages for ${itemId} ` +
              `(${offset} of ${total} fetched) — refusing to loop indefinitely.`,
            );
          }

          const res = run(
            ['transactions', 'list', '--item', itemId,
              '--start-date', startDate, '--end-date', endDate,
              '--count', String(PAGE_SIZE), '--offset', String(offset), '--json'],
            env,
          );
          if (res.status !== 0) {
            // One connection that cannot serve transactions must not abort the
            // backfill for every other connection. A brokerage offers
            // `investments` and NOT `transactions`, so it answers
            // ADDITIONAL_CONSENT_REQUIRED here forever — and that alone was
            // enough to discard a freshly linked card's two years of history,
            // which Plaid had already fetched and was holding.
            const detail = extractCliError(res.stdout) ?? extractCliError(res.stderr)
              ?? (res.stderr.trim() || res.stdout.trim()).slice(0, 160);
            issues.push(`connection ${itemId} returned no transactions: ${detail}`);
            failed = true;
            break;
          }
          const payload = parseCliJson<{
            transactions?: PlaidTransaction[];
            accounts?: PlaidAccount[];
            total_transactions?: number;
          }>(res.stdout, ['transactions', 'accounts']);

          // Accounts repeat on every page; take them once.
          for (const account of (payload?.accounts ?? []).filter(keepAccount)) {
            if (seenAccounts.has(account.account_id)) continue;
            seenAccounts.add(account.account_id);
            accounts.push(mapAccount(account, institutionOf(run, env, itemId)));
            const balance = mapBalance(account, asOf);
            if (balance) balances.push(balance);
          }

          // Accounts arrive on the same page, so the type map is populated
          // before the transactions that need it.
          const typeOf = new Map(accounts.map((a) => [a.externalId, a.type ?? undefined]));
          const batch = payload?.transactions ?? [];
          added.push(...batch.filter(keepTxn).map((t) => mapTransaction(t, typeOf.get(t.account_id))));

          // Trust total_transactions when present, but a short page also ends
          // it — belt and braces, since a wrong total would either truncate or
          // spin.
          if (typeof payload?.total_transactions === 'number') total = payload.total_transactions;
          if (batch.length === 0) break;
          offset += batch.length;
          if (batch.length < PAGE_SIZE && !Number.isFinite(total)) break;
        }

        // A connection that failed mid-fetch has a partial view of its own
        // range. Writing it would look like a completed backfill over a window
        // it never covered, and the next report would treat the gap as real.
        if (failed) continue;

        assertAccountsCoverTransactions(accounts, added);
        connections.push({
          externalId: itemId,
          accounts,
          added,
          modified: [],
          // A date-range fetch says nothing about transactions outside it, so
          // it must never be read as "everything else was deleted".
          removed: [],
          balances,
          // Deliberately null: this path did not advance the incremental
          // cursor, and the engine does not store it for a backfill anyway.
          cursor: null,
        });
      }

      return { connections, ...(issues.length ? { issues } : {}) };
    },

    /**
     * Poll until Plaid has finished fetching this Item's history.
     *
     * Counting is enough and is cheap: `--count 1` returns one row plus
     * `total_transactions` for the whole window, so each poll costs almost
     * nothing. When that count stops growing across two consecutive polls the
     * historical pull has finished — a stronger signal than a fixed wait,
     * which is either too short for a slow institution or wasted on a fast one.
     */
    // `wait` rather than `options`, so the provider's own options stay in
    // scope — the injected clock and sleep live there, beside the link ones.
    async awaitHistory(ctx, wait): Promise<{ settled: boolean; transactions: number }> {
      const env = envFor(ctx);
      const deps = options.linkDeps ?? {};
      const now = deps.now ?? (() => Date.now());
      const deadline = now() + (wait.timeoutMs ?? 5 * 60_000);
      const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => { setTimeout(r, ms); }));

      let previous = -1;
      let stable = 0;
      let total = 0;

      while (now() < deadline) {
        total = 0;
        for (const itemId of listItemIds(run, env)) {
          const res = run(
            ['transactions', 'list', '--item', itemId,
              '--start-date', wait.startDate, '--end-date', wait.endDate,
              '--count', '1', '--json'],
            env,
          );
          if (res.status !== 0) continue;
          const payload = parseCliJson<{ total_transactions?: number }>(res.stdout, 'total_transactions');
          total += payload?.total_transactions ?? 0;
        }

        if (total === previous) {
          stable += 1;
          // Two consecutive identical counts. One is not enough: a provider
          // can pause between pages and look finished mid-fetch.
          if (stable >= 2) return { settled: true, transactions: total };
        } else {
          stable = 0;
          wait.onProgress?.(`  ${total} transactions available so far…`);
        }
        previous = total;
        await sleep(5_000);
      }
      return { settled: false, transactions: total };
    },

    async sync(ctx: ProviderContext): Promise<SyncResult> {
      const env = envFor(ctx);

      // The CLI owns the cursor (it persists one per Item), so the ledger's
      // cursor is not passed back in — `--all` syncs every linked Item from
      // wherever each one left off.
      const syncRes = run(['transactions', 'sync', '--all', '--json'], env);
      if (syncRes.status !== 0) {
        throw new Error(`plaid transactions sync failed: ${syncRes.stderr.trim() || syncRes.stdout.trim()}`);
      }
      const raw = parseCliJson<PlaidSyncPayload & PlaidMultiSyncPayload>(
        syncRes.stdout,
        ['items', 'added'],
      );
      if (!raw) {
        throw new Error(`could not parse sync output from the Plaid CLI: ${syncRes.stdout.slice(0, 400)}`);
      }
      const perItem = normalizeSyncPayload(raw);

      // Accounts and balances come from `item get`, which returns both in one
      // call — cheaper than a separate balance fetch, which is billed per call.
      //
      // `item get` has no --all and REQUIRES --item once more than one Item is
      // linked, so enumerate and fetch each.
      const asOf = new Date().toISOString();
      const byItem = new Map<string, ConnectionSync>();
      const issues: string[] = [];

      for (const itemId of listItemIds(run, env)) {
        const accounts: IncomingAccount[] = [];
        const balances: ConnectionSync['balances'] = [];

        const itemRes = run(['item', 'get', '--item', itemId, '--json'], env);
        const itemPayload = itemRes.status === 0
          ? parseCliJson<{ accounts?: PlaidAccount[] }>(itemRes.stdout, 'accounts')
          : null;
        if (itemPayload) {
          for (const account of (itemPayload.accounts ?? []).filter(keepAccount)) {
            if (accounts.some((a) => a.externalId === account.account_id)) continue;
            accounts.push(mapAccount(account, institutionOf(run, env, itemId)));
            const balance = mapBalance(account, asOf);
            if (balance) balances.push(balance);
          }
        } else {
          // A connection that cannot be read is NOT a connection with nothing
          // in it. Silently treating it as empty is how a dead bank link
          // produced ten consecutive successful syncs reporting no new
          // transactions. The CLI reports some failures as an error payload on
          // stdout with a zero exit, so the parse result is the real signal.
          const detail = extractCliError(itemRes.stdout) ?? extractCliError(itemRes.stderr);
          issues.push(
            `connection ${itemId} could not be read${detail ? `: ${detail}` : ''} — `
            + 'its accounts are not being updated. Re-link it with `finance link`.',
          );
        }
        byItem.set(itemId, {
          externalId: itemId, accounts, added: [], modified: [], removed: [], balances,
          cursor: null,
        });
      }

      // Fold each Item's changes into its own connection. Previously every
      // Item's cursor was JSON-encoded into one string because the schema had
      // a single cursor per provider; each connection now keeps its own.
      for (const item of perItem) {
        const itemId = item.item?.item_id;
        if (!itemId) continue;
        const connection = byItem.get(itemId);
        // An Item reporting changes but not listed by `item list` cannot have
        // its accounts resolved, so its rows would be dropped downstream
        // anyway. Skipping here keeps that visible rather than silent.
        if (!connection) continue;

        const typeOf = new Map(connection.accounts.map((a) => [a.externalId, a.type ?? undefined]));
        const withType = (t: PlaidTransaction) => mapTransaction(t, typeOf.get(t.account_id));

        connection.added.push(...(item.added ?? []).filter(keepTxn).map(withType));
        connection.modified.push(...(item.modified ?? []).filter(keepTxn).map(withType));
        connection.removed.push(...mapRemoved(item.removed));
        connection.cursor = item.cursor ?? null;
      }

      for (const connection of byItem.values()) {
        assertAccountsCoverTransactions(
          connection.accounts, [...connection.added, ...connection.modified],
        );
      }

      return { connections: [...byItem.values()], ...(issues.length ? { issues } : {}) };
    },
  };
}

/** Pull Plaid's error message out of a CLI response that reports one as data. */
function extractCliError(output: string): string | null {
  for (const line of (output || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(trimmed) as { error?: { message?: string; code?: string } };
      if (parsed.error?.message) return parsed.error.message.split('(request_id')[0]!.trim();
      if (parsed.error?.code) return parsed.error.code;
    } catch { /* not JSON; keep looking */ }
  }
  return null;
}

/**
 * Exchange a claimed public token and record the Item.
 *
 * Shared by the normal flow and by --resume, so a recovered session takes
 * exactly the same steps — including fetching institution_id, without which a
 * re-link creates a duplicate account instead of joining the one it should.
 */
async function finishLink(
  ctx: ProviderContext,
  options: PlaidProviderOptions,
  credentials: { clientId: string; secret: string; environment: 'sandbox' | 'production' },
  completed: { publicToken: string; institutionId: string | null },
  fetcher: Fetcher,
  pendingPath: string,
): Promise<LinkResult> {
  void ctx;
  const addItem = options.linkDeps?.addItem ?? addItemToCliConfig;

  let item;
  try {
    item = await exchangePublicToken(
      credentials, completed.publicToken, completed.institutionId, fetcher,
    );
    if (!item.institutionId) {
      item = {
        ...item,
        institutionId: await getItemInstitution(credentials, item.accessToken, fetcher),
      };
    }
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }

  try {
    const { backupPath, replaced } = addItem(options.environment, {
      item_id: item.itemId,
      access_token: item.accessToken,
      sync_cursor: '',
      ...(item.institutionId ? { institution_id: item.institutionId } : {}),
    });
    // Only once it is recorded is the handle spent.
    try { unlinkSync(pendingPath); } catch { /* already gone */ }

    return {
      ok: true,
      message: `Linked${replaced ? ' (updated an existing Item)' : ''}. `
        + `Requested ${options.daysRequested} days of history.\n`
        + `  Plaid CLI config backed up to ${backupPath}`,
    };
  } catch (err) {
    return {
      ok: false,
      message: `The account linked at Plaid, but recording it locally failed: ${(err as Error).message}\n`
        + `  Item id: ${item.itemId}\n`
        + '  That Item is live and billable. Add it to the Plaid CLI config by hand, or remove\n'
        + '  it from the Plaid dashboard so it stops billing.',
    };
  }
}
