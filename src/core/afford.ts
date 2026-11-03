// Affordability scenarios from actual data.
//
// Most tools tell you what you spent. The question people actually have is
// "can I take this on" — a new mortgage, a car payment, childcare — and the
// only honest answer comes from what you really earn and really spend, not
// from a budget you wrote once.
//
// Everything here is deliberately conservative about its own limits. A
// baseline built from two months, or from a window containing a bonus, is
// worth much less than one built from a year, and the output says so rather
// than presenting a confident number.
//
// This is NOT underwriting. It models monthly cash flow only: no PMI, no
// maintenance reserve, no tax-bracket change, no closing costs.

import type Database from 'better-sqlite3';
import { resolveSpendingScope, coverageGaps } from './queries.js';

export interface BaselineOptions {
  /** Ignore transactions carrying any of these tags — one-offs, a move. */
  excludeTags?: string[];
  /** Only count whole calendar months; a partial month understates spending. */
  endDate?: string;
  /** Earliest month to include, YYYY-MM. Use to drop an abnormal month. */
  sinceMonth?: string;
}

export interface Baseline {
  months: string[];
  monthsCovered: number;
  monthlyIncomeCents: number;
  monthlySpendingCents: number;
  /** income − spending, per month. Negative means the shortfall is real. */
  monthlyNetCents: number;
  /** Charges that repeat — the part of spending that will not flex. */
  monthlyRecurringCents: number;
  /** Loan payments inside the baseline: what a move would REPLACE. */
  monthlyLoanPaymentCents: number;
  /** Income per month in the window — a spike here may already BE the bonus. */
  monthlyIncomes: number[];
  /** The mean, for comparison. The gap from the median measures the one-offs. */
  meanIncomeCents: number;
  meanSpendingCents: number;
  excludedCents: number;
  /** Per-month income spread — high variance makes the average misleading. */
  incomeRangeCents: { min: number; max: number };
  warnings: string[];
}

/** Whole calendar months only — a partial month drags the average down. */
function completeMonths(db: Database.Database, endDate?: string): string[] {
  const end = endDate ?? new Date().toISOString().slice(0, 10);
  const currentMonth = end.slice(0, 7);
  const rows = db.prepare(
    'SELECT DISTINCT substr(date,1,7) AS m FROM visible_transactions WHERE date <= ? ORDER BY m',
  ).all(end) as Array<{ m: string }>;

  const months = rows.map((r) => r.m).filter((m) => m !== currentMonth);
  // The earliest month is usually partial too — data starts mid-month.
  const earliest = (db.prepare('SELECT MIN(date) AS d FROM visible_transactions').get() as { d: string | null }).d;
  if (earliest && earliest.slice(8) !== '01' && months[0] === earliest.slice(0, 7)) months.shift();
  return months;
}

