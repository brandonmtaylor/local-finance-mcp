#!/usr/bin/env node
// MCP server (stdio) — the agent-facing surface.
//
// Thin by design: every tool resolves to a core call. The one piece of real
// behaviour here is sync-on-read — MCP cannot push work to a model, so freshness
// is decided in the read path from config rather than by the model remembering
// to call a sync tool. See core/freshness.ts.
//
// What this server will NOT do: return credentials, move money, or write to the
// ledger beyond a user's own category corrections and notes.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import Database from 'better-sqlite3';
import { loadConfig } from './core/config.js';
import { openLedger, setCategoryOverride, setNote, addTag, removeTag } from './core/ledger.js';
import {
  createProject, getProject, updateProject, closeProject, upsertVendor, listVendors,
  addLineItem, settleLineItem, setLineItemStatus, projectReport, allProjectReports,
  totalCommitted,
} from './core/projects.js';
import { decideFreshness } from './core/freshness.js';
import { CATEGORIES, type Category } from './core/normalize.js';
import { VERSION } from './core/version.js';
import {
  listAccounts,
  latestBalances,
  queryTransactions,
  getSpendingSummary,
  runReadOnlyQuery,
  SQL_SCHEMA_GUIDE,
  noDataReason,
  tagTotals,
} from './core/queries.js';
import { syncAll, oldestSyncAmong } from './core/sync.js';
import { collectInsights } from './core/insights.js';
import { computeBaseline, applyScenario, maxAffordable, principalFromPayment } from './core/afford.js';
import { buildProviders } from './providers/registry.js';
import { ledgerPath } from './core/paths.js';

const config = loadConfig();
const db = openLedger();
const providers = buildProviders(config);

const money = (cents: number, currency = 'USD') =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);

const json = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
});

const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }] });

/**
 * Refresh before answering, if policy says so.
 *
 * Returns a short note about what happened so the model can tell the user
 * whether they are looking at live or cached data.
 */
async function ensureFresh(kind: 'balances' | 'transactions', windowEnd?: string): Promise<string> {
  const automatic = providers.filter((p) => p.capabilities.automatic);
  if (automatic.length === 0) return 'no automatic providers configured; served from ledger';

  const decision = decideFreshness(
    { kind, lastSyncAt: oldestSyncAmong(db, automatic.map((p) => p.id)), windowEnd },
    config.freshness,
  );
  if (!decision.sync) return `served from the ledger — ${decision.reason}`;
  if (!decision.blocking) {
    void syncAll(db, providers, {
      timezone: config.timezone,
      automaticOnly: true,
    });
    return `served from the ledger, refreshing in the background — ${decision.reason}`;
  }

  const outcomes = await syncAll(db, providers, {
      timezone: config.timezone,
      automaticOnly: true,
    });
  if (outcomes === null) return 'another sync is already running; served from ledger';
  const failed = outcomes.filter((o) => o.error);
  if (failed.length) {
    return `synced with errors: ${failed.map((f) => `${f.providerId}: ${f.error}`).join('; ')}`;
  }
  // The reason describes the state BEFORE the sync, so it cannot simply be
  // parenthesised after "synced" — that produced "synced (never synced)", which
  // a model would reasonably report as nothing having synced. This text is read
  // by something that paraphrases it, so it has to be unambiguous on its own.
  return `synced just now, because ${decision.reason}`;
}

/**
 * Guard every read that reports an amount.
 *
 * An empty ledger and a genuinely quiet month produce the same zero, and a model
 * shown a bare 0 will state "you spent nothing" as fact. Say which it is.
 */
function emptyLedgerNotice(): string | null {
  const reason = noDataReason(db, providers.map((p) => p.id));
  return reason && `${reason} Do not report any total from it.`;
}

const server = new McpServer({ name: 'local-finance-mcp', version: VERSION });

server.registerTool(
  'list_accounts',
  {
    title: 'List accounts',
    description:
      'List every linked account with its provider, masked number, and the date range of ' +
      'transactions held for it. Start here to learn what data is available.',
    inputSchema: {},
  },
  async () => {
    const notice = emptyLedgerNotice();
    if (notice) return text(notice);
    return json({ ledger: ledgerPath(), accounts: listAccounts(db) });
  },
);

