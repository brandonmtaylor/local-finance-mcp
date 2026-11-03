// Static HTML report.
//
// Self-contained by design: inline SVG, inline CSS, no scripts, no network. It
// keeps the local-first property — you can open it, keep it, or email it, and
// nothing leaves the machine unless you send it.
//
// Charts follow the data-viz method: form chosen by the data's job, categorical
// hues assigned in fixed order (never cycled), palette validated for CVD in both
// light and dark against the actual surfaces.

import type Database from 'better-sqlite3';
import { collectInsights, type InsightsBrief } from './insights.js';
import { markdownToHtml, type NarrationResult } from './narrate.js';
import {
  getSpendingSummary,
  resolveSpendingScope,
  floorByCategory,
  latestBalances,
  tagTotals,
  incomeSources,
  type IncomeSource,
  type SpendingSummary,
  type TagTotal,
} from './queries.js';
import { attributeTransfers, netByAccount, type BankTransfer } from './attribution.js';
import { readCashMovements } from './cashMovements.js';

// ── palette ──────────────────────────────────────────────────────────────────
// Validated: light (#2a78d6,#eb6834) and dark (#3987e5,#d95926) both pass the
// lightness band, chroma floor, CVD separation, normal-vision floor and 3:1
// contrast against their surfaces. Do not substitute hues without re-running
// the validator.
const SERIES_1_LIGHT = '#2a78d6'; // blue  — spending
const SERIES_2_LIGHT = '#eb6834'; // orange — income

export interface MonthlyPoint {
  month: string;      // YYYY-MM
  spendingCents: number;
  incomeCents: number;
}

export interface ReportData {
  startDate: string;
  endDate: string;
  generatedAt: string;
  summary: SpendingSummary;
  monthly: MonthlyPoint[];
  cumulative: CumulativePoint[];
  topMerchants: SpendingSummary['topMerchants'];
  accounts: Array<{ name: string; mask: string | null; type: string | null; count: number }>;
  balances: ReturnType<typeof latestBalances>;
  insights: InsightsBrief;
  narration?: NarrationResult;
  tags: TagTotal[];
  /**
   * Transfers split by the brokerage sub-account behind them, when a brokerage
   * is linked. Absent otherwise — most ledgers have none, and an empty section
   * is worse than no section.
   */
  /**
   * The transactions behind each category, for drill-down.
   *
   * Capped per category: a twelve-month window has thousands of rows and
   * inlining all of them turns a report you can email into one you cannot.
   */
  /** Where the money came from, largest first. */
  incomeSources: IncomeSource[];
  categoryDetail: Record<string, {
    rows: Array<{ date: string; description: string; amountCents: number; account: string }>;
    shown: number;
    total: number;
  }>;
  transferSources?: Array<{
    accountName: string; netCents: number; count: number; basis: 'matched' | 'inferred' | 'mixed';
  }>;
}

/** The spend groups the headline uses for this window, as a SQL list. */
function spendingGroupsSql(db: Database.Database, startDate: string, endDate: string): string {
  return resolveSpendingScope(db, 'auto', 0.4, { startDate, endDate })
    .groups.map((g) => `'${g}'`).join(',');
}

/** Money out per calendar month, spending vs income, for the trend chart. */
export function monthlySeries(
  db: Database.Database,
  startDate: string,
  endDate: string,
): MonthlyPoint[] {
  // The same groups the headline counts, or the bars and the line disagree
  // with the total printed above them whenever card payments are folded in.
  const groups = spendingGroupsSql(db, startDate, endDate);
  const rows = db.prepare(`
    SELECT substr(date, 1, 7) AS month,
           SUM(CASE WHEN spend_group = 'income' THEN amount_cents ELSE 0 END) AS incomeCents
      FROM visible_transactions
     WHERE date >= @startDate AND date <= @endDate
     GROUP BY month ORDER BY month
  `).all({ startDate, endDate }) as Array<{ month: string; incomeCents: number }>;
  // Each month floored per category, as the headline is — no bar below zero.
  // A refund landing the month after its purchase therefore leaves the bars
  // summing a little above a headline that nets the two; a bar that dips
  // below the axis would be the worse picture.
  const spend = db.prepare(`
    SELECT substr(date, 1, 7) AS month, category, SUM(amount_cents) AS netCents
      FROM visible_transactions
     WHERE date >= @startDate AND date <= @endDate AND spend_group IN (${groups})
     GROUP BY month, category
  `).all({ startDate, endDate }) as Array<{ month: string; category: string; netCents: number }>;
  // Normalize -0, which Intl renders as "-$0.00".
  return rows.map((r) => ({
    month: r.month,
    spendingCents: floorByCategory(spend.filter((c) => c.month === r.month)).spendingCents || 0,
    incomeCents: r.incomeCents || 0,
  }));
}

/** Resolve a configured range name to concrete dates, relative to `today`. */
export type RangeName =
  | 'last-7-days' | 'last-30-days' | 'last-90-days'
  | 'month-to-date' | 'year-to-date' | 'all';

/**
 * Resolve a configured range to concrete dates.
 *
 * `all` needs the ledger, since "everything" means the earliest transaction
 * actually held — not an arbitrary far-past date that would render an empty
 * left half of every chart.
 */
export function resolveRange(
  range: RangeName,
  today = new Date(),
  db?: Database.Database,
): { start: string; end: string } {
  const ymd = (d: Date) => d.toISOString().slice(0, 10);
  const end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const back = (days: number) => {
    const d = new Date(end);
    d.setUTCDate(d.getUTCDate() - (days - 1));   // inclusive of both ends
    return d;
  };
  switch (range) {
    case 'last-7-days': return { start: ymd(back(7)), end: ymd(end) };
    case 'last-90-days': return { start: ymd(back(90)), end: ymd(end) };
    case 'month-to-date':
      return { start: ymd(new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1))), end: ymd(end) };
    case 'year-to-date':
      return { start: ymd(new Date(Date.UTC(end.getUTCFullYear(), 0, 1))), end: ymd(end) };
    case 'all': {
      const earliest = db
        ? (db.prepare('SELECT MIN(date) AS d FROM visible_transactions').get() as { d: string | null }).d
        : null;
      return { start: earliest ?? ymd(back(30)), end: ymd(end) };
    }
    default: return { start: ymd(back(30)), end: ymd(end) };
  }
}

export interface CumulativePoint { date: string; spendingCents: number; incomeCents: number }

/**
 * Running totals by day.
 *
 * A cumulative line answers a question the monthly bars cannot: what is the
 * PACE, and where do spending and income cross. Two lines that finish close
 * together is a thin margin, visible at a glance.
 */
