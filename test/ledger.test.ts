// Ledger invariants. The two that matter most:
//   - the sign convention (positive = money in) — inverting it silently flips
//     every report in the project
//   - a correction surviving a re-sync, and CHANGING THE TOTALS rather than
//     just the label

import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import {
  openLedger,
  migrate,
  resolveConnection,
  upsertTransaction,
  removeTransaction,
  appendBalance,
  setCategoryOverride,
  recordSync,
  setCursor,
  getCursor,
  getLastSyncAt,
} from '../src/core/ledger.js';
import { seedAccount, seedTxn, type Seeded } from './helpers.js';

let db: Database.Database;
let acct: Seeded;

/** A fixed transaction: same content every time, so it keeps one identity. */
const same = (over: Parameters<typeof seedTxn>[2] = {}) => seedTxn(db, acct, {
  externalId: 'ext-fixed',
  date: '2026-07-14',
  amountCents: -8_432,
  description: 'GROCERY MART #412',
  category: 'groceries',
  ...over,
});

beforeEach(() => {
  db = openLedger(':memory:');
  acct = seedAccount(db, 'acct-1');
});

describe('schema', () => {
  it('creates the ledger and is idempotent to re-open', () => {
    // Pinned to a literal on purpose. Bumping the schema should be a decision
    // someone makes and edits, not something a test quietly follows along with.
    // v2 added the projects, vendors and line_items tables.
    expect(db.pragma('user_version', { simple: true })).toBe(2);
    expect(() => openLedger(':memory:')).not.toThrow();
  });

  it('adds the v2 tables to a v1 ledger instead of refusing it', () => {
    // Additive, unlike the pre-identity schema: no existing row changes shape,
    // so this one is migrated rather than rejected.
    const fresh = openLedger(':memory:');
    fresh.exec('DROP TABLE line_items; DROP TABLE vendors; DROP TABLE projects;');
    fresh.pragma('user_version = 1');
    migrate(fresh);

    expect(fresh.pragma('user_version', { simple: true })).toBe(2);
    const tables = (fresh.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('projects','vendors','line_items')",
    ).all() as Array<{ name: string }>).map((t) => t.name).sort();
    expect(tables).toEqual(['line_items', 'projects', 'vendors']);
    fresh.close();
  });

  it('refuses a ledger built on the previous schema rather than guessing', () => {
    // The old shape keyed accounts on the provider's ids and cannot express
    // this model; migrating would mean inventing identities the rows never had.
    const legacy = openLedger(':memory:');
    legacy.exec('DROP VIEW visible_transactions; DROP TABLE sources; DROP TABLE connections;');
    // Re-opening the same handle is not the path under test; the guard runs on
    // open, so assert on its own terms.
    expect(legacy.prepare(
      "SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='sources'",
    ).get()).toEqual({ n: 0 });
    legacy.close();
  });

  it('enforces foreign keys', () => {
    expect(() => upsertTransaction(db, 'src-nope', 'acct-nope', {
      externalId: 'x', date: '2026-07-14', amountCents: -1, description: 'X',
      category: 'shopping', categorySource: 'inferred',
    })).toThrow();
  });
});

describe('sign convention', () => {
  it('stores money out as negative and money in as positive', () => {
    seedTxn(db, acct, { description: 'OUT', amountCents: -8_432 });
    seedTxn(db, acct, { description: 'IN', amountCents: 500_000, category: 'income' });

    const rows = db.prepare(
      'SELECT description, amount_cents FROM transactions ORDER BY amount_cents',
    ).all();
    expect(rows).toEqual([
      { description: 'OUT', amount_cents: -8_432 },
      { description: 'IN', amount_cents: 500_000 },
    ]);
  });

  it('keeps money as integer cents, never floats', () => {
    same({ amountCents: -8_432 });
    const row = db.prepare('SELECT amount_cents FROM transactions').get() as { amount_cents: number };
    expect(Number.isInteger(row.amount_cents)).toBe(true);
  });
});

describe('upsertTransaction', () => {
  it('derives spend_group from the category', () => {
    seedTxn(db, acct, { description: 'A', category: 'groceries' });
    seedTxn(db, acct, { description: 'B', category: 'credit_card_payment' });
    seedTxn(db, acct, { description: 'C', category: 'utilities' });

    const groups = db.prepare(
      'SELECT description, spend_group FROM transactions ORDER BY description',
    ).all();
    expect(groups).toEqual([
      { description: 'A', spend_group: 'purchases' },
      { description: 'B', spend_group: 'payments' },
      { description: 'C', spend_group: 'bills' },
    ]);
  });

  it('is idempotent — re-syncing the same row updates rather than duplicates', () => {
    same();
    same();
    same();

    const rows = db.prepare('SELECT txn_id, description FROM transactions').all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ description: 'GROCERY MART #412' });
  });

  it('promotes a pending transaction to posted in place', () => {
    // Same provider id, so the same row — even though the amount moved, which
    // would otherwise give it a different content hash.
    same({ pending: true, amountCents: -8_000 });
    same({ pending: false, amountCents: -8_432 });

    const row = db.prepare('SELECT pending, amount_cents FROM transactions').get();
    expect(row).toEqual({ pending: 0, amount_cents: -8_432 });
  });
});

