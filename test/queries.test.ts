// Read paths. Two things carry real risk here: the spending total staying free
// of internal money movement, and sql_query not being a write primitive.

import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openLedger, setCategoryOverride, appendBalance } from '../src/core/ledger.js';
import { seedAccount, seedTxn, type Seeded } from './helpers.js';
import {
  listAccounts, latestBalances, queryTransactions, getSpendingSummary, runReadOnlyQuery, ledgerIsEmpty, noDataReason,
  resolveSpendingScope, SQL_SCHEMA_GUIDE, SQL_SCHEMA_RELATIONS,
} from '../src/core/queries.js';

let db: Database.Database;
let acct: Record<'checking' | 'card', Seeded>;

/**
 * Write a transaction and return the id the ledger derived.
 *
 * `into` names the account rather than carrying an id, because identity is
 * content-derived — a test cannot choose one, and neither can a real caller.
 */
const txn = (
  over: Parameters<typeof seedTxn>[2] & { into?: 'checking' | 'card' } = {},
): string => {
  const { into = 'checking', ...rest } = over;
  return seedTxn(db, acct[into], {
    date: '2026-07-15', amountCents: -1_000, description: 'THING', category: 'shopping', ...rest,
  });
};

beforeEach(() => {
  db = openLedger(':memory:');
  acct = {
    checking: seedAccount(db, 'checking', { name: 'Checking', mask: '1111', type: 'depository' }),
    card: seedAccount(db, 'card', { name: 'Card', mask: '2222', type: 'credit' }),
  };
});

describe('ledgerIsEmpty', () => {
  // Guards the most dangerous ambiguity in the project: an empty ledger and a
  // genuinely quiet month both report zero, and an agent shown a bare 0 will
  // state "you spent nothing" as fact.
  it('is true before anything has been synced', () => {
    const fresh = openLedger(':memory:');
    expect(ledgerIsEmpty(fresh)).toBe(true);
  });

  it('is false once an account exists, even with no transactions', () => {
    // An account with no rows IS a real "you spent nothing" — the accounts are
    // there, the month was quiet. Only a total absence of accounts is unknown.
    expect(ledgerIsEmpty(db)).toBe(false);
    expect(db.prepare('SELECT COUNT(*) c FROM transactions').get()).toEqual({ c: 0 });
  });
});

describe('listAccounts', () => {
  it('reports counts and the date range held', () => {
    txn({ date: '2026-07-01' });
    txn({ date: '2026-07-31' });

    const accounts = listAccounts(db);
    const checking = accounts.find((a) => a.accountId === acct.checking.accountId)!;
    expect(checking.transactionCount).toBe(2);
    expect(checking.earliestDate).toBe('2026-07-01');
    expect(checking.latestDate).toBe('2026-07-31');
  });

  it('includes accounts with no transactions', () => {
    expect(listAccounts(db)).toHaveLength(2);
    expect(listAccounts(db).every((a) => a.transactionCount === 0)).toBe(true);
  });
});

describe('queryTransactions', () => {
  let a: string;
  let b: string;
  let c: string;

  beforeEach(() => {
    a = txn({ date: '2026-07-01', category: 'groceries', amountCents: -5_000, description: 'GROCERY MART' });
    b = txn({ date: '2026-07-15', category: 'dining', amountCents: -2_000, description: 'CAFE' });
    c = txn({ date: '2026-08-01', category: 'shopping', amountCents: -9_000, into: 'card', description: 'AMAZON' });
  });

  it('filters by date range inclusively', () => {
    const rows = queryTransactions(db, { startDate: '2026-07-01', endDate: '2026-07-15' });
    expect(rows.map((r) => r.txnId).sort()).toEqual([a, b].sort());
  });

  it('filters by account, category and search', () => {
    expect(queryTransactions(db, { accountIds: [acct.card.accountId] }).map((r) => r.txnId)).toEqual([c]);
    expect(queryTransactions(db, { categories: ['groceries'] }).map((r) => r.txnId)).toEqual([a]);
    expect(queryTransactions(db, { search: 'grocery' }).map((r) => r.txnId)).toEqual([a]);
  });

  it('filters on the EFFECTIVE category, so an override is what matches', () => {
    setCategoryOverride(db, c, 'groceries');
    const rows = queryTransactions(db, { categories: ['groceries'] });
    expect(rows.map((r) => r.txnId).sort()).toEqual([a, c].sort());
    expect(queryTransactions(db, { categories: ['shopping'] })).toHaveLength(0);
  });

  it('does not let a filter value inject SQL', () => {
    const rows = queryTransactions(db, { search: "'; DROP TABLE transactions; --" });
    expect(rows).toEqual([]);
    // Still there — the value was bound, not interpolated.
    expect(db.prepare('SELECT COUNT(*) c FROM transactions').get()).toEqual({ c: 3 });
  });

  it('respects limit and offset, newest first', () => {
    const page = queryTransactions(db, { limit: 2 });
    expect(page.map((r) => r.txnId)).toEqual([c, b]);
    expect(queryTransactions(db, { limit: 2, offset: 2 }).map((r) => r.txnId)).toEqual([a]);
  });
});

