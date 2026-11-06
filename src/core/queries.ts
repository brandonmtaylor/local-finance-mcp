// Read paths over the ledger.
//
// Every query here reads `visible_transactions`, whose category and
// spend_group already have the user's corrections applied — so a manual fix
// shows up everywhere at once.

import type Database from 'better-sqlite3';
import { type Category, type SpendGroup } from './normalize.js';

// The view already resolves an override onto the row, so every read path
// gets the corrected category without repeating the COALESCE.
const EFFECTIVE_CATEGORY = 't.category';

export interface AccountSummary {
  accountId: string;
  /**
   * The providers reaching this account, comma-separated.
   *
   * Plural because an account can be fed by several connections at once — two
   * logins at one bank, or a CSV import alongside an API. It is no longer a
   * property OF the account, which is the point of the rewrite.
   */
  providers: string;
  /** How many connections currently feed it. More than one is normal. */
  connectionCount: number;
  name: string;
  mask: string | null;
  type: string | null;
  subtype: string | null;
  currency: string;
  transactionCount: number;
  earliestDate: string | null;
  latestDate: string | null;
}

export function listAccounts(db: Database.Database): AccountSummary[] {
  return db.prepare(`
    SELECT a.account_id  AS accountId,
           (SELECT GROUP_CONCAT(DISTINCT c.provider_id)
              FROM sources s JOIN connections c ON c.connection_id = s.connection_id
             WHERE s.account_id = a.account_id AND c.active = 1) AS providers,
           (SELECT COUNT(*) FROM sources s2
              JOIN connections c2 ON c2.connection_id = s2.connection_id
             WHERE s2.account_id = a.account_id AND c2.active = 1) AS connectionCount,
           a.name        AS name,
           a.mask        AS mask,
           a.type        AS type,
           a.subtype     AS subtype,
           a.currency    AS currency,
           COUNT(t.txn_id) AS transactionCount,
           MIN(t.date)     AS earliestDate,
           MAX(t.date)     AS latestDate
      FROM accounts a
      -- The VIEW, not the base table: a transaction delivered by two
      -- connections is stored twice and is still one transaction.
      LEFT JOIN visible_transactions t ON t.account_id = a.account_id
     GROUP BY a.account_id
     ORDER BY a.name
  `).all() as AccountSummary[];
}

export interface LatestBalance {
  accountId: string;
  name: string;
  mask: string | null;
  type: string | null;
  asOf: string;
  currentCents: number | null;
  availableCents: number | null;
  limitCents: number | null;
  currency: string;
}

/**
 * Most recent balance per account — EXACTLY one row each.
 *
 * The `balances` table is append-only history, and two connections onto the
 * same real account both report it. Worse, one sync stamps a single `as_of`
 * across every connection, so "the newest row for this account" is genuinely
 * two rows and a net-worth total silently doubles. Measured: one account
 * holding $2,500 reported as $5,000.
 *
 * Resolved the same way transactions are — prefer the higher-priority active
 * connection, so a re-link's balance wins over the connection it replaced.
 */
export function latestBalances(db: Database.Database): LatestBalance[] {
  return db.prepare(`
    SELECT b.account_id      AS accountId,
           a.name            AS name,
           a.mask            AS mask,
           a.type            AS type,
           b.as_of           AS asOf,
           b.current_cents   AS currentCents,
           b.available_cents AS availableCents,
           b.limit_cents     AS limitCents,
           a.currency        AS currency
      FROM balances b
      JOIN accounts a ON a.account_id = b.account_id
      JOIN sources s ON s.source_id = b.source_id
      JOIN connections c ON c.connection_id = s.connection_id AND c.active = 1
     WHERE b.rowid = (
             SELECT b2.rowid
               FROM balances b2
               JOIN sources s2 ON s2.source_id = b2.source_id
               JOIN connections c2 ON c2.connection_id = s2.connection_id AND c2.active = 1
              WHERE b2.account_id = b.account_id
              ORDER BY b2.as_of DESC, c2.priority DESC, c2.linked_at DESC, b2.rowid
              LIMIT 1
           )
     ORDER BY a.name
  `).all() as LatestBalance[];
}

