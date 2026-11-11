#!/usr/bin/env node
// The CLI. Same core as the MCP server — this is the entry point the OS
// scheduler calls, and the one you use to set things up.

import { Command } from 'commander';
import { existsSync, writeFileSync, mkdirSync, statSync, appendFileSync, readFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createInterface, type Interface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { bold, dim, green, red, yellow, cyan, step, links } from './style.js';
import { loadConfig, defaultConfig } from './core/config.js';
import { CATEGORIES, isCategory, type Category } from './core/normalize.js';
import { configPath, financeHome, ledgerPath, providerStateDir, expandPath } from './core/paths.js';
import {
  collectReportData, renderReport, resolveRange, todayIn, isPartialPeriod, type ReportPanel,
} from './core/report.js';
import { collectInsights, incomeCadence } from './core/insights.js';
import {
  runDiagnostics, prune, previewPrune, detectSupersededConnections,
} from './core/diagnostics.js';
import { computeBaseline, applyScenario, maxAffordable, principalFromPayment, monthlyFromAnnual, detectIncomeSpike } from './core/afford.js';
import { narrate } from './core/narrate.js';
import { deliver, emailDetails, headline, openInBrowser } from './core/deliver.js';
import { join, dirname } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  openLedger, setCategoryOverride, setNote, addTag, removeTag, normalizeTag,
  setConnectionActive,
} from './core/ledger.js';
import { listAccounts, getSpendingSummary, runReadOnlyQuery, queryTransactions, tagTotals, noDataReason, dataEndsEarly, dataEndsMessage } from './core/queries.js';
import { syncAll, backfillProvider } from './core/sync.js';
import { withLock } from './core/lock.js';
import { buildProviders } from './providers/registry.js';
import { getSecretsStore, defaultBackend, envVarFor, readSecret } from './core/secrets.js';
import { verifyCredentials, probeInvestments } from './providers/plaid/api.js';
import {
  attributeTransfers, netByAccount,
  type BankTransfer, type CashMovement,
} from './core/attribution.js';
import { writeCashMovements, readCashMovements } from './core/cashMovements.js';
import { ensureNotesFile, notesPath, readNotes } from './core/notes.js';
import {
  createProject, getProject, updateProject, closeProject, upsertVendor, listVendors,
  addLineItem, settleLineItem, setLineItemStatus, projectReport, allProjectReports,
} from './core/projects.js';
import { detectVests, monthlyNetEquity } from './core/equity.js';

/**
 * How far back to pull brokerage cash movements.
 *
 * Deliberately earlier than any plausible bank history: a transfer can only be
 * attributed if the movement behind it was fetched, and a window that starts
 * after the ledger does leaves the oldest transfers permanently unexplained.
 * Investments is billed as a per-Item subscription rather than per call, so a
 * wide window costs nothing extra.
 */
const DEFAULT_MOVEMENT_START = '2020-01-01';
import { readCliConfig, readCliKeys } from './providers/plaid/cliStore.js';
import {
  installSchedule, uninstallSchedule, scheduleStatus, parseTime,
} from './core/schedule.js';
import { EXAMPLE_CONFIG } from './core/exampleConfig.js';
import { VERSION } from './core/version.js';
import { preflight, previewCsv, csvAccountToml, slugify, enablePlaidToml } from './core/setup.js';

const program = new Command();
program
  .name('finance')
  .description('Local-first personal finance ledger with pluggable providers')
  .version(VERSION);

const money = (cents: number, currency = 'USD') =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);

// ── init ─────────────────────────────────────────────────────────────────────

program
  .command('init')
  .description('Create the config file and ledger')
  .action(() => {
    const path = configPath();
    mkdirSync(financeHome(), { recursive: true });
    if (existsSync(path)) {
      console.log(`Config already exists at ${path}`);
    } else {
      writeFileSync(path, EXAMPLE_CONFIG);
      console.log(`Wrote starter config to ${path}`);
    }
    openLedger().close();
    console.log(`Ledger ready at ${ledgerPath()}`);
    console.log('\nNext: edit the config to add an account, then run `finance sync`.');
  });

// ── sync ─────────────────────────────────────────────────────────────────────

program
  .command('sync')
  .description('Pull the latest data from every configured provider')
  .option('--automatic-only', 'Skip providers that need a manual file drop (used by the scheduler)')
  .action(async (opts: { automaticOnly?: boolean }) => {
    const config = loadConfig();
    const db = openLedger();
    const providers = buildProviders(config, {
      onCsvIssues: (issues) => {
        // Never silently drop rows — a skipped transaction is a wrong report.
        console.warn(yellow(`\n${issues.length} row(s) skipped:`));
        for (const issue of issues.slice(0, 20)) {
          console.warn(`  ${issue.file}:${issue.line} — ${issue.message}`);
        }
        if (issues.length > 20) console.warn(`  … and ${issues.length - 20} more`);
      },
    });

    if (providers.length === 0) {
      console.error(red('No providers configured. Run `finance doctor` to see what is missing.'));
      process.exitCode = 1;
      return;
    }

    const outcomes = await syncAll(db, providers, {
      timezone: config.timezone,
      automaticOnly: opts.automaticOnly,
      onProgress: (m) => console.log(m),
    });

    if (outcomes === null) {
      console.log('Another sync is already running — nothing to do.');
      return;
    }
    for (const o of outcomes) {
      if (o.error) {
        console.error(`${red('✗')} ${o.providerId}: ${red(o.error)}`);
        process.exitCode = 1;
      } else {
        console.log(`${green('✓')} ${o.providerId}: +${o.added} added, ${o.modified} modified, ${o.removed} removed`);
      }
      // Printed for a successful sync too. A dead connection does not fail the
      // run — the healthy ones still wrote their data — but it produces "+0
      // added" indefinitely, which reads as a quiet week rather than a bank
      // that stopped answering. Exit non-zero so a scheduler notices as well.
      for (const issue of o.issues ?? []) {
        console.error(yellow(`  ! ${issue}`));
        process.exitCode = 1;
      }
    }
    db.close();

    // Refresh the brokerage cash-movement cache while the network is already in
    // hand. The report is generated offline, so sync is its only chance to
    // learn which sub-account a transfer came from. Best-effort throughout: a
    // brokerage that will not answer must not fail a sync that already
    // succeeded — it just leaves the transfer breakdown as it was.
    try {
      const fetched = await fetchCashMovements(DEFAULT_MOVEMENT_START);
      if (!fetched.reason && fetched.movements.length > 0) {
        console.log(`  ${fetched.movements.length} brokerage cash movement(s) cached`);
      }
    } catch (err) {
      console.warn(`  brokerage cash movements not refreshed: ${(err as Error).message}`);
    }
  });

// ── link ─────────────────────────────────────────────────────────────────────

program
  .command('link')
  .description('Connect an account (opens the provider\'s login flow in a browser)')
  .option('--provider <id>', 'Which provider to link with (default: the only automatic one)')
  .option('--history <months>', 'Backfill this many months right after linking', '24')
  .option('--resume', 'Claim a link whose wait timed out after you finished signing in')
  .option('--open', 'Open the link URL in your browser (off by default — the URL is printed)')
  .option('--products <list>', 'Plaid products to request, comma-separated. '
    + 'Default: transactions. Use "investments" for a brokerage — many '
    + 'do NOT offer transactions, so asking for it makes them unselectable in Link.')
  .option('--days <days>', 'History to REQUEST when creating the connection (max 730). '
    + 'Without this, providers use their default — commonly 90 days — and the limit is '
    + 'permanent for that connection.')
  .option('--no-history', 'Skip the history backfill')
  .action(async (opts: LinkOptions) => {
    if (!await linkAccount(opts)) process.exitCode = 1;
  });

interface LinkOptions {
  provider?: string; history?: string | false; days?: string; open?: boolean;
  products?: string; resume?: boolean;
}

/**
 * Link one connection and load its history. Shared by `finance link` and
 * `finance setup`, which used to print this as a command to run next — and the
 * printed steps did not work on a fresh config. Returns false on failure, having
 * already said why.
 */
async function linkAccount(opts: LinkOptions): Promise<boolean> {
  const config = loadConfig();
  const db = openLedger();
  try {
    let daysRequested: number | undefined;
    if (opts.days !== undefined) {
      daysRequested = Number(opts.days);
      if (!Number.isInteger(daysRequested) || daysRequested < 1 || daysRequested > 730) {
        console.error(`--days must be a whole number between 1 and 730, got "${opts.days}".`);
        return false;
      }
    }

    const linkable = buildProviders(config, {
      daysRequested,
      onProgress: (m) => console.log(links(m)),
      // Off unless asked. A tool that launches windows on your machine has to
      // earn that, and the URL is printed either way — the convenience is not
      // worth wondering what opened something.
      openBrowser: opts.open === true,
      ...(opts.products ? { linkProducts: opts.products.split(',').map((x) => x.trim()) } : {}),
      ...(opts.resume ? { resume: true } : {}),
    }).filter((p) => p.link && p.capabilities.automatic);

    const provider = opts.provider
      ? linkable.find((p) => p.id === opts.provider)
      : linkable[0];

    if (!provider) {
      console.error(linkable.length === 0
        ? 'No provider supports linking. Enable one (e.g. plaid) in the config first.'
        : `Unknown provider "${opts.provider}". Available: ${linkable.map((p) => p.id).join(', ')}`);
      return false;
    }

    console.log(`Opening ${provider.id} link flow — complete it in your browser…\n`);
    const result = await provider.link!({
      providerId: provider.id,
      stateDir: providerStateDir(provider.id),
      timezone: config.timezone,
      getSecret: (key) => readSecret(provider.id, key),
    });

    console.log(result.message);
    if (!result.ok) {
      return false;
    }

    // An investments-only link has no transactions to backfill — many
    // brokerages do not offer the product at all — so the history step would ask
    // for something that cannot exist and report an empty result as failure.
    const wantsTransactions = !opts.products
      || opts.products.split(',').some((x) => x.trim() === 'transactions');
    if (!wantsTransactions) {
      console.log('\nLinked. This connection has no transactions product, so there is no');
      console.log('history to load. Inspect what it does provide with:');
      console.log('  finance connections probe <connection_id>');
      return true;
    }

    // A fresh link with no history is a ledger that can answer nothing about the
    // past, and most people want exactly that on day one. Cursor-based sync
    // cannot reach backwards, so this is a date-range fetch.
    if (opts.history === false || !provider.backfill) {
      console.log('\nRun `finance sync` to pull transactions.');
      return true;
    }

    const months = Number(opts.history);
    if (!Number.isFinite(months) || months <= 0) {
      console.error(`--history must be a positive number of months, got "${opts.history}"`);
      return false;
    }
    const until = new Date();
    const since = new Date(until);
    since.setMonth(since.getMonth() - months);
    const ymd = (d: Date) => d.toISOString().slice(0, 10);

    // Wait for the provider to finish fetching before asking for it. Plaid
    // pulls history asynchronously after a link, so a backfill run immediately
    // returns about 90 days however much was requested — which reads as the
    // request being ignored rather than as being early. This is the whole
    // reason `link` used to need a second command run by hand later.
    if (provider.awaitHistory) {
      console.log('\nWaiting for the provider to finish fetching history…');
      const ready = await provider.awaitHistory({
        providerId: provider.id,
        stateDir: providerStateDir(provider.id),
        timezone: config.timezone,
        getSecret: (key) => readSecret(provider.id, key),
      }, {
        startDate: ymd(since),
        endDate: ymd(until),
        onProgress: (m) => console.log(m),
      });
      console.log(ready.settled
        ? `  ready — ${ready.transactions} transactions available.`
        : `  still arriving after the wait (${ready.transactions} so far). Loading what there is; `
          + 're-run `finance backfill --since ' + ymd(since) + '` in a few minutes for the rest.');
    }

    console.log(`\nLoading ${months} months of history (${ymd(since)} → ${ymd(until)})…`);
    const outcome = await backfillProvider(db, provider, config.timezone, ymd(since), ymd(until));
    if (outcome.error) {
      // The link itself succeeded, so say so — otherwise it reads as a total
      // failure and the user re-links an account that is already connected.
      console.error(`${red('✗')} history load failed: ${red(outcome.error)}`);
      console.error('  The account IS linked. Retry with `finance backfill --since <date>`.');
      return false;
    } else {
      console.log(`${green('✓')} ${outcome.added} transaction(s) loaded.`);
      reportCoverage(outcome.coverage, ymd(since), months);

      // The moment to say this is now, while they still have the context.
      // `finance doctor` reports it too, but only for someone who thinks to
      // run it — and a connection nobody looks at is exactly the one that
      // keeps billing. Checked AFTER the backfill, because until the new
      // connection has the data the old one is not yet superseded.
      const superseded = detectSupersededConnections(db);
      if (superseded.length > 0) {
        console.log('\n' + '─'.repeat(64));
        for (const d of superseded) {
          console.log(`\n${d.message}`);
          for (const line of d.detail ?? []) console.log(`  ${line}`);
          console.log(`\n  ${d.remedy}`);
        }
        console.log('\n' + '─'.repeat(64));
      }
    }
    return true;
  } finally {
    db.close();
  }
}

/**
 * Say what history actually arrived, and how far short of the request it fell.
 *
 * Plaid fixes an Item's available history at creation via `days_requested`,
 * which the Plaid CLI does not expose — so the default ~90 days is what comes
 * back however many months are asked for. Silence here is the expensive part:
 * the ledger looks two years deep, and every average over it is quietly taken
 * from one quarter.
 */
