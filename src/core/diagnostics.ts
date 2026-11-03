// Detectors for the failure modes that produce WRONG NUMBERS rather than errors.
//
// Every check here exists because it actually happened during setup, and in
// each case the ledger looked fine: no exception, no warning, a plausible
// total. A report that doubles the true total is worse than no
// report, because you act on it.
//
// All of these are pure SQL over data already held — no network, no provider
// calls — so `doctor` can run them any time, cheaply.

import type Database from 'better-sqlite3';

export type Severity = 'error' | 'warning' | 'info';

export interface Diagnostic {
  severity: Severity;
  code: string;
  /** One line, stating the problem in terms of its effect. */
  message: string;
  /** Specifics — the rows involved. */
  detail?: string[];
  /** What to actually do about it. */
  remedy?: string;
}

const dollars = (cents: number) => `$${(cents / 100).toLocaleString('en-US', {
  minimumFractionDigits: 2, maximumFractionDigits: 2,
})}`;



/**
 * Rows whose account no longer exists.
 *
 * The spending summary reads `transactions` without joining `accounts`, so
 * orphans are still counted. They appear when an account is removed without its
 * transactions — including via the sqlite3 CLI, which defaults foreign_keys OFF
 * and so silently skips the cascade.
 */
export function detectOrphans(db: Database.Database): Diagnostic[] {
  const txn = db.prepare(
    'SELECT COUNT(*) AS n, COALESCE(SUM(ABS(amount_cents)),0) AS cents FROM transactions '
    + 'WHERE account_id NOT IN (SELECT account_id FROM accounts)',
  ).get() as { n: number; cents: number };

  const accounts = db.prepare(
    // An account whose every source belongs to a provider that is gone.
    `SELECT COUNT(*) AS n FROM accounts a
      WHERE NOT EXISTS (
        SELECT 1 FROM sources s
          JOIN connections c ON c.connection_id = s.connection_id
          JOIN providers p ON p.provider_id = c.provider_id
         WHERE s.account_id = a.account_id)`,
  ).get() as { n: number };

  const out: Diagnostic[] = [];
  if (txn.n > 0) {
    out.push({
      severity: 'error',
      code: 'orphaned-transactions',
      message: `${txn.n} transactions reference an account that no longer exists `
        + `(about ${(txn.cents / 100).toFixed(2)} still counted in totals)`,
      remedy: 'Run `finance prune` to remove them.',
    });
  }
  if (accounts.n > 0) {
    out.push({
      severity: 'warning',
      code: 'orphaned-accounts',
      message: `${accounts.n} accounts belong to a provider that is no longer configured`,
      remedy: 'Run `finance prune` to remove them, or re-enable the provider in the config.',
    });
  }
  return out;
}

/**
 * An account that has been synced but holds no transactions.
 *
 * Split by whether the institution reports a BALANCE for it, because that is
 * the one signal separating two situations a bare count cannot:
 *
 *   - balance, no transactions — the institution knows the account and how much
 *     is in it, and is returning no activity. Something is wrong, and it is not
 *     the user's spending habits.
 *   - no balance, no transactions — most likely genuinely unused or closed.
 *
 * Reporting both at one severity trained people to skim past the row that
 * mattered, since the harmless case is far more common.
 */
export function detectEmptyAccounts(db: Database.Database): Diagnostic[] {
  const rows = db.prepare(`
    SELECT a.name, a.mask,
           (SELECT b.current_cents FROM balances b
             WHERE b.account_id = a.account_id
             ORDER BY b.as_of DESC LIMIT 1) AS balanceCents
      FROM accounts a
     WHERE NOT EXISTS (SELECT 1 FROM transactions t WHERE t.account_id = a.account_id)
       AND EXISTS (SELECT 1 FROM sync_log sl WHERE sl.error IS NULL)
     ORDER BY a.name
  `).all() as Array<{ name: string; mask: string | null; balanceCents: number | null }>;

  if (rows.length === 0) return [];
  const label = (r: { name: string; mask: string | null }) =>
    `${r.name}${r.mask ? ` \u2022\u2022${r.mask}` : ''}`;

  const out: Diagnostic[] = [];
  const withBalance = rows.filter((r) => r.balanceCents !== null && r.balanceCents !== 0);
  const without = rows.filter((r) => !withBalance.includes(r));

  if (withBalance.length > 0) {
    out.push({
      severity: 'warning',
      code: 'account-returns-no-transactions',
      message: `${withBalance.length} account(s) report a balance but no transactions`,
      detail: withBalance.map((r) => `${label(r)} — balance present, 0 transactions`),
      remedy: 'The institution knows this account and is returning no activity for it, so '
        + 'your totals are missing whatever it holds. Check the account at the bank, then '
        + 're-link that institution — `finance link --days 730` creates a fresh connection '
        + 'without disturbing the accounts you already have.',
    });
  }
  if (without.length > 0) {
    out.push({
      severity: 'info',
      code: 'empty-accounts',
      message: `${without.length} linked account(s) have no transactions`,
      detail: without.map(label),
      remedy: 'Normal for an unused or closed account. Nothing to do unless you expected '
        + 'activity on it.',
    });
  }
  return out;
}

