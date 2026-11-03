// Column detection against the shapes real banks actually export.
//
// The expensive mistake is picking a BALANCE column as the amount: every
// transaction silently becomes the account's balance at that moment, nothing
// errors, and the figures look plausible because they are real numbers from
// the file. Most of these tests exist for that one failure.

import { describe, it, expect } from 'vitest';
import {
  detectColumns, profileColumn, looksLikeRunningTotal,
} from '../src/providers/csv/detect.js';

const rows = (header: string[], ...data: string[][]) =>
  data.map((d) => Object.fromEntries(header.map((h, i) => [h, d[i] ?? ''])));

describe('profileColumn', () => {
  it('recognises dates, money and text by their contents', () => {
    expect(profileColumn('c', ['07/14/2026', '07/15/2026']).kind).toBe('date');
    expect(profileColumn('c', ['-84.32', '1,204.00', '$12']).kind).toBe('money');
    expect(profileColumn('c', ['GROCERY MART', 'CAFE']).kind).toBe('text');
    expect(profileColumn('c', ['', '  ']).kind).toBe('empty');
  });

  it('reports how much of the column was blank', () => {
    // A debit/credit pair is mostly blank on each side; that is the signal.
    expect(profileColumn('c', ['10.00', '', '', '5.00']).blankRate).toBe(0.5);
  });
});

describe('a signed-amount export with a balance column', () => {
  // Date, Amount, Description, Balance — the layout that makes reading the
  // wrong money column so costly.
  const wf = () => rows(
    ['Date', 'Amount', 'Description', 'Balance'],
    ['07/14/2026', '-84.32', 'GROCERY MART #412', '4821.55'],
    ['07/15/2026', '-2100.00', 'CARD ISSUER MOBILE PMT', '2721.55'],
    ['07/16/2026', '5000.00', 'DIRECT DEP PAYROLL', '7721.55'],
  );

  it('picks the amount, not the balance', () => {
    const d = detectColumns(wf());
    expect(d.amount).toBe('Amount');
    expect(d.balance).toBe('Balance');
    expect(d.date).toBe('Date');
    expect(d.description).toBe('Description');
    expect(d.dateFormat).toBe('MM/DD/YYYY');
  });

  it('still avoids the balance when the header does not say "balance"', () => {
    // Shape has to carry it: a running total dwarfs any single transaction.
    const renamed = rows(
      ['Date', 'Value', 'Description', 'Column D'],
      ['07/14/2026', '-84.32', 'GROCERY MART #412', '4821.55'],
      ['07/15/2026', '-2100.00', 'CARD ISSUER MOBILE PMT', '2721.55'],
      ['07/16/2026', '5000.00', 'DIRECT DEP PAYROLL', '7721.55'],
    );
    const d = detectColumns(renamed);
    expect(d.amount).toBe('Value');
    expect(d.warnings.join(' ')).toMatch(/running balance|balance/i);
  });
});

describe('a split debit/credit export', () => {
  it('finds both sides and reports no single amount column', () => {
    const d = detectColumns(rows(
      ['Transaction Date', 'Description', 'Debit', 'Credit'],
      ['2026-07-14', 'SHELL OIL', '45.00', ''],
      ['2026-07-15', 'PAYMENT THANK YOU', '', '2100.00'],
      ['2026-07-16', 'AMAZON', '129.99', ''],
    ));

    expect(d.debit).toBe('Debit');
    expect(d.credit).toBe('Credit');
    expect(d.amount).toBeUndefined();
    expect(d.dateFormat).toBe('YYYY-MM-DD');
  });
});

describe('ambiguity it cannot resolve', () => {
  it('says so when every date works as both US and European', () => {
    // 03/04/2026 is March 4th or 4th March and the file cannot tell you which.
    // Guessing silently would put transactions in the wrong month.
    const d = detectColumns(rows(
      ['Date', 'Amount', 'Description'],
      ['03/04/2026', '-10.00', 'A SHOP'],
      ['05/06/2026', '-20.00', 'ANOTHER SHOP'],
    ));
    expect(d.warnings.join(' ')).toMatch(/ambiguous/i);
  });

  it('names the extra date column rather than silently choosing', () => {
    const d = detectColumns(rows(
      ['Transaction Date', 'Posted Date', 'Amount', 'Description'],
      ['07/14/2026', '07/16/2026', '-84.32', 'GROCERY MART'],
      ['07/15/2026', '07/17/2026', '-12.00', 'CAFE'],
    ));
    expect(d.warnings.join(' ')).toMatch(/2 date columns/);
    expect(d.date).toBeDefined();
  });
});

describe('picking the description', () => {
  it('prefers the longest text field when no header says so', () => {
    // Banks put merchant, reference and channel in the description; the other
    // text columns are short codes.
    const d = detectColumns(rows(
      ['Date', 'Amount', 'Type', 'Details'],
      ['07/14/2026', '-84.32', 'POS', 'GROCERY MART #412 SPRINGFIELD REF#88213'],
      ['07/15/2026', '-12.00', 'ACH', 'CAFE ROSSI DOWNTOWN REF#88214'],
    ));
    expect(d.description).toBe('Details');
  });

  it('keeps a merchant column separate from the description', () => {
    const d = detectColumns(rows(
      ['Date', 'Amount', 'Description', 'Merchant'],
      ['07/14/2026', '-84.32', 'POS PURCHASE 88213 SPRINGFIELD', 'Grocery Mart'],
      ['07/15/2026', '-12.00', 'POS PURCHASE 88214 DOWNTOWN', 'Cafe Rossi'],
    ));
    expect(d.description).toBe('Description');
    expect(d.merchant).toBe('Merchant');
  });
});

describe('files it cannot read', () => {
  it('reports what is missing rather than returning a broken guess', () => {
    // A preamble above the header is the usual cause, and the fix is obvious
    // once someone is told which piece was not found.
    const d = detectColumns(rows(['a', 'b'], ['Statement for July', ''], ['Account 1111', '']));
    expect(d.warnings.join(' ')).toMatch(/no date column/);
    expect(d.warnings.join(' ')).toMatch(/no amount column/);
  });

  it('survives an empty file', () => {
    expect(() => detectColumns([])).not.toThrow();
    expect(detectColumns([]).profiles).toEqual([]);
  });
});

describe('looksLikeRunningTotal', () => {
  it('recognises a balance that moves by the amount each row', () => {
    expect(looksLikeRunningTotal(
      ['-84.32', '-2100.00', '5000.00'],
      ['4905.87', '2805.87', '7805.87'],
    )).toBe(true);
  });

  it('is not fooled by two unrelated money columns', () => {
    expect(looksLikeRunningTotal(
      ['-84.32', '-2100.00', '5000.00'],
      ['12.00', '99.00', '3.50'],
    )).toBe(false);
  });

  it('works on a nearly empty account, where magnitude says nothing', () => {
    // The reason this beats comparing sizes: a balance of $18 is smaller than
    // the transactions moving it, and is still a balance.
    expect(looksLikeRunningTotal(
      ['-40.00', '50.00'],
      ['58.00', '18.00', '68.00'],
    )).toBe(false); // misaligned on purpose
    expect(looksLikeRunningTotal(
      ['0', '-40.00', '50.00'],
      ['58.00', '18.00', '68.00'],
    )).toBe(true);
  });

  it('declines on too few rows rather than calling one match a pattern', () => {
    expect(looksLikeRunningTotal(['-10.00', '-5.00'], ['100.00', '95.00'])).toBe(false);
  });
});
