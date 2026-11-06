// Config loading + validation.
//
// TOML because humans hand-edit this file. Zod because a bad config should fail
// with a precise message at startup, not as an undefined deep inside a sync.

import { readFileSync, existsSync } from 'node:fs';
import { parse as parseToml } from 'smol-toml';
import { z } from 'zod';
import { configPath } from './paths.js';

// How stale data may be before a read triggers a sync. Defaults encode the Plaid
// billing model: Transactions is a flat monthly per-Item subscription (so syncing
// often is free), while Balance is billed per successful call (so it gets cached
// hard). See docs/freshness.md.
const FreshnessSchema = z.object({
  /** Balances are per-call billable on some providers — cache aggressively. */
  balanceTtlMinutes: z.number().int().positive().default(15),
  /** Transactions are subscription-priced — refreshing is free, so stay current. */
  transactionTtlHours: z.number().int().positive().default(6),
  /**
   * A query whose window ended more than this many days ago is treated as
   * settled and never triggers a sync. Most budget questions are about closed
   * periods, so this is what keeps historical queries instant.
   */
  settledAfterDays: z.number().int().nonnegative().default(3),
  /** Answer immediately from cache and refresh in the background. Off by default. */
  staleWhileRevalidate: z.boolean().default(false),
}).strict();

const CsvAccountSchema = z.object({
  /** Stable id for this account; appears in the ledger and in queries. */
  accountId: z.string().min(1),
  name: z.string().min(1),
  /** Last 4 only. Full account numbers are never stored. */
  mask: z.string().max(4).optional(),
  type: z.enum(['depository', 'credit', 'loan', 'investment', 'other']).default('depository'),
  currency: z.string().length(3).default('USD'),
  /** Directory watched for CSV drops, or a single file. */
  path: z.string().min(1),
  columns: z.object({
    date: z.string().min(1),
    amount: z.string().min(1).optional(),
    /** Banks that split debit/credit into two columns instead of one signed one. */
    debit: z.string().min(1).optional(),
    credit: z.string().min(1).optional(),
    description: z.string().min(1),
    merchant: z.string().min(1).optional(),
    /**
     * The bank's own category column, if the export has one. Coarse, but it
     * covers every row — far better than regex on the long tail of merchant
     * names. Used when description inference finds nothing specific.
     */
    category: z.string().min(1).optional(),
  }),
  /** e.g. "MM/DD/YYYY", "YYYY-MM-DD", "DD/MM/YYYY". */
  dateFormat: z.string().default('YYYY-MM-DD'),
  /**
   * True when a NEGATIVE number in the amount column means money left the
   * account (the common case). Credit-card exports often invert this.
   */
  negativeIsSpending: z.boolean().default(true),
}).strict();

const PlaidProviderSchema = z.object({
  enabled: z.boolean().default(false),
  /** 'sandbox' until you have verified the pipeline against fake banks. */
  environment: z.enum(['sandbox', 'production']).default('sandbox'),
  /** Where credentials come from; never the credentials themselves. */
  secretsBackend: z.enum(['keychain', 'secret-service', 'dpapi', 'env']).optional(),
  /** Path to the `plaid` binary when it is not on PATH. */
  binary: z.string().optional(),
  /**
   * Plaid account_ids to skip entirely.
   *
   * Needed for joint accounts. When two people each link the same institution
   * with their own login — because each can only see their own card — the joint
   * checking account arrives under BOTH Items, with different account_ids and
   * different transaction_ids for the same real transactions. Dedup by id
   * cannot see they are the same, so every joint transaction counts twice.
   * List one side's copies here to drop them.
   */
  ignoreAccounts: z.array(z.string()).default([]),
}).strict();

const CsvProviderSchema = z.object({
  enabled: z.boolean().default(false),
  accounts: z.array(CsvAccountSchema).default([]),
}).strict();

/**
 * Optional AI narration of the insights brief.
 *
 * A COMMAND, not an API client: the brief goes in on stdin, markdown comes back
 * on stdout. `claude -p` uses an existing Claude Code login, `ollama run <model>`
 * keeps everything on the machine, and this tool never stores a credential.
 *
 * Off by default — enabling it sends the brief to whatever command is named.
 */
