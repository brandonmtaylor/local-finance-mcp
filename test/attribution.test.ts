// Attributing bank transfers to brokerage sub-accounts.
//
// Descriptions here are synthetic. The real ones carry account numbers, which
// is the whole reason the mapping is learned at runtime rather than written
// down: nothing in this repository may know a specific reference code.

import { describe, it, expect } from 'vitest';
import {
  attributeTransfers, netByAccount, referenceTokens,
  type BankTransfer, type CashMovement,
} from '../src/core/attribution.js';

const INDIVIDUAL = { accountId: 'acct_ind', accountName: 'Individual' };
const JOINT = { accountId: 'acct_joint', accountName: 'Joint' };

function transfer(txnId: string, date: string, amountCents: number, ref: string): BankTransfer {
  return { txnId, date, amountCents, description: `BROKER SVC LLC MONEYLINE 010203 ${ref}` };
}
function movement(date: string, amountCents: number, a: typeof INDIVIDUAL): CashMovement {
  return { date, amountCents, ...a };
}

describe('referenceTokens', () => {
  it('takes alphanumeric references and leaves words and dates alone', () => {
    expect(referenceTokens('BROKER SVC LLC MONEYLINE 010203 A123456789'))
      .toEqual(['A123456789']);
  });

  it('rejects a six-digit posting date, which would otherwise look like a reference', () => {
    // The trap: `010203` is six characters and passes a naive length check.
    expect(referenceTokens('SOME TRANSFER 010203')).toEqual([]);
  });

  it('accepts a long all-digit reference', () => {
    expect(referenceTokens('TRANSFER TO 12345678')).toEqual(['12345678']);
  });
});

