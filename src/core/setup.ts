// The pieces `finance setup` is made of, kept apart from the prompting.
//
// A wizard is mostly decisions — is this environment usable, does this guess
// hold up, what should the config say — and those are worth testing without a
// terminal attached. src/cli.ts supplies the questions; this decides what the
// answers mean.

import { existsSync, accessSync, constants, statSync, readdirSync, readFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import { parse as parseCsv } from 'csv-parse/sync';
import { detectColumns, type DetectedColumns } from '../providers/csv/detect.js';
import { expandPath } from './paths.js';

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
  /** What to do about it. Absent when nothing is wrong. */
  fix?: string;
  /** False when the check is advisory — a missing optional dependency. */
  blocking: boolean;
}

/**
 * Whether this machine can run the tool at all.
 *
 * Separates blocking from advisory deliberately. A missing `plaid` binary
 * stops nothing if the user only wants CSV, and telling them it does sends
 * them off to install something they will never use.
 */
export function preflight(options: {
  home: string;
  nodeVersion?: string;
  hasPlaidBinary: boolean;
}): Check[] {
  const checks: Check[] = [];

  const major = Number((options.nodeVersion ?? process.version).replace(/^v/, '').split('.')[0]);
  checks.push({
    name: 'Node',
    ok: major >= 20,
    detail: options.nodeVersion ?? process.version,
    blocking: true,
    ...(major >= 20 ? {} : { fix: 'Node 20 or newer is required — better-sqlite3 and the MCP SDK both need it.' }),
  });

  let writable = false;
  let detail = options.home;
  try {
    // The first existing ancestor is what matters: the data directory itself
    // may not exist yet, and its parent is what decides whether it can.
    let probe = options.home;
    while (!existsSync(probe) && probe !== '/' && probe.length > 1) {
      probe = probe.slice(0, probe.lastIndexOf('/')) || '/';
    }
    accessSync(probe, constants.W_OK);
    writable = true;
  } catch {
    detail = `${options.home} (not writable)`;
  }
  checks.push({
    name: 'Data directory',
    ok: writable,
    detail,
    blocking: true,
    ...(writable ? {} : { fix: 'Set FINANCE_HOME to a directory you can write to.' }),
  });

  checks.push({
    name: 'Plaid CLI',
    ok: options.hasPlaidBinary,
    detail: options.hasPlaidBinary ? 'found on PATH' : 'not found',
    blocking: false,
    ...(options.hasPlaidBinary ? {} : {
      fix: 'Only needed for bank connections: brew install plaid/plaid-cli/plaid. '
        + 'When you do link, pass --days 730: the history window is fixed when the '
        + 'connection is created and cannot be widened afterwards. '
        + 'CSV imports work without it.',
    }),
  });

  return checks;
}

export interface CsvPreview {
  path: string;
  files: string[];
  detected: DetectedColumns;
  /** The first few rows as the importer would read them, for eyeballing. */
  sample: Array<{ date: string; amount: string; description: string }>;
  errors: string[];
}

/**
 * Read a folder or file and show what the importer would make of it.
 *
 * The sample is the point. A layout guess is only worth anything if a person
 * can look at three rows and recognise their own spending — which catches the
 * failures a confidence score cannot describe, like a column offset by one or
 * a date read as day-first.
 */
export function previewCsv(rawPath: string, limit = 5): CsvPreview {
  const path = expandPath(rawPath);
  const errors: string[] = [];

  if (!existsSync(path)) {
    return { path, files: [], detected: { profiles: [], warnings: [] }, sample: [], errors: [`${path} does not exist`] };
  }

  const files = statSync(path).isDirectory()
    ? readdirSync(path).filter((f) => extname(f).toLowerCase() === '.csv').map((f) => join(path, f))
    : [path];

  if (files.length === 0) {
    return { path, files, detected: { profiles: [], warnings: [] }, sample: [], errors: ['no .csv files here'] };
  }

  let rows: Array<Record<string, string>> = [];
  try {
    rows = parseCsv(readFileSync(files[0]!, 'utf8'), {
      columns: true, skip_empty_lines: true, trim: true, bom: true, relax_column_count: true,
    }) as Array<Record<string, string>>;
  } catch (err) {
    errors.push(`could not read ${files[0]}: ${(err as Error).message}`);
  }

  // Enough rows to judge a running balance (needs three) without reading a
  // year of history to answer a layout question.
  const detected = detectColumns(rows.slice(0, 25));
  const sample = rows.slice(0, limit).map((r) => ({
    date: detected.date ? r[detected.date] ?? '' : '',
    amount: detected.amount
      ? r[detected.amount] ?? ''
      : [detected.debit && r[detected.debit], detected.credit && r[detected.credit]]
        .filter(Boolean).join(' / '),
    description: detected.description ? r[detected.description] ?? '' : '',
  }));

  return { path, files, detected, sample, errors };
}

/**
 * The `[[providers.csv.accounts]]` block for a confirmed layout.
 *
 * Emitted as TOML text rather than merged into the config programmatically:
 * the config is a file a person owns and may have commented, and rewriting it
 * wholesale would discard that. Appending a block they can see is honest about
 * what changed.
 */
export function csvAccountToml(account: {
  accountId: string;
  name: string;
  mask?: string;
  type: string;
  path: string;
  detected: DetectedColumns;
}): string {
  const { detected } = account;
  const lines = [
    '',
    '[[providers.csv.accounts]]',
    `accountId = ${JSON.stringify(account.accountId)}`,
    `name = ${JSON.stringify(account.name)}`,
    ...(account.mask ? [`mask = ${JSON.stringify(account.mask)}`] : []),
    `type = ${JSON.stringify(account.type)}`,
    `path = ${JSON.stringify(account.path)}`,
    `dateFormat = ${JSON.stringify(detected.dateFormat ?? 'MM/DD/YYYY')}`,
  ];

  // Only meaningful with a single signed column; a debit/credit pair already
  // says which side is which.
  if (detected.amount) lines.push('negativeIsSpending = true');

  lines.push('', '[providers.csv.accounts.columns]');
  lines.push(`date = ${JSON.stringify(detected.date ?? 'Date')}`);
  if (detected.amount) {
    lines.push(`amount = ${JSON.stringify(detected.amount)}`);
  } else if (detected.debit && detected.credit) {
    lines.push(`debit = ${JSON.stringify(detected.debit)}`);
    lines.push(`credit = ${JSON.stringify(detected.credit)}`);
  }
  lines.push(`description = ${JSON.stringify(detected.description ?? 'Description')}`);
  if (detected.merchant) lines.push(`merchant = ${JSON.stringify(detected.merchant)}`);
  if (detected.balance) {
    lines.push(`# "${detected.balance}" is a running balance and is deliberately not mapped —`);
    lines.push('# reading it as the amount would make every transaction the account balance.');
  }

  return lines.join('\n') + '\n';
}

/** A stable, readable id from an account name — used as the CSV account key. */
export function slugify(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    || 'account';
}
