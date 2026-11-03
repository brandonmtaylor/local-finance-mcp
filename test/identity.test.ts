// The identity model, which is what the rest of this project rests on.
//
// A provider's ids are scoped to a connection: re-linking a bank yields new
// account ids and new transaction ids for the same real things. These tests pin
// the two properties that follow from deriving identity from content instead —
// a re-link does not duplicate, and a correction survives one — plus the case
// that makes it hard, which is transactions with nothing to tell them apart.

import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import {
  openLedger, upsertProvider, resolveConnection, resolveSource, upsertTransaction,
  setCategoryOverride, setNote, addTag, setConnectionActive, listConnections,
  type IncomingTransaction,
} from '../src/core/ledger.js';
import { normalizeDescription, naturalKey } from '../src/core/identity.js';

let db: Database.Database;

beforeEach(() => {
  db = openLedger(':memory:');
  upsertProvider(db, 'plaid', 'plaid');
});

/** One authenticated link: a Plaid Item and the account it reports. */
const link = (itemId: string, externalId: string, over: Record<string, unknown> = {}) => {
  const connectionId = resolveConnection(db, 'plaid', itemId);
  return resolveSource(db, connectionId, { ...account(externalId), ...over });
};

const account = (externalId: string) => ({
  externalId,
  name: 'CHECKING',
  mask: '1111',
  type: 'depository',
  subtype: 'checking',
  institutionId: 'ins_000002',
});

const txn = (over: Partial<IncomingTransaction> & { externalId: string }): IncomingTransaction => ({
  date: '2026-06-15',
  amountCents: -10_000,
  description: 'GROCERY MART #412',
  category: 'groceries',
  categorySource: 'inferred',
  ...over,
});

const visible = () => db.prepare(
  'SELECT txn_id, amount_cents, description FROM visible_transactions ORDER BY date, txn_id',
).all() as Array<{ txn_id: string; amount_cents: number; description: string }>;

describe('re-linking', () => {
  it('attaches a new connection to the account it already knows', () => {
    const first = link('item-plaid-acct-OLD', 'plaid-acct-OLD');
    // A re-link: same real account, entirely different provider id.
    const second = link('item-plaid-acct-NEW', 'plaid-acct-NEW');

    expect(second.accountId).toBe(first.accountId);
    expect(second.matchedExisting).toBe(true);
    expect(second.sourceId).not.toBe(first.sourceId);
    expect(db.prepare('SELECT COUNT(*) n FROM accounts').get()).toEqual({ n: 1 });
  });

  it('does not duplicate transactions the new connection re-delivers', () => {
    const old = link('item-plaid-acct-OLD', 'plaid-acct-OLD');
    upsertTransaction(db, old.sourceId, old.accountId, txn({ externalId: 'plaid-txn-A' }));

    // The same real transaction, re-delivered under a new Item with a new id.
    const fresh = link('item-plaid-acct-NEW', 'plaid-acct-NEW');
    upsertTransaction(db, fresh.sourceId, fresh.accountId, txn({ externalId: 'plaid-txn-Z' }));

    expect(db.prepare('SELECT COUNT(*) n FROM transactions').get()).toEqual({ n: 2 }); // both stored
    expect(visible()).toHaveLength(1);                                                  // one counted
  });

  it('keeps a correction attached across the re-link', () => {
    // The reason identity is content-derived. Under the previous schema an
    // override lived on the provider's transaction id and was orphaned the
    // moment the connection changed.
    const old = link('item-plaid-acct-OLD', 'plaid-acct-OLD');
    const id = upsertTransaction(db, old.sourceId, old.accountId, txn({ externalId: 'plaid-txn-A' }));
    setCategoryOverride(db, id, 'housing');
    setNote(db, id, 'fixed the dishwasher leak');
    addTag(db, id, 'appliance-leak');

    const fresh = link('item-plaid-acct-NEW', 'plaid-acct-NEW');
    const newId = upsertTransaction(db, fresh.sourceId, fresh.accountId, txn({ externalId: 'plaid-txn-Z' }));

    expect(newId).toBe(id); // same real transaction, same identity
    // The view's `category` IS the corrected one — that is the whole point of
    // naming it the same as the base column.
    const [row] = db.prepare(
      'SELECT category, spend_group, note FROM visible_transactions',
    ).all() as Array<{ category: string; spend_group: string; note: string }>;
    expect(row!.category).toBe('housing');
    // And the override must move the row's spend group too, or reclassifying
    // something as a card payment would leave it in the spending total.
    expect(row!.spend_group).toBe('bills');
    expect(row!.note).toBe('fixed the dishwasher leak');
  });

  it('prefers the newer connection when both are active', () => {
    const old = link('item-plaid-acct-OLD', 'plaid-acct-OLD');
    upsertTransaction(db, old.sourceId, old.accountId,
      txn({ externalId: 'a', description: 'GROCERY MART #412' }));
    const fresh = link('item-plaid-acct-NEW', 'plaid-acct-NEW');
    upsertTransaction(db, fresh.sourceId, fresh.accountId,
      txn({ externalId: 'z', description: 'GROCERY MART #412' }));

    const rows = db.prepare('SELECT source_id FROM visible_transactions').all() as
      Array<{ source_id: string }>;
    expect(rows[0]!.source_id).toBe(fresh.sourceId);
  });

  it('falls back to the older connection when the newer is deactivated', () => {
    const old = link('item-plaid-acct-OLD', 'plaid-acct-OLD');
    upsertTransaction(db, old.sourceId, old.accountId, txn({ externalId: 'a' }));
    const fresh = link('item-plaid-acct-NEW', 'plaid-acct-NEW');
    upsertTransaction(db, fresh.sourceId, fresh.accountId, txn({ externalId: 'z' }));

    setConnectionActive(db, resolveConnection(db, 'plaid', 'item-plaid-acct-NEW'), false);

    const rows = db.prepare('SELECT source_id FROM visible_transactions').all() as
      Array<{ source_id: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.source_id).toBe(old.sourceId);
  });
});