function reportCoverage(
  coverage: { earliest: string; latest: string } | null | undefined,
  requestedSince: string,
  requestedMonths: number,
): void {
  if (!coverage) return;
  console.log(`  covering ${coverage.earliest} → ${coverage.latest}`);

  const shortfallDays = Math.round(
    (Date.parse(coverage.earliest) - Date.parse(requestedSince)) / 86_400_000,
  );
  if (shortfallDays <= 31) return; // a month's slack: banks vary on how far back they post

  const got = Math.round(
    (Date.parse(coverage.latest) - Date.parse(coverage.earliest)) / 86_400_000,
  );
  console.log('');
  console.log(`  ⚠ you asked for ${requestedMonths} months and received about ${Math.round(got / 30)}.`);
  console.log('    Providers cap how far back a new connection can reach, and the limit is');
  console.log('    fixed when the account is linked — re-running this will not go deeper.');
  console.log('    Averages over this ledger cover the shorter span, not what you asked for.');
}

// ── backfill ─────────────────────────────────────────────────────────────────

program
  .command('backfill')
  .description('Re-fetch a date range, ignoring cursors (recovery + loading history)')
  .requiredOption('--since <date>', 'YYYY-MM-DD')
  .option('--until <date>', 'YYYY-MM-DD (defaults to today)')
  .action(async (opts: { since: string; until?: string }) => {
    const config = loadConfig();
    const db = openLedger();
    const until = opts.until ?? new Date().toISOString().slice(0, 10);
    const providers = buildProviders(config).filter((p) => p.backfill);

    if (providers.length === 0) {
      console.error('No configured provider supports backfill.');
      process.exitCode = 1;
      return;
    }

    const outcomes = await withLock('backfill', async () => {
      const results = [];
      for (const provider of providers) {
        console.log(`backfilling ${provider.id} ${opts.since} → ${until}…`);
        results.push(await backfillProvider(db, provider, config.timezone, opts.since, until));
      }
      return results;
    });

    if (outcomes === null) {
      console.log('A sync is already running — try again once it finishes.');
      return;
    }
    for (const o of outcomes) {
      if (o.error) {
        console.error(`${red('✗')} ${o.providerId}: ${red(o.error)}`);
        process.exitCode = 1;
      } else {
        console.log(`${green('✓')} ${o.providerId}: ${o.added} transaction(s) written`);
        const months = Math.max(1, Math.round(
          (Date.parse(until) - Date.parse(opts.since)) / (86_400_000 * 30),
        ));
        reportCoverage(o.coverage, opts.since, months);
      }
    }
    db.close();
  });

// ── accounts ─────────────────────────────────────────────────────────────────

program
  .command('accounts')
  .description('List linked accounts')
  .action(() => {
    const db = openLedger();
    const accounts = listAccounts(db);
    if (accounts.length === 0) {
      console.log('No accounts yet. Configure a provider and run `finance sync`.');
      return;
    }
    for (const a of accounts) {
      const mask = a.mask ? ` ••${a.mask}` : '';
      const range = a.earliestDate ? ` ${a.earliestDate} → ${a.latestDate}` : ' (no transactions)';
      // Say when more than one connection feeds an account. That is normal —
      // two logins at one bank, or a re-link — but it is also the state where
      // a wrong match would hide, so it is worth being visible rather than
      // silently folded away.
      const via = a.connectionCount > 1
        ? ` [${a.providers} ×${a.connectionCount}]`
        : ` [${a.providers ?? 'no active connection'}]`;
      console.log(`${a.name}${mask} ${via}  ${a.transactionCount} txns${range}`);
    }
    db.close();
  });

/**
 * Say "no data" instead of printing a total, when the ledger has no accounts.
 * Returns true when the caller should stop. Exits non-zero because the command
 * did not produce what was asked for — a script checking $? should not mistake
 * it for a quiet month.
 */
function stopIfNoData(db: ReturnType<typeof openLedger>, json = false): boolean {
  const reason = noDataReason(db);
  if (!reason) return false;
  if (json) console.log(JSON.stringify({ noData: reason }, null, 2));
  else console.log(`\n${reason}\n`);
  process.exitCode = 1;
  db.close();
  return true;
}

// ── summary ──────────────────────────────────────────────────────────────────

program
  .command('summary')
  .description('Spending summary for a date range')
  .option('--start <date>', 'YYYY-MM-DD (or use --range)')
  .option('--end <date>', 'YYYY-MM-DD (defaults to today)')
  .option('--range <name>', 'last-7-days | last-30-days | last-90-days | month-to-date | year-to-date | all')
  .action((opts: { start?: string; end?: string; range?: string }) => {
    const db = openLedger();
    if (stopIfNoData(db)) return;
    const today = todayIn(loadConfig().timezone);
    const r = opts.start
      ? { start: opts.start, end: opts.end ?? today }
      : resolveRange((opts.range ?? 'last-30-days') as never, today, db);
    const s = getSpendingSummary(db, r.start, r.end);

    console.log(`\n${bold(`Spending ${s.startDate} → ${s.endDate}`)}`);
    console.log(`  Total: ${bold(money(s.spendingCents, s.currency))} across ${s.transactionCount} transactions`);
    if (s.cardPaymentsCounted) {
      // Say so, or linking a card later looks like the total dropped for no reason.
      // "No card is linked" is often false. The card IS linked and simply has
      // no data reaching this far back, which is a different problem with a
      // different fix — and telling someone to link a card they already
      // linked sends them to do it again.
      const cardGap = s.coverageGaps.some((g) => g.type === 'credit');
      console.log(cardGap
        ? '  (includes credit-card payments — your cards have no data this far back, so the'
        : '  (includes credit-card payments — no card is linked, so the payment is the');
      console.log(cardGap
        ? '   payment is the only record of what was spent on it in this window.)'
        : '   only record of what was spent on it. Link the card for real categories.)');
    }

    // Income arrives on a cadence; most spending does not. A window that
    // catches one payday fewer than usual makes the net look like overspending
    // when nothing about the spending changed.
    // Not when the ledger stops early: missing paydays are then missing data,
    // and "LOW for calendar reasons alone" would be the wrong explanation.
    const cadence = s.dataEnds ? null : incomeCadence(db, s.startDate, s.endDate);
    if (cadence && Math.abs(cadence.observed - cadence.expected) >= 0.5) {
      const short = cadence.observed < cadence.expected;
      console.log('');
      console.log(yellow(`  ! this window holds ${cadence.observed} pay deposit(s); a ${
        Math.round((Date.parse(s.endDate) - Date.parse(s.startDate)) / 86_400_000) + 1
      }-day window ${cadence.daysOfMonth ? 'holds' : 'usually holds'} ${cadence.expected}`));
      const ordinal = (d: number) => (d === 31 ? 'last day'
        : `${d}${d % 10 === 1 && d !== 11 ? 'st' : d % 10 === 2 && d !== 12 ? 'nd' : d % 10 === 3 && d !== 13 ? 'rd' : 'th'}`);
      console.log(cadence.daysOfMonth
        ? `    You are paid on the ${cadence.daysOfMonth.map(ordinal).join(' and ')} of the month, so income here is`
        : `    You are paid about every ${cadence.medianGapDays} days, so income here is`);
      console.log(`    ${short ? 'LOW' : 'HIGH'} by roughly ${money(cadence.typicalCents)} for calendar reasons alone —`);
      console.log('    the net figure is not a change in behaviour.');
    }

    if (s.dataEnds) {
      console.log('');
      console.log(yellow(`  ! ${dataEndsMessage(s.dataEnds)}`));
    }

    // The caveat goes with the number, every time it is shown. A total that
    // several accounts cannot speak for is not wrong so much as incomparable —
    // reading it beside a later one measures coverage, not behaviour.
    if (s.coverageGaps.length > 0) {
      console.log('');
      console.log(yellow(`  ! ${s.coverageGaps.length} account(s) hold no data for part of this window:`));
      for (const g of s.coverageGaps) {
        console.log(`      ${g.name}${g.mask ? ` ••${g.mask}` : ''} — starts ${g.earliest},`
          + ` missing the first ${g.missingDays} day(s)`);
      }
      console.log('    This total is lower than reality by whatever they spent, and cannot');
      console.log('    be compared with a window they do cover.');
    }
    console.log('');

    for (const c of s.byCategory) {
      console.log(`  ${c.category.padEnd(24)} ${money(c.amountCents, s.currency).padStart(12)}  (${c.count})`);
    }

    if (s.incomeCents) console.log(`\n  Income: ${money(s.incomeCents, s.currency)}`);
    // Shown but never folded into the total — see getSpendingSummary.
    if (s.excluded.paymentsCents || s.excluded.transfersCents) {
      console.log(`\n  ${bold('Excluded from spending')} ${dim('(internal movement, not new spend)')}`);
      console.log(`    credit-card payments ${money(s.excluded.paymentsCents, s.currency)}`);
      console.log(`    transfers          ${money(s.excluded.transfersCents, s.currency)}`);
    }
    if (s.excluded.refundsBeyondSpendingCents) {
      // Said, not dropped: money that arrived in a spending category beyond what
      // that category spent — a payout or reimbursement, not a refund.
      console.log(`\n  Set aside: ${money(s.excluded.refundsBeyondSpendingCents, s.currency)} arrived in spending categories`);
      console.log('    beyond what they spent here — likely payouts or reimbursements, so counted as');
      console.log('    neither spending nor income. `finance doctor` lists any large enough to matter.');
    }
    db.close();
  });

// ── insights ─────────────────────────────────────────────────────────────────

program
  .command('insights')
  .description('Trends, recurring charges, outliers and large items — no AI, no network')
  .option('--start <date>', 'YYYY-MM-DD (or use --range)')
  .option('--end <date>', 'YYYY-MM-DD (defaults to today)')
  .option('--range <name>', 'last-7-days | last-30-days | last-90-days | month-to-date | year-to-date | all')
  .option('--json', 'Emit the raw brief (for piping, or handing to a model)')
  .action((opts: { start?: string; end?: string; range?: string; json?: boolean }) => {
    const db = openLedger();
    if (stopIfNoData(db, opts.json)) return;
    const today = todayIn(loadConfig().timezone);
    const r = opts.start
      ? { start: opts.start, end: opts.end ?? today }
      : resolveRange((opts.range ?? 'last-30-days') as never, today, db);
    const brief = collectInsights(db, r.start, r.end);
    const ends = dataEndsEarly(db, r.end);
    db.close();

    if (opts.json) {
      console.log(JSON.stringify(brief, null, 2));
      return;
    }

    const pct = (v: number | null) => (v === null ? 'new' : `${v > 0 ? '+' : ''}${v}%`);
    console.log(`\n${bold(`Insights ${brief.period.start} → ${brief.period.end}`)}`);
    console.log(`  Spending ${money(brief.spendingCents)}`
      + (brief.priorPeriodComparable
        ? ` (${pct(brief.spendingChangePct)} vs prior ${brief.priorPeriod.start} → ${brief.priorPeriod.end})`
        : ''));
    console.log(`  Income   ${money(brief.incomeCents)}   Net ${money(brief.netCents)}`);
    if (ends) console.log(yellow(`  ! ${dataEndsMessage(ends)}`));
    if (!brief.priorPeriodComparable) {
      // Saying nothing would imply the comparison was made and found nothing.
      console.log(ends ? '  (no comparison — this window is not covered to its end)'
      : `  (no comparison — the ledger does not reach back to ${brief.priorPeriod.start})`);
    }

    if (brief.concentration.length) {
      console.log(`\n  ${bold('Where it concentrates')}`);
      for (const c of brief.concentration) {
        console.log(`    ${c.category.padEnd(22)} ${money(c.cents).padStart(12)}  ${String(c.pctOfTotal).padStart(3)}% of spending`);
      }
    }

    const movers = brief.trends.filter((t) => Math.abs(t.changeCents) >= 10_000).slice(0, 6);
    if (movers.length) {
      console.log(`\n  ${bold('Biggest changes vs prior period')}`);
      for (const t of movers) {
        console.log(`    ${t.category.padEnd(22)} ${money(t.changeCents).padStart(12)}  (${pct(t.changePct)})`);
      }
    }

    if (brief.recurring.length) {
      console.log(`\n  ${bold('Recurring')}`);
      for (const r of brief.recurring.slice(0, 8)) {
        console.log(`    ${r.merchant.slice(0, 30).padEnd(32)} ${money(r.medianCents).padStart(10)} × ${r.occurrences}  ~every ${r.cadenceDays}d`);
      }
    }

    if (brief.unusual.length) {
      console.log(`\n  ${bold('Unusual for their category')}`);
      for (const u of brief.unusual) {
        console.log(`    ${u.date}  ${money(u.amountCents).padStart(11)}  ${u.description.slice(0, 34).padEnd(36)} ${u.multiple.toFixed(1)}× typical ${u.category}`);
      }
    }

    if (brief.newMerchants.length) {
      console.log(`\n  ${bold('First seen this period')}`);
      for (const m of brief.newMerchants.slice(0, 6)) {
        console.log(`    ${m.merchant.slice(0, 34).padEnd(36)} ${money(m.totalCents).padStart(11)}  (${m.count})`);
      }
    }
    console.log('');
  });

// ── report ───────────────────────────────────────────────────────────────────

