// Detectors for the failure modes that produce wrong numbers rather than
// errors. Each test reconstructs a situation that actually happened during
// setup — in every case the ledger looked healthy and the totals were wrong.

import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import {
  detectOrphans,
  detectEmptyAccounts, detectSyncHealth, detectUnlinkedCards, runDiagnostics, prune, previewPrune,
  detectAmbiguousMatches, detectSupersededConnections,
} from '../src/core/diagnostics.js';
import {
  openLedger, recordSync, appendBalance, upsertProvider,
  setCategoryOverride, setNote, addTag,
  
} from '../src/core/ledger.js';
import { seedAccount, seedTxn, type Seeded } from './helpers.js';

let db: Database.Database;
let acct: Seeded;

const txn = (over: Parameters<typeof seedTxn>[2] = {}): string => seedTxn(db, acct, over);

/** One account reached through its own connection. */
const account = (
  key: string, name: string, mask: string | null, type = 'depository',
) => seedAccount(db, key, { name, mask, type, itemId: `item-${key}` });

beforeEach(() => {
  db = openLedger(':memory:');
  acct = seedAccount(db, 'a1');
});



describe('detectUnlinkedCards', () => {
  // The most misleading state possible: nothing looks broken. Card payments are
  // excluded from spending because the card's purchases are counted on the card
  // — so with no card linked, the total is silently far too low. Measured on
  // real data: about a third of the true total.
  beforeEach(() => account('chk', 'Checking', '1111'));

  it('catches payments excluded with no card to account for them', () => {
    txn(({
      amountCents: -250_000, category: 'credit_card_payment',
    }));
    const [found] = detectUnlinkedCards(db);
    // A warning, not an error: the total is not missing this money, the
    // detail is. Calling it an error made a six-figure "understated" read as
    // that much money gone astray.
    expect(found!.severity).toBe('warning');
    // States what is actually true: the money is counted, the detail is not.
    expect(found!.message).toMatch(/\$2,500\.00 of card payments have no matching purchase detail/);
    expect(found!.detail!.join(' ')).toMatch(/TOTAL is not missing this money/);
    expect(found!.detail![0]).toMatch(/No credit-card accounts are linked/);
  });

  it('stays quiet once the card is linked and carrying its spending', () => {
    txn(({
      amountCents: -100_000, category: 'credit_card_payment',
    }));
    const card = account('card', 'Card', '9999', 'credit');
    seedTxn(db, card, { amountCents: -95_000, category: 'shopping' });

    expect(detectUnlinkedCards(db)).toEqual([]);
  });

  it('still complains when a linked card holds almost nothing', () => {
    // A card linked but returning no data is as bad as no card at all.
    txn(({
      amountCents: -100_000, category: 'credit_card_payment',
    }));
    const card = account('card', 'Card', '9999', 'credit');
    seedTxn(db, card, { amountCents: -1_000, category: 'shopping' });

    const [found] = detectUnlinkedCards(db);
    expect(found!.detail![0]).toMatch(/1 credit account\(s\) are linked but hold only/);
  });

  it('says nothing when there are no card payments at all', () => {
    txn(({ category: 'groceries' }));
    expect(detectUnlinkedCards(db)).toEqual([]);
  });
});

describe('detectOrphans', () => {
  it('finds transactions whose account is gone, and says what they cost', () => {
    // The summary reads `transactions` without joining `accounts`, so orphans
    // are still counted. Deleting via the sqlite3 CLI leaves them behind —
    // foreign_keys defaults OFF there, so the cascade never fires.
    const a = account('a1', 'Checking', '1111');
    seedTxn(db, a, { amountCents: -25_000 });
    db.pragma('foreign_keys = OFF');
    db.prepare('DELETE FROM accounts WHERE account_id = ?').run(a.accountId);

    const [found] = detectOrphans(db);
    expect(found!.code).toBe('orphaned-transactions');
    expect(found!.message).toMatch(/250\.00 still counted/);
    expect(found!.remedy).toMatch(/finance prune/);
  });

  it('finds accounts whose provider is gone', () => {
    // Reached by removing the provider, not by inserting a dangling reference —
    // the foreign key blocks the latter. Same route as deleting rows with the
    // sqlite3 CLI, where foreign_keys defaults OFF.
    seedAccount(db, 'gone', { providerId: 'departed', name: 'Checking', mask: '1111' });
    db.pragma('foreign_keys = OFF');
    db.prepare('DELETE FROM providers WHERE provider_id = ?').run('departed');

    const codes = detectOrphans(db).map((d) => d.code);
    expect(codes).toContain('orphaned-accounts');
  });

  it('is silent on a healthy ledger', () => {
    account('a1', 'Checking', '1111');
    txn();
    expect(detectOrphans(db)).toEqual([]);
  });
});

