// Insight extraction. These are the numbers a person would act on, so the
// tests focus on the ways an analysis lies convincingly: comparing against a
// window the data doesn't cover, calling a frequent shop a subscription, or
// reporting one merchant five times because its description carries a
// reference number.

import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import {
  median, priorPeriodOf, merchantKey, collectInsights,
  recurringCharges, unusualTransactions, newMerchants, categoryTrends,
  incomeCadence, calendarAnchors,
} from '../src/core/insights.js';
import {
  openLedger, 
} from '../src/core/ledger.js';
import { seedAccount, seedTxn, type Seeded } from './helpers.js';

let db: Database.Database;
let acct: Seeded;

const txn = (over: Parameters<typeof seedTxn>[2] = {}): string => seedTxn(db, acct, over);

beforeEach(() => {
  db = openLedger(':memory:');
  acct = seedAccount(db, 'a1');
});

describe('median', () => {
  it('handles odd, even and empty', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(3);   // rounded midpoint
    expect(median([])).toBe(0);
  });
});

describe('priorPeriodOf', () => {
  it('returns an equal-length window immediately before', () => {
    // Unequal windows would report a "drop" that is only the shorter span.
    expect(priorPeriodOf({ start: '2026-06-01', end: '2026-06-30' }))
      .toEqual({ start: '2026-05-02', end: '2026-05-31' });
  });

  it('handles a single day', () => {
    expect(priorPeriodOf({ start: '2026-06-15', end: '2026-06-15' }))
      .toEqual({ start: '2026-06-14', end: '2026-06-14' });
  });
});

describe('merchantKey', () => {
  it('strips reference numbers so repeats of one merchant collapse', () => {
    const a = merchantKey('ZELLE TO LAWN SERVICE ON 08/04 REF # BANKREF00001');
    const b = merchantKey('ZELLE TO LAWN SERVICE ON 07/27 REF # BANKREF00002');
    expect(a).toBe(b);
  });

  it('prefers the merchant name when present', () => {
    expect(merchantKey('IC* INSTACART 8005', 'Instacart')).toBe('instacart');
  });

  it('keeps genuinely different merchants apart', () => {
    expect(merchantKey('GROCERY MART #412')).not.toBe(merchantKey('TARGET 00001234'));
  });
});

describe('prior-period guard', () => {
  it('refuses to compare when the ledger does not reach back', () => {
    // The real failure: Plaid reaches ~90 days, so a 90-day report's prior
    // window is empty and the comparison read "+325629%".
    txn(({ date: '2026-06-15', amountCents: -50_000 }));
    const brief = collectInsights(db, '2026-06-01', '2026-06-30');

    expect(brief.priorPeriodComparable).toBe(false);
    expect(brief.spendingChangePct).toBeNull();
    expect(brief.trends).toEqual([]);   // suppressed, not silently misleading
  });

  it('compares when the prior window is genuinely covered', () => {
    // Prior window for June is 2026-05-02 → 2026-05-31, so the ledger must
    // reach at least that far back for the comparison to be honest.
    txn(({ date: '2026-05-02', amountCents: -2_000 }));
    txn(({ date: '2026-05-10', amountCents: -8_000 }));
    txn(({ date: '2026-06-15', amountCents: -20_000 }));
    // Covered to its end, too: a ledger stopping mid-window is not comparable.
    txn(({ date: '2026-06-30', amountCents: 300_000, category: 'income' }));

    const brief = collectInsights(db, '2026-06-01', '2026-06-30');
    expect(brief.priorPeriodComparable).toBe(true);
    expect(brief.spendingChangePct).toBe(100);   // 10k → 20k
    expect(brief.trends.length).toBeGreaterThan(0);
  });
});