export function cumulativeSeries(
  db: Database.Database,
  startDate: string,
  endDate: string,
): CumulativePoint[] {
  // The same groups the headline counts, or the bars and the line disagree
  // with the total printed above them whenever card payments are folded in.
  const groups = spendingGroupsSql(db, startDate, endDate);
  const rows = db.prepare(`
    SELECT date, category,
           CASE WHEN spend_group IN (${groups}) THEN 1 ELSE 0 END AS spending,
           SUM(CASE WHEN spend_group = 'income' THEN amount_cents ELSE 0 END) AS incomeCents,
           SUM(amount_cents) AS netCents
      FROM visible_transactions
     WHERE date >= @startDate AND date <= @endDate
       AND (spend_group IN (${groups}) OR spend_group = 'income')
     GROUP BY date, category, spending ORDER BY date
  `).all({ startDate, endDate }) as Array<{
    date: string; category: string; spending: number; incomeCents: number; netCents: number;
  }>;

  // Running totals per category, each floored at zero, so the line finishes
  // exactly on the headline and never runs below the axis on a payout.
  const running = new Map<string, number>();
  const points: CumulativePoint[] = [];
  let income = 0;
  for (const r of rows) {
    income += r.incomeCents || 0;
    if (r.spending) running.set(r.category, (running.get(r.category) ?? 0) + r.netCents);
    const spendingCents = floorByCategory(
      [...running].map(([category, netCents]) => ({ category, netCents })),
    ).spendingCents;
    const point = { date: r.date, spendingCents, incomeCents: income };
    if (points.length && points[points.length - 1]!.date === r.date) points[points.length - 1] = point;
    else points.push(point);
  }
  return points;
}

export function collectReportData(
  db: Database.Database,
  startDate: string,
  endDate: string,
  now = new Date(),
): ReportData {
  const summary = getSpendingSummary(db, startDate, endDate);
  const accounts = db.prepare(`
    SELECT a.name, a.mask, a.type, COUNT(t.txn_id) AS count
      FROM accounts a LEFT JOIN visible_transactions t
        ON t.account_id = a.account_id AND t.date >= @startDate AND t.date <= @endDate
     GROUP BY a.account_id ORDER BY count DESC
  `).all({ startDate, endDate }) as ReportData['accounts'];

  return {
    startDate,
    endDate,
    generatedAt: now.toISOString(),
    summary,
    monthly: monthlySeries(db, startDate, endDate),
    cumulative: cumulativeSeries(db, startDate, endDate),
    topMerchants: summary.topMerchants,
    accounts,
    balances: latestBalances(db),
    insights: collectInsights(db, startDate, endDate),
    tags: tagTotals(db, startDate, endDate),
    transferSources: transferSources(db, startDate, endDate),
    incomeSources: incomeSources(db, startDate, endDate),
    categoryDetail: categoryDetail(db, startDate, endDate),
  };
}

/** Per-category transaction lists, capped so the file stays emailable. */
const DETAIL_CAP = 15;

function categoryDetail(
  db: Database.Database,
  startDate: string,
  endDate: string,
): ReportData['categoryDetail'] {
  const rows = db.prepare(`
    SELECT t.category, t.date, t.description, t.amount_cents AS amountCents, a.name AS account
      FROM visible_transactions t JOIN accounts a ON a.account_id = t.account_id
     WHERE t.date >= @startDate AND t.date <= @endDate
       AND t.spend_group IN ('purchases','bills')
     ORDER BY t.category, t.amount_cents
  `).all({ startDate, endDate }) as Array<{
    category: string; date: string; description: string; amountCents: number; account: string;
  }>;

  const out: ReportData['categoryDetail'] = {};
  for (const r of rows) {
    const bucket = out[r.category] ?? { rows: [], shown: 0, total: 0 };
    bucket.total += 1;
    // Biggest first (amounts are negative, so the ORDER BY above already puts
    // them there) — a reader opening this wants the ones that moved the number.
    if (bucket.rows.length < DETAIL_CAP) {
      bucket.rows.push({
        date: r.date, description: r.description,
        amountCents: r.amountCents, account: r.account,
      });
      bucket.shown = bucket.rows.length;
    }
    out[r.category] = bucket;
  }
  return out;
}

/**
 * Split this window's transfers by the brokerage sub-account they came from.
 *
 * Reads the cache sync wrote; never touches the network, because the report is
 * generated offline. No cache, no brokerage, or nothing matched all collapse to
 * undefined — the section simply does not appear.
 */
function transferSources(
  db: Database.Database,
  startDate: string,
  endDate: string,
): ReportData['transferSources'] {
  const cache = readCashMovements();
  if (!cache || cache.movements.length === 0) return undefined;

  const transfers = db.prepare(`
    SELECT txn_id AS txnId, date, amount_cents AS amountCents, description
      FROM visible_transactions
     WHERE spend_group = 'transfers' AND date >= @startDate AND date <= @endDate
  `).all({ startDate, endDate }) as BankTransfer[];
  if (transfers.length === 0) return undefined;

  const result = attributeTransfers(transfers, cache.movements);
  if (result.attributions.length === 0) return undefined;

  const basisFor = new Map<string, Set<string>>();
  for (const a of result.attributions) {
    const seen = basisFor.get(a.accountId) ?? new Set<string>();
    seen.add(a.basis);
    basisFor.set(a.accountId, seen);
  }

  return netByAccount(transfers, result).map((row) => {
    const kinds = basisFor.get(row.accountId) ?? new Set<string>();
    return {
      accountName: row.accountName,
      netCents: row.netCents,
      count: row.count,
      basis: (kinds.size > 1 ? 'mixed' : [...kinds][0] ?? 'matched') as 'matched' | 'inferred' | 'mixed',
    };
  });
}

// ── formatting ───────────────────────────────────────────────────────────────

const money = (cents: number) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', maximumFractionDigits: 0,
  }).format(cents / 100);

const moneyExact = (cents: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);

const monthLabel = (ym: string) => {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, 1))
    .toLocaleDateString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' });
};

const dayLabel = (ymd: string) => {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!))
    .toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
};

const titleCase = (s: string) => s.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

/** Escape for HTML text and attribute contexts — merchant names are bank data. */
function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * Axis ticks a person can read.
 *
 * Snaps the interval to 1, 2, 2.5 or 5 × a power of ten, then extends the top
 * of the scale to a whole multiple. Returns the tick values and the scale max —
 * the max is what bars are drawn against, so it must be the rounded one or the
 * top gridline stops matching the tallest bar.
 */
export function niceTicks(dataMax: number, targetCount = 4): { ticks: number[]; max: number } {
  if (!Number.isFinite(dataMax) || dataMax <= 0) return { ticks: [0, 1], max: 1 };

  const rough = dataMax / targetCount;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const normalized = rough / magnitude;
  const snapped = (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10) * magnitude;
  // Amounts are integer cents, and ticks are rounded for display — a sub-unit
  // step collapses into duplicates (0, 0, 1, 1, 1) instead of a usable axis.
  const step = Math.max(1, snapped);

  const max = Math.ceil(dataMax / step) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= max + step / 2; v += step) ticks.push(Math.round(v));
  return { ticks, max };
}

// ── charts (inline SVG, no JS) ───────────────────────────────────────────────
//
// Hover comes from <title> children: native tooltips, zero script, and they
// survive being emailed. Every chart is followed by a table view in the DOM, so
// identity is never carried by color alone.

/**
 * Grouped bars: spending vs income per month.
 *
 * Two series → legend required. One shared y-axis, never dual — the whole point
 * is comparing the two magnitudes directly.
 */