/**
 * True when nothing has ever been synced.
 *
 * Callers MUST distinguish this from a genuine zero. "No transactions in June"
 * and "no data has ever been imported" produce identical numbers, and an agent
 * reading a bare 0 will report "you spent nothing" with total confidence.
 */
export function ledgerIsEmpty(db: Database.Database): boolean {
  const row = db.prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number };
  return row.n === 0;
}

/**
 * Why a total would be zero because nothing is there, or null when the ledger
 * holds accounts and a zero is a real zero.
 *
 * Every consumer that prints a total asks this first — the CLI did not, and an
 * empty ledger printed "Total: $0.00", which reads as "you spent nothing"
 * (decision 10). `providerIds` are the configured providers, when the caller
 * knows them, so the message can name the next step.
 */
export function noDataReason(db: Database.Database, providerIds?: readonly string[]): string | null {
  if (!ledgerIsEmpty(db)) return null;
  const next = providerIds && providerIds.length > 0
    ? `Configured provider(s): ${providerIds.join(', ')} — run \`finance sync\`.`
    : 'Run `finance doctor` to see what is missing.';
  return 'NO DATA: the ledger has no accounts, so nothing has been imported yet. '
    + 'This is NOT the same as having spent nothing. ' + next;
}

/**
 * Whether card payments should count toward spending.
 *
 * A credit-card payment is normally excluded because the card's PURCHASES are
 * counted on the card itself. That reasoning only holds while the card is
 * linked. With no card in the ledger the purchases were never recorded, so
 * excluding the payment too makes the money disappear — a checking-only ledger
 * reported roughly a third of true spending.
 *
 * When the card is missing, the payment is the best available proxy for what
 * was spent on it. It is not exact — you pay last month's balance, and a
 * partial payment understates while an overpayment overstates — but it is far
 * closer than zero.
 *
 * Debit cards need none of this: their purchases post straight to the
 * depository account, so nothing is ever excluded.
 *
 * Decided per query rather than at import, so linking a card later fixes the
 * numbers with no re-sync.
 */
export type CardPaymentPolicy = 'auto' | 'always' | 'never';

export interface SpendingScope {
  groups: SpendGroup[];
  /** True when payments were folded in because the cards are not linked. */
  cardPaymentsCounted: boolean;
}

export function resolveSpendingScope(
  db: Database.Database,
  policy: CardPaymentPolicy = 'auto',
  coverageThreshold = 0.4,
  window?: { startDate?: string; endDate?: string },
): SpendingScope {
  const base: SpendGroup[] = ['purchases', 'bills'];
  if (policy === 'never') return { groups: base, cardPaymentsCounted: false };
  if (policy === 'always') return { groups: [...base, 'payments'], cardPaymentsCounted: true };

  // Measured over the window being asked about, NOT over the whole ledger.
  //
  // A ledger that reaches back before the cards were linked has an all-time
  // ratio dominated by the period when they were not — low across all time,
  // high over the last ninety days. Judging a recent
  // window by the old number concludes "no card is linked" while the cards are
  // linked and reporting their own purchases — so the purchases are counted
  // AND the payments that settle them, and the same money lands twice.
  //
  // The double counting is large — a month's card spending counted twice per
  // month — and can turn a healthy surplus into a deficit. The error runs in the direction that
  // makes someone look worse than they are, and it would have persisted for
  // every window forever, because the history behind it never changes.
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (window?.startDate) { where.push('date >= @startDate'); params.startDate = window.startDate; }
  if (window?.endDate) { where.push('date <= @endDate'); params.endDate = window.endDate; }
  const dateFilter = where.length ? ` AND ${where.join(' AND ')}` : '';

  const payments = (db.prepare(
    `SELECT COALESCE(-SUM(amount_cents), 0) AS cents FROM visible_transactions
      WHERE spend_group = 'payments' AND amount_cents < 0${dateFilter}`,
  ).get(params) as { cents: number }).cents;
  if (payments <= 0) return { groups: base, cardPaymentsCounted: false };

  const cardWhere = where.map((w) => `t.${w}`).join(' AND ');
  const cardSpend = (db.prepare(
    `SELECT COALESCE(-SUM(t.amount_cents), 0) AS cents
       FROM visible_transactions t JOIN accounts a USING(account_id)
      WHERE a.type = 'credit' AND t.spend_group IN ('purchases','bills')${
  cardWhere ? ` AND ${cardWhere}` : ''}`,
  ).get(params) as { cents: number }).cents;

  // Cards carrying most of their own spending — count payments as movement.
  if (cardSpend >= payments * coverageThreshold) {
    return { groups: base, cardPaymentsCounted: false };
  }
  return { groups: [...base, 'payments'], cardPaymentsCounted: true };
}

