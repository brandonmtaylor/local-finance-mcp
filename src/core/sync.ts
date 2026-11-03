// The sync engine: run providers, write results to the ledger.
//
// Called from three places — the CLI, the scheduler, and (via freshness) an MCP
// read. All three go through here so there is exactly one implementation of
// "what does syncing mean".

import type Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import {
  upsertProvider,
  resolveConnection,
  resolveSource,
  upsertTransaction,
  removeTransaction,
  appendBalance,
  recordSync,
  setCursor,
  listConnections,
  getLastSyncAt,
} from './ledger.js';
import { providerStateDir } from './paths.js';
import { readSecret } from './secrets.js';
import { withLock } from './lock.js';
import type { Provider, ProviderContext, ConnectionSync } from '../providers/types.js';

export interface SyncOutcome {
  providerId: string;
  added: number;
  modified: number;
  removed: number;
  error?: string;
  /** Provider account ids that matched more than one account — see doctor. */
  ambiguousAccounts?: string[];
  /**
   * Connections the provider could not read.
   *
   * Not an `error`: the sync itself succeeded and wrote what the healthy
   * connections returned. But a dead link produces "+0 added" forever, which
   * reads as "nothing happened" rather than "one of your banks stopped
   * answering", so it must reach the caller.
   */
  issues?: string[];
  /**
   * Earliest and latest dates actually written, when known.
   *
   * A backfill asks for a range; the provider decides what it returns. Plaid
   * caps an Item at the `days_requested` fixed when it was created — commonly
   * 90 days — so a request for two years quietly yields three months. Reporting
   * the request rather than the result makes a ledger look deeper than it is,
   * and every average taken over it inherits that error silently.
   */
  coverage?: { earliest: string; latest: string } | null;
}

function contextFor(provider: Provider, timezone: string): ProviderContext {
  const stateDir = providerStateDir(provider.id);
  mkdirSync(stateDir, { recursive: true });
  return {
    providerId: provider.id,
    stateDir,
    timezone,
    getSecret: (key) => readSecret(provider.id, key),
  };
}

/**
 * Write one connection's results to the ledger.
 *
 * The mapping from the provider's account ids to real accounts happens here,
 * in `resolveSource`. A provider never learns that a re-link is a re-link: it
 * reports what it sees, and the ledger decides whether that is a new account or
 * a new way of reaching one it already has.
 */
function writeConnection(
  db: Database.Database,
  providerId: string,
  connection: ConnectionSync,
  /**
   * Whether to store the cursor this connection reported.
   *
   * False for a backfill: it fetched an explicit date range, which says nothing
   * about where the incremental change feed has reached. Writing it would move
   * the cursor to a position no sync ever reported and silently skip whatever
   * lies between.
   */
  advanceCursor = true,
): { added: number; modified: number; removed: number; dates: string[]; ambiguous: string[] } {
  const connectionId = resolveConnection(db, providerId, connection.externalId);

  // Every account this connection reports, mapped to the real account it feeds.
  const sources = new Map<string, { sourceId: string; accountId: string }>();
  const ambiguous: string[] = [];
  for (const account of connection.accounts) {
    const resolved = resolveSource(db, connectionId, account);
    sources.set(account.externalId, resolved);
    if (resolved.ambiguous) ambiguous.push(account.externalId);
  }

  const dates: string[] = [];
  let added = 0;
  let modified = 0;

  // Counted by what the LEDGER did, not by which list the provider used. CSV
  // re-delivers every row of every file as `added` on every run, so trusting
  // the list printed "+55 added" for a sync that changed nothing — which reads
  // as "it duplicated everything". A row already held is not an addition.
  //
  // The reverse holds too: a re-delivered row is a modification when what it
  // says changed. Mapping a CSV's Category column re-categorises every row on
  // the next sync, and reporting "0 modified" for that reads as "it ignored
  // the change".
  const held = db.prepare(
    `SELECT date, amount_cents AS amountCents, merchant_name AS merchantName, category, pending
       FROM transactions WHERE source_id = ? AND external_id = ?`,
  );
  for (const [rows, isNew] of [[connection.added, true], [connection.modified, false]] as const) {
    for (const row of rows) {
      const source = sources.get(row.accountExternalId);
      // A transaction for an account the connection did not report. Skipping is
      // the only safe move: inventing an account here would create exactly the
      // phantom duplicates this design exists to prevent.
      if (!source) continue;
      const before = held.get(source.sourceId, row.externalId) as {
        date: string; amountCents: number; merchantName: string | null; category: string; pending: number;
      } | undefined;
      upsertTransaction(db, source.sourceId, source.accountId, row);
      dates.push(row.date);
      if (!before) added += 1;
      else if (!isNew || before.category !== row.category || before.date !== row.date
        || before.amountCents !== row.amountCents || before.merchantName !== (row.merchantName ?? null)
        || before.pending !== (row.pending ? 1 : 0)) modified += 1;
    }
  }

  // A provider reports removals per connection without saying which account
  // held the row, so every source is swept — but only a deletion that actually
  // happened is counted, or a connection with three accounts would report
  // three removals for one transaction.
  let removed = 0;
  for (const externalId of connection.removed) {
    for (const { sourceId } of sources.values()) {
      if (removeTransaction(db, sourceId, externalId)) removed += 1;
    }
  }

  for (const balance of connection.balances) {
    const source = sources.get(balance.accountExternalId);
    if (!source) continue;
    appendBalance(db, { ...balance, sourceId: source.sourceId, accountId: source.accountId });
  }

  if (advanceCursor) setCursor(db, connectionId, connection.cursor);
  return { added, modified, removed, dates, ambiguous };
}