function monthlyChart(points: MonthlyPoint[]): string {
  if (points.length === 0) return '<p class="empty">No transactions in this range.</p>';

  const W = 720, H = 260, PAD_L = 64, PAD_R = 16, PAD_T = 16, PAD_B = 38;
  const plotW = W - PAD_L - PAD_R, plotH = H - PAD_T - PAD_B;
  const dataMax = Math.max(...points.flatMap((p) => [p.spendingCents, p.incomeCents]), 1);

  // Round the axis to human numbers. Dividing the raw max by four gives ticks
  // like $3,086 / $6,173 — arithmetically correct and unreadable. Snap the step
  // to 1/2/2.5/5 × 10ⁿ and extend the top of the scale to a multiple of it.
  const { ticks, max } = niceTicks(dataMax, 4);
  const y = (v: number) => PAD_T + plotH - (v / max) * plotH;

  const slot = plotW / points.length;
  const barW = Math.min(28, (slot - 10) / 2);

  const grid = ticks.map((t) => `
    <line x1="${PAD_L}" y1="${y(t).toFixed(1)}" x2="${W - PAD_R}" y2="${y(t).toFixed(1)}" class="grid"/>
    <text x="${PAD_L - 10}" y="${(y(t) + 4).toFixed(1)}" class="axis" text-anchor="end">${money(t)}</text>`).join('');

  const bars = points.map((p, i) => {
    const cx = PAD_L + slot * i + slot / 2;
    // 2px gap between adjacent fills so the pair reads as two marks, not one.
    const x1 = cx - barW - 1, x2 = cx + 1;
    const h1 = Math.max(0, plotH - (y(p.spendingCents) - PAD_T));
    const h2 = Math.max(0, plotH - (y(p.incomeCents) - PAD_T));
    return `
      <g>
        <rect x="${x1.toFixed(1)}" y="${y(p.spendingCents).toFixed(1)}" width="${barW}" height="${h1.toFixed(1)}" rx="4" class="s1">
          <title>${esc(monthLabel(p.month))} — spending ${moneyExact(p.spendingCents)}</title>
        </rect>
        <rect x="${x2.toFixed(1)}" y="${y(p.incomeCents).toFixed(1)}" width="${barW}" height="${h2.toFixed(1)}" rx="4" class="s2">
          <title>${esc(monthLabel(p.month))} — income ${moneyExact(p.incomeCents)}</title>
        </rect>
        <text x="${cx.toFixed(1)}" y="${H - 14}" class="axis" text-anchor="middle">${esc(monthLabel(p.month))}</text>
      </g>`;
  }).join('');

  return `
  <div class="legend">
    <span class="key"><i class="sw s1"></i>Spending</span>
    <span class="key"><i class="sw s2"></i>Income</span>
  </div>
  <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Spending and income by month" class="chart">
    ${grid}
    <line x1="${PAD_L}" y1="${PAD_T + plotH}" x2="${W - PAD_R}" y2="${PAD_T + plotH}" class="axis-line"/>
    ${bars}
  </svg>`;
}

/**
 * Which of `count` evenly spaced positions get a label: roughly six, always
 * both ends.
 *
 * Forcing the last point in used to land it a day or two after the previous
 * stride tick, and the two labels printed on top of each other ("Sep 2Sep 30").
 * A regular tick closer than about half a stride to the end now gives way.
 */
export function axisTickIndices(count: number, target = 5): number[] {
  if (count <= 0) return [];
  const last = count - 1;
  if (last === 0) return [0];
  const stride = Math.max(1, Math.round(last / target));
  const ticks: number[] = [];
  for (let i = 0; i < last; i += stride) ticks.push(i);
  const prev = ticks[ticks.length - 1]!;
  if (prev !== 0 && last - prev < stride * 0.6) ticks.pop();
  ticks.push(last);
  return ticks;
}

/**
 * Cumulative spending vs income as lines.
 *
 * A line is right here and wrong for the monthly bars: a running total IS
 * continuous — flat between days with activity, so it is drawn as steps. Two series
 * → legend, plus direct end-labels, so identity never rests on colour. No
 * per-point markers — at ~90 points they would be noise.
 */
function cumulativeChart(points: CumulativePoint[]): string {
  if (points.length < 2) return '<p class="empty">Not enough days to plot a trend.</p>';

  const W = 720, H = 250, PAD_L = 64, PAD_R = 92, PAD_T = 14, PAD_B = 34;
  const plotW = W - PAD_L - PAD_R, plotH = H - PAD_T - PAD_B;
  const dataMax = Math.max(...points.flatMap((p) => [p.spendingCents, p.incomeCents]), 1);
  const { ticks, max } = niceTicks(dataMax, 4);

  // Positioned by DATE, not by index. Only days with activity are points, so
  // spacing them evenly made a quiet fortnight as wide as a busy two days and
  // bent the slope — the one thing a running total is for.
  const dayOf = (date: string) => Date.parse(`${date}T00:00:00Z`) / 86_400_000;
  const firstDay = dayOf(points[0]!.date);
  const spanDays = Math.max(1, dayOf(points[points.length - 1]!.date) - firstDay);
  const xDay = (d: number) => PAD_L + ((d - firstDay) / spanDays) * plotW;
  const x = (i: number) => xDay(dayOf(points[i]!.date));
  const y = (v: number) => PAD_T + plotH - (v / max) * plotH;
  // Steps, not slopes: a running total holds its value until the next day
  // with activity, so a diagonal between two points would draw money arriving
  // gradually across days when nothing happened.
  const path = (pick: (p: CumulativePoint) => number) =>
    points.map((p, i) => (i === 0
      ? `M${x(i).toFixed(1)},${y(pick(p)).toFixed(1)}`
      : `H${x(i).toFixed(1)} V${y(pick(p)).toFixed(1)}`)).join(' ');

  const grid = ticks.map((t) => `
    <line x1="${PAD_L}" y1="${y(t).toFixed(1)}" x2="${W - PAD_R}" y2="${y(t).toFixed(1)}" class="grid"/>
    <text x="${PAD_L - 10}" y="${(y(t) + 4).toFixed(1)}" class="axis" text-anchor="end">${money(t)}</text>`).join('');

  // Evenly spaced calendar days, both ends included.
  const dateTicks = axisTickIndices(spanDays + 1)
    .map((offset) => {
      const date = new Date((firstDay + offset) * 86_400_000).toISOString().slice(0, 10);
      return `<text x="${xDay(firstDay + offset).toFixed(1)}" y="${H - 12}" class="axis" text-anchor="middle">${esc(dayLabel(date))}</text>`;
    })
    .join('');

  const last = points[points.length - 1]!;
  const endLabel = (v: number, cls: string, label: string) => `
    <text x="${(W - PAD_R + 8).toFixed(1)}" y="${(y(v) + 4).toFixed(1)}" class="end-label ${cls}">${label} ${money(v)}</text>`;

  // Nudge the labels apart when the two lines finish close together — which is
  // exactly what a thin margin looks like.
  const collide = Math.abs(y(last.spendingCents) - y(last.incomeCents)) < 14;
  const spendY = collide ? last.spendingCents : last.spendingCents;

  return `
  <div class="legend">
    <span class="key"><i class="sw s1"></i>Spending (running total)</span>
    <span class="key"><i class="sw s2"></i>Income (running total)</span>
  </div>
  <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Cumulative spending and income over the period" class="chart">
    ${grid}
    <line x1="${PAD_L}" y1="${PAD_T + plotH}" x2="${W - PAD_R}" y2="${PAD_T + plotH}" class="axis-line"/>
    <path d="${path((p) => p.incomeCents)}" class="line s2-stroke"><title>Income, running total — ends at ${moneyExact(last.incomeCents)}</title></path>
    <path d="${path((p) => p.spendingCents)}" class="line s1-stroke"><title>Spending, running total — ends at ${moneyExact(last.spendingCents)}</title></path>
    ${dateTicks}
    ${endLabel(last.incomeCents, 's2-text', 'in')}
    <g transform="translate(0, ${collide ? 13 : 0})">${endLabel(spendY, 's1-text', 'out')}</g>
  </svg>`;
}