describe('transactions with nothing to tell them apart', () => {
  // Four identical small donations on two days.
  // Plaid's full API returns no datetime, no reference_number and no check
  // number for these — verified against production — so content is all there
  // is, and content is identical.
  const donation = (externalId: string, date: string): IncomingTransaction => ({
    externalId, date, amountCents: -1_000,
    description: 'COMMUNITY FOOD BANK', category: 'charity', categorySource: 'inferred',
  });

  it('keeps genuinely repeated transactions as separate rows', () => {
    const s = link('item-acct-1', 'acct-1');
    for (const [i, date] of [['a', '2026-08-03'], ['b', '2026-08-03'],
      ['c', '2026-08-10'], ['d', '2026-08-10']] as const) {
      upsertTransaction(db, s.sourceId, s.accountId, donation(i, date));
    }
    expect(visible()).toHaveLength(4);
  });

  it('collapses them correctly when a second connection delivers the same four', () => {
    // The occurrence index is counted PER SOURCE. Counting per account would
    // make the second connection's first donation look like a third occurrence
    // and duplicate the lot.
    const old = link('item-acct-OLD', 'acct-OLD');
    for (const [i, date] of [['a', '2026-08-03'], ['b', '2026-08-03'],
      ['c', '2026-08-10'], ['d', '2026-08-10']] as const) {
      upsertTransaction(db, old.sourceId, old.accountId, donation(i, date));
    }

    const fresh = link('item-acct-NEW', 'acct-NEW');
    for (const [i, date] of [['w', '2026-08-03'], ['x', '2026-08-03'],
      ['y', '2026-08-10'], ['z', '2026-08-10']] as const) {
      upsertTransaction(db, fresh.sourceId, fresh.accountId, donation(i, date));
    }

    expect(db.prepare('SELECT COUNT(*) n FROM transactions').get()).toEqual({ n: 8 });
    expect(visible()).toHaveLength(4); // four donations, not eight and not one
  });

  it('keeps a straggler the older connection never saw', () => {
    // A late-posting transaction that arrives only via the newer connection
    // must survive: it is a fifth donation, not a duplicate of the fourth.
    const old = link('item-acct-OLD', 'acct-OLD');
    upsertTransaction(db, old.sourceId, old.accountId, donation('a', '2026-08-03'));

    const fresh = link('item-acct-NEW', 'acct-NEW');
    upsertTransaction(db, fresh.sourceId, fresh.accountId, donation('w', '2026-08-03'));
    upsertTransaction(db, fresh.sourceId, fresh.accountId, donation('x', '2026-08-03'));

    expect(visible()).toHaveLength(2);
  });
});