describe('getSpendingSummary', () => {
  beforeEach(() => {
    txn({ category: 'groceries', amountCents: -8_432, description: 'GROCERY MART' });
    txn({ category: 'utilities', amountCents: -8_900, description: 'XFINITY' });
    txn({ category: 'credit_card_payment', amountCents: -210_000, description: 'CARD PMT' });
    txn({ category: 'income', amountCents: 500_000, description: 'PAYROLL' });
    txn({ category: 'transfer', amountCents: -20_000, description: 'ZELLE' });
  });

  // 'never' pins the rule these tests are about: what happens when the card IS
  // linked. The default 'auto' folds payments in when it is not — covered
  // separately below.
  const summary = () => getSpendingSummary(db, '2026-07-01', '2026-07-31', undefined, 'never');

  it('counts purchases and bills only', () => {
    // 84.32 groceries + 89.00 utilities = 173.32. NOT 2,373.32.
    expect(summary().spendingCents).toBe(17_332);
    expect(summary().transactionCount).toBe(2);
  });

  it('reports payments and transfers separately from spending', () => {
    const s = summary();
    expect(s.excluded.paymentsCents).toBe(210_000);
    expect(s.excluded.transfersCents).toBe(20_000);
    // The whole point: they are reported, never summed into the headline.
    expect(s.spendingCents).not.toBe(s.spendingCents + s.excluded.paymentsCents);
  });

  it('reports a payment seen from both sides as the amount paid, not zero', () => {
    // −$2,100 out of checking and +$2,100 into the card net to zero, which
    // printed "credit-card payments $0.00" beside $2,700 of payments.
    txn({ into: 'card', category: 'credit_card_payment', amountCents: 210_000, description: 'PAYMENT THANK YOU' });
    txn({ into: 'card', category: 'transfer', amountCents: 20_000, description: 'ZELLE IN' });
    const s = summary();
    expect(s.excluded.paymentsCents).toBe(210_000);
    expect(s.excluded.transfersCents).toBe(20_000);
  });

  it('reports income separately', () => {
    expect(summary().incomeCents).toBe(500_000);
  });

  it('never renders a negative zero', () => {
    const empty = getSpendingSummary(db, '2020-01-01', '2020-01-31');
    expect(Object.is(empty.spendingCents, -0)).toBe(false);
    expect(Object.is(empty.excluded.paymentsCents, -0)).toBe(false);
    expect(Object.is(empty.excluded.transfersCents, -0)).toBe(false);
  });

  it('groups by the EFFECTIVE category, not the pre-override one', () => {
    // SQLite resolves a bare `GROUP BY category` to the TABLE column, so rows
    // grouped by the provider value get displayed with an overridden label —
    // producing duplicate rows and a category that appears to vanish.
    txn({ category: 'shopping', amountCents: -1_000, description: 'ONE' });
    const two = txn({ category: 'shopping', amountCents: -2_000, description: 'TWO' });
    setCategoryOverride(db, two, 'groceries');

    const categories = summary().byCategory;
    const names = categories.map((c) => c.category);
    expect(new Set(names).size).toBe(names.length);       // no duplicate labels
    expect(categories.find((c) => c.category === 'shopping')?.amountCents).toBe(1_000);
    expect(categories.find((c) => c.category === 'groceries')?.amountCents).toBe(2_000 + 8_432);
  });

  it('breaks down by category, largest first', () => {
    const categories = summary().byCategory;
    expect(categories[0]).toMatchObject({ category: 'utilities', amountCents: 8_900 });
    expect(categories[1]).toMatchObject({ category: 'groceries', amountCents: 8_432 });
  });

  it('moves a transaction between groups when its category is overridden', () => {
    // Reclassifying a "purchase" as a card payment must remove it from spending.
    const x = txn({ category: 'shopping', amountCents: -5_000, description: 'EXTRA' });
    expect(summary().spendingCents).toBe(22_332);

    setCategoryOverride(db, x, 'credit_card_payment');
    expect(summary().spendingCents).toBe(17_332);
  });

  it('scopes to the given accounts', () => {
    txn({ into: 'card', category: 'shopping', amountCents: -3_000 });
    expect(getSpendingSummary(db, '2026-07-01', '2026-07-31', [acct.card.accountId], 'never').spendingCents).toBe(3_000);
  });
});