describe('recurringCharges', () => {
  const monthly = (id: string, day: string, cents: number, desc = 'NETFLIX.COM') =>
    txn(({ txnId: id, date: day, amountCents: -cents, description: desc, category: 'entertainment' }));

  it('finds a monthly subscription and its cadence', () => {
    monthly('a', '2026-05-01', 1_599); monthly('b', '2026-06-01', 1_599); monthly('c', '2026-07-01', 1_599);
    const [found] = recurringCharges(db, { start: '2026-01-01', end: '2026-12-31' });
    expect(found).toMatchObject({ occurrences: 3, medianCents: 1_599 });
    expect(found!.cadenceDays).toBeGreaterThanOrEqual(30);
  });

  it('ignores two occurrences — that is coincidence, not a pattern', () => {
    monthly('a', '2026-05-01', 1_599); monthly('b', '2026-06-01', 1_599);
    expect(recurringCharges(db, { start: '2026-01-01', end: '2026-12-31' })).toEqual([]);
  });

  it('does not call a frequently-visited shop a subscription', () => {
    // Same merchant, wildly different amounts — a shop, not a recurring charge.
    monthly('a', '2026-05-01', 500, 'GROCERY MART'); monthly('b', '2026-05-08', 9_000, 'GROCERY MART');
    monthly('c', '2026-05-15', 42_000, 'GROCERY MART');
    expect(recurringCharges(db, { start: '2026-01-01', end: '2026-12-31' })).toEqual([]);
  });

  it('groups a merchant whose description carries a reference number', () => {
    txn(({ date: '2026-05-01', amountCents: -8_000, description: 'ZELLE TO LAWN SERVICE ON 05/01 REF # BANKREF111' }));
    txn(({ date: '2026-06-01', amountCents: -8_000, description: 'ZELLE TO LAWN SERVICE ON 06/01 REF # BANKREF222' }));
    txn(({ date: '2026-07-01', amountCents: -8_000, description: 'ZELLE TO LAWN SERVICE ON 07/01 REF # BANKREF333' }));
    expect(recurringCharges(db, { start: '2026-01-01', end: '2026-12-31' })).toHaveLength(1);
  });
});

describe('unusualTransactions', () => {
  it('compares against the category median, not a global one', () => {
    // $200 is unremarkable for housing and extraordinary for coffee.
    for (let i = 0; i < 6; i++) {
      txn(({ txnId: `c${i}`, amountCents: -500, category: 'dining' }));
      txn(({ txnId: `h${i}`, amountCents: -200_000, category: 'housing' }));
    }
    txn(({ amountCents: -20_000, category: 'dining' }));

    const unusual = unusualTransactions(db, { start: '2026-01-01', end: '2026-12-31' });

    expect(unusual.some((u) => u.category === 'dining' && u.amountCents === 20_000)).toBe(true);
    // The routine housing charges are large but entirely typical for housing.
    expect(unusual.some((u) => u.amountCents === 200_000)).toBe(false);
  });

  it('applies a floor so cheap categories do not fill the list', () => {
    for (let i = 0; i < 6; i++) txn(({ txnId: `s${i}`, amountCents: -100, category: 'dining' }));
    txn(({ amountCents: -5_000, category: 'dining' }));  // 50x but only $50
    expect(unusualTransactions(db, { start: '2026-01-01', end: '2026-12-31' })).toEqual([]);
  });
});

describe('newMerchants', () => {
  it('reports only merchants never seen before the period', () => {
    txn(({ date: '2026-01-05', description: 'GROCERY MART' }));
    txn(({ date: '2026-06-05', description: 'GROCERY MART' }));
    txn(({ date: '2026-06-06', description: 'NEW PLACE' }));

    const found = newMerchants(db, { start: '2026-06-01', end: '2026-06-30' });
    expect(found.map((m) => m.merchant)).toEqual(['NEW PLACE']);
  });

  it('collapses one merchant with varying reference numbers into a single row', () => {
    // Grouping on the raw description listed the same payee once per payment.
    txn(({ date: '2026-04-01', description: 'OLDER HISTORY' }));
    for (const [i, ref] of ['AAA1', 'BBB2', 'CCC3'].entries()) {
      txn(({
        txnId: `z${i}`, date: `2026-06-0${i + 1}`, amountCents: -350_000,
        description: `ZELLE TO LANDLORD REF # ${ref}0000000`,
      }));
    }
    const found = newMerchants(db, { start: '2026-06-01', end: '2026-06-30' });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ count: 3, totalCents: 1_050_000 });
  });

  it('says nothing when the ledger starts inside the period', () => {
    // The first report anyone runs: with no history, every merchant is "new"
    // and the section is just the ledger again.
    txn(({ date: '2026-06-05', description: 'GROCERY MART' }));
    txn(({ date: '2026-06-06', description: 'NEW PLACE' }));
    expect(newMerchants(db, { start: '2026-06-01', end: '2026-06-30' })).toEqual([]);
    // History reaching back over the prior window turns it on.
    txn(({ date: '2026-05-01', description: 'GROCERY MART' }));
    expect(newMerchants(db, { start: '2026-06-01', end: '2026-06-30' }).map((m) => m.merchant)).toEqual(['NEW PLACE']);
  });
});