/** The last sync failed, or nothing has synced recently. */
export function detectSyncHealth(db: Database.Database, staleDays = 3, now = new Date()): Diagnostic[] {
  const out: Diagnostic[] = [];

  const last = db.prepare(
    'SELECT provider_id, ran_at, error FROM sync_log ORDER BY id DESC LIMIT 1',
  ).get() as { provider_id: string; ran_at: string; error: string | null } | undefined;

  if (!last) {
    // An empty sync_log is not the same as an empty ledger. A ledger restored
    // from a backup, or written by a tool other than `finance sync`, holds real
    // data and no sync history — and telling someone looking at two years of
    // their own transactions that "nothing has ever been synced" teaches them
    // to distrust the diagnostics rather than the data.
    const rows = (db.prepare('SELECT COUNT(*) n FROM visible_transactions')
      .get() as { n: number }).n;
    return [rows === 0 ? {
      severity: 'warning', code: 'never-synced',
      message: 'nothing has ever been synced',
      remedy: 'Run `finance sync`.',
    } : {
      severity: 'info', code: 'no-sync-history',
      message: `${rows} transaction(s) present, but no sync has been recorded`,
      detail: [
        'Normal for a restored backup or a ledger populated by other means.',
        'It does mean freshness cannot be judged: nothing knows how current this is.',
      ],
      remedy: 'Run `finance sync` to establish a baseline, after which staleness is reported.',
    }];
  }

  if (last.error) {
    out.push({
      severity: 'error', code: 'sync-failed',
      message: `the last sync failed (${last.provider_id})`,
      detail: [last.error],
      remedy: 'Run `finance sync` and read the error. An expired Plaid Item needs re-linking.',
    });
  }

  const ageDays = (now.getTime() - Date.parse(last.ran_at)) / 86_400_000;
  if (Number.isFinite(ageDays) && ageDays > staleDays) {
    out.push({
      severity: 'warning', code: 'stale-sync',
      message: `last sync was ${Math.floor(ageDays)} days ago`,
      remedy: 'Check the scheduled job: `finance schedule status`, and the log at logs/sync.log.',
    });
  }

  // Repeated zero-change syncs while a schedule is running usually means an
  // Item stopped returning data rather than a genuinely quiet week. CSV is left
  // out: it only changes when someone drops in a new export, so ten quiet
  // re-reads of the same files are the normal case, not a dead link.
  const recent = db.prepare(
    `SELECT added, modified FROM sync_log
      WHERE error IS NULL
        AND provider_id NOT IN (SELECT provider_id FROM providers WHERE kind = 'csv')
      ORDER BY id DESC LIMIT 10`,
  ).all() as Array<{ added: number; modified: number }>;
  if (recent.length >= 10 && recent.every((r) => r.added === 0 && r.modified === 0)) {
    const newest = db.prepare('SELECT MAX(date) AS d FROM transactions').get() as { d: string | null };
    if (newest.d) {
      const gap = (now.getTime() - Date.parse(`${newest.d}T00:00:00Z`)) / 86_400_000;
      if (gap > staleDays) {
        out.push({
          severity: 'warning', code: 'no-new-data',
          message: `${recent.length} syncs in a row returned nothing, and the newest transaction is ${Math.floor(gap)} days old`,
          remedy: 'Banks lag 1-3 days, so this can be normal. Beyond that, an Item may need '
            + 're-authentication at the provider.',
        });
      }
    }
  }
  return out;
}

