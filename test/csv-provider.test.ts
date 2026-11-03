// End-to-end CSV import against real-shaped bank exports, then into the ledger.
//
// The headline assertion is the double-count one: a checking account and the
// credit card it pays are both imported, and the spending total must count the
// card's purchases once — not once as purchases and again as the payment.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import type Database from 'better-sqlite3';
import { expandPath } from '../src/core/paths.js';
import { ConfigSchema, type CsvAccountConfig } from '../src/core/config.js';
import { importCsvAccount, createCsvProvider } from '../src/providers/csv/index.js';
import {
  openLedger, upsertProvider, upsertTransaction, resolveConnection, resolveSource,
} from '../src/core/ledger.js';
import { seedAccount } from './helpers.js';
import { countsAsSpending } from '../src/core/normalize.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

const checkingExport = (): CsvAccountConfig =>
  ConfigSchema.parse({
    providers: {
      csv: {
        enabled: true,
        accounts: [{
          accountId: 'main-checking',
          name: 'Main Checking',
          mask: '1234',
          type: 'depository',
          path: join(FIXTURES, 'signed-amount.csv'),
          columns: { date: 'Date', amount: 'Amount', description: 'Description' },
          dateFormat: 'MM/DD/YYYY',
          negativeIsSpending: true,
        }],
      },
    },
  }).providers.csv.accounts[0]!;

const cardExport = (): CsvAccountConfig =>
  ConfigSchema.parse({
    providers: {
      csv: {
        enabled: true,
        accounts: [{
          accountId: 'rewards-card',
          name: 'Rewards Card',
          mask: '5555',
          type: 'credit',
          path: join(FIXTURES, 'debit-credit.csv'),
          columns: {
            date: 'Transaction Date',
            debit: 'Debit',
            credit: 'Credit',
            description: 'Description',
          },
          dateFormat: 'YYYY-MM-DD',
        }],
      },
    },
  }).providers.csv.accounts[0]!;

describe('importCsvAccount — single signed amount column', () => {
  it('imports every row with no issues', () => {
    const { transactions, issues } = importCsvAccount(checkingExport());
    expect(issues).toEqual([]);
    expect(transactions).toHaveLength(6);
  });

  it('applies the ledger sign convention', () => {
    const { transactions } = importCsvAccount(checkingExport());
    const groceries = transactions.find((t) => t.description.includes('GROCERY MART'))!;
    const payroll = transactions.find((t) => t.description.includes('PAYROLL'))!;

    expect(groceries.amountCents).toBe(-8_432); // money out
    expect(payroll.amountCents).toBe(500_000);  // money in
  });

  it('keeps two identical same-day coffees as two rows', () => {
    const { transactions } = importCsvAccount(checkingExport());
    const coffees = transactions.filter((t) => t.description.includes('STARBUCKS'));

    expect(coffees).toHaveLength(2);
    expect(coffees[0]!.externalId).not.toBe(coffees[1]!.externalId);
  });

  it('infers categories from the description', () => {
    const { transactions } = importCsvAccount(checkingExport());
    const byDescription = Object.fromEntries(transactions.map((t) => [t.description, t.category]));

    expect(byDescription['GROCERY MART #412 SPRINGFIELD']).toBe('groceries');
    expect(byDescription['CARD ISSUER CARD PMT AUTOPAY']).toBe('credit_card_payment');
    expect(byDescription['DIRECT DEP PAYROLL ACME CORP']).toBe('income');
    expect(byDescription['XFINITY INTERNET']).toBe('utilities');
  });

  it('is byte-for-byte idempotent across re-imports', () => {
    const first = importCsvAccount(checkingExport()).transactions.map((t) => t.txnId);
    const second = importCsvAccount(checkingExport()).transactions.map((t) => t.txnId);
    expect(second).toEqual(first);
  });
});

describe('importCsvAccount — split debit/credit columns', () => {
  it('reads debits as money out and credits as money in', () => {
    const { transactions, issues } = importCsvAccount(cardExport());
    expect(issues).toEqual([]);

    const shell = transactions.find((t) => t.description.includes('SHELL'))!;
    const payment = transactions.find((t) => t.description.includes('PAYMENT THANK YOU'))!;

    expect(shell.amountCents).toBe(-4_500);     // a charge on the card
    expect(payment.amountCents).toBe(210_000);  // a payment reducing the balance
  });

  it('classifies the card payment as movement, not spending', () => {
    const { transactions } = importCsvAccount(cardExport());
    const payment = transactions.find((t) => t.description.includes('PAYMENT THANK YOU'))!;
    expect(payment.category).toBe('credit_card_payment');
  });
});

