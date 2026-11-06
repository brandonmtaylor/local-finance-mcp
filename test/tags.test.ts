// Tags and notes. The point of tags is the EVENT case: one cause producing
// costs across several categories and weeks, where the only useful question is
// what the whole episode came to.
//
// Under content-derived identity a test cannot choose a transaction's id, so
// these hold the id the ledger minted — the same contract a real caller gets.

import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import {
  openLedger, setNote, addTag, removeTag, tagsFor, normalizeTag,
} from '../src/core/ledger.js';
import { queryTransactions, tagTotals } from '../src/core/queries.js';
import { seedAccount, seedTxn, type Seeded } from './helpers.js';

let db: Database.Database;
let acct: Seeded;

const txn = (over: Parameters<typeof seedTxn>[2] = {}) => seedTxn(db, acct, {
  date: '2026-06-04', amountCents: -1_000, description: 'THING', category: 'housing', ...over,
});

beforeEach(() => {
  db = openLedger(':memory:');
  acct = seedAccount(db, 'a1');
});

describe('normalizeTag', () => {
  it('lower-cases and hyphenates so one tag does not become three', () => {
    expect(normalizeTag('Emergency Home')).toBe('emergency-home');
    expect(normalizeTag('  DISHWASHER   LEAK  ')).toBe('dishwasher-leak');
    expect(normalizeTag('emergency-home')).toBe('emergency-home');
  });

  it('strips characters that would make a tag unmatchable', () => {
    expect(normalizeTag('tax/deductible!')).toBe('taxdeductible');
  });
});

describe('addTag', () => {
  let t1: string;
  beforeEach(() => { t1 = txn(); });

  it('attaches and lists tags', () => {
    addTag(db, t1, 'Emergency Home');
    addTag(db, t1, 'one-off');
    expect(tagsFor(db, t1)).toEqual(['emergency-home', 'one-off']);
  });

  it('is idempotent', () => {
    addTag(db, t1, 'emergency');
    addTag(db, t1, 'emergency');
    expect(tagsFor(db, t1)).toEqual(['emergency']);
  });

  it('refuses a transaction that does not exist', () => {
    // Tags carry no foreign key — they must outlive the row they describe, so
    // a re-link cannot throw a correction away. That makes this check the only
    // thing standing between a typo and a tag attached to nothing.
    expect(addTag(db, 'nope', 'emergency')).toBe(false);
  });

  it('rejects a tag that normalizes to nothing', () => {
    expect(addTag(db, t1, '!!!')).toBe(false);
    expect(tagsFor(db, t1)).toEqual([]);
  });

  it('OUTLIVES the transaction row it describes', () => {
    // The opposite of the old behaviour, and deliberate. A row can be replaced
    // by the same transaction arriving from another connection; cascading the
    // delete would discard the tag at exactly the moment it should persist.
    addTag(db, t1, 'emergency');
    db.prepare('DELETE FROM transactions WHERE txn_id = ?').run(t1);
    expect(db.prepare('SELECT COUNT(*) c FROM tags').get()).toEqual({ c: 1 });
  });
});

describe('removeTag', () => {
  it('detaches without touching the transaction', () => {
    const t1 = txn({ category: 'housing' });
    addTag(db, t1, 'emergency');

    expect(removeTag(db, t1, 'Emergency')).toBe(true);   // normalized on the way in
    expect(tagsFor(db, t1)).toEqual([]);
    expect(db.prepare('SELECT category FROM transactions').get()).toEqual({ category: 'housing' });
  });

  it('reports false when the tag was not there', () => {
    const t1 = txn();
    expect(removeTag(db, t1, 'never-applied')).toBe(false);
  });
});