server.registerTool(
  'get_balances',
  {
    title: 'Get balances',
    description:
      'Latest known balance per account. Balances are billed per call by some providers, so ' +
      'this serves a short-lived cache and refreshes only when it has expired.',
    inputSchema: {},
  },
  async () => {
    const freshness = await ensureFresh('balances');
    const balances = latestBalances(db);
    if (balances.length === 0) {
      return text(
        `No balances recorded. ${freshness}. ` +
        'Balance data requires a provider that reports it (the CSV provider does not).',
      );
    }
    return json({ freshness, balances });
  },
);

server.registerTool(
  'query_transactions',
  {
    title: 'Query transactions',
    description:
      'Search transactions with structured filters. Amounts are integer cents and SIGNED: ' +
      'negative is money out, positive is money in.',
    inputSchema: {
      startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('YYYY-MM-DD, inclusive'),
      endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('YYYY-MM-DD, inclusive'),
      accountIds: z.array(z.string()).optional(),
      categories: z.array(z.enum(CATEGORIES)).optional(),
      spendGroups: z.array(z.enum(['purchases', 'bills', 'payments', 'transfers', 'income'])).optional(),
      search: z.string().optional().describe('Substring match on description and merchant'),
      includePending: z.boolean().optional(),
      tags: z.array(z.string()).optional().describe('Only transactions carrying ALL of these tags'),
      limit: z.number().int().positive().max(5_000).optional(),
      offset: z.number().int().nonnegative().optional(),
    },
  },
  async (args) => {
    const freshness = await ensureFresh('transactions', args.endDate);
    // Checked AFTER the sync attempt — a first-run sync may have just filled it.
    const notice = emptyLedgerNotice();
    if (notice) return text(notice);
    const rows = queryTransactions(db, args);
    return json({ freshness, count: rows.length, transactions: rows });
  },
);

server.registerTool(
  'get_spending_summary',
  {
    title: 'Get spending summary',
    description:
      'Spending over a date range, broken down by category and merchant. `spendingCents` counts ' +
      'purchases and bills. CREDIT-CARD payments and transfers are reported separately under ' +
      '`excluded` and deliberately not added in — a card\'s purchases are already counted, so ' +
      'counting the payment too would count the same spending twice. LOAN payments (mortgage, ' +
      'student, auto) ARE counted as spending: a loan reports a balance rather than purchases, ' +
      'so nothing else accounts for them. When `cardPaymentsCounted` is true, card payments ARE ' +
      'included in the total because no credit-card account is linked — the payment is then the ' +
      'only record of what was spent on that card. Say so when reporting the figure. ' +
      'Refunds reduce their category only down to zero; money beyond that (an insurance ' +
      'payout filed as insurance, say) is in `excluded.refundsBeyondSpendingCents` and is ' +
      'neither spending nor income.',
    inputSchema: {
      startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('YYYY-MM-DD, inclusive'),
      endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('YYYY-MM-DD, inclusive'),
      accountIds: z.array(z.string()).optional(),
    },
  },
  async ({ startDate, endDate, accountIds }) => {
    const freshness = await ensureFresh('transactions', endDate);
    // The most dangerous zero in the project: "$0 spent" reads as a fact.
    const notice = emptyLedgerNotice();
    if (notice) return text(notice);
    const summary = getSpendingSummary(db, startDate, endDate, accountIds);
    return json({
      freshness,
      ...summary,
      spendingFormatted: money(summary.spendingCents, summary.currency),
    });
  },
);

server.registerTool(
  'get_insights',
  {
    title: 'Get a computed insight brief',
    description:
      'Deterministic analysis of a date range: spending vs the prior equal-length period, ' +
      'category concentration and trends, recurring charges with their cadence, transactions ' +
      'unusually large FOR THEIR OWN CATEGORY, and merchants seen for the first time. ' +
      'All arithmetic, no interpretation — use it as the basis for recommendations rather ' +
      'than reading raw transactions. When `priorPeriodComparable` is false the ledger does ' +
      'not reach back far enough, so do NOT describe any trend or change.',
    inputSchema: {
      startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    },
  },
  async ({ startDate, endDate }) => {
    const freshness = await ensureFresh('transactions', endDate);
    const notice = emptyLedgerNotice();
    if (notice) return text(notice);
    return json({ freshness, ...collectInsights(db, startDate, endDate) });
  },
);