export interface TransactionFilters {
  startDate?: string;
  endDate?: string;
  accountIds?: string[];
  categories?: Category[];
  spendGroups?: SpendGroup[];
  /** Case-insensitive substring over description and merchant. */
  search?: string;
  minCents?: number;
  maxCents?: number;
  includePending?: boolean;
  /** Transactions carrying ALL of these tags. */
  tags?: string[];
  limit?: number;
  offset?: number;
}

export interface TransactionResult {
  txnId: string;
  accountId: string;
  accountName: string;
  date: string;
  amountCents: number;
  currency: string;
  merchantName: string | null;
  description: string;
  category: string;
  categoryOverride: string | null;
  spendGroup: string;
  pending: number;
  note: string | null;
  /** Comma-separated, or null when untagged. */
  tags: string | null;
}

export function queryTransactions(
  db: Database.Database,
  filters: TransactionFilters = {},
): TransactionResult[] {
  const where: string[] = [];
  const params: Record<string, unknown> = {};

  if (filters.startDate) { where.push('t.date >= @startDate'); params.startDate = filters.startDate; }
  if (filters.endDate) { where.push('t.date <= @endDate'); params.endDate = filters.endDate; }
  if (filters.minCents !== undefined) { where.push('t.amount_cents >= @minCents'); params.minCents = filters.minCents; }
  if (filters.maxCents !== undefined) { where.push('t.amount_cents <= @maxCents'); params.maxCents = filters.maxCents; }
  if (filters.includePending === false) where.push('t.pending = 0');

  if (filters.search) {
    where.push('(LOWER(t.description) LIKE @search OR LOWER(COALESCE(t.merchant_name, \'\')) LIKE @search)');
    params.search = `%${filters.search.toLowerCase()}%`;
  }

  // Bound IN-lists with generated placeholders — never string interpolation.
  const inClause = (column: string, values: string[], prefix: string): string => {
    const keys = values.map((v, i) => {
      params[`${prefix}${i}`] = v;
      return `@${prefix}${i}`;
    });
    return `${column} IN (${keys.join(', ')})`;
  };

  if (filters.tags?.length) {
    // ALL tags must be present, not any — "emergency AND home" is the useful
    // reading when someone lists two.
    filters.tags.forEach((tag, i) => {
      params[`tag${i}`] = tag;
      where.push(`EXISTS (SELECT 1 FROM tags gt WHERE gt.txn_id = t.txn_id AND gt.tag = @tag${i})`);
    });
  }
  if (filters.accountIds?.length) where.push(inClause('t.account_id', filters.accountIds, 'acct'));
  if (filters.categories?.length) where.push(inClause(EFFECTIVE_CATEGORY, filters.categories, 'cat'));
  if (filters.spendGroups?.length) where.push(inClause('t.spend_group', filters.spendGroups, 'grp'));

  const limit = Math.min(filters.limit ?? 200, 5_000);
  const offset = filters.offset ?? 0;

  return db.prepare(`
    SELECT t.txn_id        AS txnId,
           t.account_id    AS accountId,
           a.name          AS accountName,
           t.date          AS date,
           t.amount_cents  AS amountCents,
           t.currency      AS currency,
           t.merchant_name AS merchantName,
           t.description   AS description,
           ${EFFECTIVE_CATEGORY} AS category,
           t.category_override   AS categoryOverride,
           t.spend_group   AS spendGroup,
           t.pending       AS pending,
           t.note          AS note,
           (SELECT GROUP_CONCAT(gt.tag, ',') FROM tags gt WHERE gt.txn_id = t.txn_id) AS tags
      FROM visible_transactions t
      JOIN accounts a ON a.account_id = t.account_id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY t.date DESC, t.txn_id
     LIMIT ${limit} OFFSET ${offset}
  `).all(params) as TransactionResult[];
}