describe('prune', () => {
  it('removes orphans and reports the counts', () => {
    const a = account('a1', 'Checking', '1111');
    seedTxn(db, a, {});
    db.pragma('foreign_keys = OFF');
    db.prepare('DELETE FROM accounts WHERE account_id = ?').run(a.accountId);

    expect(prune(db)).toEqual({ transactions: 1, accounts: 0 });
    expect(detectOrphans(db)).toEqual([]);
  });

  it('previews exactly what it then removes, including an account nothing reports', () => {
    // An account whose sources are gone (the sqlite3 CLI defaults
    // foreign_keys OFF, so nothing cascades) — and the rows still on it.
    const a = account('a2', 'Old savings', '2222');
    seedTxn(db, a, { amountCents: -1_500 });
    seedTxn(db, a, { amountCents: 4_000, description: 'interest' });
    db.pragma('foreign_keys = OFF');
    db.prepare('DELETE FROM sources WHERE account_id = ?').run(a.accountId);
    db.pragma('foreign_keys = ON');

    const preview = previewPrune(db);
    // a1, seeded in beforeEach, has no rows but keeps its source: untouched.
    expect(preview).toEqual({ transactions: 2, accounts: 1, cents: 5_500 });
    expect(prune(db)).toEqual({ transactions: 2, accounts: 1 });
    expect(previewPrune(db)).toEqual({ transactions: 0, accounts: 0, cents: 0 });
  });

  it('leaves a healthy ledger untouched', () => {
    account('a1', 'Checking', '1111');
    txn();
    expect(prune(db)).toEqual({ transactions: 0, accounts: 0 });
    expect(db.prepare('SELECT COUNT(*) c FROM transactions').get()).toEqual({ c: 1 });
  });
});

describe('detectEmptyAccounts', () => {
  it('mentions a synced account holding nothing', () => {
    account('a1', 'Travel Visa', '4444');
    recordSync(db, 'plaid', { added: 5, modified: 0, removed: 0 });
    const [found] = detectEmptyAccounts(db);
    expect(found!.severity).toBe('info');   // often legitimate
    expect(found!.detail).toEqual(['Travel Visa ••4444']);
  });

  it('says nothing before a successful sync', () => {
    account('a1', 'New', '1111');
    expect(detectEmptyAccounts(db)).toEqual([]);
  });
});

describe('detectSyncHealth', () => {
  const now = new Date('2026-08-12T12:00:00Z');

  it('reports never having synced', () => {
    expect(detectSyncHealth(db, 3, now)[0]!.code).toBe('never-synced');
  });

  it('surfaces the last failure with its message', () => {
    recordSync(db, 'plaid', { added: 0, modified: 0, removed: 0, error: 'ITEM_LOGIN_REQUIRED' });
    const [found] = detectSyncHealth(db, 3, now);
    expect(found!.code).toBe('sync-failed');
    expect(found!.detail).toEqual(['ITEM_LOGIN_REQUIRED']);
  });

  it('flags a stale sync', () => {
    db.prepare('INSERT INTO sync_log (provider_id, ran_at, added, modified, removed) VALUES (?,?,0,0,0)')
      .run('plaid', '2026-08-01T00:00:00Z');
    expect(detectSyncHealth(db, 3, now).map((d) => d.code)).toContain('stale-sync');
  });

  it('stays quiet on a healthy recent sync', () => {
    recordSync(db, 'plaid', { added: 3, modified: 0, removed: 0 });
    expect(detectSyncHealth(db, 3, now)).toEqual([]);
  });

  it('notices many empty syncs while the data has gone stale', () => {
    // Banks lag a day or two; ten empty syncs against week-old data is an Item
    // that has quietly stopped returning anything.
    account('a1', 'Checking', '1111');
    txn(({ date: '2026-08-01' }));
    for (let i = 0; i < 10; i++) recordSync(db, 'plaid', { added: 0, modified: 0, removed: 0 });
    expect(detectSyncHealth(db, 3, now).map((d) => d.code)).toContain('no-new-data');
  });

  it('does not read ten quiet CSV re-reads as a dead link', () => {
    // CSV only changes when a new export is dropped in; re-reading the same
    // files is the normal case, and its honest count is zero.
    account('a1', 'Checking', '1111');
    txn(({ date: '2026-08-01' }));
    upsertProvider(db, 'csv', 'csv');
    for (let i = 0; i < 10; i++) recordSync(db, 'csv', { added: 0, modified: 0, removed: 0 });
    expect(detectSyncHealth(db, 3, now).map((d) => d.code)).not.toContain('no-new-data');
  });
});

