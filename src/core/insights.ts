// Deterministic insight extraction.
//
// Everything here is arithmetic — no model, no key, no tokens, and it runs in
// cron. "What's unusual", "what's recurring", "what changed" are all computable
// from the ledger, and computing them means the answer is the same every time
// you ask.
//
// The AI layer sits ABOVE this, not instead of it: the brief below is small
// enough to hand to a model for interpretation ("these two subscriptions
// overlap", "groceries look high for two people") without sending the ledger.
// That is cheaper, more accurate, and exposes far less than raw transactions.

import type Database from 'better-sqlite3';

import { resolveSpendingScope } from './queries.js';

const EFFECTIVE = 't.category';

/**
 * The spend groups that count, for THIS ledger.
 *
 * Must match getSpendingSummary exactly — if insights and the summary disagree
 * about whether card payments count, the report contradicts itself.
 */
function spendingClause(db: Database.Database, window?: { start: string; end: string }): string {
  // The window matters: coverage is judged over the period being asked about,
  // not over the whole ledger. See resolveSpendingScope.
  const { groups } = resolveSpendingScope(db, 'auto', 0.4,
    window ? { startDate: window.start, endDate: window.end } : undefined);
  return `t.spend_group IN (${groups.map((g) => `'${g}'`).join(',')})`;
}

export interface Period { start: string; end: string }

export interface LargeTransaction {
  date: string; description: string; amountCents: number; category: string; account: string;
}

export interface CategoryTrend {
  category: string;
  currentCents: number;
  priorCents: number;
  changeCents: number;
  /** null when there is no prior spend to compare against. */
  changePct: number | null;
}

export interface RecurringCharge {
  merchant: string;
  occurrences: number;
  medianCents: number;
  totalCents: number;
  /** Median days between charges — ~30 monthly, ~7 weekly. */
  cadenceDays: number;
  lastDate: string;
}

export interface UnusualTransaction extends LargeTransaction {
  categoryMedianCents: number;
  /** How many times the category's typical transaction this one is. */
  multiple: number;
}

export interface MerchantTotal { merchant: string; totalCents: number; count: number }

export interface InsightsBrief {
  period: Period;
  priorPeriod: Period;
  /**
   * False when the ledger does not cover the prior window, so every
   * comparison against it is meaningless — a nearly-empty prior period
   * produces "+325629%" and labels every category "new". Callers must
   * suppress trend output when this is false rather than print the number.
   */
  priorPeriodComparable: boolean;
  spendingCents: number;
  priorSpendingCents: number;
  spendingChangePct: number | null;
  incomeCents: number;
  netCents: number;
  largest: LargeTransaction[];
  trends: CategoryTrend[];
  recurring: RecurringCharge[];
  unusual: UnusualTransaction[];
  newMerchants: MerchantTotal[];
  /** Share of total spending held by the top categories. */
  concentration: Array<{ category: string; cents: number; pctOfTotal: number }>;
}

// ── helpers ──────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

/**
 * The equal-length window immediately before `period`.
 *
 * Equal length matters — comparing a 90-day window against a calendar month
 * would report a "drop" that is only the shorter window.
 */
export function priorPeriodOf(period: Period): Period {
  const start = Date.parse(`${period.start}T00:00:00Z`);
  const end = Date.parse(`${period.end}T00:00:00Z`);
  const span = Math.max(DAY_MS, end - start + DAY_MS);
  const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return { start: ymd(start - span), end: ymd(start - DAY_MS) };
}