export interface SpendingSummary {
  startDate: string;
  endDate: string;
  /**
   * Accounts that cannot speak for this window.
   *
   * Present on the summary rather than left to a separate call, because a
   * total and the reason it is partial must travel together — anything that
   * can be read without the caveat eventually is.
   */
  coverageGaps: CoverageGap[];
  /**
   * Set when the newest transaction in the ledger is well before the window
   * ends — the other edge of coverage. A CSV import goes stale the day after
   * it is made, and without this a window past the last export prints $0.
   */
  dataEnds: DataEnd | null;
  currency: string;
  /**
   * purchases + bills, as a POSITIVE number of cents. This is the only headline
   * "you spent X" figure. Card and loan payments and account transfers are
   * excluded — see `excluded` — because counting a card payment as spending
   * double-counts the purchases that card already reported.
   */
  spendingCents: number;
  transactionCount: number;
  /**
   * True when card payments are INCLUDED above because the cards are not
   * linked. Callers must say so — an unexplained jump when a card is later
   * linked reads as a bug.
   */
  cardPaymentsCounted: boolean;
  byCategory: Array<{ category: string; group: SpendGroup; amountCents: number; count: number }>;
  topMerchants: Array<{ merchant: string; amountCents: number; count: number }>;
  incomeCents: number;
  /** Internal money movement. Deliberately NOT summed with spending. */
  /**
   * Internal movement, shown beside spending and never added to it. Each is
   * the amount MOVED — the larger of what left and what arrived — so a payment
   * seen from both the checking and the card side counts once, not zero.
   */
  excluded: {
    paymentsCents: number;
    transfersCents: number;
    /**
     * Money that arrived in a spending category beyond what that category
     * spent in the window — a payout or reimbursement, not a refund. Neither
     * spending nor income; see floorByCategory.
     */
    refundsBeyondSpendingCents: number;
  };
}

/**
 * Spending from per-category net amounts, with no category below zero.
 *
 * Money arriving in a spending category is a refund and reduces that
 * category — a returned jacket comes off shopping. But only down to zero.
 * Past that it is not a refund of anything spent in the window: it is a
 * payout, a reimbursement or income filed under a merchant's category. Five
 * insurance claim payouts filed as `insurance` once took a 90-day spending
 * total to −$11,937, and a negative "spent" is a number nobody can act on.
 * The excess is returned separately so it can be shown rather than lost.
 *
 * `netCents` uses the ledger's sign: negative is money out.
 */
export function floorByCategory(
  rows: ReadonlyArray<{ category: string; netCents: number }>,
): { spendingCents: number; beyondCents: number } {
  const net = new Map<string, number>();
  for (const r of rows) net.set(r.category, (net.get(r.category) ?? 0) + (r.netCents || 0));
  let spendingCents = 0;
  let beyondCents = 0;
  for (const n of net.values()) {
    if (n < 0) spendingCents -= n;
    else beyondCents += n;
  }
  return { spendingCents, beyondCents };
}