server.registerTool(
  'get_affordability',
  {
    title: 'What can I afford',
    description:
      'Monthly cash-flow scenarios built from ACTUAL income and spending, not a budget. ' +
      'Optionally add a new obligation (car, childcare) or replace existing loan payments ' +
      '(a house move swaps one mortgage for another). Also returns the largest new payment ' +
      'that still leaves a chosen buffer. ' +
      'ALWAYS repeat the `warnings` — a baseline from two months, or one containing a bonus, ' +
      'is far weaker than the numbers suggest. This is cash flow only: no PMI, maintenance, ' +
      'closing costs or tax changes, and it is not underwriting. An `annualIncome` figure is ' +
      'ASSUMED rather than measured — say so, and note a lender typically wants two years of ' +
      'bonus history and averages it before counting any of it.',
    inputSchema: {
      addMonthly: z.number().optional().describe('New monthly obligation, in dollars'),
      replaceLoanMonthly: z.number().optional().describe('Replaces current loan payments, in dollars'),
      bufferMonthly: z.number().optional().describe('Monthly slack to preserve, in dollars'),
      annualIncome: z.number().optional().describe(
        'Annual TAKE-HOME lump — bonus, vest, refund — spread over 12 months. Assumed, not '
        + 'measured. Gross overstates it badly; bonuses are withheld at a supplemental rate.'),
      excludeTags: z.array(z.string()).optional().describe('Leave tagged one-offs out of the baseline'),
      rate: z.number().optional().describe('Annual rate % for converting a payment to a principal'),
      termYears: z.number().optional(),
    },
  },
  async (args) => {
    const baseline = computeBaseline(db, { excludeTags: args.excludeTags });
    if (baseline.monthsCovered === 0) return text(baseline.warnings[0]!);

    const dollars = (v?: number) => (v === undefined ? undefined : Math.round(v * 100));
    const add = dollars(args.addMonthly);
    const replace = dollars(args.replaceLoanMonthly);
    const buffer = dollars(args.bufferMonthly) ?? 0;

    const scenario = (add !== undefined || replace !== undefined)
      ? applyScenario(baseline, {
        label: 'scenario', addCents: add, replaceLoanCents: replace,
        annualIncomeCents: dollars(args.annualIncome),
      })
      : undefined;
    const max = maxAffordable(baseline, buffer, replace !== undefined, dollars(args.annualIncome));

    return json({
      baseline,
      scenario,
      maxNewPaymentCents: max,
      maxPrincipalCents: max > 0
        ? principalFromPayment(max, args.rate ?? 6.5, args.termYears ?? 30)
        : 0,
      caveat: 'Cash flow only — excludes PMI, maintenance, closing costs and tax changes. Not underwriting.',
    });
  },
);

server.registerTool(
  'sql_query',
  {
    title: 'Run a read-only SQL query',
    description:
      'Run a SELECT against the ledger for analysis the structured tools do not cover. ' +
      SQL_SCHEMA_GUIDE + ' Read-only: the connection rejects writes.',
    inputSchema: {
      sql: z.string().describe('A single SELECT or WITH…SELECT statement'),
      limit: z.number().int().positive().max(5_000).optional(),
    },
  },
  async ({ sql, limit }) => {
    // Opened per call, read-only, so a bug here cannot corrupt the ledger.
    const readonly = openReadOnly();
    try {
      return json(runReadOnlyQuery(readonly, sql, limit));
    } catch (err) {
      return text(`Query rejected: ${(err as Error).message}`);
    } finally {
      readonly.close();
    }
  },
);

server.registerTool(
  'set_category',
  {
    title: 'Correct a transaction category',
    description:
      'Override the category of one transaction. The override is stored separately from the ' +
      'provider value and survives future syncs. Pass null to clear it.',
    inputSchema: {
      txnId: z.string(),
      category: z.enum(CATEGORIES).nullable().describe('null clears the override'),
    },
  },
  async ({ txnId, category }) => {
    const ok = setCategoryOverride(db, txnId, category as Category | null);
    return text(ok
      ? `Set ${txnId} to ${category ?? 'provider default'}.`
      : `No transaction with id ${txnId}.`);
  },
);

