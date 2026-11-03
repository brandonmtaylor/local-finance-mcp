// Fixture helpers for the connection/source model.
//
// Under content-derived identity a test cannot choose a transaction's id — it
// falls out of (account, date, amount, description). So `seedTxn` RETURNS the
// id it minted, and tests that need to annotate a row keep hold of it. That is
// the same contract real callers get, which is the point: a fixture that could
// name its own ids would be testing a ledger nobody uses.

import type Database from 'better-sqlite3';
import {
  upsertProvider, resolveConnection, resolveSource, upsertTransaction,
  type IncomingTransaction,
} from '../src/core/ledger.js';
import type { Category } from '../src/core/normalize.js';

export interface Seeded {
  sourceId: string;
  accountId: string;
  connectionId: string;
}

/**
 * One account reached through one connection — the ordinary case.
 *
 * `key` names both the Plaid Item and the account within it, so two calls with
 * different keys give two unrelated accounts, and two calls sharing a mask give
 * one account reached two ways.
 */
export function seedAccount(
  db: Database.Database,
  key = 'a1',
  over: Partial<{
    providerId: string;
    name: string;
    mask: string | null;
    type: string;
    subtype: string | null;
    institutionId: string | null;
    itemId: string;
  }> = {},
): Seeded {
  const providerId = over.providerId ?? 'plaid';
  upsertProvider(db, providerId, providerId);
  const connectionId = resolveConnection(db, providerId, over.itemId ?? `item-${key}`);
  const resolved = resolveSource(db, connectionId, {
    externalId: key,
    name: over.name ?? 'Checking',
    mask: over.mask === undefined ? key.slice(-4).padStart(4, '0') : over.mask,
    type: over.type ?? 'depository',
    subtype: over.subtype ?? 'checking',
    institutionId: over.institutionId ?? 'ins_test',
    currency: 'USD',
  });
  return { ...resolved, connectionId };
}

let counter = 0;

/** Write a transaction and return the id the ledger derived for it. */
export function seedTxn(
  db: Database.Database,
  into: Seeded,
  over: Partial<IncomingTransaction> & { category?: Category } = {},
): string {
  counter += 1;
  return upsertTransaction(db, into.sourceId, into.accountId, {
    // Unique per call unless a test pins it, so ordinary fixtures never collide
    // by accident — while a test that WANTS two identical rows can pass the
    // same date, amount and description and get occurrence 0 and 1.
    externalId: over.externalId ?? `ext-${counter}`,
    date: over.date ?? '2026-06-15',
    amountCents: over.amountCents ?? -10_000,
    currency: over.currency ?? 'USD',
    merchantName: over.merchantName ?? null,
    description: over.description ?? `THING ${counter}`,
    category: over.category ?? 'shopping',
    categorySource: over.categorySource ?? 'inferred',
    pending: over.pending ?? false,
    ...(over.rawJson !== undefined ? { rawJson: over.rawJson } : {}),
  });
}

/** Everything the reports would count, in date order. */
export function visibleTxns(db: Database.Database): Array<Record<string, unknown>> {
  return db.prepare(
    'SELECT * FROM visible_transactions ORDER BY date, txn_id',
  ).all() as Array<Record<string, unknown>>;
}
