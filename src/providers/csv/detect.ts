// Guessing a bank export's column layout.
//
// Every bank exports a different shape and nobody wants to hand-write a TOML
// column mapping to find that out. Header names are a strong hint and shape is
// the check on them: a column called "Amount" that holds dates is not the
// amount column, and a column called "Running Total" that holds money still is
// not.
//
// The expensive mistake this exists to prevent is picking a BALANCE column as
// the amount. A common bank export is Date, Amount, Description, Balance — take
// the wrong money column and every transaction is silently the account's
// balance at that moment. Nothing errors, every figure is wrong, and the
// numbers look plausible because they are real numbers from the file.

import { parseDate, parseAmountCents } from './parse.js';

export type ColumnKind = 'date' | 'money' | 'text' | 'empty';

export interface ColumnProfile {
  name: string;
  kind: ColumnKind;
  /** Fraction of sampled rows that parsed as the detected kind. */
  confidence: number;
  /** Mean absolute value, for money columns — separates amounts from balances. */
  meanMagnitude?: number;
  /** Mean character length, for text columns — descriptions are the longest. */
  meanLength?: number;
  /** Fraction of rows where this column was blank. */
  blankRate: number;
}

export interface DetectedColumns {
  date?: string;
  amount?: string;
  debit?: string;
  credit?: string;
  description?: string;
  merchant?: string;
  /**
   * The bank's own category, when the export has one. Card exports nearly
   * always do, and leaving it unmapped files most purchases under "other".
   */
  category?: string;
  /** Named so it can be shown as deliberately ignored rather than missed. */
  balance?: string;
  dateFormat?: string;
  profiles: ColumnProfile[];
  /** Anything the caller should see before accepting the guess. */
  warnings: string[];
}

const DATE_FORMATS = ['MM/DD/YYYY', 'DD/MM/YYYY', 'YYYY-MM-DD', 'MM/DD/YY'] as const;

const HEADER_HINTS: Record<string, RegExp> = {
  date: /^(transaction[\s_-]*)?(post(ing|ed)?[\s_-]*)?date$|^date\b/i,
  amount: /^(transaction[\s_-]*)?amount$|^amt$/i,
  debit: /^(debit|withdrawal|payment|money[\s_-]*out|charges?)$/i,
  credit: /^(credit|deposit|money[\s_-]*in|receipts?)$/i,
  balance: /balance|running[\s_-]*total/i,
  description: /^(description|memo|details?|narrative|transaction|reference)$/i,
  merchant: /^(merchant|payee|name|counterparty)$/i,
  category: /^(transaction[\s_-]*)?category$/i,
};

const isBlank = (v: string | undefined) => v === undefined || v.trim() === '';

/**
 * Which date format parses the most sampled values.
 *
 * ISO is checked by SHAPE before anything else, because parseDate accepts ISO
 * whatever format it is told — so every format scores 100% on 2026-07-14 and
 * the first one tried wins. Harmless when parsing, but it means reporting
 * "MM/DD/YYYY" for a plainly ISO file, which is exactly the kind of detail
 * someone checks the guess against.
 */
function bestDateFormat(values: string[]): { format: string; hitRate: number } | null {
  const iso = values.filter((v) => /^\d{4}-\d{2}-\d{2}(?:[T\s]|$)/.test(v.trim())).length;
  if (values.length && iso / values.length >= 0.8) {
    return { format: 'YYYY-MM-DD', hitRate: iso / values.length };
  }

  let best: { format: string; hitRate: number } | null = null;
  for (const format of DATE_FORMATS) {
    let hits = 0;
    for (const v of values) {
      try { parseDate(v, format); hits += 1; } catch { /* not this format */ }
    }
    const hitRate = values.length ? hits / values.length : 0;
    if (!best || hitRate > best.hitRate) best = { format, hitRate };
  }
  // Ambiguity is real and unresolvable from data alone: 03/04/2026 parses under
  // both US and European layouts. The caller is told rather than guessed at.
  return best && best.hitRate > 0 ? best : null;
}