program
  .command('report')
  .description('Generate a self-contained HTML report (no server, no network)')
  .option('--start <date>', 'YYYY-MM-DD (or use --range)')
  .option('--end <date>', 'YYYY-MM-DD (defaults to today)')
  .option('--range <name>', 'last-7-days | last-30-days | last-90-days | month-to-date | year-to-date | all')
  .option('--out <path>', 'Where to write it (default: reports/ under the data dir)')
  .option('--open', 'Open it in the default browser when done')
  .option('--ai', 'Add an AI analysis section (runs the command in [narration])')
  .option('--no-ai', 'Skip AI analysis even if enabled in config')
  .action((opts: { start?: string; end?: string; range?: string; out?: string; open?: boolean; ai?: boolean }) => {
    const config = loadConfig();
    const db = openLedger();
    if (stopIfNoData(db)) return;

    // --start/--end win; otherwise a named range; otherwise the configured one.
    // `all` needs the db to find the earliest transaction it actually holds.
    const today = todayIn(config.timezone);
    const resolved = opts.start
      ? { start: opts.start, end: opts.end ?? today }
      : resolveRange((opts.range ?? config.report.range) as never, today, db);

    // The chosen range leads; the others become tabs, so one file answers
    // "this month" and "everything" without regenerating.
    const panels = buildPanels(db, resolved, Boolean(opts.start), today);

    // --ai / --no-ai override the config; otherwise the config decides.
    let narration;
    const wantAi = opts.ai ?? config.narration.enabled;
    if (wantAi) {
      console.log(`Asking \`${config.narration.command}\` for an analysis…`);
      narration = narrate(insightsForNarration(db, resolved.start, resolved.end), { ...config.narration, enabled: true });
      if (!narration.ok) {
        // Never fatal — the report is fully useful without it.
        console.warn(`  analysis unavailable: ${narration.error}`);
      }
    }
    db.close();

    const target = opts.out
      ? expandPath(opts.out)
      : join(financeHome(), 'reports', `report-${resolved.start}_${resolved.end}.html`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, renderReport(panels, narration));

    console.log(`Wrote ${target}` + (panels.length > 1 ? ` (${panels.length} ranges)` : ''));
    if (opts.open) {
      // The delivery channel's opener, which knows Linux and Windows too — this
      // called macOS's `open` directly and failed everywhere else.
      const opened = openInBrowser(target);
      if (!opened.ok) console.warn(`  could not open it: ${opened.detail}`);
    }
  });

/**
 * The chosen range plus the standard comparison windows, as tabs.
 *
 * An explicit --start/--end means the user asked for exactly that window, so it
 * is rendered alone. Named ranges get company: one file then answers "this
 * month" and "everything" without regenerating.
 */
function buildPanels(
  db: ReturnType<typeof openLedger>,
  resolved: { start: string; end: string },
  exact: boolean,
  today: string,
): ReportPanel[] {
  const primary: ReportPanel = {
    id: 'primary',
    label: `${resolved.start} → ${resolved.end}`,
    data: collectReportData(db, resolved.start, resolved.end),
  };
  if (exact) return [primary];

  const extras: Array<{ id: string; label: string; range: string }> = [
    { id: 'mtd', label: 'Month to date', range: 'month-to-date' },
    { id: 'd90', label: 'Last 90 days', range: 'last-90-days' },
    { id: 'all', label: 'All time', range: 'all' },
  ];

  const panels = [primary];
  for (const extra of extras) {
    const r = resolveRange(extra.range as never, today, db);
    // Skip a window identical to one already shown.
    if (panels.some((p) => p.data.startDate === r.start && p.data.endDate === r.end)) continue;
    panels.push({
      id: extra.id,
      label: extra.label,
      data: collectReportData(db, r.start, r.end),
      partial: isPartialPeriod(extra.range as never),
    });
  }
  return panels;
}

/**
 * The SMTP password for the scheduled run, or null.
 *
 * Only looked up when smtp is a channel, so a keychain that is locked or
 * prompting cannot stall a run that would never use it. When it fails, the
 * other channels still go — the failure is logged and smtp reports itself.
 */
function smtpPassword(channels: readonly string[]): string | null {
  if (!channels.includes('smtp')) return null;
  try {
    return readSecret('smtp', 'password');
  } catch (err) {
    console.log(`✗ keystore: ${(err as Error).message}`);
    return null;
  }
}

// ── run (the scheduled job) ──────────────────────────────────────────────────

program
  .command('run')
  .description('Sync, build the report, and deliver it — what the scheduler invokes')
  .option('--dry-run', 'Do everything except deliver')
  .action(async (opts: { dryRun?: boolean }) => {
    const config = loadConfig();
    const db = openLedger();

    const syncIssues: string[] = [];
    // 1. Sync. A failure here is worth reporting but not worth skipping the
    //    report over — yesterday's data still answers most questions.
    const providers = buildProviders(config);
    if (providers.length > 0) {
      const outcomes = await syncAll(db, providers, {
        timezone: config.timezone,
        automaticOnly: true,
      });
      for (const o of outcomes ?? []) {
        console.log(o.error ? `✗ sync ${o.providerId}: ${o.error}` : `✓ sync ${o.providerId}: +${o.added}`);
        // The scheduled path, so this is the only place a dead connection can
        // surface. Also collected for the report, because a log nobody opens is
        // not a notification.
        for (const issue of o.issues ?? []) console.log(`  ! ${issue}`);
      }
      syncIssues.push(...(outcomes ?? []).flatMap((o) => o.issues ?? []));
    }

    // A daily mail reading "$0 spent" would be the worst thing this job could
    // send. Stop before the report, loudly, so the scheduler log shows why.
    if (stopIfNoData(db)) return;

    // 2. Check the numbers before reporting them.
    //
    //    A diagnostic that only speaks when someone types `finance doctor` is
    //    a diagnostic nobody reads — and this is the one job that runs every
    //    day with nobody watching, which is exactly when a silent sync failure
    //    or a card that stopped reporting turns a wrong number into a habit.
    //    Errors and warnings ride along with the report; info stays quiet, or
    //    the daily mail teaches people to ignore it.
    const problems = runDiagnostics(db).filter((d) => d.severity !== 'info');
    for (const d of problems) console.log(`  ! ${d.message}`);

    // 3. Report.
    const today = todayIn(config.timezone);
    const { start, end } = resolveRange(config.report.range, today, db);
    const panels = buildPanels(db, { start, end }, false, today);
    const data = panels[0]!.data;

    let narration;
    // The same gate the `report` command uses. These were different — `report`
    // read narration.enabled while `run` read report.ai — so a config setting
    // one and not the other produced an analysis by hand and none on a
    // schedule, which is the hardest version of this to notice.
    if (config.report.ai ?? config.narration.enabled) {
      narration = narrate(insightsForNarration(db, start, end), { ...config.narration, enabled: true });
      if (!narration.ok) console.warn(`  analysis unavailable: ${narration.error}`);
    }
    db.close();

    const target = join(financeHome(), 'reports', `report-${start}_${end}.html`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, renderReport(panels, narration));
    console.log(`${green('✓')} report ${target}` + (panels.length > 1 ? ` (${panels.length} ranges)` : ''));

    const summary = {
      spendingCents: data.summary.spendingCents,
      incomeCents: data.summary.incomeCents,
      netCents: data.summary.incomeCents - data.summary.spendingCents,
      startDate: start, endDate: end, reportPath: target,
      details: emailDetails(data, narration),
      // A connection that stopped answering belongs in the same list as any
      // other problem, so the delivered summary says "2 issues" instead of
      // reporting a clean run over a dead bank link.
      ...((problems.length + syncIssues.length)
        ? { problems: [...problems.map((d) => d.message), ...syncIssues] }
        : {}),
    };
    console.log(`  ${headline(summary)}`);

    // 3. Deliver. Never fatal — the report is already on disk.
    if (opts.dryRun) {
      console.log(`  (dry run — would deliver via: ${config.report.deliver.join(', ') || 'nothing'})`);
      return;
    }
    const outcomes2 = await deliver(config.report.deliver, summary, {
      emailTo: config.report.emailTo,
      sendEmail: config.report.sendEmail,
      copyTo: config.report.copyTo,
      command: config.report.command,
      commandArgs: config.report.commandArgs,
      smtp: config.report.smtp,
      smtpPassword: smtpPassword(config.report.deliver),
    }, {
      // Log as each finishes. Collecting first meant a single hung channel
      // hid the ones that had already succeeded, making a partial run look
      // identical to one that never got started.
      onOutcome: (o) => console.log(o.ok ? `✓ ${o.channel}: ${o.detail}` : `✗ ${o.channel}: ${o.detail}`),
    });
    if (outcomes2.some((o) => !o.ok)) process.exitCode = 1;

    // Exit explicitly once the work is done. A lingering handle — an SMTP
    // socket, a spawned helper — would otherwise keep a scheduled job alive
    // forever, and a wedged LaunchAgent silently skips the following days.
    // stdout is flushed first: writing to a log file is buffered, so exiting
    // without this loses the last lines, which is how a hung run looks
    // identical to a run that never finished its work.
    // Only wait when there is genuinely pending output: the callback form of
    // an empty write is not guaranteed to fire, which would hang here forever
    // — the very failure this block exists to prevent.
    if (!process.stdout.write('')) {
      await new Promise<void>((resolve) => process.stdout.once('drain', () => resolve()));
    }
    process.exit(process.exitCode ?? 0);
  });

// ── query ────────────────────────────────────────────────────────────────────

program
  .command('query <sql>')
  .description('Run a read-only SELECT against the ledger')
  .action((sql: string) => {
    const db = openLedger();
    try {
      const { columns, rows, truncated } = runReadOnlyQuery(db, sql);
      console.log(columns.join('\t'));
      for (const row of rows) console.log(row.map((v) => String(v ?? '')).join('\t'));
      if (truncated) console.log('… truncated');
    } catch (err) {
      console.error(`Query rejected: ${(err as Error).message}`);
      process.exitCode = 1;
    }
    db.close();
  });

// ── categorize ───────────────────────────────────────────────────────────────

program
  .command('categorize')
  .description('Reclassify transactions matching a description substring')
  .requiredOption('--match <text>', 'Case-insensitive substring of the description')
  .requiredOption('--category <name>', `One of: ${CATEGORIES.join(', ')}`)
  .option('--dry-run', 'Show what would change without writing')
  .action((opts: { match: string; category: string; dryRun?: boolean }) => {
    if (!isCategory(opts.category)) {
      console.error(`Unknown category "${opts.category}".\nValid: ${CATEGORIES.join(', ')}`);
      process.exitCode = 1;
      return;
    }
    const db = openLedger();
    const matches = queryTransactions(db, { search: opts.match, limit: 5_000 });

    if (matches.length === 0) {
      console.log(`No transactions match "${opts.match}".`);
      db.close();
      return;
    }

    const total = matches.reduce((sum, t) => sum + t.amountCents, 0);
    console.log(`${matches.length} transaction(s), ${money(total)} total:`);
    for (const t of matches.slice(0, 10)) {
      console.log(`  ${t.date}  ${money(t.amountCents).padStart(12)}  ${t.description.slice(0, 44)}`);
    }
    if (matches.length > 10) console.log(`  … and ${matches.length - 10} more`);

    if (opts.dryRun) {
      console.log(`\nDry run — would set all to "${opts.category}". Re-run without --dry-run to apply.`);
      db.close();
      return;
    }

    // Written as overrides, so a future sync cannot undo them.
    const apply = db.transaction(() => {
      for (const t of matches) setCategoryOverride(db, t.txnId, opts.category as Category);
    });
    apply();
    console.log(`\nSet ${matches.length} transaction(s) to "${opts.category}". Overrides survive future syncs.`);
    db.close();
  });

// ── note / tag ───────────────────────────────────────────────────────────────

program
  .command('note')
  .description('Attach context to transactions matching a description substring')
  .requiredOption('--match <text>', 'Case-insensitive substring of the description')
  .requiredOption('--text <note>', 'The note (use "" to clear)')
  .action((opts: { match: string; text: string }) => {
    const db = openLedger();
    const matches = queryTransactions(db, { search: opts.match, limit: 5_000 });
    if (matches.length === 0) {
      console.log(`No transactions match "${opts.match}".`);
      db.close();
      return;
    }
    const apply = db.transaction(() => {
      for (const t of matches) setNote(db, t.txnId, opts.text || null);
    });
    apply();
    for (const t of matches.slice(0, 5)) {
      console.log(`  ${t.date}  ${money(t.amountCents).padStart(11)}  ${t.description.slice(0, 40)}`);
    }
    if (matches.length > 5) console.log(`  … and ${matches.length - 5} more`);
    console.log(`\n${opts.text ? 'Noted' : 'Cleared the note on'} ${matches.length} transaction(s).`);
    db.close();
  });

const tagCmd = program.command('tag').description('Tag transactions — cuts across categories');

