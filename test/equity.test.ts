// Detecting equity compensation from the tax it leaves behind.
//
// Amounts here are synthetic. The SHAPES are taken from a real brokerage feed:
// a federal line at the supplemental rate, social security that stops at the
// wage cap, medicare that does not, and a small refund line that credits back.

import { describe, it, expect } from 'vitest';
import {
  detectVests, monthlyNetEquity, isInternalJournal, type WithholdingRow,
} from '../src/core/equity.js';

/** A vest whose gross is `gross`, withheld at the rates a real one uses. */
function vest(date: string, grossCents: number, medicareRate = 0.0145): WithholdingRow[] {
  return [
    { date, name: 'JOURNALED RSU US Federal Incom (Cash)', amountCents: Math.round(grossCents * 0.22) },
    { date, name: 'JOURNALED RSU Social Security (Cash)', amountCents: Math.round(grossCents * 0.062) },
    { date, name: 'JOURNALED RSU Medicare (Cash)', amountCents: Math.round(grossCents * medicareRate) },
  ];
}

describe('detectVests', () => {
  it('sizes a vest from the federal line at the supplemental rate', () => {
    const summary = detectVests(vest('2026-02-10', 2_000_000));

    expect(summary.events).toHaveLength(1);
    expect(summary.events[0]!.grossCents).toBe(2_000_000);
    // 22% + 6.2% + 1.45% = 29.65% withheld.
    expect(summary.events[0]!.withheldCents).toBe(593_000);
    expect(summary.events[0]!.netCents).toBe(1_407_000);
    expect(summary.events[0]!.crossChecked).toBe(true);
  });

  it('still sizes the vest when the Medicare surtax applies', () => {
    // Above the surtax threshold Medicare is 2.35%, so a Medicare-derived
    // estimate reads high. Federal is flat, so the gross stays right — and the
    // disagreement is reported rather than hidden. Observed on real
    // vests; trusting Medicare there overstates by a wide margin.
    const summary = detectVests(vest('2025-11-10', 2_000_000, 0.0235));

    expect(summary.events[0]!.grossCents).toBe(2_000_000);
    expect(summary.events[0]!.crossChecked).toBe(false);
    expect(summary.events[0]!.crossCheckGrossCents).toBeGreaterThan(3_000_000);
  });

  it('nets a refund line against the withholding', () => {
    const rows = [
      ...vest('2026-01-10', 1_000_000),
      { date: '2026-01-10', name: 'JOURNALED RSU Refund (Cash)', amountCents: -20_000 },
    ];
    const summary = detectVests(rows);
    expect(summary.events[0]!.withheldCents).toBe(296_500 - 20_000);
  });

  it('handles social security stopping at the wage cap', () => {
    // Late in the year SS withholding drops to zero while Medicare continues.
    // The federal line is unaffected, so the gross must be unaffected too.
    const rows: WithholdingRow[] = [
      { date: '2025-12-10', name: 'JOURNALED RSU US Federal Incom', amountCents: 220_000 },
      { date: '2025-12-10', name: 'JOURNALED RSU Social Security', amountCents: 0 },
      { date: '2025-12-10', name: 'JOURNALED RSU Medicare', amountCents: 14_500 },
    ];
    expect(detectVests(rows).events[0]!.grossCents).toBe(1_000_000);
  });

  it('groups each date into its own event and totals them', () => {
    const summary = detectVests([...vest('2026-01-10', 1_000_000), ...vest('2026-02-10', 2_000_000)]);
    expect(summary.events).toHaveLength(2);
    expect(summary.grossCents).toBe(3_000_000);
    // Newest first, so a reader sees the most recent vest at the top.
    expect(summary.events[0]!.date).toBe('2026-02-10');
  });

  it('reports a withholding-shaped date it cannot size, rather than dropping it', () => {
    // A broker that labels its federal line differently must not look like a
    // person with no equity. This is the failure this whole module is shaped
    // around: a silent zero is the wrong thing to tell someone sizing a loan.
    const rows: WithholdingRow[] = [
      { date: '2026-03-01', name: 'RSU VEST TAX WITHHOLDING STATE', amountCents: 50_000 },
    ];
    const summary = detectVests(rows);
    expect(summary.events).toEqual([]);
    expect(summary.unsizedDates).toEqual(['2026-03-01']);
  });

  it('ignores ordinary brokerage activity', () => {
    const rows: WithholdingRow[] = [
      { date: '2026-02-01', name: 'Electronic Funds Transfer Paid (Cash)', amountCents: 500_000 },
      { date: '2026-02-02', name: 'ACME CORP - DIVIDEND RECEIVED', amountCents: -432 },
      { date: '2026-02-03', name: 'CASH - TAX WITHHELD CASH', amountCents: 413 },
    ];
    const summary = detectVests(rows);
    expect(summary.events).toEqual([]);
    expect(summary.unsizedDates).toEqual([]);
  });
});

describe('isInternalJournal', () => {
  it('recognises journal entries that never left the broker', () => {
    // These sit in the same cash-movement feed as real bank transfers. Left in,
    // a tax journal of the same size on a nearby date pairs with a genuine
    // transfer and attributes it to the wrong account.
    expect(isInternalJournal('JOURNALED RSU US Federal Incom (Cash)')).toBe(true);
    expect(isInternalJournal('RSU VEST WITHHOLDING')).toBe(true);
  });

  it('leaves real bank transfers alone', () => {
    expect(isInternalJournal('Electronic Funds Transfer Paid (Cash)')).toBe(false);
    expect(isInternalJournal('Electronic Funds Transfer Received (Cash)')).toBe(false);
  });
});

describe('monthlyNetEquity', () => {
  it('spreads net vests across the months covered', () => {
    const summary = detectVests([...vest('2026-01-10', 1_200_000), ...vest('2026-07-10', 1_200_000)]);
    // 2 x 1,200,000 gross, 29.65% withheld -> 844,200 net each,
    // 1,688,400 over 12 months.
    expect(monthlyNetEquity(summary, 12)).toBe(140_700);
  });

  it('is zero when nothing vested', () => {
    expect(monthlyNetEquity(detectVests([]), 12)).toBe(0);
  });

  it('is zero rather than infinite when no months are covered', () => {
    expect(monthlyNetEquity(detectVests(vest('2026-01-10', 1_000_000)), 0)).toBe(0);
  });
});