/**
 * Card payments excluded, with no card to account for them.
 *
 * Payments are kept out of the spending total because the card's purchases are
 * counted on the card itself. If the card is NOT linked, that assumption is
 * false and the total is understated by roughly the payment amount — silently,
 * and by a lot. Measured on real data: a checking-only ledger reported barely a
 * third of true spending.
 *
 * This is the single most misleading state the ledger can be in, because
 * nothing looks broken.
 */
export function detectUnlinkedCards(db: Database.Database): Diagnostic[] {
  // The VIEW, not the base table — unlike most of this file.
  //
  // Diagnostics normally reads `transactions` because its job is to see what
  // analysis hides. This detector is the exception: it asks whether the
  // REPORTED totals are missing card spending, so it has to see what the
  // reports see. Reading the base table counts rows from retired connections
  // that nothing reports, and the trigger is a RATIO — measured on a real
  // ledger, card spend read as roughly 3.4x the truth, putting the
  // ratio at 0.393 against a 0.400 threshold. One thousandth from silently
  // switching off the most consequential warning here.
  const payments = db.prepare(
    `SELECT COALESCE(-SUM(t.amount_cents), 0) AS cents FROM visible_transactions t
      WHERE t.spend_group = 'payments' AND t.amount_cents < 0`,
  ).get() as { cents: number };
  if (payments.cents <= 0) return [];

  // Spending recorded ON credit accounts — what the payments are supposed to
  // be settling.
  const cardSpend = db.prepare(
    `SELECT COALESCE(-SUM(t.amount_cents), 0) AS cents
       FROM visible_transactions t JOIN accounts a USING(account_id)
      WHERE a.type = 'credit' AND t.spend_group IN ('purchases','bills')`,
  ).get() as { cents: number };

  // Some coverage is expected to be imperfect (a card linked mid-period), so
  // only complain when the gap is large enough to distort the headline.
  if (cardSpend.cents >= payments.cents * 0.4) return [];

  const cards = db.prepare(`
    SELECT COUNT(*) AS n FROM accounts a
     WHERE a.type = 'credit'
       AND EXISTS (SELECT 1 FROM sources s
                     JOIN connections c ON c.connection_id = s.connection_id
                    WHERE s.account_id = a.account_id AND c.active = 1)
  `).get() as { n: number };
  const gap = payments.cents - cardSpend.cents;

  const money = dollars;

  return [{
    // A warning, not an error. Nothing is missing from the TOTAL — the
    // payments are counted, standing in for the purchases they settled. What
    // is missing is the detail. Calling it an error and saying spending was
    // "understated by six figures" reads as a large sum having
    // gone astray, which is alarming and untrue.
    severity: 'warning',
    code: 'card-detail-missing',
    message: `${money(payments.cents)} of card payments have no matching purchase detail`,
    detail: [
      cards.n === 0
        ? 'No credit-card accounts are linked, so nothing says what those payments bought.'
        : `${cards.n} credit account(s) are linked but hold only ${money(cardSpend.cents)} of `
          + 'purchases, so what the rest settled is unknown.',
      'Your TOTAL is not missing this money — each payment is counted in place of the',
      'purchases it settled. Two things are off instead: those amounts sit under',
      '"credit_card_payment" rather than groceries or travel, and they land in the month',
      'you PAID rather than the month you spent.',
    ],
    remedy: 'Link the cards to get real categories. Where an issuer will not reach far enough '
      + 'back (some return only ~90 days), older periods stay this way permanently — the '
      + 'payment is the only record that survives.',
  }];
}

/**
 * Accounts that more than one connection resolved to on the same natural key.
 *
 * Matching never prompts — a scheduled sync runs with nobody watching — so an
 * ambiguous match is decided toward the fullest account and reported here
 * instead. This replaces the old duplicate-account detector: duplicates can no
 * longer occur, but a wrong MATCH still can, and that is the residual risk
 * worth surfacing.
 */
