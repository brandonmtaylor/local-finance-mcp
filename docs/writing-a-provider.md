# Writing a provider

A provider's only job is to turn some data source into normalized ledger records. Everything
downstream — categories, freshness, reports, the MCP tools — is provider-agnostic, so this is the
only interface you implement.

## The interface

```ts
import type { Provider, ProviderContext, SyncResult } from 'local-finance-mcp/providers';

export interface Provider {
  readonly id: string;      // instance id, e.g. "simplefin"
  readonly kind: string;    // implementation family
  readonly capabilities: {
    transactions: boolean;
    balances: boolean;
    investments: boolean;
    automatic: boolean;     // false = needs a human to drop a file in
  };

  link?(ctx: ProviderContext): Promise<LinkResult>;
  // Cursors keyed by YOUR connection ids — see below.
  sync(ctx: ProviderContext, cursors: Record<string, string | null>): Promise<SyncResult>;
}
```

`sync` returns results grouped by **connection**:

```ts
interface SyncResult {
  connections: ConnectionSync[];
}

interface ConnectionSync {
  externalId: string;       // YOUR id for this connection: a Plaid item_id, a folder key
  accounts: IncomingAccount[];
  added: Array<IncomingTransaction & { accountExternalId: string }>;
  modified: Array<IncomingTransaction & { accountExternalId: string }>;
  removed: string[];        // your transaction ids
  balances: Array<{ accountExternalId: string; asOf: string; /* … */ }>;
  cursor: string | null;    // for THIS connection
}
```

A **connection** is one authenticated link — a Plaid Item, a configured CSV folder — and it is the
unit a cursor belongs to. Grouping by it is not bookkeeping: Plaid advances one cursor per Item
while an Item reports several accounts, and a single cursor per provider fits neither. If your
source has no incremental concept, return the full current view in `added` with a `null` cursor.

## You never handle identity

The ids you supply — `externalId` on an account, on a transaction, on a connection — are **yours**,
and the ledger treats them as scoped to your connection. It mints its own ids from the CONTENT of a
transaction, and matches an account you report to a real account it may already know from an earlier
connection.

That means **a re-link is not your problem.** When a user re-authenticates and your API hands back
entirely new ids for the same accounts, report them exactly as you receive them. The ledger
recognises them, attaches them to the accounts it already has, and does not duplicate a thing. You
should never try to reuse an old id, reconcile against previous state, or detect that a re-link
happened.

Report what you see. The ledger decides what it means.

## The five things that will bite you

### 1. The sign convention

**Positive is money IN. Negative is money OUT.** Normalize to this in your adapter.

Plaid, for example, uses the opposite convention (positive = outflow), so a Plaid adapter negates on
the way in. Getting this wrong doesn't crash anything — it silently inverts every report in the
project. Assert it in a test.

### 2. Money is integer cents

Never floats. `19.99 * 100` is `1998.9999999999998` in IEEE754, and those errors accumulate across a
year of transactions. Parse as fixed-point:

```ts
const [whole, frac = ''] = raw.split('.');
const cents = Number(whole) * 100 + Number((frac + '00').slice(0, 2));
```

### 3. Transaction ids must be stable

The ledger's idempotency depends entirely on `txnId` being the same across syncs for the same
transaction. If your source provides stable ids, use them.

If it doesn't (a CSV), derive identity from content — and include an **occurrence index**, or two
identical $4 coffees on the same day collapse into one row and a transaction silently disappears.
See `src/providers/csv/parse.ts` for a worked implementation.

### 4. `removed` matters more than it looks

A pending transaction is commonly replaced by a posted one with a *different* id. Without reporting
the old id in `removed`, the ledger keeps both and every total is wrong by that amount.

If your source genuinely can't express deletion (a CSV export covering one month says nothing about
another), return an empty array — absence is not deletion.

### 5. If you don't own the cursor, implement `backfill`

This one cost real data during development and is worth reading twice.

If your source advances an incremental cursor that lives somewhere you don't control — a vendor CLI,
a hosted service — then it advances the moment *their* call succeeds. If your adapter then fails
while mapping or writing, those records are gone from every future `sync`. Not delayed. Gone.

That is exactly what happened wrapping the Plaid CLI: a foreign-key error after a successful fetch
silently consumed 50 transactions.

The fix is a date-range path that ignores cursors entirely:

```ts
async backfill(ctx, startDate, endDate): Promise<SyncResult> {
  // ... fetch by date range, return cursor: null
}
```

Return `cursor: null` (a range fetch says nothing about where the stream resumes) and
`removed: []` (absence from a range says nothing about deletion). Users reach it via
`finance backfill --since 2026-01-01`.

Also: **validate before you write.** If your transactions reference accounts your `accounts` array
doesn't include, throw with a message naming them. The ledger's foreign key will reject them anyway,
but `FOREIGN KEY constraint failed` tells the user nothing.

### 6. Map into the canonical category set

`src/core/normalize.ts` owns the vocabulary. Map your source's taxonomy onto it rather than
inventing categories, or cross-provider reports break.

The one classification that carries real weight is `spend_group`. Credit-card payments and loan
payments must land in `payments`, and inter-account movement in `transfers` — those are excluded
from spending totals. If a card payment is classified as a purchase, linking both a card and the
account that pays it double-counts every purchase on that card.

Set `categorySource` honestly: `'provider'` when the source told you, `'inferred'` when you guessed.
Never touch `annotations` — corrections belong to the user and must survive your syncs. The sync
engine only ever writes your side of a row, so there is nothing to do here except not reach around it.

## Credentials

Read them through the context; never take them from config:

```ts
const token = ctx.getSecret('access_token');
```

That resolves the OS keystore with an env-var override. Don't log them, don't return them in
`SyncResult`, and don't write them to `ctx.stateDir`.

## Registering it

Add a case in `src/providers/registry.ts` and a config section in `src/core/config.ts`. That's it —
nothing else in the project needs to change.

```ts
if (config.providers.mine.enabled) {
  providers.push(createMyProvider({ id: 'mine', ...config.providers.mine }));
}
```

## Testing

Test the adapter's mapping directly, without network access, using committed fixtures — that's the
whole reason the CSV provider exists and is worth copying as a pattern.

At minimum, assert:

- money-in is positive and money-out is negative
- re-running `sync` over the same input produces identical ids (idempotency)
- a credit-card payment classifies as `payments` and is excluded from a spending total
- a malformed record is reported rather than silently dropped

`test/csv-provider.test.ts` covers all four and is a reasonable template.
