// What a first-time user hits. Each case comes from a cold run-through of the
// README by someone who had never seen the project: everything worked, and the
// numbers still looked broken — most card spending in "other", $0 tiles for a
// window past the last export, and a doctor that said "All good".

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import type Database from 'better-sqlite3';
import { previewCsv, csvAccountToml } from '../src/core/setup.js';
import { detectColumns } from '../src/providers/csv/detect.js';
import { ConfigSchema } from '../src/core/config.js';
import { openLedger } from '../src/core/ledger.js';
import { syncAll } from '../src/core/sync.js';
import { buildProviders } from '../src/providers/registry.js';
import { getSpendingSummary, dataEndsEarly } from '../src/core/queries.js';
import { detectStaleCsv, detectUncategorised } from '../src/core/diagnostics.js';
import { renderReport, collectReportData } from '../src/core/report.js';
import { seedAccount, seedTxn } from './helpers.js';
import { collectInsights } from '../src/core/insights.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'newcomer-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const CARD = 'Transaction Date,Description,Category,Debit,Credit\n'
  + '2026-07-14,ACME 123,Groceries,45.00,\n'
  + '2026-07-15,ZORBO 77,Dining,30.00,\n'
  + '2026-07-16,PAYMENT THANK YOU,Payment/Credit,,75.00\n';

describe('the bank\'s own category column', () => {
  it('is detected, previewed, and written into the config', () => {
    writeFileSync(join(dir, 'card.csv'), CARD);
    const p = previewCsv(dir);
    expect(p.detected.category).toBe('Category');
    // Never mistaken for the description, which is what the importer keys on.
    expect(p.detected.description).toBe('Description');
    expect(p.sample[0]!.category).toBe('Groceries');

    const toml = csvAccountToml({
      accountId: 'card', name: 'Card', type: 'credit', path: dir, detected: p.detected,
    });
    expect(toml).toContain('category = "Category"');
  });

  it('turns "other" into real categories, and the next sync says it changed them', async () => {
    const files = join(dir, 'card');
    mkdirSync(files);
    writeFileSync(join(files, 'export.csv'), CARD);
    const detected = previewCsv(files).detected;

    const load = (withCategory: boolean) => {
      const d = withCategory ? detected : { ...detected, category: undefined };
      const toml = csvAccountToml({ accountId: 'card', name: 'Card', type: 'credit', path: files, detected: d });
      writeFileSync(join(dir, 'config.toml'),
        `timezone = "UTC"\n\n[providers.plaid]\nenabled = false\n\n[providers.csv]\nenabled = true\n${toml}`);
      return ConfigSchema.parse(parseToml(readFileSync(join(dir, 'config.toml'), 'utf8')));
    };

    const db = openLedger(':memory:');
    await syncAll(db, buildProviders(load(false)), { timezone: 'UTC' });
    const before = getSpendingSummary(db, '2026-07-01', '2026-07-31');
    expect(before.byCategory.map((c) => c.category)).toEqual(['other']);

    const [outcome] = (await syncAll(db, buildProviders(load(true)), { timezone: 'UTC' }))!;
    // "+0 added, 0 modified" after recategorising every row read as "it
    // ignored the change".
    expect(outcome!.added).toBe(0);
    expect(outcome!.modified).toBe(2);
    const after = getSpendingSummary(db, '2026-07-01', '2026-07-31');
    expect(after.byCategory.map((c) => c.category).sort()).toEqual(['dining', 'groceries']);
    expect(after.spendingCents).toBe(before.spendingCents);
  });
});