describe('runDiagnostics', () => {
  it('returns nothing for a healthy ledger', () => {
    account('a1', 'Checking', '1111');
    txn();
    recordSync(db, 'plaid', { added: 1, modified: 0, removed: 0 });
    expect(runDiagnostics(db, new Date())).toEqual([]);
  });

  it('puts errors before warnings and info', () => {
    // A WARNING: a connection superseded by a re-link, still billing.
    const old = seedAccount(db, 'wf', { name: 'CHECKING', mask: '1111', itemId: 'item-old' });
    seedTxn(db, old, { date: '2026-06-01', amountCents: -5_000, description: 'GROCERY' });
    const fresh = seedAccount(db, 'wf-new', { name: 'CHECKING', mask: '1111', itemId: 'item-new' });
    seedTxn(db, fresh, { date: '2026-06-01', amountCents: -5_000, description: 'GROCERY' });

    // An ERROR: transactions whose account is gone.
    const gone = seedAccount(db, 'gone', { name: 'Closed', mask: '2222' });
    seedTxn(db, gone, { amountCents: -25_000 });
    db.pragma('foreign_keys = OFF');
    db.prepare('DELETE FROM accounts WHERE account_id = ?').run(gone.accountId);

    const severities = runDiagnostics(db, new Date()).map((d) => d.severity);
    expect(severities[0]).toBe('error');
    expect(severities).toContain('warning');
    // Ordering, not merely presence: an error must never sort after a warning.
    expect(severities.indexOf('error')).toBeLessThan(severities.indexOf('warning'));
  });
});


describe('detectSupersededConnections', () => {
  // Exactly the state a re-link leaves behind: the old connection keeps
  // authenticating, keeps syncing, and with Plaid keeps billing, while the
  // newer one supplies every figure that gets reported.
  const relink = () => {
    const old = seedAccount(db, 'wf', { name: 'CHECKING', mask: '1111', itemId: 'item-old' });
    seedTxn(db, old, { date: '2026-06-01', amountCents: -5_000, description: 'GROCERY' });
    const fresh = seedAccount(db, 'wf-new', { name: 'CHECKING', mask: '1111', itemId: 'item-new' });
    seedTxn(db, fresh, { date: '2026-06-01', amountCents: -5_000, description: 'GROCERY' });
    return { old, fresh };
  };

  it('names the connection every one of whose rows is covered elsewhere', () => {
    relink();
    const [found] = detectSupersededConnections(db);

    expect(found!.code).toBe('superseded-connection');
    expect(found!.message).toContain('item-old');
    expect(found!.remedy).toContain('plaid item remove --item item-old');
  });

  it('says nothing about the connection that IS supplying the data', () => {
    relink();
    const messages = detectSupersededConnections(db).map((d) => d.message).join(' ');
    expect(messages).not.toContain('item-new');
  });

  it('stays quiet when a connection carries anything of its own', () => {
    // One row the newer connection never saw is enough: this is a real source
    // of data, not a leftover.
    const { old } = relink();
    seedTxn(db, old, { date: '2026-05-01', amountCents: -900, description: 'ONLY HERE' });
    expect(detectSupersededConnections(db)).toEqual([]);
  });

  it('ignores a connection that has delivered nothing at all', () => {
    // A fresh link that has not synced yet is not superseded — it is new. Only
    // a connection whose rows are uniformly rejected is evidence of anything.
    seedAccount(db, 'unsynced', { name: 'NEW', mask: '4321', itemId: 'item-fresh' });
    expect(detectSupersededConnections(db)).toEqual([]);
  });
});