export function detectAmbiguousMatches(db: Database.Database): Diagnostic[] {
  const rows = db.prepare(`
    SELECT a.natural_key AS naturalKey, COUNT(*) AS copies,
           GROUP_CONCAT(a.name || ' ••' || COALESCE(a.mask,'?'), ' | ') AS names
      FROM accounts a
     WHERE a.natural_key IS NOT NULL
     GROUP BY a.natural_key
    HAVING copies > 1
  `).all() as Array<{ naturalKey: string; copies: number; names: string }>;

  return rows.map((r) => ({
    severity: 'warning' as const,
    code: 'ambiguous-account-match',
    message: `${r.copies} accounts share one identity (${r.names})`,
    detail: [
      'A new connection matching this key was attached to whichever had the most',
      'transactions. If that was wrong, its history is split across two accounts.',
    ],
    remedy: 'Check whether these are genuinely different accounts. If they are the same, '
      + 'the older one can be retired; if not, nothing needs doing.',
  }));
}

/**
 * Connections that are live but contribute nothing.
 *
 * A re-link supersedes the connection it replaces: the newer one outranks it,
 * so none of the older one's rows are ever the ones chosen. It keeps
 * authenticating, keeps syncing, and — with Plaid — keeps billing monthly,
 * while every figure in every report comes from somewhere else.
 *
 * Nothing else notices. The accounts look healthy because a live connection
 * feeds them; it is simply not this one. Only a connection whose rows are
 * uniformly rejected by the view can be seen from here, which is exactly the
 * shape of "you replaced this and forgot to remove it".
 */
export function detectSupersededConnections(db: Database.Database): Diagnostic[] {
  const rows = db.prepare(`
    SELECT c.connection_id AS connectionId, c.provider_id AS providerId,
           c.external_id AS externalId, COUNT(t.txn_id) AS delivered
      FROM connections c
      JOIN sources s   ON s.connection_id = c.connection_id
      JOIN transactions t ON t.source_id = s.source_id
     WHERE c.active = 1
     GROUP BY c.connection_id
    HAVING delivered > 0
       AND NOT EXISTS (
         SELECT 1 FROM visible_transactions v
           JOIN sources s2 ON s2.source_id = v.source_id
          WHERE s2.connection_id = c.connection_id)
  `).all() as Array<{
    connectionId: string; providerId: string; externalId: string; delivered: number;
  }>;

  return rows.map((r) => ({
    severity: 'warning' as const,
    code: 'superseded-connection',
    message: `${r.providerId} connection ${r.externalId} supplies nothing — another connection covers all ${r.delivered} of its transactions`,
    detail: [
      'It still authenticates and still syncs, and with Plaid it still bills',
      'monthly, while every reported figure comes from the newer connection.',
    ],
    remedy: 'Almost certainly a link this one replaced. Remove it at the provider '
      + `(for Plaid: plaid item remove --item ${r.externalId} --force) so it stops billing. `
      + 'Nothing in the ledger depends on it.',
  }));
}

/** Severity order for display: the worst first. */
const SEVERITY_RANK: Record<Diagnostic['severity'], number> = {
  error: 0, warning: 1, info: 2,
};

/**
 * Every check, worst first.
 *
 * The ordering is deliberate rather than incidental. These are printed as a
 * list and read from the top, so a wrong TOTAL must not sit below a note about
 * an unused account. It used to depend on which detector happened to be listed
 * first, which held only while the first one happened to report errors — it
 * stopped being true the moment that detector was deleted, and nothing said so.
 *
 * A stable sort, so detectors keep their relative order within a severity and
 * the output does not shuffle between runs on the same data.
 */
/**
 * Money arriving in a spending category that no recent spending accounts for.
 *
 * A refund reduces the category it lands in, which is right for a returned
 * purchase. An insurance claim payout, a reimbursement or a tax refund filed
 * the same way is not a refund of anything — and once the payouts outweighed
 * three months of spending, the report printed spending as a negative number.
 * The totals now floor each category at zero, so this is about the label
 * rather than the arithmetic: say which rows were set aside and how to file
 * them, so the excess is not silently dropped.
 *
 * "No recent spending accounts for it" means the amount exceeds everything the
 * same category spent in the 90 days before it. Rows a person already
 * corrected are left alone.
 */