describe('attributeTransfers', () => {
  it('matches on same date and signed amount', () => {
    const transfers = [transfer('t1', '2026-03-02', 111_100, 'BBBB0001A')];
    const movements = [movement('2026-03-02', 111_100, JOINT)];

    const result = attributeTransfers(transfers, movements);
    expect(result.attributions).toEqual([
      { txnId: 't1', accountId: 'acct_joint', accountName: 'Joint', basis: 'matched', dayGap: 0 },
    ]);
  });

  it('matches money leaving the bank as well as money arriving', () => {
    // Signs agree on both sides, so an outbound transfer needs no special case.
    const transfers = [transfer('t1', '2026-03-03', -222_200, 'BBBB0001B')];
    const result = attributeTransfers(transfers, [movement('2026-03-03', -222_200, JOINT)]);
    expect(result.attributions[0]?.accountId).toBe('acct_joint');
  });

  it('tolerates a weekend settle but not an arbitrary gap', () => {
    const near = attributeTransfers(
      [transfer('t1', '2026-03-09', 50_000, 'BBBB0001C')],
      [movement('2026-03-06', 50_000, JOINT)],
    );
    expect(near.attributions[0]?.dayGap).toBe(3);

    const far = attributeTransfers(
      [transfer('t1', '2026-03-12', 50_000, 'BBBB0001C')],
      [movement('2026-03-06', 50_000, JOINT)],
    );
    expect(far.attributions).toEqual([]);
    expect(far.unattributed).toHaveLength(1);
  });

  it('consumes one movement per transfer when several share an amount and date', () => {
    // Three $500 transfers must not all match the same single movement and
    // claim three rows of evidence from one.
    const transfers = [
      transfer('t1', '2026-03-07', -50_000, 'A1112223'),
      transfer('t2', '2026-03-07', -50_000, 'B1112223'),
      transfer('t3', '2026-03-07', -50_000, 'C1112223'),
    ];
    const result = attributeTransfers(transfers, [movement('2026-03-07', -50_000, JOINT)]);

    expect(result.attributions).toHaveLength(1);
    expect(result.unattributed).toHaveLength(2);
  });

  it('learns a reference prefix and applies it outside the brokerage window', () => {
    // Two matched rows for Individual establish the prefix; the third transfer
    // predates the brokerage feed and is attributed from the description alone.
    const transfers = [
      transfer('t1', '2025-06-04', 333_300, 'AAAA0002XX'),
      transfer('t2', '2025-06-05', 444_400, 'AAAA0002YY'),
      transfer('old', '2024-02-06', 555_500, 'AAAA0002ZZ'),
    ];
    const movements = [
      movement('2025-06-04', 333_300, INDIVIDUAL),
      movement('2025-06-05', 444_400, INDIVIDUAL),
    ];

    const result = attributeTransfers(transfers, movements);
    const old = result.attributions.find((a) => a.txnId === 'old');
    expect(old).toMatchObject({ accountId: 'acct_ind', basis: 'inferred' });
    expect(result.learned).toEqual([
      { prefix: 'AAAA0002', accountId: 'acct_ind', accountName: 'Individual', from: 2 },
    ]);
  });

  it('refuses to learn from a single row', () => {
    // One row leaves the transaction-specific suffix in the prefix, which would
    // match nothing and quietly look like a working rule.
    const result = attributeTransfers(
      [transfer('t1', '2025-06-04', 333_300, 'AAAA0002XX'),
        transfer('old', '2024-02-06', 555_500, 'AAAA0002ZZ')],
      [movement('2025-06-04', 333_300, INDIVIDUAL)],
    );
    expect(result.learned).toEqual([]);
    expect(result.unattributed.map((t) => t.txnId)).toEqual(['old']);
  });

  it('drops a prefix that cannot decide between two accounts', () => {
    // Both accounts share a leading run, so neither prefix is evidence.
    const transfers = [
      transfer('a1', '2026-01-01', 100, 'SHARED111'),
      transfer('a2', '2026-01-02', 200, 'SHARED112'),
      transfer('b1', '2026-01-03', 300, 'SHARED221'),
      transfer('b2', '2026-01-04', 400, 'SHARED222'),
      transfer('later', '2026-02-01', 900, 'SHARED999'),
    ];
    const movements = [
      movement('2026-01-01', 100, INDIVIDUAL), movement('2026-01-02', 200, INDIVIDUAL),
      movement('2026-01-03', 300, JOINT), movement('2026-01-04', 400, JOINT),
    ];

    const result = attributeTransfers(transfers, movements);
    // SHARED11 and SHARED22 are distinct, so both survive — but neither
    // prefixes 'SHARED999', which stays unattributed rather than guessed.
    expect(result.unattributed.map((t) => t.txnId)).toEqual(['later']);
  });

  it('leaves an ambiguous description unattributed rather than picking one', () => {
    const transfers = [
      transfer('a1', '2026-01-01', 100, 'AAA1111'),
      transfer('a2', '2026-01-02', 200, 'AAA1112'),
      transfer('b1', '2026-01-03', 300, 'BBB2221'),
      transfer('b2', '2026-01-04', 400, 'BBB2222'),
      { txnId: 'both', date: '2026-02-01', amountCents: 900,
        description: 'TRANSFER AAA1113 BBB2223' },
    ];
    const movements = [
      movement('2026-01-01', 100, INDIVIDUAL), movement('2026-01-02', 200, INDIVIDUAL),
      movement('2026-01-03', 300, JOINT), movement('2026-01-04', 400, JOINT),
    ];

    const result = attributeTransfers(transfers, movements);
    expect(result.unattributed.map((t) => t.txnId)).toEqual(['both']);
  });
});

describe('netByAccount', () => {
  it('nets inbound against outbound per account', () => {
    const transfers = [
      transfer('t1', '2026-03-02', 111_100, 'BBBB0001A'),
      transfer('t2', '2026-03-03', -222_200, 'BBBB0001B'),
      transfer('t3', '2025-06-04', 333_300, 'AAAA0002P'),
      transfer('t4', '2025-06-05', 444_400, 'AAAA0002Q'),
    ];
    const movements = [
      movement('2026-03-02', 111_100, JOINT), movement('2026-03-03', -222_200, JOINT),
      movement('2025-06-04', 333_300, INDIVIDUAL), movement('2025-06-05', 444_400, INDIVIDUAL),
    ];

    const net = netByAccount(transfers, attributeTransfers(transfers, movements));
    expect(net).toEqual([
      { accountId: 'acct_ind', accountName: 'Individual', netCents: 777_700, count: 2 },
      { accountId: 'acct_joint', accountName: 'Joint', netCents: -111_100, count: 2 },
    ]);
  });
});