/** Classify one column by what its values actually are. */
export function profileColumn(name: string, values: string[]): ColumnProfile {
  const present = values.filter((v) => !isBlank(v)).map((v) => v.trim());
  const blankRate = values.length ? 1 - present.length / values.length : 1;
  if (present.length === 0) return { name, kind: 'empty', confidence: 1, blankRate };

  const dates = bestDateFormat(present);
  if (dates && dates.hitRate >= 0.8) {
    return { name, kind: 'date', confidence: dates.hitRate, blankRate };
  }

  let moneyHits = 0;
  let magnitude = 0;
  for (const v of present) {
    try {
      magnitude += Math.abs(parseAmountCents(v));
      moneyHits += 1;
    } catch { /* not money */ }
  }
  const moneyRate = moneyHits / present.length;
  if (moneyRate >= 0.8) {
    return {
      name,
      kind: 'money',
      confidence: moneyRate,
      meanMagnitude: magnitude / Math.max(moneyHits, 1),
      blankRate,
    };
  }

  return {
    name,
    kind: 'text',
    confidence: 1 - Math.max(dates?.hitRate ?? 0, moneyRate),
    meanLength: present.reduce((n, v) => n + v.length, 0) / present.length,
    blankRate,
  };
}

/**
 * Does `balance` behave like a running total of `amount`?
 *
 * Definitive where magnitude is only suggestive: a running balance moves by
 * exactly the transaction amount from one row to the next. Comparing the two
 * columns directly settles which is which even when the balance is small — a
 * near-empty account still has a balance, and a magnitude ratio would call
 * that a coin flip.
 *
 * Requires three rows to see two differences. Below that it declines rather
 * than guessing, because one matching difference is a coincidence.
 */
export function looksLikeRunningTotal(
  amounts: string[],
  balances: string[],
): boolean {
  const money = (v: string) => { try { return parseAmountCents(v); } catch { return null; } };
  const a = amounts.map(money);
  const b = balances.map(money);

  let checked = 0;
  let matched = 0;
  for (let i = 1; i < Math.min(a.length, b.length); i += 1) {
    const prev = b[i - 1];
    const here = b[i];
    const delta = a[i];
    // Undefined as well as null: the two columns can differ in length when a
    // row failed to parse, and indexing past the end is not a mismatch.
    if (prev == null || here == null || delta == null) continue;
    checked += 1;
    // A cent of slack: exports round, and some banks post the fee separately.
    if (Math.abs((here - prev) - delta) <= 1) matched += 1;
  }
  return checked >= 2 && matched / checked >= 0.75;
}

/** Header name suggests this role, and the shape does not contradict it. */
const hinted = (profiles: ColumnProfile[], role: keyof typeof HEADER_HINTS, kind: ColumnKind) =>
  profiles.find((p) => p.kind === kind && HEADER_HINTS[role]!.test(p.name));

/**
 * Guess a layout from a header row and a handful of parsed rows.
 *
 * Header names lead and shape adjudicates. Where they disagree, shape wins and
 * the disagreement is reported — a column named "Amount" holding text is worth
 * saying out loud, because it usually means the file has a preamble or the
 * delimiter was misread.
 */