server.registerTool(
  'set_note',
  {
    title: 'Attach context to a transaction',
    description:
      'Record why a transaction happened — "dishwasher leak, replaced flooring". Notes are ' +
      'user-owned and survive every future sync. Pass null to clear.',
    inputSchema: {
      txnId: z.string(),
      note: z.string().nullable(),
    },
  },
  async ({ txnId, note }) => text(
    setNote(db, txnId, note) ? `Noted ${txnId}.` : `No transaction with id ${txnId}.`,
  ),
);

server.registerTool(
  'add_tag',
  {
    title: 'Tag a transaction',
    description:
      'Tags are ORTHOGONAL to categories. A category says what kind of spending it is and ' +
      'there is exactly one; a tag says anything else and there can be many — "emergency", ' +
      '"reimbursable", or the name of a one-off event. The event case is the useful one: a ' +
      'dishwasher leak shows up as a repair, an appliance, a plumber and a cancellation fee ' +
      'across different categories and weeks, and tagging them all makes "what did that ' +
      'episode cost" answerable. Tagging one-offs also lets them be excluded from a baseline.',
    inputSchema: {
      txnId: z.string(),
      tag: z.string().describe('Lower-cased and hyphenated automatically'),
    },
  },
  async ({ txnId, tag }) => text(
    addTag(db, txnId, tag) ? `Tagged ${txnId} "${tag}".` : `No transaction with id ${txnId}.`,
  ),
);

server.registerTool(
  'remove_tag',
  {
    title: 'Remove a tag from a transaction',
    description: 'Detach a tag. The transaction and its category are untouched.',
    inputSchema: { txnId: z.string(), tag: z.string() },
  },
  async ({ txnId, tag }) => text(
    removeTag(db, txnId, tag) ? `Removed "${tag}" from ${txnId}.` : `${txnId} did not carry "${tag}".`,
  ),
);

server.registerTool(
  'get_tag_totals',
  {
    title: 'What each tag cost',
    description:
      'Total spending per tag, with the date range it spans. This is how to answer "what did ' +
      'the dishwasher leak cost us in total" when the answer spans several categories.',
    inputSchema: {
      startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    },
  },
  async ({ startDate, endDate }) => json(tagTotals(db, startDate, endDate)),
);

server.registerTool(
  'sync_accounts',
  {
    title: 'Force a sync',
    description:
      'Refresh from providers now, ignoring the freshness policy. Not normally needed — reads ' +
      'refresh themselves when stale. Use when the user explicitly asks for up-to-date data.',
    inputSchema: {},
  },
  async () => {
    const outcomes = await syncAll(db, providers, {
      timezone: config.timezone,
    });
    if (outcomes === null) return text('Another sync is already running.');
    if (outcomes.length === 0) return text('No providers are configured. Run `finance doctor`.');
    return json(outcomes);
  },
);

// ── projects ─────────────────────────────────────────────────────────────────
//
// A project answers what a job was SUPPOSED to cost, what is agreed but unpaid,
// and what was paid in a way no linked account will show. Spend itself is never
// stored here — it stays in the ledger as tagged transactions and is summed at
// read time.

server.registerTool(
  'list_projects',
  {
    title: 'Projects and where they stand',
    description:
      'Every tracked project — a remodel, a car, a DIY build — with budget, spend so far, and ' +
      'money agreed but not yet paid. Spend comes from ledger transactions carrying the ' +
      "project's tag, so it is always consistent with spending totals.",
    inputSchema: {
      includeClosed: z.boolean().optional().describe('Include finished and cancelled projects'),
    },
  },
  async ({ includeClosed }) => json({
    projects: allProjectReports(db, includeClosed ?? false),
    totalCommittedCents: totalCommitted(db),
  }),
);

