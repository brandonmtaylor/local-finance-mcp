// Affordability scenarios. The risk here is a confident number built on thin
// data, so most of these tests are about the tool knowing what it does not
// know — and about never reporting a shortfall as if it were break-even.

import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import {
  computeBaseline, applyScenario, maxAffordable, monthlyFromAnnual,
  monthlyPayment, principalFromPayment, detectIncomeSpike,
} from '../src/core/afford.js';
import {
  openLedger, addTag,
  
} from '../src/core/ledger.js';
import { seedAccount, seedTxn, type Seeded } from './helpers.js';

let db: Database.Database;
let acct: Seeded;

const txn = (over: Parameters<typeof seedTxn>[2] = {}): string => seedTxn(db, acct, over);

/** Two complete months, so the earliest-partial-month trim does not apply. */
function twoMonths(incomeCents: number, spendCents: number) {
  for (const m of ['06', '07']) {
    txn(({
      txnId: `inc-${m}`, date: `2026-${m}-01`, amountCents: incomeCents, category: 'income',
    }));
    txn(({
      txnId: `spend-${m}`, date: `2026-${m}-15`, amountCents: -spendCents, category: 'groceries',
    }));
  }
}

beforeEach(() => {
  db = openLedger(':memory:');
  acct = seedAccount(db, 'a1');
});

describe('computeBaseline', () => {
  it('averages complete months only', () => {
    twoMonths(1_000_000, 600_000);
    // August is the current month and incomplete — including it would drag the
    // average down and overstate what is affordable.
    txn(({ date: '2026-08-02', amountCents: -5_000 }));

    const b = computeBaseline(db, { endDate: '2026-08-12' });
    expect(b.months).toEqual(['2026-06', '2026-07']);
    expect(b.monthlyIncomeCents).toBe(1_000_000);
    expect(b.monthlySpendingCents).toBe(600_000);
    expect(b.monthlyNetCents).toBe(400_000);
  });

  it('warns when the baseline rests on too few months', () => {
    twoMonths(1_000_000, 600_000);
    expect(computeBaseline(db, { endDate: '2026-08-12' }).warnings.join(' '))
      .toMatch(/only 2 complete month/);
  });

  it('warns when income swings, because an average then hides bonus timing', () => {
    txn(({ date: '2026-06-01', amountCents: 1_000_000, category: 'income' }));
    txn(({ date: '2026-07-01', amountCents: 3_000_000, category: 'income' }));
    expect(computeBaseline(db, { endDate: '2026-08-12' }).warnings.join(' '))
      .toMatch(/income varies/);
  });

  it('excludes tagged one-offs and says how much was removed', () => {
    twoMonths(1_000_000, 600_000);
    const oneoff = txn({ date: '2026-06-04', amountCents: -120_000, category: 'housing' });
    addTag(db, oneoff, 'move');

    const withIt = computeBaseline(db, { endDate: '2026-08-12' });
    const without = computeBaseline(db, { endDate: '2026-08-12', excludeTags: ['move'] });

    expect(withIt.monthlySpendingCents).toBe(660_000);   // the $1,200 spread over 2 months
    expect(without.monthlySpendingCents).toBe(600_000);
    // With a currency sign: the bare "1200.00" read as a count, not an amount.
    expect(without.warnings.join(' ')).toMatch(/\$1200\.00 of tagged one-offs excluded/);
  });

  it('nudges you to tag one-offs when none are excluded', () => {
    twoMonths(1_000_000, 600_000);
    expect(computeBaseline(db, { endDate: '2026-08-12' }).warnings.join(' '))
      .toMatch(/no one-offs excluded/);
  });

  it('reports loan payments separately, since a move replaces them', () => {
    twoMonths(1_000_000, 600_000);
    for (const m of ['06', '07']) {
      txn(({
        txnId: `loan-${m}`, date: `2026-${m}-03`, amountCents: -420_000, category: 'loan_payment',
      }));
    }
    expect(computeBaseline(db, { endDate: '2026-08-12' }).monthlyLoanPaymentCents).toBe(420_000);
  });

  it('says so rather than guessing when there is no complete month', () => {
    txn(({ date: '2026-08-05' }));
    const b = computeBaseline(db, { endDate: '2026-08-12' });
    expect(b.monthsCovered).toBe(0);
    expect(b.warnings[0]).toMatch(/no complete calendar months/);
  });
});