describe('malformed input', () => {
  it('reports a bad row as an issue and imports the rest', () => {
    const account = { ...checkingExport(), dateFormat: 'YYYY/MM/DD' }; // wrong for this file
    const { transactions, issues } = importCsvAccount(account);

    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]!.line).toBeGreaterThan(1); // header offset accounted for
    expect(transactions.length).toBeLessThan(6);
  });

  it('reports a missing column clearly rather than importing empty rows', () => {
    const account = {
      ...checkingExport(),
      columns: { ...checkingExport().columns, amount: 'NotAColumn' },
    };
    const { issues } = importCsvAccount(account);
    expect(issues.length).toBe(6);
    expect(issues[0]!.message).toMatch(/not found/);
  });

  it('REPORTS a path that does not exist rather than importing silently', () => {
    // Silent zero is the worst outcome: indistinguishable from "you had no
    // transactions this month", with no error to chase.
    const account = { ...checkingExport(), path: '/nonexistent/nope.csv' };
    const { transactions, issues } = importCsvAccount(account);
    expect(transactions).toEqual([]);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toMatch(/does not exist/);
  });

  it('reports a directory containing no CSVs', () => {
    const account = { ...checkingExport(), path: dirname(fileURLToPath(import.meta.url)) };
    const { issues } = importCsvAccount(account);
    expect(issues[0]!.message).toMatch(/no \.csv files found/);
  });
});

describe('path expansion', () => {
  it('expands ~ so a hand-written config path actually resolves', () => {
    // Node's fs treats "~" as a literal directory name, so an unexpanded path
    // matches nothing at all — and the config file format invites writing it.
    expect(expandPath('~/Documents/statements')).toBe(join(homedir(), 'Documents/statements'));
    expect(expandPath('~')).toBe(homedir());
    expect(expandPath('$HOME/statements')).toBe(join(homedir(), 'statements'));
  });

  it('leaves absolute and relative paths alone', () => {
    expect(expandPath('/Users/x/statements')).toBe('/Users/x/statements');
    expect(expandPath('./statements')).toBe('./statements');
  });

  it('does not treat a leading ~ inside a longer name as a home reference', () => {
    expect(expandPath('~backup/statements')).toBe('~backup/statements');
  });

  it('mentions the expansion in the error, so a bad ~ path is diagnosable', () => {
    const { issues } = importCsvAccount({ ...checkingExport(), path: '~/definitely-not-here-xyz' });
    expect(issues[0]!.message).toMatch(/expanded from "~\/definitely-not-here-xyz"/);
  });
});

