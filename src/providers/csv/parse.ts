// CSV field parsing: dates, amounts, and synthetic transaction ids.
//
// A bank CSV gives you a date, a dollar amount and free text — no stable id, no
// category, no merchant. Everything hard about this provider comes from that.

import { createHash } from 'node:crypto';
import { normalizeDescription } from '../../core/normalize.js';

/**
 * Parse a date against a format string built from YYYY, MM and DD.
 *
 * Deliberately narrow: banks emit a handful of unambiguous layouts, and a
 * permissive parser would silently read 03/04/2026 as March 4th for a UK export
 * that meant April 3rd. Returns YYYY-MM-DD.
 */
export function parseDate(value: string, format: string): string {
  const raw = value.trim();
  if (!raw) throw new Error('empty date');

  // ISO with optional time — accept regardless of the configured format, since
  // it is unambiguous.
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/.exec(raw);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  const order = format.toUpperCase();
  const parts = raw.split(/[/\-.]/).map((p) => p.trim());
  if (parts.length !== 3) {
    throw new Error(`date "${raw}" does not match format "${format}"`);
  }

  // Accept a 2-digit year token too ("MM/DD/YY"); the value itself is expanded
  // below. YYYY is checked first so it isn't matched by the shorter token.
  const yearAt = order.includes('YYYY') ? order.indexOf('YYYY') : order.indexOf('YY');
  const slots = [yearAt, order.indexOf('MM'), order.indexOf('DD')];
  if (slots.some((s) => s < 0)) {
    throw new Error(`dateFormat "${format}" must contain a year (YYYY or YY), MM and DD`);
  }
  // Rank the three tokens by where they appear in the format string.
  const ranked = [
    { kind: 'y', at: slots[0]! },
    { kind: 'm', at: slots[1]! },
    { kind: 'd', at: slots[2]! },
  ].sort((a, b) => a.at - b.at);

  let year = '';
  let month = '';
  let day = '';
  ranked.forEach((slot, i) => {
    const part = parts[i]!;
    if (slot.kind === 'y') year = part.length === 2 ? `20${part}` : part;
    if (slot.kind === 'm') month = part.padStart(2, '0');
    if (slot.kind === 'd') day = part.padStart(2, '0');
  });

  const ymd = `${year}-${month}-${day}`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) {
    throw new Error(`date "${raw}" does not match format "${format}"`);
  }
  const monthNum = Number(month);
  const dayNum = Number(day);
  if (monthNum < 1 || monthNum > 12 || dayNum < 1 || dayNum > 31) {
    throw new Error(`date "${raw}" is out of range (parsed as ${ymd})`);
  }
  return ymd;
}

/**
 * Parse a money string to integer cents.
 *
 * Handles the usual bank export dialects: currency symbols, thousands
 * separators, and accounting-style parentheses for negatives.
 */
export function parseAmountCents(value: string): number {
  let raw = value.trim();
  if (!raw) throw new Error('empty amount');

  let negative = false;
  if (/^\(.*\)$/.test(raw)) {
    negative = true;
    raw = raw.slice(1, -1);
  }
  raw = raw.replace(/[$£€\s,]/g, '');
  if (raw.startsWith('-')) {
    negative = true;
    raw = raw.slice(1);
  } else if (raw.startsWith('+')) {
    raw = raw.slice(1);
  }

  if (!/^\d*(\.\d+)?$/.test(raw) || raw === '' || raw === '.') {
    throw new Error(`amount "${value}" is not a number`);
  }

  // Parse as fixed-point rather than float*100 — 19.99*100 is 1998.9999… and
  // rounds wrong often enough to matter across a year of transactions.
  const [whole = '0', frac = ''] = raw.split('.');
  const cents = Number(whole) * 100 + Number((frac + '00').slice(0, 2));
  return negative ? -cents : cents;
}

/**
 * Deterministic id for a CSV row.
 *
 * CSVs carry no stable identifier, so identity is the content itself. `index`
 * disambiguates genuine same-day duplicates (two $4 coffees) — without it the
 * second collapses into the first and the row silently disappears.
 *
 * Stability matters more than collision-resistance here: re-importing an
 * overlapping export must reproduce the same ids so rows upsert instead of
 * duplicating.
 */
export function synthesizeTxnId(
  accountId: string,
  date: string,
  amountCents: number,
  description: string,
  index: number,
): string {
  const key = [accountId, date, String(amountCents), normalizeDescription(description)].join('\0');
  const hash = createHash('sha256').update(key).digest('hex').slice(0, 16);
  return `csv:${hash}:${index}`;
}

/** Assign occurrence indexes to rows sharing an identity key, in file order. */
export function assignOccurrenceIndexes<T>(
  rows: readonly T[],
  keyOf: (row: T) => string,
): number[] {
  const seen = new Map<string, number>();
  return rows.map((row) => {
    const key = keyOf(row);
    const next = seen.get(key) ?? 0;
    seen.set(key, next + 1);
    return next;
  });
}