describe('ordinary syncing', () => {
  it('re-running a sync updates in place rather than duplicating', () => {
    const s = link('item-acct-1', 'acct-1');
    upsertTransaction(db, s.sourceId, s.accountId, txn({ externalId: 'x', pending: true }));
    upsertTransaction(db, s.sourceId, s.accountId, txn({ externalId: 'x', pending: false }));

    const rows = db.prepare('SELECT pending FROM visible_transactions').all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ pending: 0 });
  });

  it('gives each source its own cursor', () => {
    // Plaid advances a cursor per Item. The previous schema had one per
    // provider, so cursors were kept in the Plaid CLI's config file instead —
    // coupling this project to an undocumented third-party format.
    const a = link('item-acct-1', 'acct-1');
    const b = link('item-acct-2', 'acct-2', { mask: '2222' });
    expect(a.sourceId).not.toBe(b.sourceId);
    expect(listConnections(db)).toHaveLength(2);
  });
});

describe('matching an account across connections', () => {
  it('treats a renamed account as the same account', () => {
    // Banks rename products. The name is not identity.
    const first = link('item-acct-OLD', 'acct-OLD');
    const second = link('item-acct-NEW', 'acct-NEW', { name: 'CHECKING (PREFERRED)' });
    expect(second.accountId).toBe(first.accountId);
  });

  it('does NOT merge two accounts that differ by type', () => {
    const checking = link('item-acct-1', 'acct-1');
    const savings = link('item-acct-2', 'acct-2', { subtype: 'savings' });
    expect(savings.accountId).not.toBe(checking.accountId);
  });

  it('declines to match on nothing when the provider gives no mask', () => {
    // Matching without a discriminator would silently merge unrelated accounts.
    expect(naturalKey({ mask: null, institutionId: 'ins_1' })).toBeNull();
    const a = link('item-acct-1', 'acct-1', { mask: null });
    const b = link('item-acct-2', 'acct-2', { mask: null });
    expect(a.accountId).not.toBe(b.accountId);
  });

  it('records ambiguity instead of asking', () => {
    // A scheduled sync runs with nobody watching, so a prompt would hang it.
    // Take the fullest account and leave evidence for `doctor`.
    const a = link('item-acct-1', 'acct-1');
    upsertTransaction(db, a.sourceId, a.accountId, txn({ externalId: 't1' }));
    db.prepare(`INSERT INTO accounts (account_id, name, mask, type, subtype, currency,
                 institution_id, natural_key, created_at)
                VALUES ('acct_other','CHECKING','1111','depository','checking','USD',
                        'ins_000002', ?, '2026-01-01')`)
      .run(naturalKey(account('x')));

    const c = link('item-acct-3', 'acct-3');
    expect(c.ambiguous).toBeDefined();
    expect(c.accountId).toBe(a.accountId); // the one with transactions
  });
});

describe('normalizeDescription', () => {
  it('collapses the padding banks vary between renderings', () => {
    expect(normalizeDescription('  CARD ISSUER   MOBILE PMT '))
      .toBe(normalizeDescription('CARD ISSUER MOBILE PMT'));
  });

  it('keeps the reference number, which is the strongest signal available', () => {
    // Present on about a third of real rows, and the only thing distinguishing
    // otherwise-identical transfers.
    const a = normalizeDescription('ZELLE TO LAWN SERVICE REF # BANKREF00001');
    const b = normalizeDescription('ZELLE TO LAWN SERVICE REF#BANKREF00002');
    expect(a).not.toBe(b);
    expect(a).toContain('bankref00001');
  });
});