describe('createCsvProvider', () => {
  it('declares itself manual so the scheduler skips it', () => {
    const provider = createCsvProvider({ id: 'csv', accounts: [] });
    expect(provider.capabilities.automatic).toBe(false);
    expect(provider.capabilities.balances).toBe(false);
  });

  it('syncs all configured accounts in one pass', async () => {
    const provider = createCsvProvider({ id: 'csv', accounts: [checkingExport(), cardExport()] });
    const result = await provider.sync(
      { providerId: 'csv', stateDir: '/tmp', timezone: 'UTC', getSecret: () => null },
      null,
    );

    // One connection per configured account: a folder is independently linked.
    expect(result.connections.map((c) => c.externalId)).toEqual(['main-checking', 'rewards-card']);
    expect(result.connections.flatMap((c) => c.added)).toHaveLength(10);
    expect(result.connections.every((c) => c.cursor === null)).toBe(true);
  });

  it('has no interactive link step', async () => {
    const provider = createCsvProvider({ id: 'csv', accounts: [] });
    const result = await provider.link!({
      providerId: 'csv', stateDir: '/tmp', timezone: 'UTC', getSecret: () => null,
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/config\.toml/);
  });
});

describe('into the ledger', () => {
  let db: Database.Database;

  beforeEach(() => { db = openLedger(':memory:'); });

  /** Import a configured CSV account into the ledger through the new model. */
  const importInto = (account: ReturnType<typeof checkingExport>) => {
    const seeded = seedAccount(db, account.accountId, {
      providerId: 'csv',
      name: account.name,
      mask: account.mask,
      type: account.type,
      itemId: account.accountId,
    });
    for (const txn of importCsvAccount(account).transactions) {
      upsertTransaction(db, seeded.sourceId, seeded.accountId, txn);
    }
    return seeded;
  };

  it('does NOT double-count when a card and the account paying it are both imported', () => {
    // The single most important property in this project. The card
    // reports $190.98 of purchases; the checking account reports the $2,100
    // payment that settles them. Spending must be purchases only.
    for (const account of [checkingExport(), cardExport()]) importInto(account);

    const rows = db.prepare(
      `SELECT spend_group, SUM(amount_cents) total FROM transactions GROUP BY spend_group`,
    ).all() as { spend_group: string; total: number }[];
    const totals = Object.fromEntries(rows.map((r) => [r.spend_group, r.total]));

    // Real spending: groceries 84.32 + coffees 8.50 + gas 45 + amazon 129.99
    //                + netflix 15.99 = 283.80 purchases, plus 89.00 utilities.
    expect(totals.purchases).toBe(-28_380);
    expect(totals.bills).toBe(-8_900);

    // The $2,100 leaves checking and arrives at the card — nets to zero and is
    // classified as movement, so it never touches the spending total.
    expect(totals.payments).toBe(0);
    expect(countsAsSpending('payments')).toBe(false);

    const spending = (totals.purchases ?? 0) + (totals.bills ?? 0);
    expect(spending).toBe(-37_280); // $372.80, not $2,472.80
  });

  it('re-importing the same files adds no duplicate rows', () => {
    const account = checkingExport();
    importInto(account);
    const afterFirst = db.prepare('SELECT COUNT(*) c FROM transactions').get() as { c: number };

    importInto(account);
    const afterSecond = db.prepare('SELECT COUNT(*) c FROM transactions').get() as { c: number };

    expect(afterFirst.c).toBe(6);
    expect(afterSecond.c).toBe(6);
  });
});

describe('overlapping exports', () => {
  // The commonest CSV mess: two downloads whose date ranges overlap. Both
  // report the same transactions for the shared month.
  let dir: string;
  let db: Database.Database;

  const csv = (name: string, body: string) => writeFileSync(join(dir, name), body);
  const configured = () => ConfigSchema.parse({
    providers: { csv: { enabled: true, accounts: [{
      accountId: 'wf', name: 'Checking', mask: '1111', type: 'depository',
      path: dir, dateFormat: 'MM/DD/YYYY', negativeIsSpending: true,
      columns: { date: 'Date', amount: 'Amount', description: 'Description' },
    }] } },
  }).providers.csv.accounts[0]!;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'csv-overlap-'));
    db = openLedger(':memory:');
    upsertProvider(db, 'csv', 'csv');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** Run the provider the way the sync engine does. */
  const ingest = async () => {
    const provider = createCsvProvider({ id: 'csv', accounts: [configured()] });
    const result = await provider.sync(
      { providerId: 'csv', stateDir: '/tmp', timezone: 'UTC', getSecret: () => null }, {},
    );
    const conn = result.connections[0]!;
    const connectionId = resolveConnection(db, 'csv', conn.externalId);
    const sources = new Map(conn.accounts.map((a) => [a.externalId, resolveSource(db, connectionId, a)]));
    for (const t of conn.added) {
      const s = sources.get(t.accountExternalId)!;
      upsertTransaction(db, s.sourceId, s.accountId, t);
    }
    return sources;
  };

  it('counts a transaction once when two exports both report it', async () => {
    csv('jan-jun.csv', 'Date,Amount,Description\n01/15/2026,-42.10,"GROCERY MART"\n06/03/2026,-18.75,"CAFE ROSSI"\n');
    csv('jun-dec.csv', 'Date,Amount,Description\n06/03/2026,-18.75,"CAFE ROSSI"\n07/11/2026,-60.00,"HARDWARE"\n');

    const sources = await ingest();

    // One real account behind two sources — the same shape a re-linked Plaid
    // connection produces.
    expect(new Set([...sources.values()].map((s) => s.accountId)).size).toBe(1);
    expect(sources.size).toBe(2);

    expect(db.prepare('SELECT COUNT(*) n FROM transactions').get()).toEqual({ n: 4 });
    expect(db.prepare('SELECT COUNT(*) n FROM visible_transactions').get()).toEqual({ n: 3 });
  });

  it('still keeps two genuinely identical rows within ONE export', async () => {
    // The case the occurrence index exists for: two $4.25 coffees on one day
    // are two transactions, and numbering per file must not merge them.
    csv('one.csv',
      'Date,Amount,Description\n06/03/2026,-4.25,"STARBUCKS"\n06/03/2026,-4.25,"STARBUCKS"\n');
    await ingest();
    expect(db.prepare('SELECT COUNT(*) n FROM visible_transactions').get()).toEqual({ n: 2 });
  });

  it('keeps both copies when the SAME row appears twice in each of two exports', async () => {
    // Two coffees in June, and both exports cover June: the answer is two, not
    // one and not four.
    const body = 'Date,Amount,Description\n06/03/2026,-4.25,"STARBUCKS"\n06/03/2026,-4.25,"STARBUCKS"\n';
    csv('a.csv', body);
    csv('b.csv', body);
    await ingest();
    expect(db.prepare('SELECT COUNT(*) n FROM visible_transactions').get()).toEqual({ n: 2 });
  });
});