/**
 * Ranked horizontal bars for one measure across categories.
 *
 * Deliberately ONE hue, not the categorical palette: every bar is the same
 * measure, so different hues would imply a distinction that does not exist.
 * Length carries magnitude; the label carries identity.
 */
function rankedBars(
  rows: Array<{ label: string; cents: number; count?: number }>,
  totalCents: number,
): string {
  if (rows.length === 0) return '<p class="empty">Nothing to show.</p>';
  const max = Math.max(...rows.map((r) => r.cents), 1);

  return `<div class="ranked">${rows.map((r) => {
    const pct = totalCents > 0 ? (r.cents / totalCents) * 100 : 0;
    return `
    <div class="row" title="${esc(r.label)} — ${moneyExact(r.cents)}${r.count ? ` across ${r.count} transactions` : ''}">
      <div class="row-label">${esc(r.label)}</div>
      <div class="row-track"><div class="row-fill" style="width:${((r.cents / max) * 100).toFixed(1)}%"></div></div>
      <div class="row-value">${money(r.cents)}<span class="row-pct">${pct.toFixed(0)}%</span></div>
    </div>`;
  }).join('')}</div>`;
}

// ── page ─────────────────────────────────────────────────────────────────────

/**
 * Whether a range covers a period that has not finished yet.
 *
 * Month-to-date on the 14th is fourteen days of a month, shown beside three
 * complete windows with nothing distinguishing them. "This month"
 * against "last 30 days" can read as spending down a third — the month is
 * simply half over. A partial period is not comparable to a complete one, and
 * the report puts them behind adjacent tabs.
 */
export function isPartialPeriod(range: RangeName): boolean {
  return range === 'month-to-date' || range === 'year-to-date';
}

export interface ReportPanel {
  id: string;
  label: string;
  data: ReportData;
  /** True when the period has not finished — see isPartialPeriod. */
  partial?: boolean;
}

/**
 * One range's worth of content.
 *
 * Extracted so several ranges can be rendered into the same file and switched
 * between with CSS alone — no script, so the page stays inert and still opens
 * offline, in a mail client, or on a phone.
 */