const NarrationSchema = z.object({
  enabled: z.boolean().default(false),
  command: z.string().min(1).default('claude'),
  args: z.array(z.string()).default(['-p']),
  timeoutSeconds: z.number().int().positive().max(600).default(120),
}).strict();

/**
 * The scheduled report: what window, how often, and how it reaches you.
 *
 * Read by `finance schedule install`, so changing this and re-running the
 * install is the whole workflow — no flags to remember.
 */
/**
 * SMTP settings. The PASSWORD is not here — it lives in the OS keystore, same
 * as the Plaid secret: `finance secret set smtp password`.
 */
const SmtpSchema = z.object({
  host: z.string().min(1).default('smtp.gmail.com'),
  port: z.number().int().positive().default(587),
  /** Derived from the port when unset: 465 implicit TLS, otherwise STARTTLS. */
  secure: z.boolean().optional(),
  user: z.string().min(1).optional(),
  to: z.string().email().optional(),
  from: z.string().optional(),
}).strict();

const ReportSchema = z.object({
  schedule: z.enum(['off', 'daily', 'weekly', 'monthly']).default('off'),
  /** Window the report covers, relative to the day it runs. */
  range: z.enum(['last-7-days', 'last-30-days', 'last-90-days', 'month-to-date', 'year-to-date', 'all']).default('last-30-days'),
  /** notify | email | open | save-only. Empty means save only. */
  deliver: z.array(z.enum(['notify', 'email', 'smtp', 'copy', 'command', 'open', 'save-only'])).default(['notify']),
  emailTo: z.string().email().optional(),
  /** Where `copy` puts the report. Defaults to iCloud Drive on macOS. */
  copyTo: z.string().optional(),
  /**
   * The `command` channel — pushes the report anywhere without vendor code.
   * Placeholders: {file} {headline} {subject} {start} {end}.
   *   ntfy:     command = "curl", args = ["-T", "{file}", "https://ntfy.sh/topic"]
   *   Telegram: command = "curl", args = ["-F", "document=@{file}", "https://api.telegram.org/bot<t>/sendDocument?chat_id=<id>"]
   */
  command: z.string().optional(),
  commandArgs: z.array(z.string()).default([]),
  smtp: SmtpSchema.prefault({}),
  /**
   * false opens a Mail.app draft instead of sending. Useful while setting up —
   * you see exactly what would go out before it does.
   */
  sendEmail: z.boolean().default(true),
  /** Include the AI analysis section. Requires [narration] to be usable. */
  ai: z.boolean().default(false),
}).strict();

export const ConfigSchema = z.object({
  /** IANA tz — resolves "this month" and friends. */
  timezone: z.string().default('UTC').refine((tz) => {
    // Checked here so a typo fails at startup, not inside the first summary.
    try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
  }, 'must be an IANA time zone, e.g. America/New_York or Europe/London'),
  baseCurrency: z.string().length(3).default('USD'),
  freshness: FreshnessSchema.prefault({}),
  narration: NarrationSchema.prefault({}),
  report: ReportSchema.prefault({}),
  providers: z.object({
    plaid: PlaidProviderSchema.prefault({}),
    csv: CsvProviderSchema.prefault({}),
  }).prefault({}),
});

export type Config = z.infer<typeof ConfigSchema>;
export type CsvAccountConfig = z.infer<typeof CsvAccountSchema>;
export type FreshnessConfig = z.infer<typeof FreshnessSchema>;
export type NarrationConfigShape = z.infer<typeof NarrationSchema>;
export type ReportConfig = z.infer<typeof ReportSchema>;
export type SmtpConfig = z.infer<typeof SmtpSchema>;

/** Defaults with no file present — enough to run `doctor` and see what's missing. */
export function defaultConfig(): Config {
  return ConfigSchema.parse({});
}

export function parseConfig(toml: string): Config {
  let raw: unknown;
  try {
    raw = parseToml(toml);
  } catch (err) {
    throw new Error(`config is not valid TOML: ${(err as Error).message}`);
  }
  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`config failed validation:\n${issues}`);
  }
  return result.data;
}

export function loadConfig(env?: NodeJS.ProcessEnv): Config {
  const path = configPath(env);
  if (!existsSync(path)) return defaultConfig();
  return parseConfig(readFileSync(path, 'utf8'));
}