tagCmd
  .command('add <tag>')
  .description('Tag every transaction matching a description substring')
  .requiredOption('--match <text>', 'Case-insensitive substring of the description')
  .option('--note <text>', 'Also attach this note to the same transactions')
  .action((tag: string, opts: { match: string; note?: string }) => {
    const db = openLedger();
    const matches = queryTransactions(db, { search: opts.match, limit: 5_000 });
    if (matches.length === 0) {
      console.log(`No transactions match "${opts.match}".`);
      db.close();
      return;
    }
    const normalized = normalizeTag(tag);
    const total = matches.reduce((sum, t) => sum + t.amountCents, 0);
    const apply = db.transaction(() => {
      for (const t of matches) {
        addTag(db, t.txnId, normalized);
        if (opts.note) setNote(db, t.txnId, opts.note);
      }
    });
    apply();
    for (const t of matches.slice(0, 8)) {
      console.log(`  ${t.date}  ${money(t.amountCents).padStart(11)}  ${t.description.slice(0, 40)}`);
    }
    if (matches.length > 8) console.log(`  … and ${matches.length - 8} more`);
    console.log(`\nTagged ${matches.length} transaction(s) "${normalized}" — ${money(total)} total.`);
    db.close();
  });

tagCmd
  .command('rm <tag>')
  .description('Remove a tag from transactions matching a description substring')
  .requiredOption('--match <text>', 'Case-insensitive substring of the description')
  .action((tag: string, opts: { match: string }) => {
    const db = openLedger();
    const matches = queryTransactions(db, { search: opts.match, limit: 5_000 });
    let removed = 0;
    const apply = db.transaction(() => {
      for (const t of matches) if (removeTag(db, t.txnId, tag)) removed++;
    });
    apply();
    console.log(`Removed "${normalizeTag(tag)}" from ${removed} transaction(s).`);
    db.close();
  });

tagCmd
  .command('list')
  .description('What each tag cost')
  .option('--start <date>', 'YYYY-MM-DD')
  .option('--end <date>', 'YYYY-MM-DD')
  .action((opts: { start?: string; end?: string }) => {
    const db = openLedger();
    const totals = tagTotals(db, opts.start, opts.end);
    if (totals.length === 0) {
      console.log('No tags yet. Try: finance tag add emergency-home --match "HANDYMAN"');
      db.close();
      return;
    }
    console.log('');
    for (const t of totals) {
      console.log(`  ${t.tag.padEnd(24)} ${money(t.totalCents).padStart(12)}  ${String(t.count).padStart(3)} txns  ${t.firstDate} → ${t.lastDate}`);
    }
    console.log('');
    db.close();
  });

// ── secrets ──────────────────────────────────────────────────────────────────

const secrets = program.command('secret').description('Manage stored credentials');

secrets
  .command('set <providerId> <key>')
  .description('Store a credential in the OS keystore (prompts; never pass it as an argument)')
  .action(async (providerId: string, key: string) => {
    // Prompted rather than taken as an argument so the value never lands in
    // shell history or the process table.
    const value = await askHidden(`Value for ${providerId}.${key} (input is hidden): `);
    if (!value.trim()) {
      console.error('Empty value — nothing stored.');
      process.exitCode = 1;
      return;
    }
    getSecretsStore().set(providerId, key, value.trim());
    console.log(`Stored ${providerId}.${key} in the ${defaultBackend()} keystore.`);

    // Storing a wrong credential is cheap; noticing is not. It surfaces on the
    // next sync as Plaid's raw INVALID_API_KEYS, which names neither the key
    // nor the environment — and a sandbox secret pointed at production looks
    // exactly like a typo. Checking here costs one free call.
    if (providerId === 'plaid') await verifyPlaidCredentials();
  });

/**
 * Prompt without echoing what is typed. The prompt used to promise "not echoed
 * to stdout" while readline echoed every keystroke to the terminal — so an app
 * password sat on screen, and in any scrollback or screen share.
 */
