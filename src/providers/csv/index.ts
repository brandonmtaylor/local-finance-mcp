// CSV provider — import transactions from bank exports.
//
// Every bank has a "Download transactions" button, so this works everywhere with
// no signup, no API cost, and no third party holding a connection to the account.
// It is also the reason the provider interface stays honest: a CSV has no ids, no
// categories and no cursor, so anything Plaid-shaped in the contract shows up
// here immediately as a mismatch.
//
// Tradeoff: it is manual. `capabilities.automatic` is false, so the scheduler
// skips it rather than reporting a failed sync every morning.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import { parse as parseCsv } from 'csv-parse/sync';
import type { CsvAccountConfig } from '../../core/config.js';
import type { IncomingAccount, IncomingTransaction } from '../../core/ledger.js';
import { resolveCategory } from '../../core/normalize.js';
import { expandPath } from '../../core/paths.js';
import type { Provider, ProviderContext, SyncResult, LinkResult } from '../types.js';
import { parseDate, parseAmountCents, synthesizeTxnId, assignOccurrenceIndexes } from './parse.js';

/** A row after field extraction but before id assignment. */
interface StagedRow {
  /** Which export this row came from — each file is its own source. */
  file: string;
  date: string;
  amountCents: number;
  description: string;
  merchant: string | null;
  /** The bank's own label, when the export carries one. */
  providerCategory: string | null;
}

export interface CsvParseIssue {
  file: string;
  line: number;
  message: string;
}

export interface CsvImportOutcome {
  transactions: Array<IncomingTransaction & { file: string }>;
  issues: CsvParseIssue[];
}

/**
 * Resolve a configured path to the CSV files under it.
 *
 * Returns a reason when it finds nothing. Silently importing zero rows is the
 * worst possible outcome here — it looks exactly like "you had no transactions"
 * and there is no error to chase.
 */
function listCsvFiles(configuredPath: string): { files: string[]; problem?: string } {
  const path = expandPath(configuredPath);

  if (!existsSync(path)) {
    return {
      files: [],
      problem: `path does not exist: ${path}`
        + (configuredPath.startsWith('~') ? ` (expanded from "${configuredPath}")` : ''),
    };
  }
  if (statSync(path).isFile()) return { files: [path] };

  const files = readdirSync(path)
    .filter((f) => extname(f).toLowerCase() === '.csv')
    .sort() // deterministic order so occurrence indexes are stable across runs
    .map((f) => join(path, f));

  return files.length > 0
    ? { files }
    : { files: [], problem: `no .csv files found in ${path}` };
}

function requireColumn(record: Record<string, string>, column: string, file: string, line: number): string {
  const value = record[column];
  if (value === undefined) {
    const available = Object.keys(record).join(', ');
    throw new Error(`column "${column}" not found in ${file} (has: ${available})`);
  }
  void line;
  return value;
}

/**
 * Resolve the signed amount for a row.
 *
 * Two dialects: one signed column, or split debit/credit columns. Both normalize
 * to the ledger convention — positive is money IN.
 */
function resolveAmountCents(
  record: Record<string, string>,
  account: CsvAccountConfig,
  file: string,
  line: number,
): number {
  const { columns, negativeIsSpending } = account;

  if (columns.debit || columns.credit) {
    const debitRaw = columns.debit ? (record[columns.debit] ?? '').trim() : '';
    const creditRaw = columns.credit ? (record[columns.credit] ?? '').trim() : '';
    if (debitRaw && creditRaw) {
      throw new Error('row has values in both debit and credit columns');
    }
    if (debitRaw) return -Math.abs(parseAmountCents(debitRaw));
    if (creditRaw) return Math.abs(parseAmountCents(creditRaw));
    throw new Error('row has neither a debit nor a credit value');
  }

  if (!columns.amount) {
    throw new Error('config must set columns.amount, or columns.debit/columns.credit');
  }
  const cents = parseAmountCents(requireColumn(record, columns.amount, file, line));
  // negativeIsSpending=true already matches the ledger convention. When false
  // (common for credit-card exports, where a positive number is a charge), flip.
  return negativeIsSpending ? cents : -cents;
}

/**
 * Parse one account's CSV files into ledger transactions.
 *
 * Malformed rows are collected as issues rather than aborting the import — one
 * bad row in a 400-row export should not cost you the other 399.
 */