export function detectPayoutsInSpending(db: Database.Database, minCents = 50_000): Diagnostic[] {
  const rows = db.prepare(`
    SELECT t.date, t.amount_cents AS cents, t.category, t.description
      FROM visible_transactions t
     WHERE t.spend_group IN ('purchases','bills')
       AND t.amount_cents >= @minCents
       AND t.category_override IS NULL
       AND t.amount_cents > COALESCE((
         SELECT -SUM(p.amount_cents) FROM visible_transactions p
          WHERE p.category = t.category AND p.amount_cents < 0
            AND p.date < t.date AND p.date >= date(t.date, '-90 days')
       ), 0)
     ORDER BY t.date DESC
  `).all({ minCents }) as Array<{ date: string; cents: number; category: string; description: string }>;
  if (rows.length === 0) return [];

  const total = rows.reduce((sum, r) => sum + r.cents, 0);
  const sample = rows[0]!.description.replace(/\s+\d[\d\s]*.*$/, '').trim() || rows[0]!.description;
  return [{
    severity: 'warning',
    code: 'payouts-in-spending',
    message: `${rows.length} incoming amount(s), ${dollars(total)}, are filed as spending categories `
      + 'with no spending there to refund',
    detail: rows.slice(0, 8).map((r) => `${r.date}  ${dollars(r.cents)}  ${r.category}  ${r.description.slice(0, 40)}`),
    remedy: 'Spending totals set these aside rather than going negative, but they are probably '
      + 'payouts, reimbursements or income. File them as what they are, e.g. '
      + `\`finance categorize --match "${sample}" --category transfer --dry-run\` `
      + '(neither spending nor income) or `--category income`.',
  }];
}

export function runDiagnostics(db: Database.Database, now = new Date()): Diagnostic[] {
  return [
    ...detectUnlinkedCards(db),
    ...detectSupersededConnections(db),
    ...detectAmbiguousMatches(db),
    ...detectOrphans(db),
    ...detectSyncHealth(db, 3, now),
    ...detectEmptyAccounts(db),
    ...detectPayoutsInSpending(db),
  ].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}

export interface PruneResult { transactions: number; accounts: number }

/**
 * An account no connection reports any more — every source that tied it to a
 * provider is gone. Shared by the preview and the delete so the two cannot
 * disagree about what "orphaned" means.
 */
const ORPHAN_ACCOUNTS = `
  SELECT a.account_id FROM accounts a
   WHERE NOT EXISTS (
     SELECT 1 FROM sources s
       JOIN connections c ON c.connection_id = s.connection_id
       JOIN providers p ON p.provider_id = c.provider_id
      WHERE s.account_id = a.account_id)`;

/** A row whose account is missing, or is about to be removed as orphaned. */
const ORPHAN_TXNS = `
  account_id NOT IN (SELECT account_id FROM accounts)
  OR account_id IN (${ORPHAN_ACCOUNTS})`;

export interface PrunePreview extends PruneResult {
  /** Sum of |amount| across the rows that would go — what they currently distort. */
  cents: number;
}

/** What `prune` would remove, without removing it. */
export function previewPrune(db: Database.Database): PrunePreview {
  const txns = db.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(ABS(amount_cents)), 0) AS cents
       FROM transactions WHERE ${ORPHAN_TXNS}`,
  ).get() as { n: number; cents: number };
  const accounts = db.prepare(`SELECT COUNT(*) AS n FROM (${ORPHAN_ACCOUNTS})`).get() as { n: number };
  return { transactions: txns.n, accounts: accounts.n, cents: txns.cents };
}

/** Delete orphaned rows. Reports counts so a no-op is distinguishable from a fix. */
export function prune(db: Database.Database): PruneResult {
  const run = db.transaction(() => {
    // Transactions first and explicitly, so the count is right whether or not
    // foreign_keys is on to cascade them.
    const txn = db.prepare(`DELETE FROM transactions WHERE ${ORPHAN_TXNS}`).run();
    const acct = db.prepare(`DELETE FROM accounts WHERE account_id IN (${ORPHAN_ACCOUNTS})`).run();
    return { transactions: txn.changes, accounts: acct.changes };
  });
  return run();
}

// ── retiring an account ──────────────────────────────────────────────────────

export interface AccountRemovalPreview {
  accountId: string;
  name: string;
  mask: string | null;
  transactions: number;
  /** Corrections a person made by hand. These cannot be re-fetched. */
  categoryOverrides: number;
  notes: number;
  tags: number;
  earliest: string | null;
  latest: string | null;
}