describe('empty accounts, split by whether the bank reports a balance', () => {
  const synced = () => recordSync(db, 'plaid', { added: 1, modified: 0, removed: 0 });

  it('warns when an account has a balance but no activity', () => {
    // The institution knows the account and how much is in it, and returns no
    // transactions. Totals are missing whatever it holds, and that is not a
    // fact about the user's spending.
    const a = account('idle', 'STORE CARD', '4444', 'credit');
    appendBalance(db, {
      sourceId: a.sourceId, accountId: a.accountId,
      asOf: '2026-08-13T00:00:00.000Z', currentCents: -45_000,
    });
    synced();

    const [found] = detectEmptyAccounts(db);
    expect(found!.severity).toBe('warning');
    expect(found!.code).toBe('account-returns-no-transactions');
    expect(found!.remedy).toContain('link --days 730');
  });

  it('stays at info when there is no balance either', () => {
    account('unused', 'OLD SAVINGS', '4444');
    synced();

    const [found] = detectEmptyAccounts(db);
    expect(found!.severity).toBe('info');
    expect(found!.code).toBe('empty-accounts');
  });

  it('treats a zero balance as unused rather than broken', () => {
    // A closed account reporting $0 is the commonest harmless case; warning on
    // it would train people to skim past the row that matters.
    const a = account('closed', 'CLOSED', '5555');
    appendBalance(db, {
      sourceId: a.sourceId, accountId: a.accountId,
      asOf: '2026-08-13T00:00:00.000Z', currentCents: 0,
    });
    synced();

    expect(detectEmptyAccounts(db)[0]!.severity).toBe('info');
  });

  it('reports both kinds separately when both exist', () => {
    const live = account('live', 'STORE CARD', '4444', 'credit');
    appendBalance(db, {
      sourceId: live.sourceId, accountId: live.accountId,
      asOf: '2026-08-13T00:00:00.000Z', currentCents: -45_000,
    });
    account('unused', 'OLD SAVINGS', '4444');
    synced();

    const codes = detectEmptyAccounts(db).map((d) => d.code);
    expect(codes).toEqual(['account-returns-no-transactions', 'empty-accounts']);
  });

  it('says nothing before a successful sync', () => {
    // Every account is empty before the first sync; saying so would be noise.
    account('fresh', 'NEW', '1111');
    expect(detectEmptyAccounts(db)).toEqual([]);
  });
});

describe('the removal command a user is told to run', () => {
  it('is the command that actually exists', () => {
    // Printed by `finance doctor` AND by `finance link` right after a re-link,
    // so it is the main thing standing between someone and a connection that
    // bills forever. A remedy naming a command that does not exist is worse
    // than no remedy: it reads as authoritative and fails.
    const old = seedAccount(db, 'wf', { name: 'CHECKING', mask: '1111', itemId: 'item-old' });
    seedTxn(db, old, { date: '2026-06-01', amountCents: -5_000, description: 'GROCERY' });
    const fresh = seedAccount(db, 'wf-new', { name: 'CHECKING', mask: '1111', itemId: 'item-new' });
    seedTxn(db, fresh, { date: '2026-06-01', amountCents: -5_000, description: 'GROCERY' });

    const [found] = detectSupersededConnections(db);
    expect(found!.remedy).toContain('plaid item remove --item item-old --force');
    // The plural form is a different command that does not exist.
    expect(found!.remedy).not.toContain('plaid items remove');
  });
});

describe('detectUnlinkedCards reads what the reports read', () => {
  it('ignores rows from a retired connection', () => {
    // This detector is the exception to diagnostics reading the base table.
    // It asks whether REPORTED totals are missing card spending, so it must
    // see what the reports see — and its trigger is a RATIO, so counting rows
    // nothing reports moves the threshold rather than just a number.
    const checking = seedAccount(db, 'chk', { name: 'CHECKING', mask: '1111' });
    const card = seedAccount(db, 'card', { name: 'VISA', mask: '5555', type: 'credit' });
    seedTxn(db, checking, { amountCents: -100_000, category: 'credit_card_payment' });
    seedTxn(db, card, { amountCents: -5_000, category: 'shopping' });

    // Fires: $1,000 of payments against $50 of card spending.
    expect(detectUnlinkedCards(db)).toHaveLength(1);

    // A retired connection delivering plenty of card spending must NOT silence
    // it — those rows are not in any report.
    const stale = seedAccount(db, 'card-old', {
      name: 'VISA', mask: '5555', type: 'credit', itemId: 'item-stale',
    });
    seedTxn(db, stale, { amountCents: -90_000, category: 'shopping', description: 'OLD CARD BUY' });
    db.prepare(`UPDATE connections SET active = 0 WHERE connection_id =
                (SELECT connection_id FROM sources WHERE source_id = ?)`).run(stale.sourceId);

    expect(detectUnlinkedCards(db)).toHaveLength(1);
  });

  it('counts only cards a live connection still feeds', () => {
    const checking = seedAccount(db, 'chk', { name: 'CHECKING', mask: '1111' });
    seedTxn(db, checking, { amountCents: -100_000, category: 'credit_card_payment' });
    const card = seedAccount(db, 'card', { name: 'VISA', mask: '5555', type: 'credit' });
    seedTxn(db, card, { amountCents: -1_000, category: 'shopping' });

    const [found] = detectUnlinkedCards(db);
    // A retired card is not a linked card, and saying "2 credit accounts
    // linked" when one is retired sends someone looking for a card that is
    // already gone.
    expect(found!.detail!.join(' ')).toContain('1 credit account(s)');
  });
});