export function importCsvAccount(account: CsvAccountConfig): CsvImportOutcome {
  const issues: CsvParseIssue[] = [];
  const staged: StagedRow[] = [];

  const { files, problem } = listCsvFiles(account.path);
  if (problem) issues.push({ file: account.path, line: 0, message: problem });

  for (const file of files) {
    let records: Record<string, string>[];
    try {
      records = parseCsv(readFileSync(file, 'utf8'), {
        columns: true,
        skip_empty_lines: true,
        trim: true,
        bom: true,
        relax_column_count: true,
      }) as Record<string, string>[];
    } catch (err) {
      issues.push({ file, line: 0, message: `unreadable CSV: ${(err as Error).message}` });
      continue;
    }

    records.forEach((record, i) => {
      const line = i + 2; // +1 for the header, +1 for 1-based numbering
      try {
        const dateRaw = requireColumn(record, account.columns.date, file, line);
        const date = parseDate(dateRaw, account.dateFormat);
        const amountCents = resolveAmountCents(record, account, file, line);
        const description = requireColumn(record, account.columns.description, file, line).trim();
        const merchant = account.columns.merchant
          ? (record[account.columns.merchant] ?? '').trim() || null
          : null;
        const providerCategory = account.columns.category
          ? (record[account.columns.category] ?? '').trim() || null
          : null;
        staged.push({ file, date, amountCents, description, merchant, providerCategory });
      } catch (err) {
        issues.push({ file, line, message: (err as Error).message });
      }
    });
  }

  // Occurrence indexes are computed PER FILE, and that is what makes
  // overlapping exports work.
  //
  // Each file becomes its own source, so two exports covering June both number
  // their copy of one transaction 0, and the ledger's view — which keeps one
  // row per (account, content, occurrence) — collapses them. Numbering across
  // all files instead made the second export's copy occurrence 1, an entirely
  // separate transaction, and a jan-jun/jun-dec pair silently double-counted
  // June.
  //
  // Two genuinely identical rows within ONE file still get 0 and 1 and both
  // survive, which is the case the index exists for.
  const indexes = assignOccurrenceIndexes(
    staged,
    (row) => `${row.file}|${row.date}|${row.amountCents}|${row.description}`,
  );

  const transactions = staged.map((row, i): IncomingTransaction & { file: string } => {
    // Merchant patterns first, the bank's own label as the fallback for the
    // long tail. Account type disambiguates the two sides of a payment.
    const { category, source } = resolveCategory(
      row.merchant ? `${row.merchant} ${row.description}` : row.description,
      row.amountCents,
      account.type,
      row.providerCategory,
    );
    return {
      file: row.file,
      // A CSV row carries no id, so one is synthesised from its content plus an
      // occurrence index within its FILE. That serves as the PROVIDER's id —
      // unique within this file, which is this file's source — and the ledger
      // derives real identity on top, as it does for a Plaid transaction_id.
      externalId: synthesizeTxnId(
        row.file, row.date, row.amountCents, row.description, indexes[i]!,
      ),
      date: row.date,
      amountCents: row.amountCents,
      currency: account.currency,
      merchantName: row.merchant,
      description: row.description,
      category,
      categorySource: source,
      pending: false,
    };
  });

  return { transactions, issues };
}

/** Stable id for one file's source within a configured account. */
export function sourceKey(accountId: string, file: string): string {
  return `${accountId}:${basename(file)}`;
}

/**
 * The account a file reports.
 *
 * Every file of a configured account carries the same name, mask and type, so
 * they share a natural key and the ledger resolves them all to ONE real
 * account — many sources, one account, exactly as a re-linked Plaid connection
 * behaves.
 */
export function incomingAccountFor(account: CsvAccountConfig, file?: string): IncomingAccount {
  return {
    externalId: file ? sourceKey(account.accountId, file) : account.accountId,
    name: account.name,
    mask: account.mask ?? null,
    type: account.type,
    subtype: null,
    currency: account.currency,
    // A CSV has no institution. The natural key falls back to mask and type,
    // which is weaker but still refuses to match on nothing.
    institutionId: null,
  };
}


export interface CsvProviderOptions {
  id: string;
  accounts: CsvAccountConfig[];
  /** Surfaced to the caller so the CLI can report skipped rows. */
  onIssues?: (issues: CsvParseIssue[]) => void;
}

export function createCsvProvider(options: CsvProviderOptions): Provider {
  return {
    id: options.id,
    kind: 'csv',
    capabilities: {
      transactions: true,
      // A statement export is a point-in-time list of transactions, not a
      // balance feed. Claiming otherwise would let a stale running balance be
      // reported as current.
      balances: false,
      investments: false,
      automatic: false,
    },

    async link(): Promise<LinkResult> {
      return {
        ok: false,
        message:
          'The CSV provider has no interactive link step. Add an entry under ' +
          '[[providers.csv.accounts]] in config.toml pointing at your export ' +
          'directory, then run `finance sync`.',
      };
    },

    async sync(_ctx: ProviderContext): Promise<SyncResult> {
      const issues: CsvParseIssue[] = [];

      // Each configured account is its own connection: a folder is
      // independently "linked", and one failing to parse must not disturb the
      // rest. This is also the shape that keeps the contract honest — it was
      // designed against Plaid, and CSV is the check that it did not come out
      // Plaid-shaped.
      const connections = options.accounts.map((account) => {
        const outcome = importCsvAccount(account);
        issues.push(...outcome.issues);

        // One SOURCE per file. Two exports covering an overlapping month each
        // number their copy of a shared transaction 0, so the ledger's view
        // keeps one of them; a single source spanning both files would number
        // the second copy 1 and treat it as a separate transaction. All files
        // carry the same natural key, so they resolve to one real account.
        const files = [...new Set(outcome.transactions.map((t) => t.file))];
        return {
          externalId: account.accountId,
          accounts: files.map((file) => incomingAccountFor(account, file)),
          // Everything arrives as `added`; identity is content-derived, so a
          // row seen before resolves to the same id and updates in place.
          added: outcome.transactions.map(({ file, ...t }) => ({
            ...t, accountExternalId: sourceKey(account.accountId, file),
          })),
          modified: [],
          removed: [],
          balances: [],
          // A file has no change feed to resume from.
          cursor: null,
        };
      });

      if (issues.length) options.onIssues?.(issues);
      return { connections };
    },
  };
}