function renderPanel(data: ReportData, partial = false): string {
  const { summary } = data;
  const netCents = summary.incomeCents - summary.spendingCents;

  // A per-month figure makes windows of different lengths comparable — a raw total
  // means nothing until you know whether it covers one month or six.
  const spanDays = Math.max(
    1,
    Math.round((Date.parse(`${data.endDate}T00:00:00Z`) - Date.parse(`${data.startDate}T00:00:00Z`)) / 86_400_000) + 1,
  );
  const months = Math.max(spanDays / 30.44, 0.1);
  const monthsLabel = `${spanDays} days (~${months.toFixed(1)} months)`;

  const categoryRows = summary.byCategory.map((c) => ({
    label: titleCase(c.category), cents: c.amountCents, count: c.count,
  }));
  const merchantRows = data.topMerchants.slice(0, 10).map((m) => ({
    label: m.merchant, cents: m.amountCents, count: m.count,
  }));
  const merchantTotal = merchantRows.reduce((sum, m) => sum + m.cents, 0);

  // Cash and debt kept apart: a card balance is money owed, and adding it to a
  // checking balance produces a number that means nothing. Providers report a
  // liability as a positive amount owed.
  const sumOf = (pick: (t: string | null) => boolean) => data.balances
    .filter((b) => pick(b.type))
    .reduce((sum, b) => sum + (b.currentCents ?? 0), 0);
  const cashCents = sumOf((t) => t === 'depository' || t === null);
  // Investments are deliberately NOT cash. Brokerage holdings are the largest
  // balance on many ledgers and counting them as cash makes a person look far
  // more liquid than they are — the money is in shares, and turning it into
  // spendable cash means selling, with tax and timing attached.
  const investedCents = sumOf((t) => t === 'investment');
  const debtsCents = Math.abs(sumOf((t) => t === 'credit' || t === 'loan'));

  const recurringTotal = data.insights.recurring.reduce((sum, r) => sum + r.totalCents, 0);
  // Normalize each charge to a monthly figure by its own cadence — a 14-day
  // charge costs about twice what a 30-day one of the same size does.
  const recurringMonthly = data.insights.recurring.reduce(
    (sum, r) => sum + (r.cadenceDays >= 1 ? (r.medianCents * 30.44) / r.cadenceDays : r.totalCents / months),
    0,
  );

  // Each category expands to the transactions behind it. <details> rather than
  // a script: this report is read in a mail client as often as a browser, and a
  // mail client will not run JavaScript — a drill-down built on it would be
  // dead exactly where it is most often opened.
  const tableRows = summary.byCategory.map((c) => {
    const detail = data.categoryDetail[c.category];
    const inner = detail && detail.rows.length > 0 ? `
      <details class="drill">
        <summary>${detail.total} transaction${detail.total === 1 ? '' : 's'}</summary>
        <table class="drill-table">
          <tbody>
            ${detail.rows.map((r) => `
            <tr>
              <td class="drill-date">${r.date}</td>
              <td>${esc(r.description.slice(0, 46))}</td>
              <td class="drill-acct">${esc(r.account.slice(0, 18))}</td>
              <td class="num">${moneyExact(Math.abs(r.amountCents))}</td>
            </tr>`).join('')}
          </tbody>
        </table>
        ${detail.total > detail.shown
    ? `<div class="drill-more">showing the ${detail.shown} largest of ${detail.total}</div>`
    : ''}
      </details>` : '';
    return `
    <tr><td>${esc(titleCase(c.category))}${inner}</td><td>${esc(c.group)}</td>
    <td class="num">${moneyExact(c.amountCents)}</td><td class="num">${c.count}</td></tr>`;
  }).join('');
  // Above the tiles, not beside them. A window that several accounts cannot
  // speak for produces a total that is not wrong so much as incomparable — and
  // this report puts four such windows behind tabs, which is precisely the
  // arrangement that invites reading one against another.
  const gaps = summary.coverageGaps.length > 0 ? `
  <div class="coverage-gap">
    <strong>These figures are incomplete for this window.</strong>
    <ul>
      ${summary.coverageGaps.map((g) => `<li>${esc(g.name)}${g.mask ? ` ••${esc(g.mask)}` : ''}
        has no data before ${g.earliest} — missing the first ${g.missingDays} days</li>`).join('')}
    </ul>
    <div>Spending here is lower than reality by whatever those accounts hold, so
    this window cannot be compared with one they do cover.</div>
  </div>` : '';

  const partialNote = partial ? `
  <div class="coverage-gap">
    <strong>This period is not over yet.</strong>
    <div>It covers ${spanDays} day(s) so far. Comparing it with a complete window
    measures the calendar, not your spending.</div>
  </div>` : '';

  return `
  <div class="panel-range">${data.startDate} to ${data.endDate}${partial ? ' (so far)' : ''}</div>
  ${partialNote}
  ${gaps}
  <div class="tiles">
    <div class="tile">
      <div class="tile-label">Spending</div>
      <div class="tile-value">${money(summary.spendingCents)}</div>
      <div class="tile-note">${data.startDate} → ${data.endDate}</div>
      <div class="tile-note">${summary.transactionCount} transactions · ${money(Math.round(summary.spendingCents / months))}/mo</div>
      ${summary.cardPaymentsCounted ? '<div class="tile-note warn">includes card payments — no card linked</div>' : ''}
    </div>
    <div class="tile">
      <div class="tile-label">Income</div>
      <div class="tile-value">${money(summary.incomeCents)}</div>
      <div class="tile-note">${data.startDate} → ${data.endDate}</div>
      <div class="tile-note">${money(Math.round(summary.incomeCents / months))}/mo</div>
    </div>
    <div class="tile">
      <div class="tile-label">Net</div>
      <div class="tile-value ${netCents >= 0 ? 'pos' : 'neg'}">${money(netCents)}</div>
      <div class="tile-note">over ${monthsLabel}</div>
      <div class="tile-note">${money(Math.round(netCents / months))}/mo · ${netCents >= 0 ? 'income exceeded spending' : 'spending exceeded income'}</div>
    </div>
  </div>

  <nav class="jump">
    <a href="#by-month">By month</a>
    ${data.incomeSources.length > 0 ? '<a href="#income">Came from</a>' : ''}
    <a href="#where">Went</a>
    ${(data.insights.trends.length > 0 && data.insights.priorPeriodComparable) ? '<a href="#changed">Changed</a>' : ''}
    ${data.insights.unusual.length > 0 ? '<a href="#unusual">Unusual</a>' : ''}
    ${data.insights.newMerchants.length > 0 ? '<a href="#new">New</a>' : ''}
    <a href="#merchants">Merchants</a>
    ${data.insights.recurring.length > 0 ? '<a href="#recurring">Recurring</a>' : ''}
    ${data.balances.length > 0 ? '<a href="#standing">Standing</a>' : ''}
    <a href="#excluded">Excluded</a>
  </nav>

  <section id="by-month">
    <h2>By month</h2>
    ${monthlyChart(data.monthly)}
  </section>

  <section id="running">
    <h2>Running totals</h2>
    ${cumulativeChart(data.cumulative)}
    <p class="note">
      Where the two lines finish apart is the period&rsquo;s margin. Converging lines mean
      spending kept pace with income.
    </p>
  </section>

  ${data.incomeSources.length > 0 ? `
  <section id="income">
    <h2>Where it came from</h2>
    <div class="section-total">
      <span>${money(summary.incomeCents)} in</span>
      <span>${data.incomeSources.length} source${data.incomeSources.length === 1 ? '' : 's'}</span>
      <span>${money(Math.round(summary.incomeCents / months))} per month</span>
    </div>
    <div class="table-wrap">
      <table style="margin-top:10px">
        <thead><tr>
          <th>Source</th><th class="num">Total</th><th class="num">Share</th>
          <th class="num wide">Typical</th><th class="num wide">Times</th>
          <th class="num">Every</th><th class="wide">Last</th>
        </tr></thead>
        <tbody>
          ${data.incomeSources.slice(0, 12).map((i) => `
          <tr>
            <td>${esc(i.source.slice(0, 34))}</td>
            <td class="num">${moneyExact(i.totalCents)}</td>
            <td class="num">${i.pctOfIncome}%</td>
            <td class="num wide">${moneyExact(i.medianCents)}</td>
            <td class="num wide">${i.count}</td>
            <td class="num">${i.cadenceDays ? `${i.cadenceDays}d` : '—'}</td>
            <td class="wide">${i.lastDate}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>
    <p class="note">
      Grouped by payer, with the run date and reference number stripped &mdash; those
      change every payment, so grouping on the raw descriptor would make each paycheque
      its own source. <strong>Every</strong> is the median gap between payments, which is
      what shows a payer that has quietly stopped: a fortnightly source last seen six
      weeks ago is the thing worth noticing here.
      ${summary.excluded.transfersCents !== 0 ? 'Money moved in from your own accounts is not income and is not counted here.' : ''}
    </p>
  </section>` : ''}

  <section id="where">
    <h2>Where it went</h2>
    <div class="section-total">
      <span>${money(summary.spendingCents)} total</span>
      <span>${summary.transactionCount} transactions</span>
      <span>${money(Math.round(summary.spendingCents / months))} per month</span>
    </div>
    ${rankedBars(categoryRows, summary.spendingCents)}
    <details style="margin-top:16px">
      <summary>Table view</summary>
      <div class="table-wrap"><table style="margin-top:10px">
        <thead><tr><th>Category</th><th>Group</th><th class="num">Amount</th><th class="num">Count</th></tr></thead>
        <tbody>${tableRows}</tbody>
      </table></div>
    </details>
  </section>

    ${(data.insights.trends.length > 0 && data.insights.priorPeriodComparable) ? `
  <section id="changed">
    <h2>What changed</h2>
    <div class="section-total">
      <span>vs ${data.insights.priorPeriod.start} &rarr; ${data.insights.priorPeriod.end}</span>
    </div>
    <div class="table-wrap"><table style="margin-top:10px">
      <thead><tr><th>Category</th><th class="num">This period</th><th class="num">Prior</th><th class="num">Change</th></tr></thead>
      <tbody>
        ${data.insights.trends.slice(0, 10).map((t) => `
        <tr>
          <td>${esc(titleCase(t.category))}</td>
          <td class="num">${moneyExact(t.currentCents)}</td>
          <td class="num">${moneyExact(t.priorCents)}</td>
          <td class="num ${t.changeCents > 0 ? 'neg' : 'pos'}">${t.changeCents > 0 ? '+' : ''}${moneyExact(t.changeCents)}${
  t.changePct === null ? ' (new)' : ` (${t.changePct > 0 ? '+' : ''}${Math.round(t.changePct)}%)`}</td>
        </tr>`).join('')}
      </tbody>
    </table></div>
    <p class="note">
      Compared against the period immediately before this one, of the same length. A
      category with no prior spending shows as new rather than as an infinite increase.
    </p>
  </section>` : ''}

  ${data.insights.unusual.length > 0 ? `
  <section id="unusual">
    <h2>Unusual for their category</h2>
    <div class="table-wrap"><table style="margin-top:10px">
      <thead><tr><th>Date</th><th>Description</th><th class="num">Amount</th><th class="num">vs typical</th></tr></thead>
      <tbody>
        ${data.insights.unusual.slice(0, 10).map((u) => `
        <tr>
          <td>${u.date}</td>
          <td>${esc(u.description.slice(0, 44))}</td>
          <td class="num">${moneyExact(Math.abs(u.amountCents))}</td>
          <td class="num">${u.multiple.toFixed(1)}&times; ${esc(titleCase(u.category))}</td>
        </tr>`).join('')}
      </tbody>
    </table></div>
    <p class="note">
      Measured against the median transaction in the SAME category, not against all
      spending &mdash; a large grocery run and a large mortgage payment are not
      comparably surprising. This is where a duplicate charge, a wrong category or a
      card you did not use tends to show up first.
    </p>
  </section>` : ''}

  ${data.insights.newMerchants.length > 0 ? `
  <section id="new">
    <h2>First seen this period</h2>
    <div class="table-wrap"><table style="margin-top:10px">
      <thead><tr><th>Merchant</th><th class="num">Amount</th><th class="num">Times</th></tr></thead>
      <tbody>
        ${data.insights.newMerchants.slice(0, 10).map((m) => `
        <tr>
          <td>${esc(m.merchant)}</td>
          <td class="num">${moneyExact(m.totalCents)}</td>
          <td class="num">${m.count}</td>
        </tr>`).join('')}
      </tbody>
    </table></div>
    <p class="note">
      Merchants with no history before this period. Most are ordinary, but a new
      recurring charge and an unrecognised card usually appear here first &mdash;
      which is only useful if you read it while it is still new.
    </p>
  </section>` : ''}

  <section id="merchants">
    <h2>Top merchants</h2>
    <div class="section-total">
      <span>${money(merchantTotal)} across the top ${merchantRows.length}</span>
      <span>${summary.spendingCents > 0 ? Math.round((merchantTotal / summary.spendingCents) * 100) : 0}% of all spending</span>
    </div>
    ${rankedBars(merchantRows, summary.spendingCents)}
    <details class="drill" style="margin-top:14px">
      <summary>Every merchant, with what it cost</summary>
      <div class="table-wrap">
        <table style="margin-top:8px">
          <thead><tr><th>Merchant</th><th class="num">Total</th><th class="num">Times</th><th class="num">Typical</th></tr></thead>
          <tbody>
            ${summary.topMerchants.map((m) => `
            <tr>
              <td>${esc(m.merchant.slice(0, 40))}</td>
              <td class="num">${moneyExact(m.amountCents)}</td>
              <td class="num">${m.count}</td>
              <td class="num">${moneyExact(Math.round(m.amountCents / Math.max(1, m.count)))}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </details>
  </section>

  ${data.insights.recurring.length > 0 ? `
  <section id="recurring">
    <h2>Recurring</h2>
    <div class="section-total">
      <span>${money(Math.round(recurringMonthly))} / month at current cadence</span>
      <span>${money(recurringTotal)} in this window</span>
    </div>
    <div class="table-wrap"><table>
      <thead><tr>
        <th>Merchant</th><th class="num">Typical</th><th class="num">Every</th>
        <th class="num wide">Seen</th><th class="num wide">Window total</th>
        <th class="num">Per year</th><th class="num wide">Share</th><th class="wide">Last</th>
      </tr></thead>
      <tbody>
        ${data.insights.recurring.map((r) => `
        <tr>
          <td>${esc(r.merchant)}</td>
          <td class="num">${moneyExact(r.medianCents)}</td>
          <td class="num">${r.cadenceDays >= 1 ? `${Math.round(r.cadenceDays)}d` : 'same day'}</td>
          <td class="num wide">${r.occurrences}</td>
          <td class="num wide">${moneyExact(r.totalCents)}</td>
          <td class="num">${r.cadenceDays >= 1 ? money(Math.round((r.medianCents * 365.25) / r.cadenceDays)) : '—'}</td>
          <td class="num wide">${summary.spendingCents > 0 && r.cadenceDays >= 1
    ? `${(((r.medianCents * 30.44) / r.cadenceDays / (summary.spendingCents / months)) * 100).toFixed(1)}%`
    : '—'}</td>
          <td class="wide">${r.lastDate}</td>
        </tr>`).join('')}
      </tbody>
    </table></div>
    <p class="note">
      Charges that repeat on a steady cadence, each normalised by its own interval
      &mdash; a charge every 14 days costs about twice what a 30-day charge of the same
      size does, so the two are only comparable once both are put on the same footing.
      <strong>Per year</strong> is the number worth reading: a $40 charge is easy to
      wave through and $1,040 a year is not, and they are the same charge.
      <strong>Share</strong> is that annual cost against your typical month&rsquo;s
      spending, so a small recurring item that quietly eats a real percentage is visible.
    </p>
  </section>` : ''}

  ${data.balances.length > 0 ? `
  <section id="standing">
    <h2>Where you stand</h2>
    <div class="section-total">
      <span>${money(cashCents)} cash</span>
      ${investedCents > 0 ? `<span>${money(investedCents)} invested</span>` : ''}
      <span>${money(debtsCents)} owed</span>
      <span class="${cashCents + investedCents - debtsCents >= 0 ? 'pos' : 'neg'}">${money(cashCents + investedCents - debtsCents)} total</span>
    </div>
    <div class="table-wrap"><table style="margin-top:10px">
      <thead><tr><th>Account</th><th>Type</th><th class="num">Balance</th><th>As of</th></tr></thead>
      <tbody>
        ${data.balances.map((b) => `
        <tr>
          <td>${esc(b.name)}${b.mask ? ` <span style="color:var(--muted)">&bull;&bull;${esc(b.mask)}</span>` : ''}</td>
          <td>${esc(b.type ?? '—')}</td>
          <td class="num">${b.currentCents === null ? '—' : moneyExact(b.currentCents)}</td>
          <td style="color:var(--muted)">${b.asOf.slice(0, 10)}</td>
        </tr>`).join('')}
      </tbody>
    </table></div>
    <p class="note">
      The latest balance each account reported, which is not necessarily today &mdash; the
      date is shown per account so a stale one is visible rather than assumed current.
      Card and loan balances are what is OWED, so they are subtracted. Investments are
      kept separate from cash on purpose: shares are not spendable money, and turning
      them into it means selling, with tax and timing attached. This is not net worth
      &mdash; property, vehicles and anything not linked here are missing from both sides.
    </p>
  </section>` : ''}

  <section id="excluded">
    <h2>Not counted as spending</h2>
    <div class="excluded">
      <div>Credit-card payments<b>${money(summary.excluded.paymentsCents)}</b></div>
      <div>Transfers<b>${money(summary.excluded.transfersCents)}</b></div>
      ${summary.excluded.refundsBeyondSpendingCents ? `<div>Payouts beyond spending<b>${money(summary.excluded.refundsBeyondSpendingCents)}</b></div>` : ''}
    </div>
    ${summary.excluded.refundsBeyondSpendingCents ? `<p class="note">
      Money that arrived in a spending category beyond everything that category spent in this
      window &mdash; an insurance payout or reimbursement rather than a refund. It is counted as
      neither spending nor income, so spending never reads below zero. <code>finance doctor</code>
      lists the rows.
    </p>` : ''}
    ${(data.transferSources?.length ?? 0) > 0 ? `
    <h3 style="font-size:13px;font-weight:600;margin-top:18px">Where those transfers went</h3>
    <div class="table-wrap"><table style="margin-top:8px">
      <tbody>
        ${data.transferSources!.map((row) => `
        <tr>
          <td>${esc(row.accountName)}</td>
          <td class="num">${moneyExact(row.netCents)}</td>
          <td style="color:var(--muted)">${row.netCents >= 0 ? 'net in' : 'net out'} &middot; ${row.count} transfer${row.count === 1 ? '' : 's'}</td>
        </tr>`).join('')}
      </tbody>
    </table></div>
    <p class="note">
      One brokerage is one merchant on a statement, so proceeds arriving and your own
      savings going the other way read identically and cancel out. These are split by the
      sub-account the brokerage itself reports the movement against &mdash; matched on date
      and amount, and where the brokerage&rsquo;s history is shorter than the bank&rsquo;s,
      by the account reference the bank puts in the description.
    </p>` : ''}
    ${summary.cardPaymentsCounted ? `
    <p class="note">
      <strong>Credit-card payments are being counted as spending above.</strong> No credit-card
      account is linked, so the payment is the only record of what was spent on that card —
      excluding it would understate the total. Link the card to get real categories and to stop
      relying on the payment as a proxy.
    </p>` : ''}
    <p class="note">
      Money moving between your own accounts, and payments that settle a credit-card
      balance. A card&rsquo;s purchases are already counted, so counting the payment too
      would count the same spending twice. Loan payments are NOT excluded &mdash; a
      mortgage or student loan reports a balance rather than purchases, so nothing else
      accounts for them and they belong in spending.
    </p>
  </section>`;
}

export function renderReport(panels: ReportPanel[], narration?: NarrationResult): string {
  if (panels.length === 0) throw new Error('renderReport needs at least one panel');
  const primary = panels[0]!;

  // Radio inputs + sibling selectors give a working tab control with zero
  // JavaScript. The cost is that every range is rendered into the file; at a
  // few tens of KB each that is a fair trade for a page that cannot break.
  const tabs = panels.length > 1 ? `
  <div class="tabs">
    ${panels.map((p, i) => `<input type="radio" name="range" id="tab-${esc(p.id)}"${i === 0 ? ' checked' : ''}>`).join('')}
    <div class="tabstrip">
      ${panels.map((p) => `<label for="tab-${esc(p.id)}">${esc(p.label)}</label>`).join('')}
    </div>
    ${panels.map((p) => `<div class="panel panel-${esc(p.id)}">${renderPanel(p.data, p.partial)}</div>`).join('')}
  </div>` : `<div>${renderPanel(primary.data, primary.partial)}</div>`;

  const tabCss = panels.map((p) => `
  .tabs > input#tab-${p.id}:checked ~ .tabstrip label[for="tab-${p.id}"] {
    background: var(--surface); color: var(--ink); border-color: var(--border);
  }
  .tabs > input#tab-${p.id}:checked ~ .panel-${p.id} { display: block; }`).join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Finance report ${primary.data.startDate} to ${primary.data.endDate}</title>
<style>
  /* Light values on bare :root; dark redefined under BOTH the media query and
     an explicit theme stamp, so a toggle wins in either direction. */
  :root {
    color-scheme: light;
    --surface: #fcfcfb; --plane: #f9f9f7;
    --ink: #0b0b0b; --ink-2: #52514e; --muted: #898781;
    --grid: #e1e0d9; --border: #e6e5df;
    --s1: ${SERIES_1_LIGHT}; --s2: ${SERIES_2_LIGHT};
    --good: #0ca30c; --critical: #d03b3b;
    /* A caution surface for "these numbers are incomplete". Warm rather than
       red: the figures are not wrong, they are partial, and red would put a
       missing card on a level with a failed sync. */
    --warn-bg: #fdf6e3; --warn-border: #e8d9a8;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      color-scheme: dark;
      --surface: #1a1a19; --plane: #0d0d0d;
      --ink: #ffffff; --ink-2: #c3c2b7; --muted: #898781;
      --grid: #2c2c2a; --border: #2c2c2a;
      --s1: #3987e5; --s2: #d95926;
      --good: #0ca30c; --critical: #d03b3b;
      --warn-bg: #2a2617; --warn-border: #4a4225;
    }
  }
  :root[data-theme="dark"] {
    color-scheme: dark;
    --surface: #1a1a19; --plane: #0d0d0d;
    --ink: #ffffff; --ink-2: #c3c2b7; --muted: #898781;
    --grid: #2c2c2a; --border: #2c2c2a;
    --s1: #3987e5; --s2: #d95926;
  }

  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 32px 20px 64px;
    background: var(--plane); color: var(--ink);
    font: 15px/1.5 ui-sans-serif, -apple-system, "Segoe UI", system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 860px; margin: 0 auto; }
  header { margin-bottom: 28px; }
  h1 { font-size: 22px; font-weight: 600; margin: 0 0 4px; letter-spacing: -0.01em; }
  .sub { color: var(--ink-2); font-size: 14px; }

  section { background: var(--surface); border: 1px solid var(--border); border-radius: 12px;
            padding: 20px 22px; margin-bottom: 18px; overflow: hidden; }
  h2 { font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em;
       color: var(--ink-2); margin: 0 0 16px; }

  /* Hero numbers: the headline is a stat, not a chart. */
  /* Must match section's margin-bottom — the tiles are a sibling block, and
     without it they sit flush against the first section. */
  .coverage-gap {
      margin: 0 0 20px; padding: 14px 16px; border-radius: 10px;
      background: var(--warn-bg); border: 1px solid var(--warn-border);
      color: var(--ink); font-size: 14px; line-height: 1.5;
    }
    .coverage-gap ul { margin: 8px 0; padding-left: 20px; }
    .coverage-gap li { margin: 2px 0; }
    .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
           gap: 14px; margin-bottom: 18px; }
  .tile { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 16px 18px; }
  .tile-label { font-size: 12px; color: var(--ink-2); margin-bottom: 6px; }
  .tile-value { font-size: 28px; font-weight: 600; letter-spacing: -0.02em;
                font-variant-numeric: tabular-nums; }
  .tile-note { font-size: 12px; color: var(--muted); margin-top: 4px; }
  .pos { color: var(--good);     --warn-bg: #2a2617; --warn-border: #4a4225;
  } .neg { color: var(--critical); }
  .tile-note.warn { color: var(--critical); }

  .chart { width: 100%; height: auto; display: block; }
  .grid { stroke: var(--grid); stroke-width: 1; }
  .axis-line { stroke: var(--grid); stroke-width: 1; }
  .axis { fill: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; }
  .s1 { fill: var(--s1); } .s2 { fill: var(--s2); }
  .line { fill: none; stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
  .s1-stroke { stroke: var(--s1); } .s2-stroke { stroke: var(--s2); }
  /* Direct end-labels wear text ink, not the series colour — the line beside
     them carries identity. */
  .end-label { font-size: 11px; fill: var(--ink-2); font-variant-numeric: tabular-nums; }

  .legend { display: flex; gap: 18px; margin-bottom: 10px; font-size: 13px; color: var(--ink-2); }
  .key { display: inline-flex; align-items: center; gap: 7px; }
  .sw { width: 11px; height: 11px; border-radius: 3px; display: inline-block; }
  .sw.s1 { background: var(--s1); } .sw.s2 { background: var(--s2); }

  .ranked { display: flex; flex-direction: column; gap: 9px; }
  .row { display: grid; grid-template-columns: 150px 1fr 108px; align-items: center; gap: 12px; }
  .row-label { font-size: 13px; color: var(--ink-2); overflow: hidden;
               text-overflow: ellipsis; white-space: nowrap; }
  .row-track { background: var(--grid); border-radius: 4px; height: 15px; overflow: hidden; }
  .row-fill { background: var(--s1); height: 100%; border-radius: 4px; }
  .row-value { text-align: right; font-size: 13px; font-variant-numeric: tabular-nums; }
  .row-pct { color: var(--muted); margin-left: 8px; font-size: 12px; }

  .section-total { display: flex; flex-wrap: wrap; gap: 18px; margin: -6px 0 16px;
                   font-size: 13px; color: var(--ink-2); font-variant-numeric: tabular-nums; }
  .section-total span:first-child { color: var(--ink); font-weight: 600; }
  .excluded { display: flex; gap: 28px; flex-wrap: wrap; }
  .excluded div { font-size: 13px; color: var(--ink-2); }
  .excluded b { display: block; color: var(--ink); font-size: 17px; font-weight: 600;
                font-variant-numeric: tabular-nums; margin-top: 2px; }
  .note { font-size: 12px; color: var(--muted); margin-top: 12px; line-height: 1.45; }

  /* A table wider than its card must scroll INSIDE the card, not spill past the
     rounded border — which is what it did on a phone, with the right-hand
     columns escaping the outline entirely. The wrapper is what scrolls; the
     section keeps its own edges. */
  .table-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch;
                margin: 0 -22px; padding: 0 22px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  /* On a phone the secondary columns go, so the table fits its card. A table
     that relies on sideways scrolling reads as clipped: there is no scrollbar
     on a phone and none at all in most mail clients, so "Typica" and "Wind"
     looked like a rendering bug. The wrapper still scrolls if something is
     wider than expected; every hidden column is explained in the note. */
  @media (max-width: 620px) {
    th.wide, td.wide { display: none; }
    th, td { padding: 6px 5px; }
    table { font-size: 12px; }
  }
  th, td { text-align: left; padding: 7px 8px; border-bottom: 1px solid var(--border); }
  th { color: var(--muted); font-weight: 500; font-size: 12px; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  details summary { cursor: pointer; color: var(--ink-2); font-size: 13px; }
  /* Drill-down. Closed it is one quiet line; open it is the detail behind the
     number, which is the question a category total always provokes. */
  /* A jump list for a long page. position:sticky needs no script, so it works
     in a mail client too — where it simply scrolls with the page if sticky is
     unsupported, rather than breaking. */
  .jump { position: sticky; top: 0; z-index: 5; background: var(--bg);
          border-bottom: 1px solid var(--border); margin: 0 0 18px;
          padding: 10px 0; display: flex; gap: 14px; flex-wrap: wrap;
          font-size: 12px; }
  .jump a { color: var(--ink-2); text-decoration: none; white-space: nowrap; }
  .jump a:hover { color: var(--ink); text-decoration: underline; }
  @media print { .jump { display: none; } }
  .drill { margin-top: 6px; }
  .drill > summary { font-size: 11px; color: var(--muted); list-style: none; }
  .drill > summary::-webkit-details-marker { display: none; }
  .drill > summary::before { content: '▸ '; }
  .drill[open] > summary::before { content: '▾ '; }
  .drill-table { margin: 6px 0 10px; font-size: 12px; }
  .drill-table td { border-bottom: none; padding: 3px 8px 3px 0; }
  .drill-date { color: var(--muted); white-space: nowrap; font-variant-numeric: tabular-nums; }
  .drill-acct { color: var(--muted); }
  .drill-more { font-size: 11px; color: var(--muted); padding-bottom: 8px; }
  .empty { color: var(--muted); font-size: 13px; }
  .tabs > input[type="radio"] { position: absolute; opacity: 0; pointer-events: none; }
  .tabstrip { display: flex; gap: 6px; margin-bottom: 18px; flex-wrap: wrap; }
  .tabstrip label { font-size: 13px; padding: 7px 14px; border-radius: 8px; cursor: pointer;
                    color: var(--ink-2); border: 1px solid transparent; user-select: none; }
  .tabstrip label:hover { color: var(--ink); }
  /* Each panel states its own range: the page header sits before the radio
     inputs in DOM order, so no sibling selector can update it per tab. */
  .panel-range { font-size: 13px; color: var(--ink-2); margin: 0 0 14px;
                 font-variant-numeric: tabular-nums; }
  .panel { display: none; }
  ${tabCss}
  .ai { border-left: 3px solid var(--s2); }
  .ai-range { font-weight: 400; text-transform: none; letter-spacing: 0; color: var(--muted); }
  .ai-body h3 { font-size: 13px; margin: 14px 0 6px; color: var(--ink); }
  .ai-body h3:first-child { margin-top: 0; }
  .ai-body ul { margin: 0 0 10px; padding-left: 20px; }
  .ai-body li { margin-bottom: 5px; font-size: 14px; }
  .ai-body p { margin: 0 0 10px; font-size: 14px; }
  footer { color: var(--muted); font-size: 12px; text-align: center; margin-top: 26px; }
  @media print { body { background: #fff; } section { break-inside: avoid; } }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>Finance report</h1>
    <div class="sub">Generated ${new Date(primary.data.generatedAt).toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
    })}</div>
  </header>

  ${tabs}

  ${narration?.ok && narration.markdown ? `
  <section class="ai">
    <h2>Analysis <span class="ai-range">${esc(primary.label)}</span></h2>
    <div class="ai-body">${markdownToHtml(narration.markdown)}</div>
    <p class="note">
      Written by <code>${esc(narration.producedBy)}</code> from the computed figures for
      <strong>${esc(primary.label)}</strong>. Everything else in this report is arithmetic;
      this section is not. Check anything it suggests before acting on it.
    </p>
  </section>` : ''}

  <footer>Generated ${new Date(primary.data.generatedAt).toLocaleString('en-US')} · local-finance-mcp · all data local</footer>
</div>
</body>
</html>`;
}