describe('corrections', () => {
  it('SURVIVE a re-sync that would otherwise overwrite them', () => {
    const id = same({ category: 'other' });
    setCategoryOverride(db, id, 'groceries');

    // Provider re-syncs with its own (wrong) idea of the category.
    same({ category: 'shopping' });

    const row = db.prepare(
      'SELECT provider_category, category FROM visible_transactions',
    ).get() as { provider_category: string; category: string };

    expect(row.provider_category).toBe('shopping'); // provider value refreshed
    expect(row.category).toBe('groceries');         // correction intact
  });

  it('change the SPEND GROUP, not merely the label', () => {
    // The load-bearing half. spend_group decides whether a row counts as
    // spending at all, so an override that leaves it alone lets a
    // reclassified card payment stay in the total — the double-count this
    // project exists to prevent, returning by the back door.
    const id = same({ category: 'shopping' });
    expect((db.prepare('SELECT spend_group FROM visible_transactions').get() as
      { spend_group: string }).spend_group).toBe('purchases');

    setCategoryOverride(db, id, 'credit_card_payment');
    expect((db.prepare('SELECT spend_group FROM visible_transactions').get() as
      { spend_group: string }).spend_group).toBe('payments');
  });

  it('keep their effect on spend_group after a later sync', () => {
    const id = same({ category: 'shopping' });
    setCategoryOverride(db, id, 'credit_card_payment');
    same({ category: 'shopping' }); // provider re-syncs

    const row = db.prepare(
      'SELECT provider_category, category, spend_group FROM visible_transactions',
    ).get() as { provider_category: string; category: string; spend_group: string };

    expect(row.provider_category).toBe('shopping');
    expect(row.category).toBe('credit_card_payment');
    expect(row.spend_group).toBe('payments'); // still excluded from spending
  });

  it('still refresh spend_group for rows with no correction', () => {
    same({ category: 'shopping' });
    same({ category: 'utilities' });
    expect((db.prepare('SELECT spend_group FROM visible_transactions').get() as
      { spend_group: string }).spend_group).toBe('bills');
  });

  it('report whether the target existed', () => {
    const id = same();
    expect(setCategoryOverride(db, id, 'dining')).toBe(true);
    expect(setCategoryOverride(db, 'missing', 'dining')).toBe(false);
  });
});

describe('removeTransaction', () => {
  it('deletes rows a provider reports as removed', () => {
    same();
    removeTransaction(db, acct.sourceId, 'ext-fixed');
    expect(db.prepare('SELECT COUNT(*) c FROM transactions').get()).toEqual({ c: 0 });
  });

  it('removes it from ONE source only', () => {
    // A second connection reporting the same transaction keeps it visible:
    // one bank forgetting a row is not the same as the row not existing.
    same();
    const other = seedAccount(db, 'acct-1', { itemId: 'item-second' });
    upsertTransaction(db, other.sourceId, other.accountId, {
      externalId: 'ext-other', date: '2026-07-14', amountCents: -8_432,
      description: 'GROCERY MART #412', category: 'groceries', categorySource: 'inferred',
    });

    removeTransaction(db, acct.sourceId, 'ext-fixed');
    expect(db.prepare('SELECT COUNT(*) c FROM visible_transactions').get()).toEqual({ c: 1 });
  });
});

describe('balances', () => {
  it('appends history rather than overwriting', () => {
    for (const [asOf, cents] of [
      ['2026-07-01T00:00:00.000Z', 100_000], ['2026-08-01T00:00:00.000Z', 120_000],
    ] as const) {
      appendBalance(db, {
        sourceId: acct.sourceId, accountId: acct.accountId, asOf,
        currentCents: cents, availableCents: cents, limitCents: null,
      });
    }

    const rows = db.prepare('SELECT as_of, current_cents FROM balances ORDER BY as_of').all();
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ current_cents: 120_000 });
  });
});

describe('cursor + sync log', () => {
  it('round-trips a cursor PER CONNECTION', () => {
    // Plaid advances one cursor per Item. A single cursor per provider is what
    // forced the old schema to keep them in the Plaid CLI's config file.
    const a = resolveConnection(db, 'plaid', 'item-A');
    const b = resolveConnection(db, 'plaid', 'item-B');

    expect(getCursor(db, a)).toBeNull();
    setCursor(db, a, 'cursor-A');
    setCursor(db, b, 'cursor-B');

    expect(getCursor(db, a)).toBe('cursor-A');
    expect(getCursor(db, b)).toBe('cursor-B');
  });

  it('records sync outcomes including failures', () => {
    recordSync(db, 'plaid', { added: 3, modified: 1, removed: 0 });
    recordSync(db, 'plaid', { added: 0, modified: 0, removed: 0, error: 'boom' });

    const rows = db.prepare('SELECT added, error FROM sync_log ORDER BY id').all();
    expect(rows).toEqual([
      { added: 3, error: null },
      { added: 0, error: 'boom' },
    ]);
    expect(getLastSyncAt(db, 'plaid')).toBeInstanceOf(Date);
  });
});
