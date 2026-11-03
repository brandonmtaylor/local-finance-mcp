// Accounts almost never share a start date. A bank that gives two years sits
// beside a card that gives ninety days, and any window reaching past the
// shorter one is answered by a SUBSET of the accounts — silently, and with a
// number indistinguishable from a complete one.
//
// On a real ledger a full-year summary reported a spending total two thirds
// of which was credit-card payments standing in for purchases nobody had the data for,
// under a note claiming no card was linked. Both cards were linked.

import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openLedger } from '../src/core/ledger.js';
import { coverageGaps, getSpendingSummary } from '../src/core/queries.js';
import { seedAccount, seedTxn } from './helpers.js';

let db: Database.Database;
beforeEach(() => { db = openLedger(':memory:'); });

/** A checking account reaching back two years, and a card reaching back three months. */
const mixed = () => {
  const checking = seedAccount(db, 'chk', { name: 'CHECKING', mask: '1111', type: 'depository' });
  const card = seedAccount(db, 'card', { name: 'VISA', mask: '5555', type: 'credit' });
  seedTxn(db, checking, { date: '2024-01-05', amountCents: -10_000, description: 'OLD' });
  seedTxn(db, checking, { date: '2026-07-01', amountCents: -10_000, description: 'RECENT' });
  seedTxn(db, card, { date: '2026-07-02', amountCents: -5_000, description: 'CARD BUY' });
  return { checking, card };
};

describe('coverageGaps', () => {
  it('names the account that cannot speak for the window', () => {
    mixed();
    const gaps = coverageGaps(db, '2024-01-01', '2026-12-31');

    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ name: 'VISA', type: 'credit', earliest: '2026-07-02' });
    expect(gaps[0]!.missingDays).toBeGreaterThan(900);
  });

  it('says nothing when every account covers the window', () => {
    mixed();
    expect(coverageGaps(db, '2026-07-01', '2026-07-31')).toEqual([]);
  });

  it('ignores an account with no transactions at all', () => {
    // That is a different problem — an account returning nothing — and
    // reporting it here would bury the accounts that DO have a gap.
    mixed();
    seedAccount(db, 'empty', { name: 'UNUSED', mask: '9999' });
    expect(coverageGaps(db, '2024-01-01', '2026-12-31').map((g) => g.name)).toEqual(['VISA']);
  });

  it('ignores a retired connection rather than blaming it for a gap', () => {
    const { card } = mixed();
    db.prepare(`UPDATE connections SET active = 0 WHERE connection_id =
                (SELECT connection_id FROM sources WHERE source_id = ?)`).run(card.sourceId);
    expect(coverageGaps(db, '2024-01-01', '2026-12-31')).toEqual([]);
  });

  it('measures the gap against the window, not against all of history', () => {
    mixed();
    const gaps = coverageGaps(db, '2026-06-01', '2026-07-31');
    // The card starts 2026-07-02: about a month of a two-month window.
    expect(gaps[0]!.missingDays).toBeGreaterThan(25);
    expect(gaps[0]!.missingDays).toBeLessThan(40);
  });

  it('stays quiet about a gap too small to mean anything', () => {
    // The earliest transaction is a proxy for coverage, not coverage itself.
    // An account whose first purchase falls a few days into the window covered
    // that window and simply sat idle — and a caveat printed on every summary
    // is a caveat nobody reads.
    mixed();
    expect(coverageGaps(db, '2026-06-28', '2026-07-31')).toEqual([]);
  });
});

describe('the summary carries its own caveat', () => {
  it('reports gaps beside the total rather than leaving them to a separate call', () => {
    // A total and the reason it is partial have to travel together. Anything
    // that can be read without the caveat eventually is.
    mixed();
    const s = getSpendingSummary(db, '2024-01-01', '2026-12-31');
    expect(s.coverageGaps.map((g) => g.name)).toEqual(['VISA']);
  });

  it('is empty for a window everything covers', () => {
    mixed();
    expect(getSpendingSummary(db, '2026-07-01', '2026-07-31').coverageGaps).toEqual([]);
  });
});