export function getSpendingSummary(
  db: Database.Database,
  startDate: string,
  endDate: string,
  accountIds?: string[],
  policy: CardPaymentPolicy = 'auto',
): SpendingSummary {
  const scope = resolveSpendingScope(db, policy, 0.4, { startDate, endDate });
  const groupList = scope.groups.map((g) => `'${g}'`).join(',');
  const params: Record<string, unknown> = { startDate, endDate };
  let accountFilter = '';
  if (accountIds?.length) {
    const keys = accountIds.map((id, i) => {
      params[`acct${i}`] = id;
      return `@acct${i}`;
    });
    accountFilter = ` AND t.account_id IN (${keys.join(', ')})`;
  }
  const where = `FROM visible_transactions t WHERE t.date >= @startDate AND t.date <= @endDate${accountFilter}`;

  // Money out is negative in the ledger; spending totals read better positive,
  // so flip the sign once here rather than at every call site.
  const byCategory = db.prepare(`
    SELECT ${EFFECTIVE_CATEGORY} AS category,
           t.spend_group         AS "group",
           -SUM(t.amount_cents)  AS amountCents,
           COUNT(*)              AS count
      ${where} AND t.spend_group IN (${groupList})
     -- GROUP BY the full expression, never the alias: SQLite resolves a bare
     -- alias name to the TABLE column of the same name, which silently groups
     -- by the pre-override value while displaying the post-override one.
     GROUP BY ${EFFECTIVE_CATEGORY}, "group"
     ORDER BY amountCents DESC
  `).all(params) as SpendingSummary['byCategory'];
  const floored = floorByCategory(byCategory.map((c) => ({ category: c.category, netCents: -c.amountCents })));
  // A category that took in more than it spent is not a line of spending.
  const spentCategories = byCategory.filter((c) => c.amountCents > 0);

  const topMerchants = db.prepare(`
    SELECT COALESCE(NULLIF(t.merchant_name, ''), t.description) AS merchant,
           -SUM(t.amount_cents) AS amountCents,
           COUNT(*)             AS count
      ${where} AND t.spend_group IN (${groupList})
     GROUP BY merchant
     ORDER BY amountCents DESC
     LIMIT 10
  `).all(params) as SpendingSummary['topMerchants'];

  const groupTotals = db.prepare(`
    SELECT t.spend_group AS "group", SUM(t.amount_cents) AS total, COUNT(*) AS count,
           COALESCE(SUM(CASE WHEN t.amount_cents < 0 THEN -t.amount_cents END), 0) AS outflow,
           COALESCE(SUM(CASE WHEN t.amount_cents > 0 THEN t.amount_cents END), 0) AS inflow
      ${where}
     GROUP BY "group"
  `).all(params) as Array<{ group: SpendGroup; total: number; count: number; outflow: number; inflow: number }>;

  const totalFor = (group: SpendGroup) => groupTotals.find((g) => g.group === group)?.total ?? 0;
  const countFor = (group: SpendGroup) => groupTotals.find((g) => g.group === group)?.count ?? 0;
  // How much moved, for money that only moves between your own accounts. Not
  // the net: a card payment with both accounts linked is −$900 on checking and
  // +$900 on the card, which nets to a "$0.00 of card payments" that reads as a
  // bug. The larger side is the amount moved, seen from one end or both.
  const movedFor = (group: SpendGroup) => {
    const g = groupTotals.find((row) => row.group === group);
    return g ? Math.max(g.outflow, g.inflow) : 0;
  };

  const currency = (db.prepare(
    `SELECT currency FROM visible_transactions t WHERE t.date >= @startDate AND t.date <= @endDate LIMIT 1`,
  ).get({ startDate, endDate }) as { currency: string } | undefined)?.currency ?? 'USD';

  return {
    startDate,
    endDate,
    coverageGaps: coverageGaps(db, startDate, endDate),
    dataEnds: dataEndsEarly(db, endDate),
    currency,
    spendingCents: floored.spendingCents,
    transactionCount: scope.groups.reduce((sum, g) => sum + countFor(g), 0),
    cardPaymentsCounted: scope.cardPaymentsCounted,
    byCategory: spentCategories,
    topMerchants,
    incomeCents: totalFor('income'),
    excluded: {
      // Zero when payments were folded into spending — reporting them in both
      // places would invite double-counting by anyone adding the two.
      paymentsCents: scope.cardPaymentsCounted ? 0 : movedFor('payments'),
      transfersCents: movedFor('transfers'),
      refundsBeyondSpendingCents: floored.beyondCents,
    },
  };
}


