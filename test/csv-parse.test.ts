// Field-level parsing. Money and dates are where silent data corruption lives:
// a float rounding error or a DD/MM misread doesn't crash, it just makes every
// report quietly wrong.

import { describe, it, expect } from 'vitest';
import {
  parseDate,
  parseAmountCents,
  synthesizeTxnId,
  assignOccurrenceIndexes,
} from '../src/providers/csv/parse.js';

describe('parseDate', () => {
  it('parses the common US layout', () => {
    expect(parseDate('07/14/2026', 'MM/DD/YYYY')).toBe('2026-07-14');
    expect(parseDate('7/4/2026', 'MM/DD/YYYY')).toBe('2026-07-04');
  });

  it('parses day-first without confusing it for month-first', () => {
    // The whole reason the format is configured rather than sniffed.
    expect(parseDate('03/04/2026', 'DD/MM/YYYY')).toBe('2026-04-03');
    expect(parseDate('03/04/2026', 'MM/DD/YYYY')).toBe('2026-03-04');
  });

  it('accepts ISO regardless of configured format', () => {
    expect(parseDate('2026-07-14', 'MM/DD/YYYY')).toBe('2026-07-14');
    expect(parseDate('2026-07-14T09:31:00Z', 'MM/DD/YYYY')).toBe('2026-07-14');
  });

  it('handles dash and dot separators', () => {
    expect(parseDate('07-14-2026', 'MM/DD/YYYY')).toBe('2026-07-14');
    expect(parseDate('14.07.2026', 'DD/MM/YYYY')).toBe('2026-07-14');
  });

  it('expands 2-digit years', () => {
    expect(parseDate('07/14/26', 'MM/DD/YY')).toBe('2026-07-14');
  });

  it('rejects unparseable or out-of-range dates instead of guessing', () => {
    expect(() => parseDate('not a date', 'MM/DD/YYYY')).toThrow();
    expect(() => parseDate('', 'MM/DD/YYYY')).toThrow();
    expect(() => parseDate('13/45/2026', 'MM/DD/YYYY')).toThrow(/out of range/);
  });
});

describe('parseAmountCents', () => {
  it('parses plain and signed amounts', () => {
    expect(parseAmountCents('84.32')).toBe(8_432);
    expect(parseAmountCents('-84.32')).toBe(-8_432);
    expect(parseAmountCents('+84.32')).toBe(8_432);
  });

  it('strips currency symbols and thousands separators', () => {
    expect(parseAmountCents('$1,234.56')).toBe(123_456);
    expect(parseAmountCents('-$2,100.00')).toBe(-210_000);
    expect(parseAmountCents('£99.99')).toBe(9_999);
  });

  it('reads accounting parentheses as negative', () => {
    expect(parseAmountCents('(84.32)')).toBe(-8_432);
    expect(parseAmountCents('($1,234.56)')).toBe(-123_456);
  });

  it('avoids float rounding error', () => {
    // 19.99 * 100 is 1998.9999999999998 in IEEE754. Fixed-point parsing must not.
    expect(parseAmountCents('19.99')).toBe(1_999);
    expect(parseAmountCents('0.07')).toBe(7);
    expect(parseAmountCents('1234567.89')).toBe(123_456_789);
  });

  it('handles missing or short decimals', () => {
    expect(parseAmountCents('100')).toBe(10_000);
    expect(parseAmountCents('100.5')).toBe(10_050);
  });

  it('rejects non-numeric input', () => {
    expect(() => parseAmountCents('abc')).toThrow();
    expect(() => parseAmountCents('')).toThrow();
    expect(() => parseAmountCents('12.34.56')).toThrow();
  });
});

describe('synthesizeTxnId', () => {
  it('is stable for identical content — the basis of idempotent re-import', () => {
    const a = synthesizeTxnId('acct', '2026-07-14', -8_432, 'GROCERY MART #412', 0);
    const b = synthesizeTxnId('acct', '2026-07-14', -8_432, 'GROCERY MART #412', 0);
    expect(a).toBe(b);
  });

  it('ignores whitespace and case differences in the description', () => {
    const a = synthesizeTxnId('acct', '2026-07-14', -8_432, 'GROCERY MART  #412', 0);
    const b = synthesizeTxnId('acct', '2026-07-14', -8_432, 'grocery mart #412', 0);
    expect(a).toBe(b);
  });

  it('separates same-day duplicates by occurrence index', () => {
    const first = synthesizeTxnId('acct', '2026-07-15', -425, 'STARBUCKS', 0);
    const second = synthesizeTxnId('acct', '2026-07-15', -425, 'STARBUCKS', 1);
    expect(first).not.toBe(second);
  });

  it('separates different accounts, dates and amounts', () => {
    const base = synthesizeTxnId('a', '2026-07-14', -8_432, 'GROCERY MART', 0);
    expect(synthesizeTxnId('b', '2026-07-14', -8_432, 'GROCERY MART', 0)).not.toBe(base);
    expect(synthesizeTxnId('a', '2026-07-15', -8_432, 'GROCERY MART', 0)).not.toBe(base);
    expect(synthesizeTxnId('a', '2026-07-14', -8_433, 'GROCERY MART', 0)).not.toBe(base);
  });
});

describe('assignOccurrenceIndexes', () => {
  it('numbers repeats in order and restarts per key', () => {
    const rows = ['a', 'b', 'a', 'a', 'c', 'b'];
    expect(assignOccurrenceIndexes(rows, (r) => r)).toEqual([0, 0, 1, 2, 0, 1]);
  });

  it('returns all zeros when every row is unique', () => {
    expect(assignOccurrenceIndexes(['a', 'b', 'c'], (r) => r)).toEqual([0, 0, 0]);
  });
});
