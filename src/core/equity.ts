// Equity compensation that never reaches a bank account.
//
// Vested shares are income. They are also invisible to every ledger built from
// bank data: the shares appear at the broker, tax is withheld there, and what
// is left stays as stock. The bank sees only the slice someone chooses to sell
// and move across — which is a financing decision, not earnings.
//
// The consequence is not cosmetic. For someone paid largely in shares,
// measured income can fall well short of measured spending, so the
// affordability baseline reports a permanent monthly shortfall. The rest is
// vesting equity, and nothing in the ledger can say so.
//
// The trace it does leave is tax withholding, which a broker reports as cash
// movements inside the investment account. US federal withholding on
// supplemental wages is a statutory flat rate, so a withholding line implies
// the gross it was taken from.
//
// WHAT THIS IS NOT: a tax calculation, and not a general "detect equity"
// solution. It reads one broker's labelling convention, verified against one
// account. Everything here reports what it could not parse rather than
// returning a confident zero, because a silent zero is indistinguishable from
// "this person has no equity" and that is the wrong thing to tell someone
// sizing a loan.

/** A cash movement inside an investment account, with the broker's own label. */
export interface WithholdingRow {
  date: string;
  /** The broker's description. This is what identifies the row. */
  name: string;
  /** Positive = money left the investment account. */
  amountCents: number;
  accountName?: string;
}

export interface VestEvent {
  date: string;
  /** Derived from federal withholding at the statutory supplemental rate. */
  grossCents: number;
  withheldCents: number;
  netCents: number;
  /**
   * Whether an independent estimate from the Medicare line agrees.
   *
   * False is NOT an error. Medicare gains a 0.9% surtax above a wage
   * threshold, so the two legitimately diverge once someone crosses it —
   * observed on real vests. Reported so a reader can see the
   * estimate was checked rather than asserted.
   */
  crossChecked: boolean;
  /** The Medicare-derived gross, when there was one. */
  crossCheckGrossCents?: number;
}

export interface VestSummary {
  events: VestEvent[];
  grossCents: number;
  withheldCents: number;
  netCents: number;
  /**
   * Dates that carried withholding-shaped rows but no federal line to size
   * them from. Surfaced, never dropped: an unparsed broker format must look
   * different from an account with no equity.
   */
  unsizedDates: string[];
}

/**
 * US federal withholding on supplemental wages, which is what a vest is.
 *
 * Statutory and flat to $1M of supplemental wages in a year; above that it
 * becomes 37%. Someone past that threshold will be under-estimated here, which
 * is the safe direction for an affordability figure but is still wrong, so it
 * is named rather than buried.
 */
const FEDERAL_SUPPLEMENTAL_RATE = 0.22;

/** Medicare, used only to check the federal-derived figure. */
const MEDICARE_RATE = 0.0145;

/** How far the two estimates may drift before they stop corroborating. */
const CROSS_CHECK_TOLERANCE = 0.1;

/**
 * Labels that mark a row as belonging to an equity event.
 *
 * Deliberately broad across vehicles (RSU, ESPP, restricted stock) because the
 * withholding shape is the same. Seen in the wild as "JOURNALED RSU US Federal
 * Incom"; other brokers word it differently, which is the main reason this
 * reports what it cannot parse.
 */
const EQUITY_MARKER = /\b(rsu|restricted stock|espp|vest(ed|ing)?)\b/i;

const FEDERAL = /\bfed(eral)?\b/i;
const MEDICARE = /\bmedicare\b/i;
/** A refund line is a credit back, not a deduction — it nets against the rest. */
const WITHHOLDING_COMPONENT = /\b(fed(eral)?|medicare|social security|soc sec|fica|state|refund)\b/i;

/** True when a row is an internal broker journal rather than money to a bank. */
export function isInternalJournal(name: string): boolean {
  // "JOURNALED" is the giveaway: the cash never left, it moved between the
  // broker's own buckets. These must not be offered to bank-transfer matching,
  // where an equal amount on a nearby date would pair with a real transfer.
  return /\bjournal(ed|ing)?\b/i.test(name) || EQUITY_MARKER.test(name);
}

/**
 * Group withholding rows into vest events and size each one.
 *
 * Pure. Callers supply the rows; nothing here reaches a network or a clock.
 */
export function detectVests(rows: WithholdingRow[]): VestSummary {
  const byDate = new Map<string, WithholdingRow[]>();
  for (const row of rows) {
    if (!EQUITY_MARKER.test(row.name)) continue;
    if (!WITHHOLDING_COMPONENT.test(row.name)) continue;
    const bucket = byDate.get(row.date) ?? [];
    bucket.push(row);
    byDate.set(row.date, bucket);
  }

  const events: VestEvent[] = [];
  const unsizedDates: string[] = [];

  for (const [date, bucket] of [...byDate].sort((a, b) => (a[0] < b[0] ? 1 : -1))) {
    const sumWhere = (re: RegExp) => bucket
      .filter((r) => re.test(r.name))
      .reduce((sum, r) => sum + r.amountCents, 0);

    const federal = sumWhere(FEDERAL);
    // Every component together, refunds included — a refund is negative here
    // and correctly reduces the total withheld.
    const withheld = bucket.reduce((sum, r) => sum + r.amountCents, 0);

    if (federal <= 0) {
      // Withholding-shaped, but nothing to size it from.
      unsizedDates.push(date);
      continue;
    }

    const gross = Math.round(federal / FEDERAL_SUPPLEMENTAL_RATE);
    const medicare = sumWhere(MEDICARE);
    const crossGross = medicare > 0 ? Math.round(medicare / MEDICARE_RATE) : undefined;
    const crossChecked = crossGross !== undefined
      && Math.abs(crossGross - gross) / gross <= CROSS_CHECK_TOLERANCE;

    events.push({
      date,
      grossCents: gross,
      withheldCents: withheld,
      netCents: gross - withheld,
      crossChecked,
      ...(crossGross !== undefined ? { crossCheckGrossCents: crossGross } : {}),
    });
  }

  return {
    events,
    grossCents: events.reduce((s, e) => s + e.grossCents, 0),
    withheldCents: events.reduce((s, e) => s + e.withheldCents, 0),
    netCents: events.reduce((s, e) => s + e.netCents, 0),
    unsizedDates,
  };
}

/**
 * Net equity income per month across the span the events cover.
 *
 * Spread evenly on purpose. Vests are lumpy and the monthly figure exists to
 * sit beside a monthly affordability baseline, where the question is what the
 * year supports rather than what arrived in any one month. A lender does the
 * same thing, and discounts it further.
 */
export function monthlyNetEquity(summary: VestSummary, monthsCovered: number): number {
  if (monthsCovered <= 0 || summary.events.length === 0) return 0;
  return Math.round(summary.netCents / monthsCovered);
}