/** Collapse a description to something stable enough to group repeat charges. */
export function merchantKey(description: string, merchantName?: string | null): string {
  const base = (merchantName?.trim() || description).toLowerCase();
  const stripped = base
    // A reference token MIXES letters and digits ("bankref00001"). Matching any
    // long alphanumeric run instead would delete the merchant itself —
    // "instacart" is nine letters.
    .replace(/\b(?=[a-z0-9]*\d)(?=[a-z0-9]*[a-z])[a-z0-9]{6,}\b/g, ' ')
    .replace(/\bon \d{1,2}\/\d{1,2}\b/g, ' ')            // "ON 08/04"
    .replace(/\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/g, ' ')   // bare dates
    .replace(/\b\d{3,}\b/g, ' ')                          // store / reference numbers
    .replace(/\b(ref|id|inv|txn|trace)\b/g, ' ')
    .replace(/[*#]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Never return empty: a merchant made entirely of stripped tokens would then
  // group with every other such merchant.
  return stripped || base.replace(/\s+/g, ' ').trim();
}

// ── extraction ───────────────────────────────────────────────────────────────

function spendingTotal(db: Database.Database, period: Period): number {
  const row = db.prepare(
    `SELECT -COALESCE(SUM(t.amount_cents),0) AS cents FROM visible_transactions t
      WHERE t.date >= @start AND t.date <= @end AND ${spendingClause(db, period)}`,
  ).get(period) as { cents: number };
  return row.cents || 0;
}

export function largestTransactions(
  db: Database.Database, period: Period, limit = 8,
): LargeTransaction[] {
  return db.prepare(`
    SELECT t.date, t.description, -t.amount_cents AS amountCents,
           ${EFFECTIVE} AS category, a.name AS account
      FROM visible_transactions t JOIN accounts a USING(account_id)
     WHERE t.date >= @start AND t.date <= @end AND ${spendingClause(db, period)}
     ORDER BY t.amount_cents ASC LIMIT ${limit}
  `).all(period) as LargeTransaction[];
}

export function categoryTrends(
  db: Database.Database, period: Period, prior: Period,
): CategoryTrend[] {
  const rows = db.prepare(`
    SELECT ${EFFECTIVE} AS category,
           -COALESCE(SUM(CASE WHEN t.date >= @start AND t.date <= @end THEN t.amount_cents END),0) AS currentCents,
           -COALESCE(SUM(CASE WHEN t.date >= @priorStart AND t.date <= @priorEnd THEN t.amount_cents END),0) AS priorCents
      FROM visible_transactions t
     WHERE ${spendingClause(db, period)} AND t.date >= @priorStart AND t.date <= @end
     GROUP BY ${EFFECTIVE}
  `).all({
    start: period.start, end: period.end,
    priorStart: prior.start, priorEnd: prior.end,
  }) as Array<{ category: string; currentCents: number; priorCents: number }>;

  return rows
    .map((r) => ({
      category: r.category,
      currentCents: r.currentCents || 0,
      priorCents: r.priorCents || 0,
      changeCents: (r.currentCents || 0) - (r.priorCents || 0),
      // No prior spend means "new", not "infinity percent" — the caller decides
      // how to word that, so report null rather than a misleading number.
      changePct: r.priorCents > 0
        ? Math.round((((r.currentCents || 0) - r.priorCents) / r.priorCents) * 100)
        : null,
    }))
    .filter((r) => r.currentCents > 0 || r.priorCents > 0)
    .sort((a, b) => Math.abs(b.changeCents) - Math.abs(a.changeCents));
}

/**
 * Charges that repeat: same merchant, similar amount, regular cadence.
 *
 * Requires 3+ occurrences — two could be coincidence. Amounts must cluster
 * (each within 25% of the median) so a merchant you happen to visit often, at
 * varying prices, is not reported as a subscription.
 */
export function recurringCharges(
  db: Database.Database, period: Period, minOccurrences = 3,
): RecurringCharge[] {
  const rows = db.prepare(`
    SELECT t.date, t.description, t.merchant_name AS merchantName, -t.amount_cents AS amountCents
      FROM visible_transactions t
     WHERE t.date >= @start AND t.date <= @end AND ${spendingClause(db, period)} AND t.amount_cents < 0
  `).all(period) as Array<{ date: string; description: string; merchantName: string | null; amountCents: number }>;

  const groups = new Map<string, Array<{ date: string; amountCents: number; label: string }>>();
  for (const r of rows) {
    const key = merchantKey(r.description, r.merchantName);
    if (!key) continue;
    const list = groups.get(key) ?? [];
    list.push({ date: r.date, amountCents: r.amountCents, label: r.merchantName?.trim() || r.description });
    groups.set(key, list);
  }

  const out: RecurringCharge[] = [];
  for (const [, entries] of groups) {
    if (entries.length < minOccurrences) continue;
    const amounts = entries.map((e) => e.amountCents);
    const med = median(amounts);
    if (med <= 0) continue;
    // Amounts must cluster, or a frequently-visited shop looks like a subscription.
    if (!amounts.every((a) => Math.abs(a - med) <= med * 0.25)) continue;

    const dates = entries.map((e) => Date.parse(`${e.date}T00:00:00Z`)).sort((a, b) => a - b);
    const gaps = dates.slice(1).map((d, i) => Math.round((d - dates[i]!) / DAY_MS));
    out.push({
      merchant: entries[0]!.label,
      occurrences: entries.length,
      medianCents: med,
      totalCents: amounts.reduce((s, a) => s + a, 0),
      cadenceDays: median(gaps),
      lastDate: new Date(dates[dates.length - 1]!).toISOString().slice(0, 10),
    });
  }
  return out.sort((a, b) => b.totalCents - a.totalCents);
}

/**
 * Transactions far above what is typical for their own category.
 *
 * Compared against the category's median rather than a global one — $200 is
 * unremarkable for housing and extraordinary for coffee. The floor stops the
 * list filling with trivia from cheap categories.
 */
export function unusualTransactions(
  db: Database.Database, period: Period, multipleThreshold = 4, floorCents = 15_000,
): UnusualTransaction[] {
  const rows = db.prepare(`
    SELECT t.date, t.description, -t.amount_cents AS amountCents,
           ${EFFECTIVE} AS category, a.name AS account
      FROM visible_transactions t JOIN accounts a USING(account_id)
     WHERE t.date >= @start AND t.date <= @end AND ${spendingClause(db, period)} AND t.amount_cents < 0
  `).all(period) as LargeTransaction[];

  const byCategory = new Map<string, number[]>();
  for (const r of rows) {
    const list = byCategory.get(r.category) ?? [];
    list.push(r.amountCents);
    byCategory.set(r.category, list);
  }

  const medians = new Map([...byCategory].map(([k, v]) => [k, median(v)]));

  return rows
    .filter((r) => r.amountCents >= floorCents)
    .map((r) => {
      const med = medians.get(r.category) ?? 0;
      return { ...r, categoryMedianCents: med, multiple: med > 0 ? r.amountCents / med : 0 };
    })
    .filter((r) => r.multiple >= multipleThreshold)
    .sort((a, b) => b.amountCents - a.amountCents)
    .slice(0, 8);
}

/** Merchants seen in this period and never before — new commitments show up here. */
export function newMerchants(
  db: Database.Database, period: Period, limit = 8,
): MerchantTotal[] {
  // "New" means "not seen before", which needs a before. When the ledger
  // starts inside the period — the first report anyone runs — every merchant
  // qualifies, and the list is the whole ledger under a heading that says
  // something is unusual. Require history covering the prior window, the same
  // bar the trend comparison uses.
  const earliest = (db.prepare('SELECT MIN(date) AS d FROM visible_transactions')
    .get() as { d: string | null }).d;
  if (earliest === null || earliest > priorPeriodOf(period).start) return [];

  // Grouped in JS on the normalized key, not in SQL on the raw description:
  // descriptions embed reference numbers, so the same merchant would otherwise
  // appear once per transaction ("ZELLE TO … REF #BANKREF1", "… REF #BANKREF2").
  const seenBefore = new Set(
    (db.prepare(`
      SELECT DISTINCT t.description, t.merchant_name AS merchantName
        FROM visible_transactions t WHERE t.date < @start
    `).all({ start: period.start }) as Array<{ description: string; merchantName: string | null }>)
      .map((r) => merchantKey(r.description, r.merchantName)),
  );

  const rows = db.prepare(`
    SELECT t.description, t.merchant_name AS merchantName, -t.amount_cents AS amountCents
      FROM visible_transactions t
     WHERE t.date >= @start AND t.date <= @end AND ${spendingClause(db, period)} AND t.amount_cents < 0
  `).all(period) as Array<{ description: string; merchantName: string | null; amountCents: number }>;

  const totals = new Map<string, MerchantTotal>();
  for (const r of rows) {
    const key = merchantKey(r.description, r.merchantName);
    if (!key || seenBefore.has(key)) continue;
    const entry = totals.get(key) ?? {
      merchant: r.merchantName?.trim() || r.description, totalCents: 0, count: 0,
    };
    entry.totalCents += r.amountCents;
    entry.count += 1;
    totals.set(key, entry);
  }
  return [...totals.values()].sort((a, b) => b.totalCents - a.totalCents).slice(0, limit);
}

export function collectInsights(
  db: Database.Database,
  start: string,
  end: string,
): InsightsBrief {
  const period = { start, end };
  const prior = priorPeriodOf(period);

  const spendingCents = spendingTotal(db, period);
  const priorSpendingCents = spendingTotal(db, prior);

  // The ledger has to actually cover the prior window. Plaid reaches back ~90
  // days, so a 90-day report's prior period is usually empty — and comparing
  // against near-zero yields absurd percentages and labels everything "new".
  const earliest = (db.prepare(
    'SELECT MIN(date) AS d FROM visible_transactions',
  ).get() as { d: string | null }).d;
  const priorPeriodComparable = earliest !== null
    && earliest <= prior.start
    && priorSpendingCents > 0;
  const income = db.prepare(
    `SELECT COALESCE(SUM(t.amount_cents),0) AS cents FROM visible_transactions t
      WHERE t.date >= @start AND t.date <= @end AND t.spend_group='income'`,
  ).get(period) as { cents: number };

  const trends = categoryTrends(db, period, prior);
  const concentration = trends
    .filter((t) => t.currentCents > 0)
    .sort((a, b) => b.currentCents - a.currentCents)
    .slice(0, 5)
    .map((t) => ({
      category: t.category,
      cents: t.currentCents,
      pctOfTotal: spendingCents > 0 ? Math.round((t.currentCents / spendingCents) * 100) : 0,
    }));

  return {
    period,
    priorPeriod: prior,
    priorPeriodComparable,
    spendingCents,
    priorSpendingCents,
    spendingChangePct: priorPeriodComparable
      ? Math.round(((spendingCents - priorSpendingCents) / priorSpendingCents) * 100)
      : null,
    incomeCents: income.cents || 0,
    netCents: (income.cents || 0) - spendingCents,
    largest: largestTransactions(db, period),
    trends: priorPeriodComparable ? trends : [],
    recurring: recurringCharges(db, period),
    unusual: unusualTransactions(db, period),
    newMerchants: newMerchants(db, period),
    concentration,
  };
}

export interface IncomeCadence {
  /** Median days between income deposits, when a regular pattern exists. */
  medianGapDays: number;
  /** Deposits actually inside the window. */
  observed: number;
  /**
   * Deposits a window of this length would hold. Exact for pay on fixed days
   * of the month, an average for pay every N days.
   */
  expected: number;
  /**
   * Set when pay lands on fixed days of the month (the 1st and 15th, the last
   * day) rather than every N days. 31 means the last day of the month.
   */
  daysOfMonth?: number[];
  /** The typical deposit, for saying what one more or fewer is worth. */
  typicalCents: number;
}

/**
 * Whether a window caught a representative number of paydays.
 *
 * The distortion this exists to name: income arrives on a cadence, most
 * spending does not. Someone paid fortnightly has a 30-day window catch two
 * deposits or three depending on nothing but where the window falls — a swing
 * of half a month's income — while the mortgage and the utilities land once
 * either way. The resulting "net" is then mostly an artefact of the calendar.
 *
 * Concretely: a last-30-days window that catches two fortnightly paydays can
 * show spending a little above income, which reads as a household living
 * beyond its means. Shift the window a few days to catch three and the same
 * month is comfortably positive. The behaviour did not change; the window
 * moved.
 *
 * Returns null when there is no discernible cadence — irregular income cannot
 * be under-represented by a window, because it has no rate to depart from.
 */
export function incomeCadence(
  db: Database.Database,
  startDate: string,
  endDate: string,
  /** Deposits below this are noise — refunds, interest, transfers in. */
  minCents = 50_000,
): IncomeCadence | null {
  const dates = (db.prepare(`
    SELECT date, amount_cents AS cents FROM visible_transactions
     WHERE spend_group = 'income' AND amount_cents >= ?
     ORDER BY date
  `).all(minCents) as Array<{ date: string; cents: number }>);
  if (dates.length < 4) return null;

  const gaps: number[] = [];
  for (let i = 1; i < dates.length; i += 1) {
    const g = Math.round(
      (Date.parse(dates[i]!.date) - Date.parse(dates[i - 1]!.date)) / 86_400_000,
    );
    if (g > 0) gaps.push(g);
  }
  if (gaps.length < 3) return null;

  const medianOf = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2);
  };
  const medianGapDays = medianOf(gaps);
  if (medianGapDays <= 0) return null;

  // Irregular income has no rate to depart from, so nothing here would mean
  // anything. Half the gaps within a few days of the median is a low bar, and
  // deliberately so — the alternative is staying silent on a real distortion.
  const regular = gaps.filter((g) => Math.abs(g - medianGapDays) <= 3).length;
  if (regular / gaps.length < 0.5) return null;

  const inWindow = dates.filter((d) => d.date >= startDate && d.date <= endDate);
  const spanDays = Math.round(
    (Date.parse(endDate) - Date.parse(startDate)) / 86_400_000,
  ) + 1;

  // Pay on the 1st and 15th has a median gap of ~15 days, and 92 / 15 says a
  // quarter "usually holds 6.6" — so a perfectly ordinary quarter with six
  // paydays was flagged as short by half a paycheque. A calendar schedule is
  // counted on the calendar instead.
  const anchors = calendarAnchors(dates.map((d) => d.date));
  const expected = anchors
    ? anchorDaysIn(anchors, startDate, endDate)
    : Math.round((spanDays / medianGapDays) * 10) / 10;

  return {
    medianGapDays,
    observed: inWindow.length,
    expected,
    typicalCents: medianOf(dates.map((d) => d.cents)),
    ...(anchors ? { daysOfMonth: anchors } : {}),
  };
}