export interface SyncAllOptions {
  timezone: string;
  /** Skip providers that need a human to drop a file in (CSV). */
  automaticOnly?: boolean;
  onProgress?: (message: string) => void;
}

/**
 * Sync one provider: hand it the cursors it owns, write back what it returns.
 */
export async function syncProvider(
  db: Database.Database,
  provider: Provider,
  timezone: string,
): Promise<SyncOutcome> {
  upsertProvider(db, provider.id, provider.kind);
  const ctx = contextFor(provider, timezone);

  // Cursors are keyed by the provider's own connection id, so a provider never
  // has to know about our ids.
  const cursors: Record<string, string | null> = {};
  for (const c of listConnections(db, provider.id)) cursors[c.externalId] = c.cursor;

  try {
    const result = await provider.sync(ctx, cursors);
    const totals = { added: 0, modified: 0, removed: 0 };
    const dates: string[] = [];
    const ambiguous: string[] = [];

    db.transaction(() => {
      for (const connection of result.connections) {
        const written = writeConnection(db, provider.id, connection);
        totals.added += written.added;
        totals.modified += written.modified;
        totals.removed += written.removed;
        dates.push(...written.dates);
        ambiguous.push(...written.ambiguous);
      }
    })();

    const sorted = dates.sort();
    const outcome: SyncOutcome = {
      providerId: provider.id,
      ...totals,
      coverage: sorted.length ? { earliest: sorted[0]!, latest: sorted[sorted.length - 1]! } : null,
      ...(ambiguous.length ? { ambiguousAccounts: ambiguous } : {}),
      ...(result.issues?.length ? { issues: result.issues } : {}),
    };
    recordSync(db, provider.id, outcome);
    return outcome;
  } catch (err) {
    const message = (err as Error).message;
    recordSync(db, provider.id, { added: 0, modified: 0, removed: 0, error: message });
    return { providerId: provider.id, added: 0, modified: 0, removed: 0, error: message };
  }
}

/**
 * Fetch an explicit date range, ignoring cursors.
 *
 * Exists because the incremental path can advance a cursor we do not control:
 * a sync that fails after consuming records would otherwise skip them forever.
 * Also how history is loaded after a link.
 */
export async function backfillProvider(
  db: Database.Database,
  provider: Provider,
  timezone: string,
  startDate: string,
  endDate: string,
): Promise<SyncOutcome> {
  if (!provider.backfill) {
    return {
      providerId: provider.id,
      added: 0, modified: 0, removed: 0,
      error: `${provider.id} does not support backfill`,
    };
  }
  upsertProvider(db, provider.id, provider.kind);
  const ctx = contextFor(provider, timezone);

  try {
    const result = await provider.backfill(ctx, startDate, endDate);
    const totals = { added: 0, modified: 0, removed: 0 };
    const dates: string[] = [];

    db.transaction(() => {
      for (const connection of result.connections) {
        const written = writeConnection(db, provider.id, connection, false);
        totals.added += written.added;
        totals.modified += written.modified;
        totals.removed += written.removed;
        dates.push(...written.dates);
      }
    })();

    const sorted = dates.sort();
    const outcome: SyncOutcome = {
      providerId: provider.id,
      ...totals,
      coverage: sorted.length ? { earliest: sorted[0]!, latest: sorted[sorted.length - 1]! } : null,
    };
    recordSync(db, provider.id, outcome);
    return outcome;
  } catch (err) {
    const message = (err as Error).message;
    recordSync(db, provider.id, { added: 0, modified: 0, removed: 0, error: message });
    return { providerId: provider.id, added: 0, modified: 0, removed: 0, error: message };
  }
}

/**
 * Sync every provider under the advisory lock.
 *
 * Returns null when another sync already holds the lock — the caller should
 * carry on with what is in the ledger rather than queue, since the in-flight
 * sync produces the freshness they wanted anyway.
 */
export async function syncAll(
  db: Database.Database,
  providers: Provider[],
  options: SyncAllOptions,
): Promise<SyncOutcome[] | null> {
  const selected = options.automaticOnly
    ? providers.filter((p) => p.capabilities.automatic)
    : providers;

  return withLock('sync', async () => {
    const outcomes: SyncOutcome[] = [];
    for (const provider of selected) {
      options.onProgress?.(`syncing ${provider.id}…`);
      // Sequential on purpose: providers share the lock and the ledger, and a
      // handful of accounts is not worth the concurrency bugs.
      outcomes.push(await syncProvider(db, provider, options.timezone));
    }
    return outcomes;
  });
}

/** Oldest last-sync across the given providers — the freshness input. */
export function oldestSyncAmong(db: Database.Database, providerIds: string[]): Date | null {
  if (!providerIds.length) return null;
  let oldest: Date | null = null;
  for (const id of providerIds) {
    const at = getLastSyncAt(db, id);
    if (at === null) return null; // never synced dominates
    if (oldest === null || at < oldest) oldest = at;
  }
  return oldest;
}