export function computeBaseline(db: Database.Database, options: BaselineOptions = {}): Baseline {
  let months = completeMonths(db, options.endDate);
  const warnings: string[] = [];

  if (options.sinceMonth) {
    const before = months.length;
    months = months.filter((m) => m >= options.sinceMonth!);
    if (months.length < before) {
      warnings.push(`baseline restricted to ${months.join(', ') || 'nothing'} — `
        + `${before - months.length} earlier month(s) excluded by choice, not by the data`);
    }
  }

  if (months.length === 0) {
    return {
      months: [], monthsCovered: 0,
      monthlyIncomeCents: 0, monthlySpendingCents: 0, monthlyNetCents: 0, monthlyIncomes: [],
      meanIncomeCents: 0, meanSpendingCents: 0,
      monthlyRecurringCents: 0, monthlyLoanPaymentCents: 0, excludedCents: 0,
      incomeRangeCents: { min: 0, max: 0 },
      warnings: ['no complete calendar months of data — a baseline needs at least one'],
    };
  }

  // Bounded by the months this baseline actually covers, so a ledger that
  // predates the cards being linked does not make every recent month look like
  // it has no card coverage.
  const { groups } = resolveSpendingScope(db, 'auto', 0.4, {
    startDate: `${months[0]}-01`,
    endDate: `${months[months.length - 1]}-31`,
  });
  const groupList = groups.map((g) => `'${g}'`).join(',');
  const monthList = months.map((m) => `'${m}'`).join(',');

  const tagFilter = options.excludeTags?.length
    ? `AND NOT EXISTS (SELECT 1 FROM tags g WHERE g.txn_id = t.txn_id AND g.tag IN (${
      options.excludeTags.map((x) => `'${x.replace(/'/g, "''")}'`).join(',')}))`
    : '';

  const perMonth = db.prepare(`
    SELECT substr(t.date,1,7) AS month,
           COALESCE(SUM(CASE WHEN t.spend_group='income' THEN t.amount_cents END),0) AS income,
           COALESCE(-SUM(CASE WHEN t.spend_group IN (${groupList}) THEN t.amount_cents END),0) AS spending,
           COALESCE(-SUM(CASE WHEN t.category='loan_payment' THEN t.amount_cents END),0) AS loans
      FROM visible_transactions t
     WHERE substr(t.date,1,7) IN (${monthList}) ${tagFilter}
     GROUP BY month
  `).all() as Array<{ month: string; income: number; spending: number; loans: number }>;

  const excluded = options.excludeTags?.length
    ? (db.prepare(`
      SELECT COALESCE(-SUM(t.amount_cents),0) AS cents FROM visible_transactions t
       WHERE substr(t.date,1,7) IN (${monthList})
         AND t.spend_group IN (${groupList})
         AND EXISTS (SELECT 1 FROM tags g WHERE g.txn_id = t.txn_id AND g.tag IN (${
        options.excludeTags.map((x) => `'${x.replace(/'/g, "''")}'`).join(',')}))
    `).get() as { cents: number }).cents
    : 0;

  const n = months.length;
  const sum = (pick: (r: typeof perMonth[number]) => number) => perMonth.reduce((s, r) => s + pick(r), 0);
  const incomes = perMonth.map((r) => r.income);

  // The MEDIAN month, not the mean.
  //
  // Household cash flow is skewed, not symmetric: a bonus or a big sale is
  // several times a normal month and there is no matching month several times
  // BELOW normal to cancel it. Averaging therefore describes a month that
  // never happened, and it errs upward — on one ledger the mean showed a small
  // surplus while the median month was clearly SHORT, because outlier
  // months lifted income more than they lifted spending. A tool answering
  // "what can I afford" must not be optimistic by construction.
  //
  // The mean is kept and reported beside it, because the gap between them is
  // itself the useful signal — it says how much of the picture is one-offs.
  const median = (xs: number[]): number => {
    if (xs.length === 0) return 0;
    const sorted = [...xs].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2
      ? sorted[mid]!
      : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
  };

  // Net is the median of each month's OWN net, NOT median(income) minus
  // median(spending). Those two medians come from different months, and
  // subtracting them silently assumes income and spending peak together in the
  // same month — which is exactly backwards on a real ledger, where a big
  // income month is also the month a card balance gets cleared. The difference
  // of medians can then overstate the monthly shortfall by most of its size
  // against the median month itself. That number sizes a loan, so the
  // error runs straight into a decision.
  const monthlyNet = median(perMonth.map((r) => r.income - r.spending));

  const monthlyIncome = median(perMonth.map((r) => r.income));
  const monthlySpending = median(perMonth.map((r) => r.spending));
  const monthlyLoans = median(perMonth.map((r) => r.loans));

  const meanIncome = Math.round(sum((r) => r.income) / n);
  const meanSpending = Math.round(sum((r) => r.spending) / n);

  // Recurring charges, normalised to a month by their own cadence.
  const recurring = db.prepare(`
    SELECT t.date, t.description, t.merchant_name AS merchantName, -t.amount_cents AS cents
      FROM visible_transactions t
     WHERE substr(t.date,1,7) IN (${monthList}) AND t.spend_group IN (${groupList}) AND t.amount_cents < 0
  `).all() as Array<{ date: string; description: string; merchantName: string | null; cents: number }>;
  const monthlyRecurring = estimateRecurringMonthly(recurring, n);

  // The distance between the typical month and the average one IS the
  // information: a large gap says most of the difference is one-off events,
  // and that an average is the wrong thing to plan against.
  if (n >= 3) {
    const gap = (meanIncome - meanSpending) - (monthlyNet);
    if (Math.abs(gap) >= 50_000) {
      const outliers = months.filter((_, i) => {
        const r = perMonth[i];
        return r && (r.income > monthlyIncome * 1.8 || r.spending > monthlySpending * 1.8);
      });
      warnings.push(
        `a typical month leaves ${monthlyNet >= 0 ? '' : 'MINUS '}`
        + `$${Math.abs((monthlyNet) / 100).toFixed(0)}, while the AVERAGE month `
        + `leaves ${meanIncome - meanSpending >= 0 ? '' : 'MINUS '}`
        + `$${Math.abs((meanIncome - meanSpending) / 100).toFixed(0)} — `
        + `${outliers.length} unusual month(s) (${outliers.slice(0, 4).join(', ')}) move the average. `
        + 'These figures use the typical month, which is the one that repeats',
      );
    }
  }

  if (n < 3) {
    warnings.push(`only ${n} complete month(s) of data — one unusual month moves this a lot`);
  }

  // The most dangerous shape this function can be handed: a long baseline
  // where some accounts only cover the recent end of it. Spending looks lower
  // per month than it is, so the money left over looks larger, so the payment
  // someone can "afford" comes out too high — the error runs in the direction
  // that costs the most to act on.
  const gaps = coverageGaps(db, `${months[0]}-01`, `${months[months.length - 1]}-28`);
  for (const g of gaps) {
    warnings.push(
      `${g.name}${g.mask ? ` \u2022\u2022${g.mask}` : ''} has no data before ${g.earliest}, `
      + `so ${Math.round(g.missingDays / 30)} month(s) of this baseline exclude it — `
      + 'spending is understated and affordability overstated by whatever it holds',
    );
  }
  const spread = Math.max(...incomes) - Math.min(...incomes);
  if (incomes.length > 1 && spread > monthlyIncome * 0.15) {
    warnings.push('income varies month to month — an average hides bonus timing');
  }
  if (options.excludeTags?.length && excluded > 0) {
    warnings.push(`${(excluded / 100).toFixed(2)} of tagged one-offs excluded from the baseline`);
  }
  if (!options.excludeTags?.length) {
    warnings.push('no one-offs excluded — tag unusual costs and re-run to see a truer baseline');
  }

  return {
    months,
    monthsCovered: n,
    monthlyIncomeCents: monthlyIncome,
    monthlySpendingCents: monthlySpending,
    monthlyNetCents: monthlyNet,
    monthlyRecurringCents: monthlyRecurring,
    monthlyLoanPaymentCents: monthlyLoans,
    monthlyIncomes: incomes,
    meanIncomeCents: meanIncome,
    meanSpendingCents: meanSpending,
    excludedCents: excluded,
    incomeRangeCents: { min: Math.min(...incomes), max: Math.max(...incomes) },
    warnings,
  };
}

/** Repeating charges normalised to a monthly figure by their own cadence. */
function estimateRecurringMonthly(
  rows: Array<{ date: string; description: string; merchantName: string | null; cents: number }>,
  months: number,
): number {
  const groups = new Map<string, number[]>();
  for (const r of rows) {
    const key = (r.merchantName?.trim() || r.description).toLowerCase()
      .replace(/\b(?=[a-z0-9]*\d)(?=[a-z0-9]*[a-z])[a-z0-9]{6,}\b/g, ' ')
      .replace(/\b\d{3,}\b/g, ' ').replace(/\s+/g, ' ').trim();
    if (!key) continue;
    const bucket = groups.get(key) ?? [];
    bucket.push(r.cents);
    groups.set(key, bucket);
  }
  let total = 0;
  for (const [, amounts] of groups) {
    // Present in most months, at a stable amount.
    if (amounts.length < Math.max(2, months)) continue;
    const sorted = [...amounts].sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)]!;
    if (med <= 0 || !amounts.every((a) => Math.abs(a - med) <= med * 0.25)) continue;
    total += med * (amounts.length / months);
  }
  return Math.round(total);
}

export interface Scenario {
  label: string;
  /** A new monthly obligation. */
  addCents?: number;
  /** Replace existing loan payments (a move swaps one mortgage for another). */
  replaceLoanCents?: number;
  /**
   * Income that arrives annually — a bonus, an equity vest, a tax refund —
   * spread across twelve months.
   *
   * Supplied rather than measured: a short window will not contain it, and
   * waiting a year to find out is not useful. Give the TAKE-HOME figure; bonus
   * is usually withheld at a supplemental rate, so gross overstates it badly.
   *
   * Treat with more suspicion than salary. It is not guaranteed, it arrives as
   * a lump rather than monthly, and a lender will typically want two years of
   * history and average it before counting any of it.
   */
  annualIncomeCents?: number;
}

export interface ScenarioResult {
  label: string;
  monthlyNetCents: number;
  changeCents: number;
  /** Net as a share of income — how much slack is left. */
  netAsPctOfIncome: number;
}

/**
 * Find a month whose income stands out enough to look like a lump.
 *
 * Exists to catch a double-count: if the bonus already landed inside the
 * baseline window it is ALREADY in measured income, and adding it again via
 * --lump-net counts the same money twice. That error is silent — the answer
 * simply improves — so it has to be detected rather than left to the reader.
 *
 * Each month is compared against the median of the OTHER months, not of all of
 * them. A plain median breaks on the commonest window there is: with two
 * months, the middle value IS the larger one, so a spike is measured against
 * itself and never fires.
 */
export function detectIncomeSpike(
  monthlyIncomes: number[],
  months: string[],
  threshold = 1.25,
): { month: string; excessCents: number } | null {
  if (monthlyIncomes.length < 2) return null;

  for (let i = 0; i < monthlyIncomes.length; i += 1) {
    const others = monthlyIncomes.filter((_, j) => j !== i).sort((a, b) => a - b);
    if (others.length === 0) continue;
    const mid = Math.floor(others.length / 2);
    const median = others.length % 2 === 0
      ? Math.round((others[mid - 1]! + others[mid]!) / 2)
      : others[mid]!;
    if (median > 0 && monthlyIncomes[i]! > median * threshold) {
      return { month: months[i] ?? '?', excessCents: monthlyIncomes[i]! - median };
    }
  }
  return null;
}

/** An annual lump as a monthly figure. Plain twelfths — no smoothing, no growth. */
export function monthlyFromAnnual(annualCents?: number): number {
  if (!annualCents || annualCents <= 0) return 0;
  return Math.round(annualCents / 12);
}

export function applyScenario(baseline: Baseline, scenario: Scenario): ScenarioResult {
  let spending = baseline.monthlySpendingCents;
  if (scenario.replaceLoanCents !== undefined) {
    spending = spending - baseline.monthlyLoanPaymentCents + scenario.replaceLoanCents;
  }
  if (scenario.addCents) spending += scenario.addCents;

  const income = baseline.monthlyIncomeCents + monthlyFromAnnual(scenario.annualIncomeCents);
  const net = income - spending;
  return {
    label: scenario.label,
    monthlyNetCents: net,
    changeCents: net - baseline.monthlyNetCents,
    netAsPctOfIncome: baseline.monthlyIncomeCents > 0
      ? Math.round((net / baseline.monthlyIncomeCents) * 100)
      : 0,
  };
}

/**
 * The largest new monthly payment that still leaves `bufferCents` spare.
 *
 * Returns a negative number when the baseline already fails to clear the
 * buffer — saying "you can afford $0" would imply breaking even, which is not
 * the same as being short.
 */
export function maxAffordable(
  baseline: Baseline,
  bufferCents: number,
  replacesLoan = false,
  annualIncomeCents?: number,
): number {
  const freed = replacesLoan ? baseline.monthlyLoanPaymentCents : 0;
  return baseline.monthlyNetCents + freed + monthlyFromAnnual(annualIncomeCents) - bufferCents;
}

/**
 * Monthly principal + interest for a loan. Standard amortisation.
 *
 * Converts an affordable PAYMENT into an affordable PRICE, which is the
 * question behind the question. Taxes and insurance are separate and must be
 * supplied — they are a large share of a housing payment and vary by area.
 */
export function monthlyPayment(principalCents: number, annualRatePct: number, years: number): number {
  if (principalCents <= 0 || years <= 0) return 0;
  const n = years * 12;
  const r = annualRatePct / 100 / 12;
  if (r === 0) return Math.round(principalCents / n);
  return Math.round((principalCents * r) / (1 - Math.pow(1 + r, -n)));
}

/** Loan principal supportable by a monthly payment — the inverse of the above. */
export function principalFromPayment(paymentCents: number, annualRatePct: number, years: number): number {
  if (paymentCents <= 0 || years <= 0) return 0;
  const n = years * 12;
  const r = annualRatePct / 100 / 12;
  if (r === 0) return Math.round(paymentCents * n);
  return Math.round((paymentCents * (1 - Math.pow(1 + r, -n))) / r);
}
