// Scale properties. Both of these were wrong once and neither showed up in a
// correctness test: the ledger behaved perfectly and simply got slower the
// longer it was used, which is the failure mode nobody notices until it is
// months old.

import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openLedger } from '../src/core/ledger.js';
import { seedAccount, seedTxn } from './helpers.js';

let db: Database.Database;

beforeEach(() => { db = openLedger(':memory:'); });

/** Write `n` transactions into one source, all with distinct content. */
function fill(n: number, into = seedAccount(db, 'a1')) {
  db.transaction(() => {
    for (let i = 0; i < n; i += 1) {
      seedTxn(db, into, {
        externalId: `x-${i}`,
        date: `2025-${String((i % 12) + 1).padStart(2, '0')}-01`,
        amountCents: -(1_000 + i),
        description: `MERCHANT ${i}`,
      });
    }
  })();
  return into;
}

describe('insert cost does not grow with history', () => {
  it('stays linear as a source accumulates rows', () => {
    // Every insert computes an occurrence index by counting rows with the same
    // content in the same source. Unindexed, that count scans the source's
    // entire history and a sync becomes O(n²) in its own past — 51 seconds to
    // write 60k rows, against 2 with the index.
    fill(2_000);

    const timed = (n: number) => {
      const start = performance.now();
      fill(n, seedAccount(db, `bench-${n}-${Math.trunc(performance.now())}`));
      return performance.now() - start;
    };
    const small = timed(500);
    const large = timed(4_000);

    // Eight times the rows should cost roughly eight times as much. Allow a
    // wide margin for a noisy machine — this is guarding against quadratic
    // blow-up, not measuring throughput.
    expect(large / Math.max(small, 1)).toBeLessThan(40);
  });

  it('keeps the dedup index available to the view', () => {
    fill(200);
    const plan = db.prepare(
      'EXPLAIN QUERY PLAN SELECT COUNT(*) FROM visible_transactions',
    ).all() as Array<{ detail: string }>;
    const detail = plan.map((p) => p.detail).join(' ');

    // A full scan inside the correlated subquery would make every read
    // quadratic too.
    expect(detail).toContain('idx_txn_dedup');
  });

  it('indexes the occurrence count that runs on every insert', () => {
    fill(200);
    const plan = db.prepare(
      'EXPLAIN QUERY PLAN SELECT COUNT(*) FROM transactions WHERE source_id = ? AND base_key = ?',
    ).all('s', 'b') as Array<{ detail: string }>;
    expect(plan.map((p) => p.detail).join(' ')).toContain('idx_txn_occurrence');
  });
});