describe('card payments when no card is linked', () => {
  // A payment is excluded because the card's PURCHASES are counted on the card.
  // With no card linked those purchases were never recorded, so excluding the
  // payment too makes the money vanish: a real checking-only ledger reported
  // about a third of the true total.
  beforeEach(() => {
    txn({ category: 'groceries', amountCents: -10_000 });
    txn({ category: 'credit_card_payment', amountCents: -200_000 });
  });

  it('counts the payment when the card is absent', () => {
    const s = getSpendingSummary(db, '2026-07-01', '2026-07-31');
    expect(s.cardPaymentsCounted).toBe(true);
    expect(s.spendingCents).toBe(210_000);
    // Never reported in both places — anyone adding them would double-count.
    expect(s.excluded.paymentsCents).toBe(0);
  });

  it('stops counting it once the card carries its own spending', () => {
    const cc = seedAccount(db, 'cc', { name: 'Visa', mask: '9999', type: 'credit' });
    seedTxn(db, cc, {
      date: '2026-07-15', category: 'shopping', amountCents: -190_000, description: 'CARD SPEND',
    });

    const s = getSpendingSummary(db, '2026-07-01', '2026-07-31');
    expect(s.cardPaymentsCounted).toBe(false);
    expect(s.excluded.paymentsCents).toBe(200_000);
  });

  it('honours an explicit policy over the automatic choice', () => {
    expect(getSpendingSummary(db, '2026-07-01', '2026-07-31', undefined, 'never').cardPaymentsCounted).toBe(false);
    expect(getSpendingSummary(db, '2026-07-01', '2026-07-31', undefined, 'always').cardPaymentsCounted).toBe(true);
  });

  it('does not fold payments in when there are none', () => {
    const fresh = openLedger(':memory:');
    seedAccount(fresh, 'a', { name: 'A', mask: '1111', type: 'depository' });
    expect(resolveSpendingScope(fresh).cardPaymentsCounted).toBe(false);
  });
});

describe('latestBalances', () => {
  it('returns only the most recent observation per account', () => {
    appendBalance(db, { sourceId: acct.checking.sourceId, accountId: acct.checking.accountId, asOf: '2026-07-01T00:00:00Z', currentCents: 100, availableCents: 100, limitCents: null });
    appendBalance(db, { sourceId: acct.checking.sourceId, accountId: acct.checking.accountId, asOf: '2026-08-01T00:00:00Z', currentCents: 500, availableCents: 500, limitCents: null });

    const balances = latestBalances(db);
    expect(balances).toHaveLength(1);
    expect(balances[0]).toMatchObject({ currentCents: 500 });
  });
});

describe('runReadOnlyQuery', () => {
  beforeEach(() => { txn(); });

  it('runs a SELECT and returns columns plus rows', () => {
    const result = runReadOnlyQuery(db, 'SELECT txn_id, amount_cents FROM transactions');
    expect(result.columns).toEqual(['txn_id', 'amount_cents']);
    expect(result.rows).toEqual([[expect.any(String), -1_000]]);
  });

  it('allows a CTE', () => {
    const result = runReadOnlyQuery(db, 'WITH x AS (SELECT 1 AS n) SELECT n FROM x');
    expect(result.rows).toEqual([[1]]);
  });

  it.each([
    'DELETE FROM transactions',
    'UPDATE transactions SET amount_cents = 0',
    'DROP TABLE transactions',
    'INSERT INTO transactions (txn_id) VALUES ("x")',
    'PRAGMA user_version = 99',
    'ATTACH DATABASE \'/tmp/evil.db\' AS evil',
  ])('rejects %s', (sql) => {
    expect(() => runReadOnlyQuery(db, sql)).toThrow();
  });

  it('rejects a write smuggled after a semicolon', () => {
    expect(() => runReadOnlyQuery(db, 'SELECT 1; DELETE FROM transactions')).toThrow(/multiple statements/);
    expect(db.prepare('SELECT COUNT(*) c FROM transactions').get()).toEqual({ c: 1 });
  });

  it('tolerates a single trailing semicolon', () => {
    expect(() => runReadOnlyQuery(db, 'SELECT 1;')).not.toThrow();
  });

  it('truncates past the limit and says so', () => {
    for (let i = 0; i < 10; i++) txn({ txnId: `t${i}` });
    const result = runReadOnlyQuery(db, 'SELECT txn_id FROM transactions', 5);
    expect(result.rows).toHaveLength(5);
    expect(result.truncated).toBe(true);
  });
});