async function askHidden(prompt: string): Promise<string> {
  let muted = false;
  const output = new Writable({
    write(chunk, encoding, done) {
      if (!muted) process.stderr.write(chunk, encoding);
      done();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: process.stdin.isTTY === true });
  try {
    const answer = rl.question(prompt);
    muted = true; // the prompt is written synchronously; everything after is typing
    return await answer;
  } finally {
    rl.close();
    process.stderr.write('\n');
  }
}

/**
 * Probe stored Plaid credentials, reporting what they actually unlock.
 *
 * Never fails the command. The credential IS stored by this point, and a
 * network blip is not a reason to imply otherwise — the check adds
 * information, it does not gate anything.
 */
async function verifyPlaidCredentials(
  forEnvironment?: 'sandbox' | 'production',
): Promise<boolean> {
  const clientId = readSecret('plaid', 'client_id');
  const secret = readSecret('plaid', 'secret');
  if (!clientId || !secret) {
    console.log('  (both client_id and secret are needed before this can be checked)');
    return false;
  }

  let environment: 'sandbox' | 'production' = forEnvironment ?? 'sandbox';
  if (!forEnvironment) {
    try {
      environment = loadConfig().providers.plaid.environment;
    } catch {
      // No config yet is fine — `finance secret set` legitimately runs first.
    }
  }

  process.stdout.write(`  checking against ${environment}… `);
  try {
    const result = await verifyCredentials({ clientId, secret, environment });
    if (result.ok) {
      console.log('works.');
      return true;
    }
    console.log('failed.');
    if (result.wrongEnvironment) {
      console.error(`\n  ${result.reason}.`);
      console.error(`  Either set environment = "${result.wrongEnvironment}" under`);
      console.error('  [providers.plaid] in the config, or store the keys for '
        + `${environment} instead.`);
    } else {
      console.error(`\n  ${result.reason}`);
      console.error('  The value is stored; correct it with `finance secret set` and re-run.');
    }
    return false;
  } catch (err) {
    console.log('could not check.');
    console.error(`  ${(err as Error).message}`);
    console.error('  The value is stored — this check needs network access.');
    return false;
  }
}

secrets
  .command('check <providerId> <key>')
  .description('Report whether a credential is set (never prints the value)')
  .action((providerId: string, key: string) => {
    const present = getSecretsStore().get(providerId, key) !== null
      || process.env[envVarFor(providerId, key)] !== undefined;
    console.log(`${providerId}.${key}: ${present ? 'set' : 'NOT set'}`);
    if (!present) process.exitCode = 1;
  });

secrets
  .command('rm <providerId> <key>')
  .description('Delete a stored credential')
  .action((providerId: string, key: string) => {
    getSecretsStore().delete(providerId, key);
    console.log(`Removed ${providerId}.${key}.`);
  });

// ── schedule ─────────────────────────────────────────────────────────────────

const schedule = program.command('schedule').description('Manage the background sync');

schedule
  .command('install')
  .description('Install the scheduled job (reads [report] in the config)')
  .option('--daily <time>', 'HH:MM, 24-hour local time', '07:00')
  .option('--sync-only', 'Only sync — do not build or deliver a report')
  .action((opts: { daily: string; syncOnly?: boolean }) => installDaily(opts.daily, opts.syncOnly === true));

/** Install the daily job. Shared by `schedule install` and `finance setup`. */
function installDaily(daily: string, syncOnly: boolean): void {
  const config = loadConfig();
  const spec = parseTime(daily);
  // Absolute paths: launchd and systemd do not inherit the shell PATH, and a
  // bare "node" is the most common reason a schedule silently never runs.
  const status = installSchedule(spec, {
    nodePath: realpathSync(process.execPath),
    cliPath: fileURLToPath(import.meta.url),
  }, syncOnly ? ['sync', '--automatic-only'] : ['run']);

  console.log(`Installed at ${daily} (${status.platform}): ${syncOnly ? 'sync only' : 'sync + report + deliver'}`);
  if (status.path) console.log(`  ${status.path}`);
  if (!syncOnly) {
    console.log(`  range: ${config.report.range} · deliver: ${config.report.deliver.join(', ') || 'save only'}`
      + `${config.report.ai ? ' · with AI analysis' : ''}`);
    if (config.report.deliver.includes('email') && !config.report.emailTo) {
      console.warn('  ! deliver includes "email" but report.emailTo is not set');
    }
  }
}

schedule
  .command('status')
  .description('Show whether the background sync is installed')
  .action(() => {
    const status = scheduleStatus();
    console.log(status.installed
      ? `${green('✓ Installed')}${status.detail ? ` — ${status.detail}` : ''}${status.path ? dim(`\n  ${status.path}`) : ''}`
      : `${yellow('Not installed.')} Run \`finance schedule install\`.`);
  });

schedule
  .command('uninstall')
  .description('Remove the background sync')
  .action(() => {
    uninstallSchedule();
    console.log('Removed the scheduled sync.');
  });

// ── afford ───────────────────────────────────────────────────────────────────

program
  .command('afford')
  .description('What you can take on, from what you actually earn and spend')
  .option('--add <dollars>', 'A new monthly obligation — car payment, childcare')
  .option('--replace-loan <dollars>', 'Replace current loan payments (a move swaps one mortgage for another)')
  .option('--buffer <dollars>', 'Monthly slack to keep when computing the maximum', '0')
  .option('--exclude-tag <tag...>', 'Leave tagged one-offs out of the baseline')
  .option('--since <YYYY-MM>', 'Earliest month to include — use to drop an abnormal month')
  .option('--lump-net <dollars>', 'A yearly EXTRA on top of your pay, after tax — bonus, vest, refund')
  .option('--lump-gross <dollars>', 'The same extra before tax — requires --tax-rate')
  .option('--tax-rate <pct>', 'Your combined withholding on that extra, for --lump-gross')
  .option('--rate <pct>', 'Convert an affordable payment into a price', '6.5')
  .option('--term <years>', 'Loan term for that conversion', '30')
  .action((opts: {
    add?: string; replaceLoan?: string; buffer: string;
    lumpNet?: string; lumpGross?: string; taxRate?: string;
    excludeTag?: string[]; since?: string; rate: string; term: string;
  }) => {
    const db = openLedger();
    const baseline = computeBaseline(db, {
      excludeTags: opts.excludeTag, sinceMonth: opts.since, endDate: todayIn(loadConfig().timezone),
    });
    db.close();

    if (baseline.monthsCovered === 0) {
      console.error(baseline.warnings[0]);
      process.exitCode = 1;
      return;
    }

    const cents = (v?: string) => (v === undefined ? undefined : Math.round(Number(v) * 100));

    console.log(`\n${bold(`Baseline — ${baseline.monthsCovered} complete month(s)`)}${dim(`: ${baseline.months.join(', ')}`)}`);
    // Each figure is the MEDIAN month, which is deliberate (see computeBaseline)
    // and invisible unless it is said: a reader who averages the months by hand
    // gets a different number and concludes the tool is wrong.
    console.log('  (each figure is the typical — median — month, so one unusual month cannot move it)');
    // Measured income comes from bank DEPOSITS, which are already net of tax.
    // A gross bonus added to that is pre-tax dollars summed with post-tax
    // dollars — an overstatement of roughly a third, in the direction that
    // makes an unaffordable payment look affordable. So gross must be
    // converted, and the tool will not invent the rate to do it with.
    let annualCents = opts.lumpNet === undefined ? undefined : Math.round(Number(opts.lumpNet) * 100);
    let grossNote: string | undefined;
    if (opts.lumpGross !== undefined) {
      if (opts.lumpNet !== undefined) {
        console.error('Pass --lump-net or --lump-gross, not both.');
        process.exitCode = 1;
        return;
      }
      if (opts.taxRate === undefined) {
        console.error(
          'A gross lump needs --tax-rate, because measured income is already after tax\n'
          + 'and adding a pre-tax figure to it overstates what you can afford.\n\n'
          + 'This tool will not guess your rate. A lump is usually withheld harder than\n'
          + 'salary — in the US, supplemental federal withholding plus FICA plus any state\n'
          + 'tax commonly lands somewhere around 30-40%. Check a recent bonus deposit\n'
          + 'against its gross and use YOUR number:\n\n'
          + `  finance afford --lump-gross ${opts.lumpGross} --tax-rate 32\n\n`
          + 'Or skip the arithmetic and pass what actually hit the bank:\n\n'
          + '  finance afford --lump-net <deposited amount>',
        );
        process.exitCode = 1;
        return;
      }
      const rate = Number(opts.taxRate);
      if (!Number.isFinite(rate) || rate < 0 || rate >= 100) {
        console.error('--tax-rate must be a percentage between 0 and 100.');
        process.exitCode = 1;
        return;
      }
      const grossCents = Math.round(Number(opts.lumpGross) * 100);
      annualCents = Math.round(grossCents * (1 - rate / 100));
      grossNote = `${money(grossCents)} gross − ${rate}% tax = ${money(annualCents)} net`;
    }
    const annualMonthly = monthlyFromAnnual(annualCents);

    console.log(`  Income            ${money(baseline.monthlyIncomeCents).padStart(12)}/mo  (measured, after tax)`);
    if (annualMonthly > 0) {
      console.log(`  + yearly extra    ${money(annualMonthly).padStart(12)}/mo  (${money(annualCents!)}/yr after tax, assumed)`);
      if (grossNote) console.log(`                                   ${grossNote}`);

      // If a lump already landed inside the baseline window, it is ALREADY in
      // measured income. Adding it again counts the same money twice.
      if (baseline.monthlyIncomeCents > 0
          && annualMonthly > baseline.monthlyIncomeCents * 0.5) {
        const pct = Math.round((annualMonthly / baseline.monthlyIncomeCents) * 100);
        console.log('');
        console.log(`  ⚠ that extra is ${pct}% of your measured monthly income — check it is not your salary.`);
        console.log('    Your pay is ALREADY counted: income here is measured from real deposits.');
        console.log('    This flag is only for a yearly EXTRA on top — a bonus, a vest, a refund.');
      }

      const spike = detectIncomeSpike(baseline.monthlyIncomes, baseline.months);
      if (spike) {
        console.log('');
        console.log(`  ⚠ ${spike.month} already shows ${money(spike.excessCents)} of income above a typical month.`);
        console.log('    If that WAS the lump, it is counted twice here — drop the flag,');
        console.log(`    or re-run with --since to exclude ${spike.month} from the baseline.`);
      }
    }
    console.log(`  Spending          ${money(baseline.monthlySpendingCents).padStart(12)}/mo`
      // The gap between the two is the useful signal: it is how much of the
      // picture is one-offs. Shown only when it is large enough to matter.
      + (Math.abs(baseline.meanSpendingCents - baseline.monthlySpendingCents) >= 10_000
        ? `  (average ${money(baseline.meanSpendingCents)} — an unusual month is pulling it)`
        : ''));
    const netLabel = (cents: number) => (cents < 0
      ? `SHORT ${money(Math.abs(cents))}/mo`
      : `${money(cents)}/mo`);
    // Coloured AFTER padding: escape codes count toward padStart's width and
    // would push the column out of line.
    const netShown = (cents: number, width = 0) =>
      (cents < 0 ? red : green)(bold(netLabel(cents).padStart(width)));
    console.log(`  ${(baseline.monthlyNetCents < 0 ? 'Shortfall' : 'Left over').padEnd(18)}${netShown(baseline.monthlyNetCents, 15)}`);
    // Income, spending and net are each the median of a DIFFERENT set of
    // months, so they will not subtract — and a reader who tries is entitled to
    // think one of them is wrong. Say it, but only when the gap is big enough
    // to notice.
    const naive = baseline.monthlyIncomeCents - baseline.monthlySpendingCents;
    if (Math.abs(naive - baseline.monthlyNetCents) >= 25_000) {
      console.log('      (these three do not subtract: each is the median of a different set');
      console.log('       of months. The net is the median month\'s OWN net, which is the one');
      console.log('       that repeats — subtracting the other two assumes income and spending');
      console.log('       peak in the same month, and here they do not.)');
    }
    console.log(`    of which recurring ${money(baseline.monthlyRecurringCents).padStart(9)}/mo  (will not flex)`);
    if (baseline.monthlyLoanPaymentCents > 0) {
      console.log(`    loan payments      ${money(baseline.monthlyLoanPaymentCents).padStart(9)}/mo  (freed by --replace-loan)`);
    }

    // Equity that vested but never reached a bank account. Reported BESIDE the
    // baseline and never added into it: the figure above stays conservative,
    // which is the right direction for a loan, while a reader can see what the
    // ledger structurally cannot count. Without this a person with meaningful
    // equity reads a permanent shortfall and no explanation for it.
    const cache = readCashMovements();
    if (cache) {
      const vests = detectVests(
        cache.movements
          .filter((m): m is typeof m & { name: string } => typeof m.name === 'string')
          .map((m) => ({ date: m.date, name: m.name, amountCents: m.amountCents })),
      );
      if (vests.events.length > 0) {
        const perMonth = monthlyNetEquity(vests, baseline.monthsCovered);
        console.log(`\n  Equity vested   ${money(perMonth).padStart(12)}/mo  NOT counted above`);
        console.log(`    ${vests.events.length} vest(s), ${money(vests.grossCents)} gross, `
          + `${money(vests.netCents)} net of withholding`);
        const checked = vests.events.filter((e) => e.crossChecked).length;
        console.log(`    sized from federal withholding at the 22% supplemental rate; `
          + `${checked} of ${vests.events.length} corroborated by the Medicare line`);
        console.log('    a lender will discount this and usually wants two years of it');
      }
      if (vests.unsizedDates.length > 0) {
        console.log(`\n  ! ${vests.unsizedDates.length} date(s) carry withholding this could not size `
          + `(${vests.unsizedDates.slice(0, 3).join(', ')})`);
        console.log('    equity income may be larger than shown, or absent — not assumed either way');
      }
    }

    const addCents = cents(opts.add);
    const replaceCents = cents(opts.replaceLoan);
    if (addCents !== undefined || replaceCents !== undefined) {
      const result = applyScenario(baseline, {
        label: 'scenario', addCents, replaceLoanCents: replaceCents, annualIncomeCents: annualCents,
      });
      console.log(`\n${bold('Scenario')}`);
      if (replaceCents !== undefined) console.log(`  replace loan payments with ${money(replaceCents)}/mo`);
      if (addCents !== undefined) console.log(`  add ${money(addCents)}/mo`);
      console.log(`  Result            ${netShown(result.monthlyNetCents)}`);
      if (result.monthlyNetCents < 0) {
        console.log(red(`  ⚠ you would spend ${money(Math.abs(result.monthlyNetCents))} MORE than you earn, every month`));
      }

      // A bonus, vest or refund is not salary. Folding it into one number lets
      // variable money quietly carry a fixed obligation, so the guaranteed-only
      // figure is always shown beside it — never replaced by it.
      if (annualCents !== undefined && annualCents > 0) {
        const guaranteed = applyScenario(baseline, {
          label: 'scenario', addCents, replaceLoanCents: replaceCents,
        });
        console.log('');
        console.log(`  Counting only guaranteed income (no ${money(annualCents)}/yr lump):`);
        console.log(`                    ${netShown(guaranteed.monthlyNetCents)}`);
        console.log(`  The lump is worth ${money(monthlyFromAnnual(annualCents))}/mo — and it is not promised.`);
        console.log('  A fixed monthly payment should survive the year that lump does not arrive.');
      }
    }

    const buffer = cents(opts.buffer) ?? 0;
    const max = maxAffordable(baseline, buffer, replaceCents !== undefined, annualCents);
    if (baseline.monthsCovered < 3) {
      // Above the number, not below it. A borrowing estimate is the figure
      // someone acts on, and a caveat printed after a six-figure total reads as
      // a footnote to a conclusion already drawn.
      console.log(yellow(`\n  ⚠ Based on ${baseline.monthsCovered} complete month(s) — not enough to size`));
      console.log(yellow('    a mortgage. One unusual month moves the figure below by thousands.'));
    }
    console.log(`\n${bold(`Maximum new payment leaving ${money(buffer)}/mo spare`)}`);
    if (max <= 0) {
      console.log(red(`  none — you are already SHORT ${money(Math.abs(max))}/mo before adding anything`));
    } else {
      console.log(`  ${green(bold(`${money(max)}/mo`))}`);
      const principal = principalFromPayment(max, Number(opts.rate), Number(opts.term));
      console.log(`  ≈ ${money(principal)} borrowed at ${opts.rate}% over ${opts.term} years`);
      console.log('    (principal & interest only — taxes, insurance and HOA are on top)');
    }

    if (baseline.warnings.length) {
      console.log(`\n${yellow(bold('Read with care'))}`);
      for (const w of baseline.warnings) console.log(`  · ${w}`);
      if (annualMonthly > 0) {
        console.log('  · the yearly extra is ASSUMED, not measured — enter it after tax, and');
        console.log('    note a lender usually wants two years of history before counting it');
      }
      console.log('  · cash flow only — no PMI, maintenance, closing costs or tax changes');
    }
    console.log('');
  });

// ── setup ────────────────────────────────────────────────────────────────────

program
  .command('setup')
  .description('Guided first-time setup — checks, credentials, and a working account')
  .action(async () => {
    // A wizard needs a human. Piped or redirected stdin does not merely give
    // wrong answers — readline/promises resolves the FIRST question and then
    // never settles the second, so the process hangs with no output and no
    // error. Saying so is better than appearing to work and stopping.
    if (!process.stdin.isTTY) {
      console.error('`finance setup` is interactive and needs a terminal.');
      console.error('For an unattended setup, edit the config directly — see');
      // Points at the config itself, which carries a commented example of every
      // field. The previous pointer was docs/writing-a-provider.md, which is
      // about implementing a provider and mentions CSV columns nowhere — a
      // dead end for the one person following it.
      console.error(`edit ${configPath()}, which has a commented example of every field.`);
      console.error('docs/csv.md in the project explains what each one means.');
      process.exitCode = 1;
      return;
    }

    const rl = createInterface({ input: process.stdin, output: process.stdout });

    // Guard against the input ending mid-flow anyway (a closed terminal, a
    // ^D). Without this the same hang returns, just later.
    let closed = false;
    rl.on('close', () => { closed = true; });

    const ask = async (q: string, fallback = '') => {
      if (closed) throw new Error('input closed');
      const answer = (await rl.question(`${bold(q)} ${fallback ? `${dim(`[${fallback}]`)} ` : ''}`)).trim();
      return answer || fallback;
    };
    // [Y/n] rather than "(y/n) [y]": the capital is the default, which is the
    // convention people already read without thinking.
    const yes = async (q: string, fallback: 'y' | 'n' = 'y') => {
      const answer = await ask(`${q} ${dim(fallback === 'y' ? '[Y/n]' : '[y/N]')}`);
      return answer ? /^y/i.test(answer) : fallback === 'y';
    };

    try {
      console.log(`\n${bold('finance setup')}  ${dim('— about ten minutes. Ctrl-C stops at any point.')}`);
      console.log(step(1, 4, 'Check this machine'));
      const checks = preflight({
        home: financeHome(),
        hasPlaidBinary: hasBinary('plaid'),
      });
      for (const c of checks) {
        const mark = c.ok ? green('\u2713') : c.blocking ? red('\u2717') : yellow('\u00b7');
        console.log(`  ${mark} ${c.name}: ${dim(c.detail)}`);
        if (c.fix) console.log(`      ${yellow(c.fix)}`);
      }
      if (checks.some((c) => !c.ok && c.blocking)) {
        console.error(red('\nFix the blocking items above, then run `finance setup` again.'));
        process.exitCode = 1;
        return;
      }

      if (!existsSync(configPath())) {
        mkdirSync(financeHome(), { recursive: true });
        writeFileSync(configPath(), EXAMPLE_CONFIG);
        console.log(dim(`\n  wrote ${configPath()}`));
      }
      openLedger().close();

      // CSV first, deliberately. It needs no account, no keys and no third
      // party, so someone can have real numbers on screen inside a minute and
      // decide whether the tool is worth the Plaid setup at all.
      console.log(step(2, 4, 'Bank exports (CSV)'));
      console.log(dim('  Download "transactions" as CSV from each bank and card website. Free, no'));
      console.log(dim('  signup, and every feature works from it. Automatic sync is the next step.\n'));

      // One export per account: a checking account and a card are two files
      // with different layouts, and the card is where the categories are.
      let added = 0;
      if (await yes('Set up a CSV account now?')) {
        do {
          if (await setupCsvAccount(ask, yes, added)) added += 1;
        } while (await yes('\n  Add another — every bank and card you use?', 'n'));
      } else {
        console.log(dim('  skipped — add one later with `finance setup`.'));
      }

      // Defaults to no: Enter through a wizard should never read as agreeing
      // to sign up for something.
      let linked = 0;
      console.log(step(3, 4, 'Automatic sync (Plaid)'));
      console.log(dim('  Optional. Transactions arrive every morning instead of you downloading them.\n'));
      if (!hasBinary('plaid')) {
        console.log('  For automatic sync later, install the Plaid CLI and run `finance setup` again:');
        console.log(`    ${cyan('brew install plaid/plaid-cli/plaid')}`);
      } else if (await yes(added > 0
        ? '  Also link banks through Plaid?'
        : '  Link your banks through Plaid?', 'n')) {
        linked = await setupPlaid(ask, yes, (cmd, args) => runInteractive(rl, cmd, args));
      }

      console.log(step(4, 4, 'Daily report'));
      if (added + linked === 0) {
        console.log(dim('  Nothing to report on yet — add an account first.'));
      } else if (await yes('  Sync and send you the report every morning at 7:00?', 'n')) {
        installDaily('07:00', false);
        const deliverTo = loadConfig().report.deliver;
        if (!deliverTo.includes('smtp') && !deliverTo.includes('email')) {
          console.log(dim('  It sends a notification. To get the report by email instead, see'));
          console.log(dim('  docs/report.md#email — about five minutes with a Gmail app password.'));
        }
      } else {
        console.log(dim('  skipped — later: finance schedule install --daily 07:00'));
      }

      const next = (cmd: string, why: string) => console.log(`  ${cyan(cmd.padEnd(24))}${dim(why)}`);
      console.log(`\n${green(bold(added + linked > 0 ? '\u2713 Setup complete.' : 'Setup finished.'))} Next:`);
      if (added > 0 && linked === 0) next('finance sync', 'import what was just configured');
      if (added + linked > 0) next('finance report --open', 'see it');
      next('finance doctor', 'tells you if anything is off');
    } catch (err) {
      if ((err as Error).message === 'input closed') {
        console.error(yellow('\n\nInput ended before setup finished — nothing further was written.'));
        process.exitCode = 1;
        return;
      }
      throw err;
    } finally {
      rl.close();
    }
  });

/** Is a command on PATH? Used to decide whether Plaid is even an option. */
function hasBinary(name: string): boolean {
  try {
    execFileSync('command', ['-v', name], { stdio: 'ignore', shell: '/bin/sh', timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Hand the terminal to an interactive command (`plaid login`), then take it
 * back. The wizard's readline holds stdin in raw mode; left that way, the child
 * reads keystrokes one at a time with no echo, and the parent can swallow
 * input meant for the child.
 */
function runInteractive(rl: Interface, cmd: string, args: string[]): boolean {
  rl.pause();
  const raw = process.stdin.isTTY ? process.stdin.isRaw : false;
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  try {
    // A human is driving it, so the timeout is generous — but there is one.
    const res = spawnSync(cmd, args, { stdio: 'inherit', timeout: 15 * 60_000 });
    return res.status === 0;
  } finally {
    if (process.stdin.isTTY) process.stdin.setRawMode(raw);
    rl.resume();
  }
}

/**
 * Plaid, done rather than described. This used to print four commands, and
 * following them on a fresh config failed: Plaid was never enabled, and the
 * starter config points at sandbox, where a real bank cannot connect. It also
 * sent people to find keys in a dashboard that `plaid login` fetches for them.
 *
 * Returns how many connections were linked.
 */
async function setupPlaid(
  ask: (q: string, fallback?: string) => Promise<string>,
  yes: (q: string, fallback?: 'y' | 'n') => Promise<boolean>,
  interactive: (cmd: string, args: string[]) => boolean,
): Promise<number> {
  console.log(dim('\n  Plaid connects to your banks through your OWN free Plaid account — your'));
  console.log(dim('  banks link to it, not to us. What that exposes: docs/plaid.md'));

  const environment = await yes('\n  Connect your real banks? (n = Plaid\'s test banks, to try it first)', 'y')
    ? 'production' as const
    : 'sandbox' as const;

  // Keys: what `plaid login` saved for this environment comes first — it is
  // per environment, where a stored pair may be the other one's. Copied, never
  // echoed, and typed by hand only when nothing else has them.
  let keys = readCliKeys(environment);
  const stored = Boolean(readSecret('plaid', 'client_id') && readSecret('plaid', 'secret'));
  if (!keys && !stored) {
    if (!await yes('\n  Do you already have a Plaid account?', 'n')) {
      console.log('  Opening the signup page. Create the account and verify the email, then come back.\n');
      interactive('plaid', ['register']);
    }
    console.log('\n  Signing in. This opens your browser and fetches your API keys.\n');
    interactive('plaid', ['login']);
    keys = readCliKeys(environment);
  }
  if (keys) {
    getSecretsStore().set('plaid', 'client_id', keys.clientId);
    getSecretsStore().set('plaid', 'secret', keys.secret);
    console.log(`\n  ${green('\u2713')} Copied your ${environment} keys into the ${defaultBackend()} keystore ${dim('(not shown)')}`);
  } else if (!stored) {
    console.log('\n  No keys came back from `plaid login`. Store them by hand, then run setup again:');
    console.log('    finance secret set plaid client_id');
    console.log('    finance secret set plaid secret');
    return 0;
  }
  const keysOk = await verifyPlaidCredentials(environment);
  if (!keysOk) {
    if (environment === 'production') {
      console.log('\n  Real banks need Plaid\'s free Trial Plan, which is a separate approval.');
      if (await yes('  Open the Trial Plan page now?', 'y')) interactive('plaid', ['trial']);
      console.log('  Once it is approved, run `finance setup` again.');
    }
    return 0;
  }

  writeFileSync(configPath(), enablePlaidToml(readFileSync(configPath(), 'utf8'), environment));
  console.log(`  ${green('\u2713')} Plaid enabled (${environment}) ${dim(`in ${configPath()}`)}`);

  console.log(yellow('\n  \u26a0 Link every bank AND every credit card you use. Anything left out is'));
  console.log(yellow('    invisible: with checking but no cards, all you see is "paid the card".'));
  if (environment === 'sandbox') {
    console.log(dim('  Test mode: pick any bank and sign in with user_good / pass_good.'));
  }

  let linked = 0;
  do {
    const kind = await ask('\n  Linking a bank or card (1), or a brokerage (2)?', '1');
    // Many brokerages do not offer transactions, and asking for it makes them
    // unselectable in Link — the confusing way to find that out.
    const ok = await linkAccount({
      days: '730', history: '24', open: true,
      ...(kind.trim() === '2' ? { products: 'investments' } : {}),
    });
    if (ok) linked += 1;
  } while (await yes('\n  Link another bank or card?', 'n'));
  return linked;
}

/**
 * Point at a folder, show what was found, write the config block.
 *
 * The sample rows are the load-bearing part: a layout guess is worth nothing
 * until someone recognises their own spending in it, and three real rows catch
 * the failures a confidence score cannot describe — a column offset by one, or
 * a date read day-first.
 */
async function setupCsvAccount(
  ask: (q: string, fallback?: string) => Promise<string>,
  yes: (q: string, fallback?: 'y' | 'n') => Promise<boolean>,
  alreadyAdded: number,
): Promise<boolean> {
  const path = await ask('\n  Folder or file with your CSV exports:');
  if (!path) return false;

  const preview = previewCsv(path);
  if (preview.errors.length) {
    for (const e of preview.errors) console.error(red(`  ${e}`));
    return false;
  }

  console.log(dim(`\n  ${preview.files.length} file(s). Reading ${preview.files[0]}\n`));
  const d = preview.detected;
  console.log(`    date         ${d.date ?? '(not found)'}   format ${d.dateFormat ?? '?'}`);
  console.log(`    amount       ${d.amount ?? (d.debit && d.credit ? `${d.debit} / ${d.credit}` : '(not found)')}`);
  console.log(`    description  ${d.description ?? '(not found)'}`);
  if (d.merchant) console.log(`    merchant     ${d.merchant}`);
  console.log(`    category     ${d.category ?? '(none — categories will be guessed from descriptions)'}`);
  if (d.balance) console.log(`    ${d.balance} — running balance, ignored`);

  for (const w of d.warnings) console.log(yellow(`\n  \u26a0 ${w}`));

  console.log(`\n  ${bold('First rows as they would be imported')} ${dim('(negative = money out)')}\n`);
  for (const row of preview.sample) {
    const amount = row.amount.padStart(12);
    console.log(`    ${row.date.padEnd(12)} ${row.amount.startsWith('-') ? amount : green(amount)}  ${row.description.slice(0, 44)}`
      + (row.category ? `  ${dim(`[${row.category}]`)}` : ''));
  }

  if (!await yes('\n  Does that look right?')) {
    console.log(`  Nothing written. Edit ${configPath()} by hand — docs/csv.md in the project`);
    console.log('  explains each column setting.');
    return false;
  }

  // Ask the type first: it decides a sensible name, and a split debit/credit
  // layout is what card exports usually look like.
  const looksLikeCard = Boolean(d.debit && d.credit) || /card|visa|amex|mastercard/i.test(path);
  const type = await ask('\n  Type — depository (checking/savings) or credit (a card):',
    looksLikeCard ? 'credit' : 'depository');
  const name = await ask('  Name for this account:',
    type === 'credit' ? 'Credit card' : alreadyAdded > 0 ? 'Savings' : 'Checking');
  const mask = await ask('  Last 4 digits (optional):');

  // Re-running setup must not append a second block with the same id, which
  // would make two accounts out of one config entry's worth of files.
  const existing = readFileSync(configPath(), 'utf8');
  let accountId = slugify(name);
  for (let n = 2; existing.includes(`accountId = ${JSON.stringify(accountId)}`); n += 1) {
    accountId = `${slugify(name)}-${n}`;
  }

  const toml = csvAccountToml({
    accountId, name, type, path,
    ...(mask ? { mask } : {}),
    detected: d,
  });
  appendFileSync(configPath(), toml);
  console.log(`\n  ${green('\u2713')} Added "${name}" ${dim(`to ${configPath()}`)}`);
  return true;
}

// ── connections ──────────────────────────────────────────────────────────────

const connections = program
  .command('connections')
  .description('The authenticated links feeding your accounts');

connections
  .command('list', { isDefault: true })
  .description('Show every connection, what it feeds, and whether it still counts')
  .action(() => {
    const db = openLedger();
    const rows = db.prepare(`
      SELECT c.connection_id AS id, c.provider_id AS provider, c.external_id AS externalId,
             c.priority, c.active, c.linked_at AS linkedAt,
             COUNT(DISTINCT s.account_id) AS accounts,
             COUNT(t.txn_id)              AS delivered,
             (SELECT COUNT(*) FROM visible_transactions v
                JOIN sources vs ON vs.source_id = v.source_id
               WHERE vs.connection_id = c.connection_id) AS counted,
             MIN(t.date) AS earliest, MAX(t.date) AS latest
        FROM connections c
        LEFT JOIN sources s      ON s.connection_id = c.connection_id
        LEFT JOIN transactions t ON t.source_id = s.source_id
       GROUP BY c.connection_id
       ORDER BY c.provider_id, c.priority DESC
    `).all() as Array<{
      id: string; provider: string; externalId: string; priority: number; active: number;
      accounts: number; delivered: number; counted: number;
      earliest: string | null; latest: string | null;
    }>;
    db.close();

    if (rows.length === 0) {
      console.log('No connections yet. Run `finance link` or configure a CSV account.');
      return;
    }

    for (const r of rows) {
      const state = r.active ? '' : dim('  (retired)');
      console.log(`\n${bold(r.provider)}  ${r.externalId}${state}`);
      console.log(`  ${r.accounts} account(s) · ${r.delivered} delivered · ${r.counted} counted`
        + (r.earliest ? ` · ${r.earliest} → ${r.latest}` : ''));
      // "delivered but not counted" is the shape of a connection another one
      // has superseded — the number that tells you it is safe to retire.
      if (r.active && r.delivered > 0 && r.counted === 0) {
        console.log(yellow('  ! supplies nothing — another connection covers all of it'));
      }
      console.log(dim(`  ${r.id}`));
    }
    console.log('\nRetire one with: finance connections disable <connection_id>');
  });

connections
  .command('disable <connectionId>')
  .description('Stop a connection counting, without deleting what it delivered')
  .action((connectionId: string) => {
    const db = openLedger();
    const before = db.prepare(
      'SELECT external_id AS externalId, active FROM connections WHERE connection_id = ?',
    ).get(connectionId) as { externalId: string; active: number } | undefined;

    if (!before) {
      console.error(`No connection ${connectionId}. Run \`finance connections\` to list them.`);
      db.close();
      process.exitCode = 1;
      return;
    }

    setConnectionActive(db, connectionId, false);
    const counted = (db.prepare('SELECT COUNT(*) n FROM visible_transactions').get() as { n: number }).n;
    db.close();

    // Retired, not deleted: the rows stay, so re-enabling restores them and a
    // mistake costs nothing. That is the whole reason this is not a delete.
    console.log(`Retired ${before.externalId}. Its transactions remain but no longer count.`);
    console.log(`  ${counted} transaction(s) now counted.`);
    console.log('  Re-enable with `finance connections enable ' + connectionId + '`');
    console.log('\nThe connection still exists at the provider and may still bill —');
    console.log('remove it there too (for Plaid: `plaid item remove --item <id> --force`).');
  });

connections
  .command('enable <connectionId>')
  .description('Bring a retired connection back')
  .action((connectionId: string) => {
    const db = openLedger();
    setConnectionActive(db, connectionId, true);
    const counted = (db.prepare('SELECT COUNT(*) n FROM visible_transactions').get() as { n: number }).n;
    db.close();
    console.log(`Enabled. ${counted} transaction(s) now counted.`);
  });


connections
  .command('probe <connectionId>')
  .description('Dump what a connection actually returns — for looking before building on it')
  .option('--since <YYYY-MM-DD>', 'Earliest date to fetch', '2024-01-01')
  .action(async (connectionId: string, opts: { since: string }) => {
    const db = openLedger();
    const row = db.prepare(
      'SELECT provider_id AS providerId, external_id AS externalId FROM connections WHERE connection_id = ?',
    ).get(connectionId) as { providerId: string; externalId: string } | undefined;
    db.close();

    if (!row) {
      console.error(`No connection ${connectionId}. Run \`finance connections\` to list them.`);
      process.exitCode = 1;
      return;
    }

    const clientId = readSecret('plaid', 'client_id');
    const secret = readSecret('plaid', 'secret');
    if (!clientId || !secret) {
      console.error('Plaid credentials are not set.');
      process.exitCode = 1;
      return;
    }

    const accessToken = findAccessToken(row.externalId);
    if (!accessToken) {
      console.error(`No access token recorded for ${row.externalId}.`);
      process.exitCode = 1;
      return;
    }

    const environment = loadConfig().providers.plaid.environment;
    const today = new Date().toISOString().slice(0, 10);
    try {
      const probe = await probeInvestments(
        { clientId, secret, environment }, accessToken, opts.since, today,
      );

      console.log(`\n${probe.accounts.length} account(s):`);
      for (const a of probe.accounts) {
        console.log(`  ${a.name}  [${a.type}/${a.subtype ?? '—'}]`);
      }

      // The whole point: which subtypes this institution actually sends,
      // rather than which ones the enum allows.
      const bySubtype = new Map<string, { n: number; total: number }>();
      for (const t of probe.transactions) {
        const key = `${t.type}/${t.subtype ?? '—'}`;
        const seen = bySubtype.get(key) ?? { n: 0, total: 0 };
        bySubtype.set(key, { n: seen.n + 1, total: seen.total + t.amount });
      }

      console.log(`\n${probe.transactions.length} of ${probe.total} transaction(s), by type/subtype:`);
      for (const [key, v] of [...bySubtype].sort((a, b) => b[1].n - a[1].n)) {
        console.log(`  ${key.padEnd(28)} ×${String(v.n).padEnd(5)} $${v.total.toFixed(2)}`);
      }

      console.log('\nA few, verbatim:');
      for (const t of probe.transactions.slice(0, 8)) {
        console.log(`  ${t.date}  ${String(t.amount).padStart(12)}  ${t.type}/${t.subtype ?? '—'}  ${t.name.slice(0, 40)}`);
      }
    } catch (err) {
      console.error(`\nProbe failed: ${(err as Error).message}`);
      process.exitCode = 1;
    }
  });

// ── transfers ────────────────────────────────────────────────────────────────

program
  .command('transfers')
  .description('Split brokerage transfers by which sub-account they came from')
  .option('--since <YYYY-MM-DD>', 'Earliest date to consider', DEFAULT_MOVEMENT_START)
  .option('--detail', 'List every transfer, not just the per-account totals')
  .action(async (opts: { since: string; detail?: boolean }) => {
    const db = openLedger();

    // Transfers only. Matching on (date, amount) alone across every category
    // would pair a $500 purchase with a $500 brokerage withdrawal sooner or
    // later, and a wrong attribution is worse than a missing one.
    const transfers = db.prepare(`
      SELECT txn_id AS txnId, date, amount_cents AS amountCents, description
      FROM visible_transactions
      WHERE spend_group = 'transfers' AND date >= ?
      ORDER BY date DESC
    `).all(opts.since) as BankTransfer[];

    // Every connection holding an investment account is a candidate source.
    db.close();

    const fetched = await fetchCashMovements(opts.since);
    if (fetched.reason) {
      console.log(fetched.reason);
      return;
    }
    const movements = fetched.movements;

    const result = attributeTransfers(transfers, movements);
    const net = netByAccount(transfers, result);

    if (net.length === 0) {
      console.log(`\nNothing matched across ${transfers.length} transfer(s) `
        + `and ${movements.length} brokerage cash movement(s).`);
      return;
    }

    console.log(`\nBrokerage transfers by source account (since ${opts.since}):\n`);
    for (const row of net) {
      const dollars = (row.netCents / 100).toLocaleString('en-US', {
        style: 'currency', currency: 'USD', maximumFractionDigits: 0,
      });
      const direction = row.netCents >= 0 ? 'net into your bank' : 'net out to the brokerage';
      console.log(`  ${row.accountName.padEnd(20)} ${dollars.padStart(12)}  ${direction}  (${row.count} transfers)`);
    }

    const matched = result.attributions.filter((a) => a.basis === 'matched').length;
    const inferred = result.attributions.length - matched;
    console.log(`\n  ${matched} confirmed against the brokerage feed, ${inferred} inferred `
      + `from the account reference in the description.`);
    if (result.unattributed.length > 0) {
      console.log(`  ${result.unattributed.length} could not be attributed and are left alone.`);
    }

    if (opts.detail) {
      console.log('\nEvery transfer:');
      const by = new Map(result.attributions.map((a) => [a.txnId, a]));
      for (const t of transfers) {
        const a = by.get(t.txnId);
        const amount = (t.amountCents / 100).toFixed(2).padStart(11);
        console.log(`  ${t.date}  ${amount}  ${(a?.accountName ?? '— unattributed').padEnd(20)} `
          + `${a ? a.basis : ''}`);
      }
    }
  });

/**
 * Brokerage cash movements for every linked investment connection.
 *
 * Also refreshes the on-disk cache, so the offline report can attribute
 * transfers without a network call of its own.
 */
async function fetchCashMovements(
  since: string,
): Promise<{ movements: CashMovement[]; reason?: string }> {
  const db = openLedger();
  const investmentConnections = db.prepare(`
    SELECT DISTINCT c.external_id AS externalId
    FROM connections c
    JOIN sources s ON s.connection_id = c.connection_id
    JOIN accounts a ON a.account_id = s.account_id
    WHERE c.active = 1 AND a.type = 'investment'
  `).all() as Array<{ externalId: string }>;
  db.close();

  if (investmentConnections.length === 0) {
    return {
      movements: [],
      reason: 'No linked investment accounts, so there is nothing to attribute transfers to.\n'
        + '  Link a brokerage with: finance link --products investments --days 730',
    };
  }

  const clientId = readSecret('plaid', 'client_id');
  const secret = readSecret('plaid', 'secret');
  if (!clientId || !secret) return { movements: [], reason: 'Plaid credentials are not set.' };

  const environment = loadConfig().providers.plaid.environment;
  const today = new Date().toISOString().slice(0, 10);
  const movements: CashMovement[] = [];

  for (const connection of investmentConnections) {
    const accessToken = findAccessToken(connection.externalId);
    if (!accessToken) continue;
    const probe = await probeInvestments(
      { clientId, secret, environment }, accessToken, since, today,
    );
    const nameOf = new Map(probe.accounts.map((a) => [a.accountId, a.name]));
    for (const t of probe.transactions) {
      // Only cash actually entering or leaving. Buys, sells and dividends move
      // money inside the brokerage and never reach the bank.
      if (t.subtype !== 'withdrawal' && t.subtype !== 'deposit') continue;
      movements.push({
        date: t.date,
        // Plaid signs these from the bank's point of view already: a withdrawal
        // from the brokerage is positive, and that is money arriving.
        amountCents: Math.round(t.amount * 100),
        accountId: t.accountId,
        accountName: nameOf.get(t.accountId) ?? t.accountId,
        // The broker's label. Two consumers need it: transfer attribution, to
        // exclude internal journals that never reached a bank, and vest
        // detection, for which the label IS the evidence.
        name: t.name,
      });
    }
  }

  writeCashMovements(movements, new Date().toISOString());
  return { movements };
}

/** The Plaid CLI's config is where access tokens live; read one out by item id. */
function findAccessToken(itemId: string): string | null {
  try {
    const config = readCliConfig();
    for (const bucket of Object.values(config.environments ?? {})) {
      const hit = (bucket.items ?? []).find((i) => i.item_id === itemId);
      if (hit?.access_token) return hit.access_token;
    }
  } catch {
    // Reported by the caller as a missing token, which is what it amounts to.
  }
  return null;
}

/**
 * The insights the narration reads, over a window long enough to see a pattern.
 *
 * Recurring detection needs a charge to appear MORE THAN ONCE. Over 30 days a
 * monthly subscription appears exactly once and is invisible, so the daily
 * report asked for savings advice while handing over almost nothing to advise
 * on — and got, correctly, "there is nothing here to point at".
 *
 * The displayed range is untouched. This only widens what the analysis is
 * allowed to look at, because "what repeats" is a different question from
 * "what did I spend this month" and needs a different window to answer.
 */
function insightsForNarration(
  db: ReturnType<typeof openLedger>, start: string, end: string,
): ReturnType<typeof collectInsights> {
  const MIN_DAYS = 90;
  const spanDays = Math.round(
    (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000,
  );
  if (spanDays >= MIN_DAYS) return collectInsights(db, start, end);

  const widened = new Date(`${end}T00:00:00Z`);
  widened.setUTCDate(widened.getUTCDate() - MIN_DAYS);
  return collectInsights(db, widened.toISOString().slice(0, 10), end);
}

// ── project ──────────────────────────────────────────────────────────────────

/**
 * Dollars from the command line into whole cents.
 *
 * Throws rather than coercing: NaN cents would be stored and every later sum
 * would be NaN, which is far harder to trace back than a rejected argument.
 */
function dollarsToCents(value: string): number {
  const n = Number(String(value).replace(/[$,]/g, '').trim());
  if (!Number.isFinite(n)) throw new Error(`"${value}" is not an amount`);
  return Math.round(n * 100);
}

const project = program
  .command('project')
  .description('Track a job against a budget — a remodel, a car, a DIY build');

project
  .command('list')
  .description('Every project and where it stands')
  .option('--all', 'Include finished and cancelled ones')
  .action((opts: { all?: boolean }) => {
    const db = openLedger();
    const rows = allProjectReports(db, opts.all);
    db.close();

    if (rows.length === 0) {
      console.log('\nNo projects yet:');
      console.log('  finance project new "Deck Rebuild" --type remodel --budget 9800\n');
      return;
    }

    console.log('');
    for (const r of rows) {
      const p = r.project;
      const per = p.budgetPeriod ? `/${p.budgetPeriod.replace('ly', '')}` : '';
      console.log(`  ${p.name}${p.status !== 'active' ? ` (${p.status})` : ''}  [#${p.tag}]`
        + `${p.type ? `  ${p.type}` : ''}`);
      // A periodic budget is measured over this period, so the figure beside it
      // must be this period's spend — not the lifetime total.
      const thisPeriod = r.budgetWindow ? ` this ${p.budgetPeriod === 'yearly' ? 'year' : 'month'}` : '';
      console.log(`    ${money(r.budgetSpentCents).padStart(12)} spent${thisPeriod}`
        + (r.budgetCents === null ? '  ·  no budget' : `  of  ${money(r.budgetCents)}${per}`));
      if (r.committedCents > 0) {
        console.log(`    ${money(r.committedCents).padStart(12)} committed and unpaid`);
      }
      if (r.remainingCents !== null) {
        const over = r.remainingCents < 0;
        console.log(`    ${money(Math.abs(r.remainingCents)).padStart(12)} ${over ? 'OVER' : 'left'}`
          + (r.committedCents > 0 && r.remainingAfterCommitmentsCents !== null
            ? `  (${money(r.remainingAfterCommitmentsCents)} after commitments)` : ''));
      }
      console.log('');
    }
  });

project
  .command('new <name>')
  .description('Start a project')
  .option('--type <type>', 'remodel | auto | diy | anything you like')
  .option('--ongoing', 'Something with no end (a car), rather than a job that finishes')
  .option('--budget <amount>', 'Target spend, in dollars')
  .option('--period <period>', 'monthly | yearly — only with --ongoing')
  .option('--start <YYYY-MM-DD>', 'When it started')
  .option('--target-end <YYYY-MM-DD>', 'When it should finish')
  .option('--tag <tag>', 'Tag to join on (default: derived from the name)')
  .option('--note <text>', 'Anything worth remembering')
  .action((name: string, opts: {
    type?: string; ongoing?: boolean; budget?: string; period?: string;
    start?: string; targetEnd?: string; tag?: string; note?: string;
  }) => {
    const db = openLedger();
    try {
      const p = createProject(db, {
        name,
        kind: opts.ongoing ? 'ongoing' : 'project',
        ...(opts.type ? { type: opts.type } : {}),
        ...(opts.tag ? { tag: opts.tag } : {}),
        ...(opts.budget ? { budgetCents: dollarsToCents(opts.budget) } : {}),
        ...(opts.period ? { budgetPeriod: opts.period as 'monthly' | 'yearly' } : {}),
        ...(opts.start ? { startedOn: opts.start } : {}),
        ...(opts.targetEnd ? { targetEndOn: opts.targetEnd } : {}),
        ...(opts.note ? { note: opts.note } : {}),
      });
      console.log(`\nTracking "${p.name}" as #${p.tag}`);
      console.log('\nCosts flow in when you tag transactions into it:');
      console.log(`  finance tag add --match "<merchant>" ${p.tag}`);
      console.log('\nAdd a quote, a commitment, or a cash cost:');
      console.log(`  finance project item ${p.tag} "Exterior labour" 8000 --committed --vendor "Acme Co"\n`);
    } catch (err) {
      console.error(`\n${(err as Error).message}\n`);
      process.exitCode = 1;
    } finally {
      db.close();
    }
  });

project
  .command('show <project>')
  .description('Everything known about one project')
  .option('--since <YYYY-MM-DD>', 'Only count ledger spend from this date')
  .action((name: string, opts: { since?: string }) => {
    const db = openLedger();
    const r = projectReport(db, name, opts.since ? { startDate: opts.since } : undefined);
    db.close();
    if (!r) {
      console.error(`\nNo project matching "${name}". See \`finance project list\`.\n`);
      process.exitCode = 1;
      return;
    }
    const p = r.project;
    console.log(`\n${p.name}  [#${p.tag}]  ${p.type ?? p.kind}, ${p.status}`);
    if (p.note) console.log(`  ${p.note}`);
    if (p.startedOn || p.targetEndOn) {
      console.log(`  ${p.startedOn ?? '?'} → ${p.endedOn ?? p.targetEndOn ?? 'open'}`);
    }
    console.log('');
    console.log(`  From the ledger   ${money(r.ledgerCents).padStart(12)}  (${r.ledgerCount} transaction(s)`
      + `${r.firstDate ? `, ${r.firstDate} → ${r.lastDate}` : ''})`);
    if (r.offLedgerCents > 0) {
      console.log(`  Off-ledger        ${money(r.offLedgerCents).padStart(12)}  entered by hand`);
    }
    console.log(`  Spent so far      ${money(r.spentCents).padStart(12)}`);
    if (r.committedCents > 0) {
      console.log(`  Committed         ${money(r.committedCents).padStart(12)}  agreed, not yet paid`);
      console.log(`  On the hook for   ${money(r.exposureCents).padStart(12)}  spent + committed`);
    }
    if (r.quotedCents > 0) {
      console.log(`  Quoted            ${money(r.quotedCents).padStart(12)}  priced, not agreed`);
    }
    if (r.budgetCents !== null) {
      const over = (r.remainingCents ?? 0) < 0;
      if (r.budgetWindow) {
        const unit = p.budgetPeriod === 'yearly' ? 'year' : 'month';
        console.log(`  Budget            ${money(r.budgetCents).padStart(12)}  per ${unit}, `
          + `${r.budgetWindow.startDate} → ${r.budgetWindow.endDate}`);
        console.log(`  Spent this ${unit.padEnd(6)} ${money(r.budgetSpentCents).padStart(12)}`);
      } else {
        console.log(`  Budget            ${money(r.budgetCents).padStart(12)}`);
      }
      console.log(`  ${(over ? 'OVER by' : 'Left').padEnd(18)}${money(Math.abs(r.remainingCents ?? 0)).padStart(12)}`);
    }

    if (r.items.length > 0) {
      console.log('\n  Line items:');
      for (const i of r.items) {
        const flag = i.offLedger ? ' off-ledger' : '';
        console.log(`    ${money(i.amountCents).padStart(11)}  ${i.status.padEnd(9)} ${i.label}${flag}`);
        if (i.vendor) {
          const bits = [i.vendor.company, i.vendor.contactName, i.vendor.phone, i.vendor.email]
            .filter(Boolean).join(' · ');
          console.log(`                 ${bits}`);
        }
        if (i.status === 'committed') console.log(`                 settle with: finance project settle ${i.itemId}`);
      }
    }
    console.log('');
  });

project
  .command('item <project> <label> <amount>')
  .description('Add a quote, a commitment, or a cost the ledger will never see')
  .option('--committed', 'Agreed and unpaid — counted as exposure, never as spend')
  .option('--offledger', 'Already spent through something not linked (cash, another bank)')
  .option('--vendor <company>', 'Who it is with — created if new')
  .option('--phone <phone>', 'Vendor phone')
  .option('--email <email>', 'Vendor email')
  .option('--contact <name>', 'Vendor point of contact')
  .option('--due <YYYY-MM-DD>', 'When it is due')
  .option('--note <text>', 'Anything worth remembering')
  .action((name: string, label: string, amount: string, opts: {
    committed?: boolean; offledger?: boolean; vendor?: string; phone?: string;
    email?: string; contact?: string; due?: string; note?: string;
  }) => {
    const db = openLedger();
    const p = getProject(db, name);
    if (!p) {
      db.close();
      console.error(`\nNo project matching "${name}".\n`);
      process.exitCode = 1;
      return;
    }
    try {
      const vendor = opts.vendor
        ? upsertVendor(db, {
          company: opts.vendor,
          ...(opts.contact ? { contactName: opts.contact } : {}),
          ...(opts.phone ? { phone: opts.phone } : {}),
          ...(opts.email ? { email: opts.email } : {}),
        })
        : null;

      const item = addLineItem(db, p.projectId, {
        label,
        amountCents: dollarsToCents(amount),
        status: opts.offledger ? 'settled' : opts.committed ? 'committed' : 'quoted',
        ...(opts.offledger ? { offLedger: true } : {}),
        ...(vendor ? { vendorId: vendor.vendorId } : {}),
        ...(opts.due ? { dueOn: opts.due } : {}),
        ...(opts.note ? { note: opts.note } : {}),
      });
      console.log(`\n${money(item.amountCents)}  ${item.status}  ${item.label}`
        + `${vendor ? `  (${vendor.company})` : ''}   ${item.itemId}\n`);
    } catch (err) {
      console.error(`\n${(err as Error).message}\n`);
      process.exitCode = 1;
    } finally {
      db.close();
    }
  });

project
  .command('settle <itemId>')
  .description('Mark a commitment paid — do this once the payment is in the ledger and tagged')
  .option('--on <YYYY-MM-DD>', 'When it was paid')
  .action((itemId: string, opts: { on?: string }) => {
    const db = openLedger();
    try {
      settleLineItem(db, itemId, opts.on);
      console.log('\nSettled. It stops counting as owed — the ledger is the record now.\n');
    } catch (err) {
      console.error(`\n${(err as Error).message}\n`);
      process.exitCode = 1;
    } finally {
      db.close();
    }
  });

project
  .command('cancel <itemId>')
  .description('Drop a line item from every total')
  .action((itemId: string) => {
    const db = openLedger();
    try {
      setLineItemStatus(db, itemId, 'cancelled');
      console.log('\nCancelled.\n');
    } catch (err) {
      console.error(`\n${(err as Error).message}\n`);
      process.exitCode = 1;
    } finally {
      db.close();
    }
  });

project
  .command('edit <project>')
  .description('Change a budget, dates, type or note')
  .option('--name <name>')
  .option('--type <type>')
  .option('--budget <amount>', 'In dollars')
  .option('--start <YYYY-MM-DD>')
  .option('--target-end <YYYY-MM-DD>')
  .option('--note <text>')
  .action((name: string, opts: {
    name?: string; type?: string; budget?: string; start?: string;
    targetEnd?: string; note?: string;
  }) => {
    const db = openLedger();
    try {
      const p = updateProject(db, name, {
        ...(opts.name ? { name: opts.name } : {}),
        ...(opts.type ? { type: opts.type } : {}),
        ...(opts.budget ? { budgetCents: dollarsToCents(opts.budget) } : {}),
        ...(opts.start ? { startedOn: opts.start } : {}),
        ...(opts.targetEnd ? { targetEndOn: opts.targetEnd } : {}),
        ...(opts.note ? { note: opts.note } : {}),
      });
      console.log(`\nUpdated ${p.name}.\n`);
    } catch (err) {
      console.error(`\n${(err as Error).message}\n`);
      process.exitCode = 1;
    } finally {
      db.close();
    }
  });

project
  .command('close <project>')
  .description('Finish a project')
  .option('--cancelled', 'It did not happen, rather than it finished')
  .action((name: string, opts: { cancelled?: boolean }) => {
    const db = openLedger();
    const p = getProject(db, name);
    if (!p) {
      db.close();
      console.error(`\nNo project matching "${name}".\n`);
      process.exitCode = 1;
      return;
    }
    closeProject(db, p.projectId, opts.cancelled ? 'cancelled' : 'done');
    db.close();
    console.log(`\n${p.name} marked ${opts.cancelled ? 'cancelled' : 'done'}.\n`);
  });

project
  .command('vendors')
  .description('Everyone you have worked with')
  .action(() => {
    const db = openLedger();
    const rows = listVendors(db);
    db.close();
    if (rows.length === 0) { console.log('\nNo vendors yet.\n'); return; }
    console.log('');
    for (const v of rows) {
      console.log(`  ${v.company}`);
      const bits = [v.contactName, v.phone, v.email].filter(Boolean).join(' · ');
      if (bits) console.log(`    ${bits}`);
      if (v.note) console.log(`    ${v.note}`);
    }
    console.log('');
  });

// ── notes ────────────────────────────────────────────────────────────────────

program
  .command('notes')
  .description('Standing context for the AI analysis — what the numbers cannot say')
  .option('--show', 'Print what is currently being sent')
  .action((opts: { show?: boolean }) => {
    if (opts.show) {
      const notes = readNotes();
      if (!notes) {
        // Two different states: no file, or a file holding only the template's
        // comments — which are stripped, so nothing is sent. Telling the second
        // to "create it" sends someone to a file they already have.
        console.log(existsSync(notesPath())
          ? `\nNothing is sent yet — the file holds only the template's comments. Write below them:\n  ${notesPath()}\n`
          : `\nNothing yet. Create it with \`finance notes\`:\n  ${notesPath()}\n`);
        return;
      }
      console.log(`\nSent with every analysis (${notes.text.length} chars`
        + `${notes.truncated ? ', TRUNCATED — trim it' : ''}):\n`);
      console.log(notes.text.split('\n').map((l) => `  ${l}`).join('\n'));
      console.log('');
      return;
    }

    const { path, created } = ensureNotesFile();
    console.log(created ? `\nCreated ${path}` : `\n${path}`);
    console.log('\nEdit it and every report from then on reads it. Worth writing down:');
    console.log('  · what a large recurring payment actually IS');
    console.log('  · what is deliberate, so it stops being flagged as an anomaly');
    console.log('  · what you are saving for, so advice is about that');
    console.log('  · what NOT to suggest cutting, and why\n');
  });

// ── prune ────────────────────────────────────────────────────────────────────

program
  .command('prune')
  .description('Remove orphaned rows left behind by a deleted account or provider')
  .option('--dry-run', 'Report what would be removed without deleting')
  .action((opts: { dryRun?: boolean }) => {
    const db = openLedger();

    const preview = previewPrune(db);
    if (preview.transactions === 0 && preview.accounts === 0) {
      console.log('Nothing to prune.');
      db.close();
      return;
    }

    console.log(`${preview.transactions} orphaned transaction(s) — ${money(preview.cents)} currently counted in totals`);
    console.log(`${preview.accounts} orphaned account(s)`);

    if (opts.dryRun) {
      console.log('\nDry run — re-run without --dry-run to remove them.');
      db.close();
      return;
    }
    const result = prune(db);
    console.log(`\nRemoved ${result.transactions} transaction(s) and ${result.accounts} account(s).`);
    db.close();
  });

// ── doctor ───────────────────────────────────────────────────────────────────

program
  .command('doctor')
  .description('Check the install and report what is missing')
  .action(() => {
    let problems = 0;
    const ok = (m: string) => console.log(`  ${green('✓')} ${m}`);
    const bad = (m: string) => { problems++; console.log(`  ${red('✗')} ${red(m)}`); };
    const warn = (m: string) => { problems++; console.log(`  ${yellow('!')} ${yellow(m)}`); };
    const note = (m: string) => console.log(dim(`    ${m}`));
    const section = (title: string) => console.log(`\n${bold(title)}`);

    section('Config');
    const cfgPath = configPath();
    let config = defaultConfig();
    if (!existsSync(cfgPath)) {
      bad(`no config at ${cfgPath}`);
      note('run `finance setup` (guided) or `finance init` (just the starter config)');
    } else {
      try {
        config = loadConfig();
        ok(`valid config at ${cfgPath}`);
      } catch (err) {
        bad(`config invalid: ${(err as Error).message}`);
      }
    }

    section('Ledger');
    const dbPath = ledgerPath();
    // Looking must not create: opening a ledger that is not there makes one,
    // so `doctor` before `init` used to report "✓ ledger.db (4 KB, 0 accounts)"
    // for a file it had just written.
    if (!existsSync(dbPath)) {
      bad(`no ledger at ${dbPath}`);
      note('run `finance setup`, then `finance sync`');
    } else try {
      const db = openLedger();
      const accounts = listAccounts(db);
      const size = existsSync(dbPath) ? statSync(dbPath).size : 0;
      ok(`${dbPath} (${(size / 1024).toFixed(0)} KB, ${accounts.length} accounts)`);
      const txns = db.prepare('SELECT COUNT(*) c FROM transactions').get() as { c: number };
      const last = db.prepare(
        'SELECT provider_id, ran_at, error FROM sync_log ORDER BY id DESC LIMIT 1',
      ).get() as { provider_id: string; ran_at: string; error: string | null } | undefined;
      ok(`${txns.c} transactions`);
      if (last) {
        if (last.error) bad(`last sync (${last.provider_id}) failed: ${last.error}`);
        else ok(`last sync ${last.provider_id} at ${last.ran_at}`);
      } else {
        note('never synced');
      }
      db.close();
    } catch (err) {
      bad(`cannot open ledger: ${(err as Error).message}`);
    }

    section('Providers');
    const providers = buildProviders(config);
    if (providers.length === 0) {
      bad('none configured');
      // The path, not just the instruction. "Edit the config" is only useful
      // to someone who already knows where it is, which is nobody on their
      // first run.
      note(`add an account under [providers.csv] in ${configPath()}`);
      note('it has a commented example of every field — uncomment and edit one');
    } else {
      for (const p of providers) {
        ok(`${p.id} (${p.kind})${p.capabilities.automatic ? '' : ' — manual, scheduler will skip'}`);
      }
    }

    section('Secrets');
    ok(`backend: ${defaultBackend()}`);

    section('Data integrity');
    if (!existsSync(dbPath)) {
      note('nothing to check until there is a ledger');
    } else try {
      const db = openLedger();
      const found = runDiagnostics(db);
      db.close();
      if (found.length === 0) {
        ok('no duplicates, orphans or stalled syncs');
      } else {
        for (const d of found) {
          // Errors here mean the NUMBERS are wrong, not that a command failed.
          if (d.severity === 'error') bad(d.message);
          else if (d.severity === 'warning') warn(d.message);
          else console.log(`  ${dim('·')} ${d.message}`);
          for (const line of d.detail ?? []) note(line);
          // The remedy is the line to act on, so it is the one not dimmed.
          if (d.remedy) console.log(`    ${cyan('→')} ${d.remedy}`);
        }
      }
    } catch (err) {
      bad(`could not run diagnostics: ${(err as Error).message}`);
    }

    section('Schedule');
    const sched = scheduleStatus();
    if (sched.installed) ok(`installed${sched.detail ? ` — ${sched.detail}` : ''}`);
    else {
      note('not installed — run `finance schedule install`');
      if (providers.every((p) => !p.capabilities.automatic)) {
        note('(no automatic providers configured, so a schedule would have nothing to do)');
      }
    }

    console.log(problems === 0
      ? `\n${green(bold('All good.'))}\n`
      : `\n${yellow(bold(`${problems} problem(s) found.`))}\n`);
    if (problems > 0) process.exitCode = 1;
  });

// ── mcp ──────────────────────────────────────────────────────────────────────

program
  .command('mcp')
  .description('Run the MCP server on stdio (used by Claude and other MCP clients)')
  .action(async () => {
    await import('./mcp.js');
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