export function detectColumns(rows: Array<Record<string, string>>): DetectedColumns {
  const warnings: string[] = [];
  const headers = rows.length ? Object.keys(rows[0]!) : [];
  const profiles = headers.map((h) => profileColumn(h, rows.map((r) => r[h] ?? '')));

  const dateCols = profiles.filter((p) => p.kind === 'date');
  const moneyCols = profiles.filter((p) => p.kind === 'money');
  const textCols = profiles.filter((p) => p.kind === 'text');

  // ── date ───────────────────────────────────────────────────────────────────
  // Exports often carry both a posted and an authorised date; the posted one is
  // what a statement reconciles against, so prefer the header that says so.
  const date = (hinted(profiles, 'date', 'date') ?? dateCols[0])?.name;
  const sample = date ? rows.map((r) => r[date] ?? '').filter((v) => !isBlank(v)) : [];
  const format = sample.length ? bestDateFormat(sample) : null;

  if (dateCols.length > 1) {
    warnings.push(
      `${dateCols.length} date columns (${dateCols.map((c) => c.name).join(', ')}) — `
      + `using "${date}". If your statement reconciles against a different one, change it.`,
    );
  }
  // Only when EVERY sampled date fits both ways. One 04/15 settles it — the
  // warning used to fire on any single ambiguous row, beside a preview whose
  // own dates proved the order.
  if (format && format.format.startsWith('MM') && sample.every((v) => {
    const [a, b] = v.split(/[/\-.]/);
    return Number(a) <= 12 && Number(b) <= 12;
  })) {
    // Genuinely undecidable from the data: 03/04 is March 4th or 4th March.
    warnings.push(
      'day/month order is ambiguous in this file — every sampled date works both ways. '
      + `Assuming ${format.format}; check a row you recognise before trusting it.`,
    );
  }

  // ── money ──────────────────────────────────────────────────────────────────
  const debit = hinted(profiles, 'debit', 'money');
  const credit = hinted(profiles, 'credit', 'money');
  const balance = hinted(profiles, 'balance', 'money');

  let amount: ColumnProfile | undefined;
  if (!(debit && credit)) {
    const candidates = moneyCols.filter((p) => p !== balance);
    amount = hinted(profiles, 'amount', 'money') ?? candidates[0];

    // No header said "balance", but two money columns remain. The larger one is
    // almost always a running total: a balance is the sum of everything before
    // it, so it dwarfs any single transaction.
    if (!balance && candidates.length > 1) {
      // Test each ordered pair: does one column move by the other's value?
      let running: { total: ColumnProfile; delta: ColumnProfile } | undefined;
      for (const total of candidates) {
        for (const delta of candidates) {
          if (total === delta) continue;
          if (looksLikeRunningTotal(
            rows.map((r) => r[delta.name] ?? ''),
            rows.map((r) => r[total.name] ?? ''),
          )) { running = { total, delta }; break; }
        }
        if (running) break;
      }

      if (running) {
        amount = running.delta;
        warnings.push(
          `"${running.total.name}" is a running balance — it moves by exactly the value in `
          + `"${running.delta.name}" on each row — so it is being ignored. Reading it as the `
          + 'amount would make every transaction the account balance instead.',
        );
      } else {
        warnings.push(
          `several money columns (${candidates.map((c) => c.name).join(', ')}) and no clear `
          + `winner — using "${amount?.name}". Check three rows before syncing.`,
        );
      }
    }
  }

  // ── text ───────────────────────────────────────────────────────────────────
  // The description is the longest text field: banks put the merchant, the
  // reference and the channel in it, and everything else is short.
  const categoryCol = hinted(profiles, 'category', 'text');
  const byLength = textCols.filter((p) => p !== categoryCol).sort((a, b) => (b.meanLength ?? 0) - (a.meanLength ?? 0));
  const description = (hinted(profiles, 'description', 'text') ?? byLength[0])?.name;
  const merchantHit = hinted(profiles, 'merchant', 'text');
  const merchant = merchantHit && merchantHit.name !== description ? merchantHit.name : undefined;

  if (!date) warnings.push('no date column found — the file may have a preamble above the header.');
  if (!amount && !(debit && credit)) warnings.push('no amount column found.');
  if (!description) warnings.push('no description column found.');

  return {
    ...(date ? { date } : {}),
    ...(amount ? { amount: amount.name } : {}),
    ...(debit && credit ? { debit: debit.name, credit: credit.name } : {}),
    ...(description ? { description } : {}),
    ...(merchant ? { merchant } : {}),
    ...(categoryCol && categoryCol.name !== description ? { category: categoryCol.name } : {}),
    ...(balance ? { balance: balance.name } : {}),
    ...(format ? { dateFormat: format.format } : {}),
    profiles,
    warnings,
  };
}
