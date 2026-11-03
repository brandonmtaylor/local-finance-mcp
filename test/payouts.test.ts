// Money arriving in a spending category beyond what that category spent.
//
// Found in a real report: insurance claim payouts into checking matched the
// insurance pattern, were filed as `insurance` bills, and — being money IN to
// a spending group — took a 90-day spending total below zero. A refund may
// reduce its category; it may not take spending negative. Every consumer of a
// spending total has to agree on that, so each is checked here.
//
// Amounts are invented.

import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openLedger, setCategoryOverride } from '../src/core/ledger.js';
import { floorByCategory, getSpendingSummary } from '../src/core/queries.js';
import { collectInsights } from '../src/core/insights.js';
import { computeBaseline } from '../src/core/afford.js';
import { cumulativeSeries, monthlySeries } from '../src/core/report.js';
import { detectPayoutsInSpending } from '../src/core/diagnostics.js';
import { inferCategory } from '../src/core/normalize.js';
import { seedAccount, seedTxn, type Seeded } from './helpers.js';

let db: Database.Database;
let chk: Seeded;
const txn = (date: string, amountCents: number, category: Parameters<typeof seedTxn>[2]['category'], description: string) =>
  seedTxn(db, chk, { date, amountCents, category, description });

beforeEach(() => {
  db = openLedger(':memory:');
  chk = seedAccount(db, 'chk', { name: 'Checking', mask: '1111', type: 'depository' });
  txn('2026-06-02', -15_000, 'insurance', 'INSURER BILLING');        // the premium
  txn('2026-06-10', -40_000, 'groceries', 'GROCERY MART');
  txn('2026-06-12', -2_500, 'shopping', 'STORE');
  txn('2026-06-20', 1_000, 'shopping', 'STORE REFUND');               // an ordinary refund
  txn('2026-06-22', 2_000_000, 'insurance', 'INSURER PAYMENT CLAIM'); // a $20,000 payout
});

const WINDOW = ['2026-06-01', '2026-06-30'] as const;

describe('floorByCategory', () => {
  it('lets a refund reduce its category, never below zero', () => {
    expect(floorByCategory([
      { category: 'shopping', netCents: -2_500 }, { category: 'shopping', netCents: 1_000 },
      { category: 'insurance', netCents: -15_000 }, { category: 'insurance', netCents: 2_000_000 },
    ])).toEqual({ spendingCents: 1_500, beyondCents: 1_985_000 });
  });
});

describe('a payout filed as a spending category', () => {
  it('does not take the summary negative, and is reported rather than lost', () => {
    const s = getSpendingSummary(db, ...WINDOW);
    expect(s.spendingCents).toBe(40_000 + 1_500);       // groceries + shopping net of its refund
    expect(s.excluded.refundsBeyondSpendingCents).toBe(1_985_000);
    expect(s.byCategory.map((c) => c.category).sort()).toEqual(['groceries', 'shopping']);
    expect(s.byCategory.every((c) => c.amountCents > 0)).toBe(true);
    expect(s.incomeCents).toBe(0);                        // not income either
  });

  it('gives insights the same total as the summary', () => {
    const brief = collectInsights(db, ...WINDOW);
    expect(brief.spendingCents).toBe(getSpendingSummary(db, ...WINDOW).spendingCents);
    expect(brief.netCents).toBe(-41_500);
  });

  it('keeps the report charts on the headline and above the axis', () => {
    const headline = getSpendingSummary(db, ...WINDOW).spendingCents;
    const line = cumulativeSeries(db, ...WINDOW);
    expect(line.every((p) => p.spendingCents >= 0)).toBe(true);
    expect(line[line.length - 1]!.spendingCents).toBe(headline);
    expect(monthlySeries(db, ...WINDOW)[0]!.spendingCents).toBe(headline);
  });

  it('does not give afford a month that spent less than nothing', () => {
    txn('2026-05-05', -50_000, 'groceries', 'GROCERY MART');
    txn('2026-07-05', -50_000, 'groceries', 'GROCERY MART');
    const b = computeBaseline(db, { endDate: '2026-08-15' });
    // The median would hide a single absurd month; the mean cannot. June is
    // $415 floored, not −$19,435.
    // (May is partial — the ledger starts on the 5th — so it is left out.)
    expect(b.months).toEqual(['2026-06', '2026-07']);
    expect(b.meanSpendingCents).toBe(Math.round((41_500 + 50_000) / 2));
  });
});

describe('detectPayoutsInSpending', () => {
  it('names the payout and how to file it', () => {
    const [found] = detectPayoutsInSpending(db);
    expect(found!.code).toBe('payouts-in-spending');
    expect(found!.detail).toHaveLength(1);
    expect(found!.detail![0]).toMatch(/\$20,000\.00\s+insurance\s+INSURER PAYMENT CLAIM/);
    expect(found!.remedy).toMatch(/finance categorize --match "INSURER PAYMENT CLAIM" --category transfer --dry-run/);
  });

  it('leaves a refund that recent spending accounts for alone', () => {
    txn('2026-06-25', -90_000, 'shopping', 'BIG TV');
    txn('2026-06-28', 90_000, 'shopping', 'BIG TV RETURN');
    expect(detectPayoutsInSpending(db)[0]!.detail).toHaveLength(1);
  });

  it('stays quiet once the row is corrected', () => {
    const id = db.prepare("SELECT txn_id FROM visible_transactions WHERE description = 'INSURER PAYMENT CLAIM'").get() as { txn_id: string };
    setCategoryOverride(db, id.txn_id, 'transfer');
    expect(detectPayoutsInSpending(db)).toEqual([]);
    expect(getSpendingSummary(db, ...WINDOW).excluded.refundsBeyondSpendingCents).toBe(0);
  });
});

describe('tax refunds', () => {
  it('are income, not negative tax', () => {
    expect(inferCategory('IRS TREAS 310 TAX REF 000000', 150_000)).toBe('income');
    expect(inferCategory('STATE TAX REFUND', 40_000)).toBe('income');
    expect(inferCategory('IRS USATAXPYMT', -150_000)).toBe('taxes');
  });
});
