// Freshness is the answer to "does the model have to remember to sync?" — no,
// because the decision is made here, deterministically, from config.

import { describe, it, expect } from 'vitest';
import { decideFreshness } from '../src/core/freshness.js';
import { ConfigSchema } from '../src/core/config.js';

const freshness = ConfigSchema.parse({}).freshness;
const NOW = new Date('2026-08-11T12:00:00.000Z');
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000);
const hoursAgo = (n: number) => new Date(NOW.getTime() - n * 3_600_000);

describe('decideFreshness', () => {
  it('always syncs when nothing has ever been synced', () => {
    const d = decideFreshness({ kind: 'transactions', lastSyncAt: null, now: NOW }, freshness);
    expect(d).toMatchObject({ sync: true, blocking: true });
  });

  it('syncs an empty ledger even for a long-settled window', () => {
    // Settled data can't change — but with nothing stored there is nothing to serve.
    const d = decideFreshness(
      { kind: 'transactions', lastSyncAt: null, windowEnd: '2026-01-31', now: NOW },
      freshness,
    );
    expect(d.sync).toBe(true);
  });

  it('never syncs for a window that has already settled', () => {
    // The common case: "what did we spend in July". Stale provider, instant answer.
    const d = decideFreshness(
      { kind: 'transactions', lastSyncAt: hoursAgo(72), windowEnd: '2026-07-31', now: NOW },
      freshness,
    );
    expect(d.sync).toBe(false);
    expect(d.reason).toMatch(/settled/);
  });

  it('does sync for a window still inside the settling period', () => {
    const d = decideFreshness(
      { kind: 'transactions', lastSyncAt: hoursAgo(72), windowEnd: '2026-08-10', now: NOW },
      freshness,
    );
    expect(d.sync).toBe(true);
  });

  it('serves transactions from cache inside the TTL', () => {
    const d = decideFreshness(
      { kind: 'transactions', lastSyncAt: hoursAgo(1), now: NOW },
      freshness,
    );
    expect(d.sync).toBe(false);
  });

  it('syncs transactions once past the TTL', () => {
    const d = decideFreshness(
      { kind: 'transactions', lastSyncAt: hoursAgo(7), now: NOW },
      freshness,
    );
    expect(d).toMatchObject({ sync: true, blocking: true });
  });

  it('caches balances hard — they are billed per call', () => {
    expect(
      decideFreshness({ kind: 'balances', lastSyncAt: minutesAgo(10), now: NOW }, freshness).sync,
    ).toBe(false);
    expect(
      decideFreshness({ kind: 'balances', lastSyncAt: minutesAgo(20), now: NOW }, freshness).sync,
    ).toBe(true);
  });

  it('ignores windowEnd for balances — a balance is always "now"', () => {
    const d = decideFreshness(
      { kind: 'balances', lastSyncAt: minutesAgo(60), windowEnd: '2026-01-01', now: NOW },
      freshness,
    );
    expect(d.sync).toBe(true);
  });

  describe('staleWhileRevalidate', () => {
    const swr = ConfigSchema.parse({ freshness: { staleWhileRevalidate: true } }).freshness;

    it('makes a stale transaction read non-blocking', () => {
      const d = decideFreshness({ kind: 'transactions', lastSyncAt: hoursAgo(7), now: NOW }, swr);
      expect(d).toMatchObject({ sync: true, blocking: false });
    });

    it('still blocks on balances — a stale balance shown as current misleads', () => {
      const d = decideFreshness({ kind: 'balances', lastSyncAt: minutesAgo(60), now: NOW }, swr);
      expect(d).toMatchObject({ sync: true, blocking: true });
    });
  });

  it('honours a configured TTL over the default', () => {
    const strict = ConfigSchema.parse({ freshness: { transactionTtlHours: 1 } }).freshness;
    expect(
      decideFreshness({ kind: 'transactions', lastSyncAt: hoursAgo(2), now: NOW }, strict).sync,
    ).toBe(true);
  });
});