describe('detectIncomeSpike', () => {
  it('fires on a two-month window — the case a plain median cannot see', () => {
    // With two months the middle value IS the larger one, so comparing a spike
    // against the median of ALL months measures it against itself and never
    // fires. Each month is therefore compared against the median of the others.
    twoMonths(500_000, 300_000);
    txn(({
      date: '2026-07-20', amountCents: 400_000, category: 'income',
    }));

    const b = computeBaseline(db, { endDate: '2026-08-12' });
    expect(b.monthlyIncomes).toEqual([500_000, 900_000]);

    const spike = detectIncomeSpike(b.monthlyIncomes, b.months);
    expect(spike).not.toBeNull();
    expect(spike!.month).toBe('2026-07');
    expect(spike!.excessCents).toBe(400_000);
  });

  it('stays quiet when income is merely uneven', () => {
    expect(detectIncomeSpike([500_000, 540_000, 520_000], ['a', 'b', 'c'])).toBeNull();
  });

  it('finds the spike among several normal months', () => {
    const spike = detectIncomeSpike(
      [500_000, 500_000, 950_000, 510_000], ['a', 'b', 'c', 'd'],
    );
    expect(spike!.month).toBe('c');
  });

  it('cannot judge a single month, so says nothing', () => {
    expect(detectIncomeSpike([900_000], ['a'])).toBeNull();
    expect(detectIncomeSpike([], [])).toBeNull();
  });

  it('is not fooled by a zero-income month into calling everything a spike', () => {
    expect(detectIncomeSpike([0, 0], ['a', 'b'])).toBeNull();
  });
});

describe('applyScenario', () => {
  const baseline = {
    months: ['2026-06', '2026-07'], monthsCovered: 2,
    monthlyIncomeCents: 1_000_000, monthlySpendingCents: 600_000, monthlyNetCents: 400_000,
    monthlyRecurringCents: 100_000, monthlyLoanPaymentCents: 200_000, excludedCents: 0,
    incomeRangeCents: { min: 1_000_000, max: 1_000_000 }, warnings: [],
  };

  it('subtracts a new obligation', () => {
    const r = applyScenario(baseline, { label: 'car', addCents: 50_000 });
    expect(r.monthlyNetCents).toBe(350_000);
    expect(r.changeCents).toBe(-50_000);
  });

  it('swaps the old loan out when replacing it', () => {
    // A move does not stack two mortgages — the old payment goes away.
    const r = applyScenario(baseline, { label: 'move', replaceLoanCents: 500_000 });
    expect(r.monthlyNetCents).toBe(100_000);   // 400k + 200k freed − 500k new
  });

  it('handles replacing and adding together', () => {
    const r = applyScenario(baseline, { label: 'both', replaceLoanCents: 500_000, addCents: 50_000 });
    expect(r.monthlyNetCents).toBe(50_000);
  });
});

describe('annual income', () => {
  const baseline = {
    months: ['2026-06', '2026-07'], monthsCovered: 2,
    monthlyIncomeCents: 1_000_000, monthlySpendingCents: 1_100_000, monthlyNetCents: -100_000,
    monthlyRecurringCents: 0, monthlyLoanPaymentCents: 400_000, excludedCents: 0,
    incomeRangeCents: { min: 1_000_000, max: 1_000_000 }, warnings: [],
  };

  it('spreads a lump across twelve months', () => {
    expect(monthlyFromAnnual(1_200_000)).toBe(100_000);
    expect(monthlyFromAnnual(0)).toBe(0);
    expect(monthlyFromAnnual(undefined)).toBe(0);
    expect(monthlyFromAnnual(-500)).toBe(0);   // never a negative "boost"
  });

  it('lifts a scenario by the monthly share', () => {
    // A bonus does not arrive monthly, but it does arrive — leaving it out
    // understates as badly as the budget it replaced overstated.
    const without = applyScenario(baseline, { label: 'x', addCents: 50_000 });
    const with_ = applyScenario(baseline, { label: 'x', addCents: 50_000, annualIncomeCents: 1_200_000 });
    expect(with_.monthlyNetCents - without.monthlyNetCents).toBe(100_000);
  });

  it('raises the maximum payment too', () => {
    expect(maxAffordable(baseline, 0, true)).toBe(300_000);
    expect(maxAffordable(baseline, 0, true, 1_200_000)).toBe(400_000);
  });
});