server.registerTool(
  'get_project',
  {
    title: 'One project in full',
    description:
      'Budget, spend, commitments and every line item with its vendor contact details. ' +
      'Accepts a project id, its tag, or its name. `spentCents` is what has actually left ' +
      'the account; `committedCents` is agreed and unpaid and is NEVER part of spend; ' +
      '`exposureCents` is the two together — what the job costs if nothing changes. ' +
      'Compare the budget with `budgetSpentCents`, not `spentCents`: for an ongoing project ' +
      'with a monthly or yearly budget it is this period\'s spend (`budgetWindow`), while ' +
      '`spentCents` is lifetime.',
    inputSchema: {
      project: z.string().describe('Project id, tag, or name'),
      startDate: z.string().optional().describe('YYYY-MM-DD — only count ledger spend from here'),
      endDate: z.string().optional(),
    },
  },
  async ({ project, startDate, endDate }) => {
    const report = projectReport(db, project, { ...(startDate ? { startDate } : {}), ...(endDate ? { endDate } : {}) });
    return report ? json(report) : text(`No project matching "${project}".`);
  },
);

server.registerTool(
  'create_project',
  {
    title: 'Start tracking a project',
    description:
      'Create a project to track costs against. Costs flow in automatically from any ledger ' +
      'transaction tagged with the returned tag — use add_tag for that. Use kind "ongoing" ' +
      'for something with no end (a car), which then takes a budget period; a bounded ' +
      "project's budget is the total for the whole job and takes no period.",
    inputSchema: {
      name: z.string(),
      type: z.string().optional().describe('remodel | auto | diy | anything useful'),
      kind: z.enum(['project', 'ongoing']).optional(),
      budgetCents: z.number().int().optional(),
      budgetPeriod: z.enum(['monthly', 'yearly']).optional().describe('Only with kind "ongoing"'),
      startedOn: z.string().optional().describe('YYYY-MM-DD'),
      targetEndOn: z.string().optional().describe('YYYY-MM-DD'),
      tag: z.string().optional().describe('Defaults to a slug of the name'),
      note: z.string().optional(),
    },
  },
  async (input) => {
    try {
      return json(createProject(db, input));
    } catch (err) {
      return text((err as Error).message);
    }
  },
);

server.registerTool(
  'add_project_item',
  {
    title: 'Add a quote, a commitment, or an off-ledger cost',
    description:
      'A line item on a project. Choose status carefully, because it decides what the money ' +
      'means:\n' +
      '  "quoted"    — priced, not agreed. Not counted as owed.\n' +
      '  "committed" — agreed and unpaid. Counted as exposure, NEVER as spend, because the ' +
      'payment will also arrive in the ledger and counting both would double it.\n' +
      '  "settled"   — already paid. The ledger is the record, so this does not add to spend ' +
      'UNLESS offLedger is true.\n' +
      'Set offLedger only for money no linked account will ever show — cash, a cheque from an ' +
      'unlinked bank, someone else\'s card. Every one of those is maintained by hand, so keep ' +
      'the bucket small. Vendor details are optional and stored once, reusable across projects.',
    inputSchema: {
      project: z.string().describe('Project id, tag, or name'),
      label: z.string(),
      amountCents: z.number().int().positive(),
      status: z.enum(['quoted', 'committed', 'settled']).optional().describe('Default: quoted'),
      offLedger: z.boolean().optional().describe('Only valid with status "settled"'),
      vendorCompany: z.string().optional(),
      vendorContactName: z.string().optional(),
      vendorPhone: z.string().optional(),
      vendorEmail: z.string().optional(),
      dueOn: z.string().optional().describe('YYYY-MM-DD'),
      note: z.string().optional(),
    },
  },
  async (input) => {
    const project = getProject(db, input.project);
    if (!project) return text(`No project matching "${input.project}".`);
    try {
      const vendor = input.vendorCompany
        ? upsertVendor(db, {
          company: input.vendorCompany,
          ...(input.vendorContactName ? { contactName: input.vendorContactName } : {}),
          ...(input.vendorPhone ? { phone: input.vendorPhone } : {}),
          ...(input.vendorEmail ? { email: input.vendorEmail } : {}),
        })
        : null;
      return json(addLineItem(db, project.projectId, {
        label: input.label,
        amountCents: input.amountCents,
        ...(input.status ? { status: input.status } : {}),
        ...(input.offLedger !== undefined ? { offLedger: input.offLedger } : {}),
        ...(vendor ? { vendorId: vendor.vendorId } : {}),
        ...(input.dueOn ? { dueOn: input.dueOn } : {}),
        ...(input.note ? { note: input.note } : {}),
      }));
    } catch (err) {
      return text((err as Error).message);
    }
  },
);

