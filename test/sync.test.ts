// Backfill coverage reporting.
//
// A backfill asks for a date range; the provider decides what it actually
// returns. Plaid fixes an Item's reachable history at creation via
// `days_requested` — commonly 90 days — so a request for two years quietly
// yields three months. Reporting the request instead of the result makes a
// shallow ledger look deep, and every average taken over it inherits that
// error with nothing on screen to suggest it.

import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { backfillProvider, syncProvider } from '../src/core/sync.js';
import { openLedger } from '../src/core/ledger.js';
import type { Provider, SyncResult, ConnectionSync } from '../src/providers/types.js';

let db: Database.Database;

beforeEach(() => {
  db = openLedger(':memory:');
});

const account = (externalId: string) => ({
  externalId, name: 'Checking', mask: externalId.slice(-4).padStart(4, '0'),
  type: 'depository', subtype: 'checking', institutionId: 'ins_test', currency: 'USD',
});

const txn = (over: { externalId: string; date?: string }) => ({
  accountExternalId: 'a1', date: '2026-06-15', amountCents: -1_000, currency: 'USD',
  description: `THING ${over.externalId}`, category: 'shopping' as const,
  categorySource: 'inferred', pending: false,
  ...over,
});

/** A provider that returns exactly what the test hands it. */
const stubProvider = (backfill: Provider['backfill']): Provider => ({
  id: 'stub',
  kind: 'stub',
  capabilities: { transactions: true, balances: false, investments: false, automatic: true },
  sync: async (): Promise<SyncResult> => ({ connections: [] }),
  backfill,
});

/** One connection reporting one account — the shape a provider now returns. */
const result = (over: Partial<ConnectionSync>): SyncResult => ({
  connections: [{
    externalId: 'conn-1', accounts: [account('a1')],
    added: [], modified: [], removed: [], balances: [], cursor: null,
    ...over,
  }],
});

describe('backfillProvider coverage', () => {
  it('reports the span actually written, not the span requested', async () => {
    const provider = stubProvider(async () => result({
      // Deliberately unsorted: the provider makes no ordering promise.
      added: [
        txn({ externalId: 't2', date: '2026-07-01' }),
        txn({ externalId: 't1', date: '2026-05-14' }),
        txn({ externalId: 't3', date: '2026-08-11' }),
      ],
    }));

    const outcome = await backfillProvider(db, provider, 'UTC', '2024-08-12', '2026-08-12');

    expect(outcome.added).toBe(3);
    // Two years requested, three months delivered — the gap the user must see.
    expect(outcome.coverage).toEqual({ earliest: '2026-05-14', latest: '2026-08-11' });
  });

  it('counts modified rows toward coverage, not just added ones', async () => {
    const provider = stubProvider(async () => result({
      added: [txn({ externalId: 't1', date: '2026-06-01' })],
      modified: [txn({ externalId: 't0', date: '2026-01-09' })],
    }));

    const outcome = await backfillProvider(db, provider, 'UTC', '2026-01-01', '2026-08-12');
    expect(outcome.coverage!.earliest).toBe('2026-01-09');
  });

  it('reports null rather than a bogus range when nothing arrived', async () => {
    // An empty backfill must not read as "covered zero days ending today" —
    // that is a claim about history, and it would be a false one.
    const provider = stubProvider(async () => result({}));
    const outcome = await backfillProvider(db, provider, 'UTC', '2024-08-12', '2026-08-12');
    expect(outcome.coverage).toBeNull();
  });

  it('has no coverage claim when the backfill failed', async () => {
    const provider = stubProvider(async () => { throw new Error('upstream refused'); });
    const outcome = await backfillProvider(db, provider, 'UTC', '2024-08-12', '2026-08-12');

    expect(outcome.error).toMatch(/upstream refused/);
    expect(outcome.coverage).toBeUndefined();
  });

  it('says so rather than throwing when the provider cannot backfill at all', async () => {
    const provider = stubProvider(undefined);
    const outcome = await backfillProvider(db, provider, 'UTC', '2024-08-12', '2026-08-12');
    expect(outcome.error).toMatch(/does not support backfill/);
  });
});

describe('removal counting', () => {
  /** A connection reporting three accounts, one transaction, and one removal. */
  const threeAccounts = (removed: string[]) => stubProvider(async () => ({
    connections: [{
      externalId: 'conn-1',
      accounts: [account('a1'), account('a2'), account('a3')],
      added: [], modified: [], removed, balances: [], cursor: null,
    }],
  }));

  it('counts one removal per transaction, not per account in the connection', async () => {
    // A provider reports removals for the connection without saying which
    // account held the row, so every source is swept. Counting the sweep
    // instead of the deletion made a three-account connection report three
    // removals for one transaction — straight into the sync log.
    const seed = stubProvider(async () => ({
      connections: [{
        externalId: 'conn-1',
        accounts: [account('a1'), account('a2'), account('a3')],
        added: [{ ...txn({ externalId: 'gone' }), accountExternalId: 'a1' }],
        modified: [], removed: [], balances: [], cursor: null,
      }],
    }));
    await backfillProvider(db, seed, 'UTC', '2026-01-01', '2026-12-31');

    const outcome = await backfillProvider(
      db, threeAccounts(['gone']), 'UTC', '2026-01-01', '2026-12-31',
    );

    expect(outcome.removed).toBe(1);
    expect(db.prepare('SELECT COUNT(*) n FROM transactions').get()).toEqual({ n: 0 });
  });

  it('counts nothing when the id was never there', async () => {
    const outcome = await backfillProvider(
      db, threeAccounts(['never-existed']), 'UTC', '2026-01-01', '2026-12-31',
    );
    expect(outcome.removed).toBe(0);
  });
});

describe('sync counts', () => {
  // CSV hands back every row of every file as `added` on every run. Counting
  // the provider's list printed "+55 added" for a re-sync that changed
  // nothing, which reads as "it duplicated everything".
  const csvLike = (rows: ReturnType<typeof txn>[]): Provider => ({
    ...stubProvider(async () => result({})),
    sync: async () => result({ added: rows }),
  });

  it('reports what the ledger gained, not what the provider re-sent', async () => {
    const rows = [txn({ externalId: 't1' }), txn({ externalId: 't2' })];
    const first = await syncProvider(db, csvLike(rows), 'UTC');
    expect(first).toMatchObject({ added: 2, modified: 0 });

    const again = await syncProvider(db, csvLike(rows), 'UTC');
    expect(again).toMatchObject({ added: 0, modified: 0 });

    const more = await syncProvider(db, csvLike([...rows, txn({ externalId: 't3' })]), 'UTC');
    expect(more).toMatchObject({ added: 1, modified: 0 });
    expect(db.prepare('SELECT COUNT(*) c FROM transactions').get()).toEqual({ c: 3 });
  });

  it('still counts a provider-reported modification', async () => {
    await syncProvider(db, csvLike([txn({ externalId: 't1' })]), 'UTC');
    const provider: Provider = {
      ...stubProvider(async () => result({})),
      sync: async () => result({ modified: [{ ...txn({ externalId: 't1' }), pending: true }] }),
    };
    expect(await syncProvider(db, provider, {})).toMatchObject({ added: 0, modified: 1 });
  });
});