describe('setup preview', () => {
  it('shows amounts signed the way they will be stored', () => {
    // A card purchase printed as +45.00 beside a README saying positive means
    // money in.
    writeFileSync(join(dir, 'card.csv'), CARD);
    const p = previewCsv(dir);
    expect(p.sample.map((r) => r.amount)).toEqual(['-45.00', '-30.00', '+75.00']);
  });

  it('does not call the date order ambiguous when a row settles it', () => {
    const rows = [
      { Date: '04/01/2026', Amount: '-1.00', Description: 'A' },
      { Date: '04/15/2026', Amount: '-2.00', Description: 'B' },
    ];
    expect(detectColumns(rows).warnings.join(' ')).not.toMatch(/ambiguous/);
    // Still warned when every row genuinely fits both ways.
    expect(detectColumns(rows.slice(0, 1)).warnings.join(' ')).toMatch(/ambiguous/);
  });
});

describe('a ledger that ends before the window does', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = openLedger(':memory:');
    const a = seedAccount(db, 'a1');
    seedTxn(db, a, { date: '2026-09-28', amountCents: -5_000 });
  });

  it('is named on the summary instead of printing a bare $0', () => {
    const s = getSpendingSummary(db, '2026-10-05', '2026-11-03');
    expect(s.spendingCents).toBe(0);
    expect(s.dataEnds).toEqual({ latest: '2026-09-28', missingDays: 36 });
  });

  it('suppresses the prior-period comparison rather than reporting -100%', () => {
    seedTxn(db, seedAccount(db, 'a1'), { date: '2026-09-01', amountCents: -5_000 });
    expect(collectInsights(db, '2026-10-05', '2026-11-03').priorPeriodComparable).toBe(false);
  });

  it('stays quiet when the data is current', () => {
    expect(dataEndsEarly(db, '2026-10-02')).toBeNull();
  });

  it('puts a banner on the report, and never says income exceeded spending at zero', () => {
    const html = renderReport([{ id: 'p', label: '30d', data: collectReportData(db, '2026-10-05', '2026-11-03') }]);
    expect(html).toContain('Nothing has been imported after 2026-09-28');
    expect(html).toContain('nothing recorded in this window');
    expect(html).not.toContain('income exceeded spending');
  });
});

describe('doctor, for a CSV user', () => {
  let db: Database.Database;
  beforeEach(() => { db = openLedger(':memory:'); });

  it('flags an export that has gone stale', () => {
    const a = seedAccount(db, 'c1', { providerId: 'csv', name: 'Card' });
    seedTxn(db, a, { date: '2026-09-28' });
    const [d] = detectStaleCsv(db, 21, new Date('2026-11-03T12:00:00Z'));
    expect(d!.code).toBe('csv-data-old');
    expect(d!.detail![0]).toMatch(/2026-09-28 \(36 days ago\)/);
    expect(detectStaleCsv(db, 21, new Date('2026-10-05T12:00:00Z'))).toEqual([]);
  });

  it('leaves Plaid accounts to the sync checks', () => {
    const a = seedAccount(db, 'p1');
    seedTxn(db, a, { date: '2026-01-01' });
    expect(detectStaleCsv(db, 21, new Date('2026-11-03T12:00:00Z'))).toEqual([]);
  });

  it('flags spending that is mostly uncategorised, and points at the Category column', () => {
    const a = seedAccount(db, 'c1', { providerId: 'csv' });
    for (let i = 0; i < 12; i++) seedTxn(db, a, { date: '2026-07-10', category: 'other' });
    for (let i = 0; i < 4; i++) seedTxn(db, a, { date: '2026-07-10', category: 'groceries' });
    const [d] = detectUncategorised(db);
    expect(d!.message).toMatch(/^12 of 16 purchases/);
    expect(d!.remedy).toMatch(/category = "Category"/);
  });

  it('stays quiet when a little is uncategorised', () => {
    const a = seedAccount(db, 'c1', { providerId: 'csv' });
    for (let i = 0; i < 12; i++) seedTxn(db, a, { date: '2026-07-10', category: 'other' });
    for (let i = 0; i < 60; i++) seedTxn(db, a, { date: '2026-07-10', category: 'groceries' });
    expect(detectUncategorised(db)).toEqual([]);
  });
});