export interface IncomeSource {
  /** The payer, with per-payment references stripped. */
  source: string;
  totalCents: number;
  count: number;
  /** The typical payment — a mean is dragged around by a single bonus. */
  medianCents: number;
  firstDate: string;
  lastDate: string;
  /** Median days between payments; null when there is only one. */
  cadenceDays: number | null;
  pctOfIncome: number;
}

/**
 * Where the money comes from.
 *
 * The report could say how much came in and never where from, which is the
 * first question anyone asks of an income total — and the one that shows a
 * second job, a side contract, or a payer that quietly stopped.
 *
 * Grouping needs the payer, not the payment. A payroll descriptor carries the
 * run date and a reference number ("ACME CORP PAYROLL 260417 1022921"), so
 * grouping on the raw string makes every single paycheque its own source and
 * the whole view useless. Those tokens are stripped first.
 */
export function incomeSources(
  db: Database.Database,
  startDate: string,
  endDate: string,
): IncomeSource[] {
  const rows = db.prepare(`
    SELECT COALESCE(merchant_name, description) AS raw, date, amount_cents AS cents
      FROM visible_transactions
     WHERE spend_group = 'income' AND date >= @startDate AND date <= @endDate
     ORDER BY date
  `).all({ startDate, endDate }) as Array<{ raw: string; date: string; cents: number }>;

  const groups = new Map<string, { label: string; dates: string[]; amounts: number[] }>();
  for (const r of rows) {
    const key = normalizePayer(r.raw);
    if (!key) continue;
    const g = groups.get(key) ?? { label: titleish(key), dates: [], amounts: [] };
    g.dates.push(r.date);
    g.amounts.push(r.cents);
    groups.set(key, g);
  }

  const totalIncome = rows.reduce((sum, r) => sum + r.cents, 0);
  const out: IncomeSource[] = [];
  for (const g of groups.values()) {
    const total = g.amounts.reduce((a, b) => a + b, 0);
    const sorted = [...g.amounts].sort((a, b) => a - b);
    const gaps: number[] = [];
    for (let i = 1; i < g.dates.length; i += 1) {
      const days = Math.round(
        (Date.parse(`${g.dates[i]}T00:00:00Z`) - Date.parse(`${g.dates[i - 1]}T00:00:00Z`)) / 86_400_000,
      );
      if (days > 0) gaps.push(days);
    }
    const sortedGaps = [...gaps].sort((a, b) => a - b);
    out.push({
      source: g.label,
      totalCents: total,
      count: g.amounts.length,
      medianCents: sorted[Math.floor(sorted.length / 2)] ?? 0,
      firstDate: g.dates[0]!,
      lastDate: g.dates[g.dates.length - 1]!,
      cadenceDays: sortedGaps.length ? sortedGaps[Math.floor(sortedGaps.length / 2)]! : null,
      pctOfIncome: totalIncome > 0 ? Math.round((total / totalIncome) * 100) : 0,
    });
  }
  return out.sort((a, b) => b.totalCents - a.totalCents);
}