server.registerTool(
  'update_project_item',
  {
    title: 'Settle or cancel a line item',
    description:
      'Settle a commitment once the payment has landed AND been tagged into the project — ' +
      'until then it counts as owed, and after it the ledger is the record, so leaving it ' +
      'open would report the same money as both spent and outstanding. Cancel drops it from ' +
      'every total.',
    inputSchema: {
      itemId: z.string(),
      status: z.enum(['settled', 'cancelled']),
      on: z.string().optional().describe('YYYY-MM-DD, when it was settled'),
    },
  },
  async ({ itemId, status, on }) => {
    try {
      if (status === 'settled') settleLineItem(db, itemId, on);
      else setLineItemStatus(db, itemId, 'cancelled');
      return text(`${itemId} is now ${status}.`);
    } catch (err) {
      return text((err as Error).message);
    }
  },
);

server.registerTool(
  'upsert_vendor',
  {
    title: 'Record or update who you worked with',
    description:
      'Company, contact name, phone, email. Matched on company name, so calling this again ' +
      'with new details UPDATES the existing record rather than creating a second one — which ' +
      'is the point of storing them once: a phone number is current state, and duplicate ' +
      'copies go stale. Fields you omit are left as they were.',
    inputSchema: {
      company: z.string(),
      contactName: z.string().optional(),
      phone: z.string().optional(),
      email: z.string().optional(),
      note: z.string().optional(),
    },
  },
  async (input) => {
    try {
      return json(upsertVendor(db, input));
    } catch (err) {
      return text((err as Error).message);
    }
  },
);

server.registerTool(
  'update_project',
  {
    title: 'Change a project\'s plan',
    description:
      'Correct a budget, dates, type, status or note after the fact. Omitted fields are left ' +
      'alone. The tag cannot be changed: it is the join key, so moving it would silently ' +
      'orphan every transaction already tagged into the project and drop its spend to zero.',
    inputSchema: {
      project: z.string().describe('Project id, tag, or name'),
      name: z.string().optional(),
      type: z.string().nullable().optional(),
      budgetCents: z.number().int().nullable().optional(),
      budgetPeriod: z.enum(['monthly', 'yearly']).nullable().optional(),
      startedOn: z.string().nullable().optional(),
      targetEndOn: z.string().nullable().optional(),
      status: z.enum(['planning', 'active', 'done', 'cancelled']).optional(),
      note: z.string().nullable().optional(),
    },
  },
  async ({ project, ...patch }) => {
    try {
      return json(updateProject(db, project, patch));
    } catch (err) {
      return text((err as Error).message);
    }
  },
);

server.registerTool(
  'close_project',
  {
    title: 'Finish a project',
    description:
      'Mark a project done, or cancelled if it never happened. Its transactions and line items ' +
      'stay; it simply drops out of the active list and stops counting toward committed money.',
    inputSchema: {
      project: z.string(),
      cancelled: z.boolean().optional().describe('It did not happen, rather than it finished'),
    },
  },
  async ({ project, cancelled }) => {
    const found = getProject(db, project);
    if (!found) return text(`No project matching "${project}".`);
    closeProject(db, found.projectId, cancelled ? 'cancelled' : 'done');
    return text(`${found.name} marked ${cancelled ? 'cancelled' : 'done'}.`);
  },
);

server.registerTool(
  'list_vendors',
  {
    title: 'Everyone you have worked with',
    description: 'Company, contact, phone and email for every vendor recorded across all projects.',
    inputSchema: {},
  },
  async () => json(listVendors(db)),
);

function openReadOnly(): Database.Database {
  // better-sqlite3 enforces this at the connection level, which is the actual
  // guarantee; the SQL check in runReadOnlyQuery is just a clearer error.
  return new Database(ledgerPath(), { readonly: true, fileMustExist: true });
}

const transport = new StdioServerTransport();
await server.connect(transport);