/**
 * The fixed days of the month pay lands on, or null when it does not.
 *
 * Up to two anchors, each catching deposits within three days of it — pay due
 * on a weekend arrives a day or two early. Every-N-days pay drifts through the
 * month and fails the 80% bar. Needs six deposits, so a short history of
 * fortnightly pay cannot cluster by chance. Day 28 and later count as "the last
 * day", since a month-end payroll lands on the 28th to the 31st.
 */
export function calendarAnchors(dates: string[]): number[] | null {
  if (dates.length < 6) return null;
  const doms = dates.map((d) => {
    const day = Number(d.slice(8, 10));
    return day >= 28 ? 31 : day;
  });
  const near = (a: number, b: number) => Math.abs(a - b) <= 3;
  const anchors: number[] = [];
  let left = doms;
  for (let k = 0; k < 2 && left.length > 0; k += 1) {
    let best = 0, bestHits = 0;
    for (let day = 1; day <= 31; day += 1) {
      const hits = left.filter((d) => near(d, day)).length;
      if (hits > bestHits) { best = day; bestHits = hits; }
    }
    // A second anchor has to carry a real share, or one stray deposit becomes
    // a payday.
    if (k > 0 && bestHits < dates.length * 0.25) break;
    // Report the most common actual day near it, not the window's centre.
    const caught = left.filter((d) => near(d, best));
    const counts = new Map<number, number>();
    for (const d of caught) counts.set(d, (counts.get(d) ?? 0) + 1);
    anchors.push([...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]![0]);
    left = left.filter((d) => !near(d, best));
  }
  const covered = doms.filter((d) => anchors.some((a) => near(d, a))).length;
  return covered / doms.length >= 0.8 ? anchors.sort((a, b) => a - b) : null;
}

/** How many of the anchor days fall inside [startDate, endDate]. */
function anchorDaysIn(anchors: number[], startDate: string, endDate: string): number {
  let n = 0;
  let y = Number(startDate.slice(0, 4));
  let m = Number(startDate.slice(5, 7));
  const pad = (v: number) => String(v).padStart(2, '0');
  for (;;) {
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    for (const a of anchors) {
      const date = `${y}-${pad(m)}-${pad(Math.min(a, lastDay))}`;
      if (date >= startDate && date <= endDate) n += 1;
    }
    if (`${y}-${pad(m)}` >= endDate.slice(0, 7)) break;
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return n;
}
