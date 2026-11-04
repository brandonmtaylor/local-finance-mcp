// A local cache of brokerage cash movements.
//
// The report is generated offline — no server, no network — which is a promise
// worth keeping, so it cannot call a provider to work out which sub-account a
// transfer came from. Sync is where the network already happens, so sync writes
// these down and the report reads them.
//
// Cached rather than stored in the ledger on purpose. These are not
// transactions: they never appear on a statement, they are not spending, and
// giving them ids and a place in the ledger would put rows in front of anyone
// running a query who has no reason to want them. This is working data for one
// derivation, and treating it as a cache means a stale or missing file costs
// only that derivation.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { financeHome } from './paths.js';
import type Database from 'better-sqlite3';
import {
  attributeTransfers, netByAccount,
  type CashMovement, type BankTransfer, type AttributionResult,
} from './attribution.js';

export interface CashMovementCache {
  fetchedAt: string;
  movements: CashMovement[];
}

export function cashMovementsPath(): string {
  return join(financeHome(), 'cash-movements.json');
}

/**
 * Read the cache. Returns null when absent or unreadable.
 *
 * Never throws: every caller treats a missing cache as "no attribution
 * available", which is a complete and correct state — the ledger predates any
 * brokerage link, and it will predate this file too.
 */
export function readCashMovements(path = cashMovementsPath()): CashMovementCache | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const cache = parsed as Partial<CashMovementCache>;
    if (!Array.isArray(cache.movements)) return null;
    return {
      fetchedAt: typeof cache.fetchedAt === 'string' ? cache.fetchedAt : '',
      movements: cache.movements.filter((m): m is CashMovement =>
        !!m && typeof m.date === 'string' && typeof m.amountCents === 'number'
        && typeof m.accountId === 'string' && typeof m.accountName === 'string'),
    };
  } catch {
    return null;
  }
}

/**
 * Replace the cache.
 *
 * 0600 because these carry account names and dated amounts — less than the
 * ledger holds, but the same kind of thing, and there is no reason for it to be
 * world-readable when the ledger beside it is not.
 */
export function writeCashMovements(
  movements: CashMovement[],
  fetchedAt: string,
  path = cashMovementsPath(),
): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ fetchedAt, movements }, null, 2), { mode: 0o600 });
}

export interface CachedAttribution {
  /** When sync last refreshed the brokerage feed this rests on. */
  fetchedAt: string;
  transfers: BankTransfer[];
  result: AttributionResult;
  net: ReturnType<typeof netByAccount>;
}

/**
 * A window's bank transfers, attributed to brokerage sub-accounts from the
 * cache. Shared by the report and the MCP server, neither of which touches the
 * network. Null when there is no cache or no transfer in the window.
 */
export function attributeFromCache(
  db: Database.Database,
  startDate: string,
  endDate: string,
  cache: CashMovementCache | null = readCashMovements(),
): CachedAttribution | null {
  if (!cache || cache.movements.length === 0) return null;
  const transfers = db.prepare(`
    SELECT txn_id AS txnId, date, amount_cents AS amountCents, description
      FROM visible_transactions
     WHERE spend_group = 'transfers' AND date >= @startDate AND date <= @endDate
     ORDER BY date DESC
  `).all({ startDate, endDate }) as BankTransfer[];
  if (transfers.length === 0) return null;
  const result = attributeTransfers(transfers, cache.movements);
  return { fetchedAt: cache.fetchedAt, transfers, result, net: netByAccount(transfers, result) };
}
