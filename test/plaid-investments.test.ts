// Investment activity fetching.
//
// Every test injects a fetcher; none reach the network.
//
// The paging tests are the point of this file. A real two-year brokerage window
// returned 508 rows against a 500-per-call API maximum, so the un-paged version
// dropped eight — and reported success. Cash movements are what bank transfers
// reconcile against, so eight missing rows is eight transfers that silently
// cannot be attributed to the account they came from.

import { describe, it, expect } from 'vitest';
import { probeInvestments, type Fetcher } from '../src/providers/plaid/api.js';

const credentials = { clientId: 'cid', secret: 'sec', environment: 'production' as const };

function row(i: number) {
  return {
    date: '2026-01-01', name: `txn ${i}`, amount: i,
    type: 'cash', subtype: 'withdrawal' as string | null,
  };
}

/** Serves `total` rows across as many pages as the caller's count/offset ask for. */
function pagedFetch(total: number) {
  const calls: Array<{ count: number; offset: number }> = [];
  const fetcher: Fetcher = async (_url, init) => {
    const body = JSON.parse(init.body) as { options?: { count?: number; offset?: number } };
    const count = body.options?.count ?? 100;
    const offset = body.options?.offset ?? 0;
    calls.push({ count, offset });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        accounts: [{ account_id: 'acct_1', name: 'Individual', type: 'investment', subtype: 'brokerage' }],
        investment_transactions: Array.from(
          { length: Math.max(0, Math.min(count, total - offset)) },
          (_, k) => row(offset + k),
        ),
        total_investment_transactions: total,
      }),
    };
  };
  return { fetcher, calls };
}

describe('probeInvestments paging', () => {
  it('fetches every row when the total exceeds one page', async () => {
    const { fetcher, calls } = pagedFetch(508);
    const probe = await probeInvestments(credentials, 'tok', '2024-08-14', '2026-08-14', fetcher);

    // The regression: 500 here meant eight rows vanished without a word.
    expect(probe.transactions).toHaveLength(508);
    expect(probe.total).toBe(508);
    expect(calls).toEqual([{ count: 500, offset: 0 }, { count: 500, offset: 500 }]);
  });

  it('makes exactly one call when everything fits on a page', async () => {
    const { fetcher, calls } = pagedFetch(245);
    const probe = await probeInvestments(credentials, 'tok', '2025-08-14', '2026-08-14', fetcher);

    expect(probe.transactions).toHaveLength(245);
    expect(calls).toHaveLength(1);
  });

  it('reports accounts once rather than once per page', async () => {
    const { fetcher } = pagedFetch(1200);
    const probe = await probeInvestments(credentials, 'tok', '2024-08-14', '2026-08-14', fetcher);

    expect(probe.transactions).toHaveLength(1200);
    expect(probe.accounts).toEqual([
      { accountId: 'acct_1', name: 'Individual', type: 'investment', subtype: 'brokerage' },
    ]);
  });

  it('stops on a short page even when the total says otherwise', async () => {
    // A total that overstates what the endpoint will actually serve must not
    // spin forever: the short page is the authority on when to stop.
    let served = 0;
    const fetcher: Fetcher = async () => ({
      ok: true,
      status: 200,
      json: async () => {
        const page = served === 0 ? 500 : 3;
        served += 1;
        return {
          accounts: [],
          investment_transactions: Array.from({ length: page }, (_, k) => row(k)),
          total_investment_transactions: 99_999,
        };
      },
    });

    const probe = await probeInvestments(credentials, 'tok', '2024-01-01', '2026-01-01', fetcher);
    expect(probe.transactions).toHaveLength(503);
  });

  it('handles an empty window without calling twice', async () => {
    const { fetcher, calls } = pagedFetch(0);
    const probe = await probeInvestments(credentials, 'tok', '2026-08-01', '2026-08-02', fetcher);

    expect(probe.transactions).toEqual([]);
    expect(calls).toHaveLength(1);
  });
});