describe('notes', () => {
  it('records and clears context', () => {
    const t1 = txn();
    setNote(db, t1, 'dishwasher leak — replaced flooring');
    expect(queryTransactions(db)[0]!.note).toMatch(/dishwasher leak/);

    setNote(db, t1, null);
    expect(queryTransactions(db)[0]!.note).toBeNull();
  });

  it('SURVIVES a re-sync', () => {
    // A note is user-owned. Re-delivering the same transaction — same content,
    // so the same id — must not disturb it.
    const t1 = txn({ description: 'ORIGINAL' });
    setNote(db, t1, 'context worth keeping');

    // The same row again, from the same source: identity is unchanged.
    seedTxn(db, acct, {
      externalId: `ext-refresh`, date: '2026-06-04', amountCents: -1_000,
      description: 'ORIGINAL', category: 'housing',
    });

    const row = queryTransactions(db)[0]!;
    expect(row.note).toBe('context worth keeping');
  });
});

describe('tagTotals', () => {
  beforeEach(() => {
    // One cause, three categories, three weeks — the case tags exist for.
    const repair = txn({ date: '2026-06-04', amountCents: -120_000, category: 'housing' });
    const plumber = txn({ date: '2026-06-02', amountCents: -6_000, category: 'professional_services' });
    const appliance = txn({ date: '2026-06-20', amountCents: -89_900, category: 'shopping' });
    txn({ date: '2026-06-10', amountCents: -5_000, category: 'groceries' }); // unrelated
    for (const id of [repair, plumber, appliance]) addTag(db, id, 'dishwasher-leak');
  });

  it('totals an episode across categories and reports its span', () => {
    const [total] = tagTotals(db);
    expect(total).toMatchObject({
      tag: 'dishwasher-leak', count: 3, totalCents: 215_900,
      firstDate: '2026-06-02', lastDate: '2026-06-20',
    });
  });

  it('excludes untagged spending', () => {
    expect(tagTotals(db)).toHaveLength(1);
    expect(tagTotals(db)[0]!.totalCents).toBe(215_900);
  });

  it('respects a date window', () => {
    const [total] = tagTotals(db, '2026-06-03', '2026-06-30');
    expect(total!.count).toBe(2);   // the 06-02 plumber falls outside
  });
});

describe('filtering by tag', () => {
  let a: string;
  let b: string;
  let c: string;

  beforeEach(() => {
    a = txn({ description: 'A' });
    b = txn({ description: 'B' });
    c = txn({ description: 'C' });
    addTag(db, a, 'emergency'); addTag(db, a, 'home');
    addTag(db, b, 'emergency');
  });

  it('requires ALL listed tags, not any', () => {
    expect(queryTransactions(db, { tags: ['emergency'] }).map((t) => t.txnId).sort())
      .toEqual([a, b].sort());
    expect(queryTransactions(db, { tags: ['emergency', 'home'] }).map((t) => t.txnId)).toEqual([a]);
  });

  it('returns the tags on each row', () => {
    const row = queryTransactions(db, { tags: ['home'] })[0]!;
    expect(row.tags!.split(',').sort()).toEqual(['emergency', 'home']);
    expect(queryTransactions(db).find((t) => t.txnId === c)!.tags).toBeNull();
  });

  it('does not let a tag value inject SQL', () => {
    const rows = queryTransactions(db, { tags: ["'; DROP TABLE tags; --"] });
    expect(rows).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) c FROM tags').get()).toEqual({ c: 3 });
  });
});

describe('tag totals across connections', () => {
  it('counts a tagged transaction once when two connections deliver it', () => {
    // A tag is keyed on txn_id, which both stored copies share, so joining the
    // base table counted a $1,200 repair as $2,400 — the tag feature exists
    // precisely to answer "what did that episode cost", so doubling it is the
    // worst possible place for this bug.
    // Same institution, mask and type, so it resolves to the account already
    // known — which is what a re-link looks like.
    const second = seedAccount(db, 'a1-relinked', { mask: '00a1', itemId: 'item-second' });

    const row = {
      date: '2026-06-04', amountCents: -120_000,
      description: 'HANDYMAN', category: 'housing' as const,
    };
    const id = seedTxn(db, acct, { ...row, externalId: 'from-old' });
    const same = seedTxn(db, second, { ...row, externalId: 'from-new' });
    addTag(db, id, 'garage-door');

    expect(same).toBe(id); // one real transaction

    const [total] = tagTotals(db);
    expect(total!.count).toBe(1);
    expect(total!.totalCents).toBe(120_000);
  });
});