describe('categoryTrends', () => {
  it('reports null percent for a category with no prior spend', () => {
    txn(({ date: '2026-06-15', category: 'dining', amountCents: -5_000 }));
    const [trend] = categoryTrends(db,
      { start: '2026-06-01', end: '2026-06-30' }, { start: '2026-05-01', end: '2026-05-31' });
    // "New" is the truth; a percentage against zero is not.
    expect(trend!.changePct).toBeNull();
  });
});

describe('incomeCadence', () => {
  const pay = (date: string) => txn({ date, amountCents: 350_000, category: 'income', description: `PAYROLL ${date}` });

  it('counts pay on the 1st and 15th on the calendar', () => {
    // A quarter of semi-monthly pay holds exactly six paydays. Dividing 92
    // days by a ~15-day median gap said 6.6, and flagged the quarter as short
    // by half a paycheque.
    for (const m of ['04', '05', '06', '07', '08', '09']) { pay(`2026-${m}-01`); pay(`2026-${m}-15`); }
    const c = incomeCadence(db, '2026-07-01', '2026-09-30')!;
    expect(c.daysOfMonth).toEqual([1, 15]);
    expect(c.observed).toBe(6);
    expect(c.expected).toBe(6);
  });

  it('still catches a window that really is a payday short', () => {
    for (const m of ['04', '05', '06', '07', '08', '09']) {
      pay(`2026-${m}-01`);
      if (m !== '08') pay(`2026-${m}-15`);   // the 15th of August never arrived
    }
    const c = incomeCadence(db, '2026-07-01', '2026-09-30')!;
    expect(c.daysOfMonth).toEqual([1, 15]);
    expect(c).toMatchObject({ observed: 5, expected: 6 });
    // And a partial month counts only the paydays it contains.
    expect(incomeCadence(db, '2026-07-02', '2026-08-14')!.expected).toBe(2);
  });

  it('keeps averaging for pay every two weeks, which drifts through the month', () => {
    let d = Date.UTC(2026, 3, 3);
    for (let i = 0; i < 14; i++, d += 14 * 86_400_000) pay(new Date(d).toISOString().slice(0, 10));
    const c = incomeCadence(db, '2026-07-01', '2026-07-30')!;
    expect(c.daysOfMonth).toBeUndefined();
    expect(c.medianGapDays).toBe(14);
    expect(c.expected).toBeCloseTo(2.1, 1);
  });
});

describe('calendarAnchors', () => {
  it('treats a weekend-shifted payday as the same day', () => {
    // The 15th falling on a Saturday pays on Friday the 14th.
    expect(calendarAnchors(['2026-01-15', '2026-02-13', '2026-03-13', '2026-04-15', '2026-05-15', '2026-06-15']))
      .toEqual([15]);
  });

  it('reads the 28th to the 31st as the last day of the month', () => {
    expect(calendarAnchors(['2026-01-30', '2026-02-27', '2026-03-31', '2026-04-30', '2026-05-29', '2026-06-30']))
      .toEqual([31]);
  });

  it('needs enough history to call a schedule', () => {
    expect(calendarAnchors(['2026-01-01', '2026-01-15', '2026-02-01', '2026-02-15'])).toBeNull();
  });
});