describe('latestBalances across connections', () => {
  // The same failure the transaction path was rewritten to remove, which had
  // survived in the balance path: two connections onto one real account both
  // report a balance, and a net-worth total doubles.
  const relinked = () => {
    const old = seedAccount(db, 'chk-old', { name: 'CHECKING', mask: '1111', itemId: 'item-old' });
    const fresh = seedAccount(db, 'chk-new', { name: 'CHECKING', mask: '1111', itemId: 'item-new' });
    expect(fresh.accountId).toBe(old.accountId); // one real account, two ways in
    return { old, fresh };
  };

  it('returns ONE row per account when two connections report it', () => {
    const { old, fresh } = relinked();
    // A single sync stamps one as_of across every connection, so "the newest
    // row for this account" is genuinely two rows.
    const asOf = '2026-08-13T12:00:00.000Z';
    for (const s of [old, fresh]) {
      appendBalance(db, {
        sourceId: s.sourceId, accountId: s.accountId, asOf, currentCents: 250_000,
      });
    }

    const rows = latestBalances(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.currentCents).toBe(250_000); // not 500_000
  });

  it('prefers the newer connection when both are current', () => {
    const { old, fresh } = relinked();
    const asOf = '2026-08-13T12:00:00.000Z';
    appendBalance(db, { sourceId: old.sourceId, accountId: old.accountId, asOf, currentCents: 100 });
    appendBalance(db, { sourceId: fresh.sourceId, accountId: fresh.accountId, asOf, currentCents: 999 });

    expect(latestBalances(db)[0]!.currentCents).toBe(999);
  });

  it('still prefers the genuinely newer observation over connection priority', () => {
    // Priority only breaks ties. A stale reading from the newer connection
    // must not outrank a fresh one from the older.
    const { old, fresh } = relinked();
    appendBalance(db, {
      sourceId: fresh.sourceId, accountId: fresh.accountId,
      asOf: '2026-08-01T00:00:00.000Z', currentCents: 100,
    });
    appendBalance(db, {
      sourceId: old.sourceId, accountId: old.accountId,
      asOf: '2026-08-13T00:00:00.000Z', currentCents: 777,
    });

    expect(latestBalances(db)[0]!.currentCents).toBe(777);
  });
});