/** Strip the parts of a descriptor that change every payment. */
function normalizePayer(raw: string): string {
  return raw.toLowerCase()
    // Mixed letter-and-digit reference tokens, and any long run of digits.
    .replace(/\b(?=[a-z0-9]*\d)(?=[a-z0-9]*[a-z])[a-z0-9]{6,}\b/g, ' ')
    .replace(/\b\d{3,}\b/g, ' ')
    // Dates embedded mid-descriptor, and the clock times beside them.
    .replace(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g, ' ')
    .replace(/\b\d{1,2}:\d{2}(:\d{2})?\s*(am|pm)?\b/g, ' ')
    .replace(/[^a-z ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const titleish = (s: string) => s.replace(/\b[a-z]/g, (c) => c.toUpperCase());

export interface TagTotal {
  tag: string;
  count: number;
  /** Positive cents — what this tag cost in total. */
  totalCents: number;
  firstDate: string;
  lastDate: string;
}

/**
 * What each tag cost.
 *
 * This is the point of tags: a dishwasher leak spans a repair, an appliance, a
 * plumber and a cancellation fee across categories and weeks, and the only
 * question worth asking is what the whole episode came to.
 */
export function tagTotals(
  db: Database.Database,
  startDate?: string,
  endDate?: string,
): TagTotal[] {
  const where = ["t.spend_group IN ('purchases','bills')"];
  const params: Record<string, unknown> = {};
  if (startDate) { where.push('t.date >= @startDate'); params.startDate = startDate; }
  if (endDate) { where.push('t.date <= @endDate'); params.endDate = endDate; }

  return db.prepare(`
    SELECT gt.tag AS tag, COUNT(*) AS count, -SUM(t.amount_cents) AS totalCents,
           MIN(t.date) AS firstDate, MAX(t.date) AS lastDate
      -- Likewise here, and this one doubles real money: a tag is keyed on
      -- txn_id, which both stored copies share, so joining the base table
      -- counted a $1,200 repair as $2,400.
      FROM tags gt JOIN visible_transactions t ON t.txn_id = gt.txn_id
     WHERE ${where.join(' AND ')}
     GROUP BY gt.tag ORDER BY totalCents DESC
  `).all(params) as TagTotal[];
}

/**
 * What an agent is told about the schema before writing its own SQL.
 *
 * It names the view first because the base `transactions` table is the
 * trap: it holds one row per SOURCE, so a transaction delivered by two
 * connections (or two overlapping CSV exports) appears twice, and it carries
 * the provider's category rather than the user's correction. A test checks
 * that every relation named here exists.
 */
export const SQL_SCHEMA_GUIDE =
  'Query visible_transactions, never transactions: it has exactly one row per real '
  + 'transaction, and its category and spend_group already include the user\'s '
  + 'corrections (the provider\'s originals are provider_category / provider_spend_group). '
  + 'The base transactions table repeats a row for every connection that delivered it and '
  + 'double-counts. Amounts are integer cents in amount_cents; positive is money in, '
  + 'negative is money out. Spending is spend_group IN (\'purchases\', \'bills\'); for totals prefer '
  + 'get_spending_summary, which also counts card payments when no card is linked. '
  + 'Other relations: accounts, connections, sources, balances, tags (txn_id, tag), '
  + 'annotations, sync_log, providers, projects, line_items, vendors.';

/** Every relation SQL_SCHEMA_GUIDE names, for the test that keeps it honest. */
export const SQL_SCHEMA_RELATIONS = [
  'visible_transactions', 'transactions', 'accounts', 'connections', 'sources', 'balances',
  'tags', 'annotations', 'sync_log', 'providers', 'projects', 'line_items', 'vendors',
] as const;

const FORBIDDEN_SQL = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|ATTACH|DETACH|PRAGMA|VACUUM)\b/i;

/**
 * Run an arbitrary read-only SELECT.
 *
 * This is what makes open-ended analysis possible without predicting every
 * question up front. Safety is layered: the connection itself is opened
 * read-only (the real guarantee), and this check rejects obvious writes early
 * with a clearer message than SQLite's.
 */
export function runReadOnlyQuery(
  db: Database.Database,
  sql: string,
  limit = 1_000,
): { columns: string[]; rows: unknown[][]; truncated: boolean } {
  const trimmed = sql.trim().replace(/;\s*$/, '');
  if (!/^(SELECT|WITH)\b/i.test(trimmed)) {
    throw new Error('only SELECT (or WITH … SELECT) queries are allowed');
  }
  if (trimmed.includes(';')) {
    throw new Error('multiple statements are not allowed');
  }
  if (FORBIDDEN_SQL.test(trimmed)) {
    throw new Error('query contains a write or schema statement');
  }

  const stmt = db.prepare(trimmed);
  const rows = stmt.raw().all() as unknown[][];
  const columns = stmt.columns().map((c) => c.name);
  return {
    columns,
    rows: rows.slice(0, limit),
    truncated: rows.length > limit,
  };
}

export interface CoverageGap {
  accountId: string;
  name: string;
  mask: string | null;
  type: string | null;
  /** Earliest transaction this account has at all. Null when it has none. */
  earliest: string | null;
  /** Days of the requested window this account cannot speak for. */
  missingDays: number;
}

export interface DataEnd {
  /** The newest transaction date in the ledger. */
  latest: string;
  /** Days between that and the end of the window. */
  missingDays: number;
}

/**
 * The ledger stops well before the window does.
 *
 * coverageGaps names accounts that START late; this names a ledger that ENDS
 * early. A CSV export is a snapshot, so a "last 30 days" view a few weeks
 * after the last import reports $0 spent, $0 earned — and "income exceeded
 * spending" — when the truth is that nothing has been imported. Decision 10:
 * a zero must be able to say why.
 *
 * Measured across the whole ledger, not per account, because one quiet
 * account is normal and every account going quiet at once is not.
 */
export function dataEndsEarly(
  db: Database.Database,
  endDate: string,
  materialDays = 10,
): DataEnd | null {
  const row = db.prepare('SELECT MAX(date) AS latest FROM visible_transactions')
    .get() as { latest: string | null };
  if (!row.latest) return null;
  const missingDays = Math.round((Date.parse(endDate) - Date.parse(row.latest)) / 86_400_000);
  return missingDays >= materialDays ? { latest: row.latest, missingDays } : null;
}

/** One line for anywhere a total is printed. */
export function dataEndsMessage(d: DataEnd): string {
  return `the ledger's newest transaction is ${d.latest}, ${d.missingDays} days before this window ends `
    + '— anything after that has not been imported, so these totals are missing it. '
    + 'Run `finance sync` (for CSV, download a newer export first).';
}

/**
 * Accounts that cannot speak for the window being asked about.
 *
 * The failure this exists to name: accounts rarely share a start date. A bank
 * that gives two years sits beside a card that gives ninety days, and any
 * window reaching past the shorter one is answered by a subset of the
 * accounts — silently, and with a number that looks exactly like a complete
 * one. On a real ledger a full-year summary reported a spending total of which
 * two-thirds was credit-card payments standing in for purchases nobody had the
 * data for.
 *
 * That total is not wrong so much as incomparable: it cannot be read beside a
 * 2026 total, and the difference between them is mostly coverage rather than
 * behaviour.
 */
export function coverageGaps(
  db: Database.Database,
  startDate: string,
  endDate: string,
  /**
   * How large a gap has to be before it is worth reporting, in days.
   *
   * Necessary because the earliest TRANSACTION is only a proxy for the
   * earliest COVERAGE, and the two differ by however long an account happened
   * to sit idle. A card whose first purchase falls three days into the window
   * covered that window; a card whose first purchase falls ninety days in did
   * not. Nothing in the data distinguishes them, so a threshold does — and
   * getting it wrong in the noisy direction is worse, because a caveat printed
   * on every summary is a caveat nobody reads.
   */
  materialDays = 30,
): CoverageGap[] {
  const rows = db.prepare(`
    SELECT a.account_id AS accountId, a.name, a.mask, a.type,
           (SELECT MIN(v.date) FROM visible_transactions v
             WHERE v.account_id = a.account_id) AS earliest
      FROM accounts a
     WHERE EXISTS (SELECT 1 FROM sources s
                     JOIN connections c ON c.connection_id = s.connection_id
                    WHERE s.account_id = a.account_id AND c.active = 1)
     ORDER BY a.name
  `).all() as Array<{
    accountId: string; name: string; mask: string | null;
    type: string | null; earliest: string | null;
  }>;

  const day = 86_400_000;
  const windowStart = Date.parse(startDate);
  const windowEnd = Date.parse(endDate);

  return rows.flatMap((r) => {
    // An account with no transactions at all is a different problem, reported
    // by detectEmptyAccounts — not a coverage gap in this window.
    if (!r.earliest) return [];
    const first = Date.parse(r.earliest);
    if (!(first > windowStart)) return [];
    const missingDays = Math.round((Math.min(first, windowEnd) - windowStart) / day);
    return missingDays >= materialDays ? [{ ...r, missingDays }] : [];
  });
}
