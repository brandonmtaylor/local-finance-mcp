// The decisions `finance setup` makes, tested without a terminal attached.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { preflight, previewCsv, csvAccountToml, slugify } from '../src/core/setup.js';
import { parse as parseToml } from 'smol-toml';
import { readFileSync } from 'node:fs';
import { ConfigSchema } from '../src/core/config.js';
import { openLedger } from '../src/core/ledger.js';
import { syncAll } from '../src/core/sync.js';
import { buildProviders } from '../src/providers/registry.js';
import { getSpendingSummary } from '../src/core/queries.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'setup-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('preflight', () => {
  const run = (over: Partial<Parameters<typeof preflight>[0]> = {}) =>
    preflight({ home: dir, nodeVersion: 'v20.11.0', hasPlaidBinary: true, ...over });

  it('passes on a usable machine', () => {
    expect(run().every((c) => c.ok)).toBe(true);
  });

  it('blocks on an old Node', () => {
    const node = run({ nodeVersion: 'v18.19.0' }).find((c) => c.name === 'Node')!;
    expect(node.ok).toBe(false);
    expect(node.blocking).toBe(true);
  });

  it('treats a missing Plaid CLI as advisory, not blocking', () => {
    // It stops nothing if the user only wants CSV, and saying otherwise sends
    // them to install something they will never use.
    const plaid = run({ hasPlaidBinary: false }).find((c) => c.name === 'Plaid CLI')!;
    expect(plaid.ok).toBe(false);
    expect(plaid.blocking).toBe(false);
    expect(plaid.fix).toMatch(/CSV imports work without it/);
  });

  it('accepts a data directory that does not exist yet', () => {
    // It is created on first use; what matters is whether its parent allows it.
    const check = preflight({
      home: join(dir, 'not', 'yet'), nodeVersion: 'v20.0.0', hasPlaidBinary: true,
    }).find((c) => c.name === 'Data directory')!;
    expect(check.ok).toBe(true);
  });

  it('reports an unwritable location rather than failing later', () => {
    const check = preflight({
      home: '/proc/nope/finance', nodeVersion: 'v20.0.0', hasPlaidBinary: true,
    }).find((c) => c.name === 'Data directory')!;
    expect(check.ok).toBe(false);
    expect(check.fix).toMatch(/FINANCE_HOME/);
  });
});

describe('previewCsv', () => {
  const write = (name: string, body: string) => writeFileSync(join(dir, name), body);
  const WF = 'Date,Amount,Description,Balance\n'
    + '07/14/2026,-84.32,"GROCERY MART #412",4905.87\n'
    + '07/15/2026,-2100.00,"CARD ISSUER MOBILE PMT",2805.87\n'
    + '07/16/2026,5000.00,"DIRECT DEP PAYROLL",7805.87\n';

  it('detects the layout and returns rows a person can recognise', () => {
    write('export.csv', WF);
    const p = previewCsv(dir);

    expect(p.files).toHaveLength(1);
    expect(p.detected.amount).toBe('Amount');
    expect(p.detected.balance).toBe('Balance');
    // The sample is the point: a confidence score cannot show a column offset
    // by one, and three real rows can.
    expect(p.sample[0]).toEqual({
      date: '07/14/2026', amount: '-84.32', description: 'GROCERY MART #412',
    });
  });

  it('shows both sides for a debit/credit export', () => {
    write('c1.csv', 'Transaction Date,Description,Debit,Credit\n'
      + '2026-07-14,SHELL OIL,45.00,\n2026-07-15,PAYMENT,,2100.00\n');
    const p = previewCsv(dir);
    expect(p.detected.debit).toBe('Debit');
    expect(p.sample[0]!.amount).toBe('45.00');
    expect(p.sample[1]!.amount).toBe('2100.00');
  });

  it('reports a path that does not exist', () => {
    expect(previewCsv(join(dir, 'nope')).errors[0]).toMatch(/does not exist/);
  });

  it('reports a folder with no CSVs', () => {
    mkdirSync(join(dir, 'empty'));
    expect(previewCsv(join(dir, 'empty')).errors[0]).toMatch(/no \.csv files/);
  });
});