describe('maxAffordable', () => {
  const short = {
    months: ['2026-06'], monthsCovered: 1,
    monthlyIncomeCents: 1_000_000, monthlySpendingCents: 1_100_000, monthlyNetCents: -100_000,
    monthlyRecurringCents: 0, monthlyLoanPaymentCents: 300_000, excludedCents: 0,
    incomeRangeCents: { min: 1_000_000, max: 1_000_000 }, warnings: [],
  };

  it('returns a NEGATIVE number when the baseline is already short', () => {
    // Reporting "$0 affordable" would imply breaking even, which is not the
    // same as being short every month.
    expect(maxAffordable(short, 0)).toBe(-100_000);
  });

  it('adds back the freed loan payment when the new one replaces it', () => {
    expect(maxAffordable(short, 0, true)).toBe(200_000);
  });

  it('subtracts the requested buffer', () => {
    expect(maxAffordable(short, 50_000, true)).toBe(150_000);
  });
});

describe('loan maths', () => {
  it('computes a standard amortised payment', () => {
    // $400,000 at 6.5% over 30 years ≈ $2,528/mo.
    const payment = monthlyPayment(40_000_000, 6.5, 30);
    expect(payment).toBeGreaterThan(252_000);
    expect(payment).toBeLessThan(254_000);
  });

  it('inverts cleanly — payment back to principal', () => {
    const principal = 40_000_000;
    const payment = monthlyPayment(principal, 6.5, 30);
    expect(Math.abs(principalFromPayment(payment, 6.5, 30) - principal)).toBeLessThan(50_000);
  });

  it('handles a zero rate without dividing by zero', () => {
    expect(monthlyPayment(36_000_000, 0, 30)).toBe(100_000);
  });

  it('returns zero for nonsense input rather than NaN', () => {
    expect(monthlyPayment(0, 6.5, 30)).toBe(0);
    expect(principalFromPayment(-5, 6.5, 30)).toBe(0);
    expect(monthlyPayment(1_000, 6.5, 0)).toBe(0);
  });
});

describe('a typical month, not an average one', () => {
  it('uses the median so one big month cannot lift the answer', () => {
    // Household cash flow is skewed: a bonus is several times a normal month
    // and nothing is several times below normal to cancel it. Averaging
    // therefore describes a month that never happened, and errs UPWARD — which
    // is the wrong direction for a tool answering "what can I afford".
    for (const m of ['01', '02', '03', '04', '05']) {
      seedTxn(db, acct, {
        txnId: undefined, date: `2026-${m}-01`, amountCents: 500_000, category: 'income',
        description: `PAY ${m}`,
      });
      seedTxn(db, acct, {
        date: `2026-${m}-15`, amountCents: -450_000, category: 'groceries',
        description: `SPEND ${m}`,
      });
    }
    // One month with a large bonus and no matching spending.
    seedTxn(db, acct, {
      date: '2026-06-01', amountCents: 5_000_000, category: 'income', description: 'BONUS',
    });
    seedTxn(db, acct, {
      date: '2026-06-15', amountCents: -450_000, category: 'groceries', description: 'SPEND 06',
    });

    const b = computeBaseline(db, { endDate: '2026-08-12' });

    // Typical month: $5,000 in, $4,500 out.
    expect(b.monthlyIncomeCents).toBe(500_000);
    expect(b.monthlyNetCents).toBe(50_000);

    // The mean would have said far more, and is kept for comparison.
    expect(b.meanIncomeCents).toBeGreaterThan(b.monthlyIncomeCents);
  });

  it('says how far the average is from the typical, and names the months', () => {
    for (const m of ['01', '02', '03', '04']) {
      seedTxn(db, acct, { date: `2026-${m}-01`, amountCents: 500_000, category: 'income', description: `P${m}` });
      seedTxn(db, acct, { date: `2026-${m}-15`, amountCents: -400_000, category: 'groceries', description: `S${m}` });
    }
    seedTxn(db, acct, { date: '2026-05-01', amountCents: 5_000_000, category: 'income', description: 'BONUS' });
    seedTxn(db, acct, { date: '2026-05-15', amountCents: -400_000, category: 'groceries', description: 'S05' });

    const warnings = computeBaseline(db, { endDate: '2026-08-12' }).warnings.join(' ');
    expect(warnings).toMatch(/typical month leaves/);
    expect(warnings).toMatch(/AVERAGE month leaves/);
    expect(warnings).toContain('2026-05');
  });

  it('stays quiet when every month is much like the others', () => {
    // No gap between typical and average means nothing to explain, and a
    // caveat on every run is a caveat nobody reads.
    for (const m of ['01', '02', '03', '04', '05']) {
      seedTxn(db, acct, { date: `2026-${m}-01`, amountCents: 500_000, category: 'income', description: `P${m}` });
      seedTxn(db, acct, { date: `2026-${m}-15`, amountCents: -400_000, category: 'groceries', description: `S${m}` });
    }
    const warnings = computeBaseline(db, { endDate: '2026-08-12' }).warnings.join(' ');
    expect(warnings).not.toMatch(/AVERAGE month leaves/);
  });
});