describe('card-payment coverage is judged over the window, not the ledger', () => {
  it('does not let old uncovered history make a covered window look uncovered', () => {
    // The real failure. A ledger reaching back before the cards were linked has
    // an all-time ratio dominated by the period when they were not — low
    // across all time, high over the last ninety days. Judging the
    // recent window by the old number counts the card purchases AND the
    // payments that settle them, and the same money lands twice.
    const card = seedAccount(db, 'card', { name: 'CARD', type: 'credit' });
    const checking = seedAccount(db, 'chk', { name: 'CHECKING', type: 'depository' });

    // Old: payments only, no card detail — the card was not linked yet.
    for (const m of ['01', '02', '03']) {
      seedTxn(db, checking, {
        date: `2025-${m}-15`, amountCents: -500_000,
        description: 'CARD PAYMENT', category: 'credit_card_payment',
      });
    }
    // Recent: the card reports its own purchases, and each payment has both sides.
    for (const d of ['05', '15', '25']) {
      seedTxn(db, card, {
        date: `2026-06-${d}`, amountCents: -100_000,
        description: 'SHOP', category: 'shopping',
      });
    }
    seedTxn(db, checking, {
      date: '2026-06-28', amountCents: -300_000,
      description: 'CARD PAYMENT', category: 'credit_card_payment',
    });
    seedTxn(db, card, {
      date: '2026-06-28', amountCents: 300_000,
      description: 'PAYMENT THANK YOU', category: 'credit_card_payment',
    });

    // All time looks uncovered, and for the old months it genuinely is.
    expect(resolveSpendingScope(db, 'auto').cardPaymentsCounted).toBe(true);

    // June is fully covered, so the payments must NOT be counted again.
    const june = resolveSpendingScope(db, 'auto', 0.4, {
      startDate: '2026-06-01', endDate: '2026-06-30',
    });
    expect(june.cardPaymentsCounted).toBe(false);
    expect(june.groups).toEqual(['purchases', 'bills']);

    // And the summary must agree: $3,000 of purchases, not $6,000.
    const summary = getSpendingSummary(db, '2026-06-01', '2026-06-30');
    expect(summary.spendingCents).toBe(300_000);
    expect(summary.cardPaymentsCounted).toBe(false);
  });

  it('still counts payments for a window the cards do not cover', () => {
    const checking = seedAccount(db, 'chk', { name: 'CHECKING', type: 'depository' });
    seedTxn(db, checking, {
      date: '2025-02-15', amountCents: -500_000,
      description: 'CARD PAYMENT', category: 'credit_card_payment',
    });

    const scope = resolveSpendingScope(db, 'auto', 0.4, {
      startDate: '2025-02-01', endDate: '2025-02-28',
    });
    expect(scope.cardPaymentsCounted).toBe(true);
  });
});

describe('SQL_SCHEMA_GUIDE', () => {
  // This text is all an agent knows about the schema before writing SQL. It
  // once named a column that no longer existed and pointed at the base table,
  // which double-counts — so it is checked against the real schema.
  it('names only relations that exist, and lists every one it names', () => {
    const existing = new Set((db.prepare(
      "SELECT name FROM sqlite_master WHERE type IN ('table','view')",
    ).all() as { name: string }[]).map((r) => r.name));
    for (const rel of SQL_SCHEMA_RELATIONS) expect(existing, rel).toContain(rel);

    const named = new Set(SQL_SCHEMA_GUIDE.match(/\b[a-z]+(?:_[a-z]+)*\b/g));
    for (const rel of existing) {
      if (rel === 'sqlite_sequence') continue;
      expect(SQL_SCHEMA_RELATIONS as readonly string[], `${rel} missing from the guide`).toContain(rel);
      expect(named.has(rel), `${rel} not mentioned in the guide`).toBe(true);
    }
  });

  it('steers to a query that counts once and applies corrections', () => {
    // The same real account reached through a second connection (a re-link),
    // both delivering the same purchase.
    const relinked = seedAccount(db, 'checking', {
      name: 'Checking', mask: '1111', type: 'depository', itemId: 'item-relink',
    });
    const id = txn({ description: 'BIG TV', amountCents: -90_000 });
    seedTxn(db, relinked, {
      date: '2026-07-15', amountCents: -90_000, description: 'BIG TV', category: 'shopping',
    });
    setCategoryOverride(db, id, 'housing');

    const base = runReadOnlyQuery(db, 'SELECT COUNT(*) FROM transactions');
    expect(base.rows[0]![0]).toBe(2);

    const viaGuide = runReadOnlyQuery(db,
      "SELECT COUNT(*), SUM(amount_cents), MAX(category) FROM visible_transactions "
      + "WHERE spend_group IN ('purchases','bills')");
    expect(viaGuide.rows[0]).toEqual([1, -90_000, 'housing']);
    expect(SQL_SCHEMA_GUIDE).toMatch(/visible_transactions, never transactions/);
    expect(SQL_SCHEMA_GUIDE).not.toMatch(/COALESCE/);
  });
});

describe('noDataReason', () => {
  // Every printed total asks this first. The CLI once printed "Total: $0.00"
  // for a ledger nothing had been imported into.
  it('says why there is nothing, and what to do next', () => {
    const empty = openLedger(':memory:');
    expect(noDataReason(empty)).toMatch(/NO DATA.*NOT the same as having spent nothing.*finance doctor/);
    expect(noDataReason(empty, ['csv'])).toMatch(/Configured provider\(s\): csv — run `finance sync`/);
  });

  it('stays out of the way once an account exists, even with no rows', () => {
    // An account with nothing in the window is a real zero (decision 10).
    expect(noDataReason(db)).toBeNull();
  });
});