describe('csvAccountToml', () => {
  const base = {
    accountId: 'main-checking', name: 'Main Checking', mask: '1111',
    type: 'depository', path: '/Users/x/statements',
  };

  it('emits a block for a single signed amount column', () => {
    const toml = csvAccountToml({
      ...base,
      detected: {
        date: 'Date', amount: 'Amount', description: 'Description',
        balance: 'Balance', dateFormat: 'MM/DD/YYYY', profiles: [], warnings: [],
      },
    });

    expect(toml).toContain('[[providers.csv.accounts]]');
    expect(toml).toContain('amount = "Amount"');
    expect(toml).toContain('negativeIsSpending = true');
    // The balance is called out as deliberately unmapped, so nobody "fixes"
    // the omission later.
    expect(toml).toMatch(/# "Balance" is a running balance/);
    expect(toml).not.toMatch(/^balance = /m);
  });

  it('emits debit and credit instead, with no sign flag', () => {
    // A split pair already says which side is which.
    const toml = csvAccountToml({
      ...base,
      detected: {
        date: 'Transaction Date', debit: 'Debit', credit: 'Credit',
        description: 'Description', dateFormat: 'YYYY-MM-DD', profiles: [], warnings: [],
      },
    });
    expect(toml).toContain('debit = "Debit"');
    expect(toml).toContain('credit = "Credit"');
    expect(toml).not.toContain('negativeIsSpending');
  });

  it('quotes values so a Windows path or an apostrophe cannot break the file', () => {
    const toml = csvAccountToml({
      ...base, name: "O'Brien Checking", path: 'C:\\Users\\x\\statements',
      detected: { date: 'Date', amount: 'Amount', description: 'Description', profiles: [], warnings: [] },
    });
    expect(toml).toContain('name = "O\'Brien Checking"');
    expect(toml).toContain('path = "C:\\\\Users\\\\x\\\\statements"');
  });
});

describe('slugify', () => {
  it('makes a readable, stable id', () => {
    expect(slugify('Main Checking')).toBe('main-checking');
    expect(slugify('  Card ••1111  ')).toBe('card-1111');
  });

  it('never returns an empty id', () => {
    expect(slugify('•••')).toBe('account');
  });
});

describe('what setup produces actually works', () => {
  // The prompts are thin; this is the part worth proving. The config block the
  // wizard appends has to survive being loaded and synced, or the wizard is a
  // convincing way to produce a file that fails later.
  it('emits a config a real sync can use, end to end', async () => {
    const statements = join(dir, 'statements');
    mkdirSync(statements);
    writeFileSync(join(statements, 'export.csv'),
      'Date,Amount,Description,Balance\n'
      + '07/14/2026,-84.32,"GROCERY MART #412",4905.87\n'
      + '07/15/2026,-2100.00,"CARD ISSUER MOBILE PMT",2805.87\n'
      + '07/16/2026,5000.00,"DIRECT DEP PAYROLL",7805.87\n');

    // Exactly what the wizard does: preview, then emit the block.
    const preview = previewCsv(statements);
    const toml = csvAccountToml({
      accountId: slugify('Main Checking'),
      name: 'Main Checking',
      mask: '1111',
      type: 'depository',
      path: statements,
      detected: preview.detected,
    });
    writeFileSync(join(dir, 'config.toml'), `timezone = "UTC"\n\n[providers.plaid]\nenabled = false\n\n[providers.csv]\nenabled = true\n${toml}`);

    const config = ConfigSchema.parse(parseToml(readFileSync(join(dir, 'config.toml'), 'utf8')));
    const db = openLedger(':memory:');
    const outcomes = await syncAll(db, buildProviders(config), { timezone: 'UTC' });

    expect(outcomes![0]!.error).toBeUndefined();
    expect(outcomes![0]!.added).toBe(3);

    const summary = getSpendingSummary(db, '2026-07-01', '2026-07-31');

    // $84.32 of groceries plus the $2,100 card payment. The payment counts
    // because no credit account is linked, so it is the only trace of that
    // spending — the deliberate `auto` policy, not an accident.
    expect(summary.spendingCents).toBe(218_432);
    expect(summary.cardPaymentsCounted).toBe(true);
    expect(summary.incomeCents).toBe(500_000);

    // The point of column detection: the balance column must not have become
    // the amount. Those values sum to $15,518 — a plausible-looking figure
    // with no relationship to anything that happened.
    expect(summary.spendingCents).not.toBe(1_551_761);
    expect(getSpendingSummary(db, '2026-07-01', '2026-07-31', undefined, 'never').spendingCents)
      .toBe(8_432);
    db.close();
  });
});