describe('the typical month is a real month', () => {
  // The net must be the median of each month's OWN net, not median(income)
  // minus median(spending). Those two medians are drawn from different months,
  // and subtracting them assumes income and spending peak together — the
  // opposite of what a real ledger does, where the big income month is also
  // when a card balance gets cleared.

  it('pairs income against the spending of the SAME month', () => {
    // Income peaks in March, spending peaks in May, and they never coincide.
    //   month:  01     02     03     04     05
    //   income: 10000  10000  40000  10000  10000   -> median 10000
    //   spend:   9000   9000   9000   9000  39000   -> median  9000
    //   net:    +1000  +1000 +31000  +1000 -29000   -> median +1000
    // Difference-of-medians happens to agree here, so the divergence is
    // asserted through a case where it cannot.
    const rows: Array<[string, number, number]> = [
      ['01', 1_000_000, 900_000],
      ['02', 1_000_000, 900_000],
      ['03', 4_000_000, 900_000],
      ['04', 1_000_000, 900_000],
      ['05', 1_000_000, 3_900_000],
    ];
    for (const [m, inc, spend] of rows) {
      seedTxn(db, acct, { date: `2026-${m}-01`, amountCents: inc, category: 'income', description: `P${m}` });
      seedTxn(db, acct, { date: `2026-${m}-15`, amountCents: -spend, category: 'groceries', description: `S${m}` });
    }

    const baseline = computeBaseline(db, { endDate: '2026-08-12' });
    expect(baseline.monthlyNetCents).toBe(100_000);
  });

  it('diverges from the difference of medians when the peaks sit apart', () => {
    // Built so the two answers cannot agree:
    //   month:   01     02     03
    //   income: 1000   2000   3000    -> median 2000
    //   spend:  5000   1000   2000    -> median 2000
    //   net:   -4000  +1000  +1000    -> median +1000
    //
    // Difference of medians says the typical month breaks even. It does not:
    // two of the three months clear +1000, and the one bad month is bad because
    // spending spiked in the month income was LOWEST — which is precisely the
    // pairing that subtracting two medians throws away.
    const rows: Array<[string, number, number]> = [
      ['01', 100_000, 500_000],
      ['02', 200_000, 100_000],
      ['03', 300_000, 200_000],
    ];
    for (const [m, inc, spend] of rows) {
      seedTxn(db, acct, { date: `2026-${m}-01`, amountCents: inc, category: 'income', description: `P${m}` });
      seedTxn(db, acct, { date: `2026-${m}-15`, amountCents: -spend, category: 'groceries', description: `S${m}` });
    }

    const baseline = computeBaseline(db, { endDate: '2026-08-12' });
    expect(baseline.monthlyIncomeCents).toBe(200_000);
    expect(baseline.monthlySpendingCents).toBe(200_000);
    // The bug this pins: 200_000 - 200_000 = 0, and 0 is the wrong answer.
    expect(baseline.monthlyNetCents).toBe(100_000);
    expect(baseline.monthlyNetCents).not.toBe(
      baseline.monthlyIncomeCents - baseline.monthlySpendingCents,
    );
  });
});

