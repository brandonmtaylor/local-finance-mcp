// The provider contract — the extension point of this project.
//
// A provider's only job is to produce records already normalized into the
// canonical shapes in core/ledger.ts. Everything downstream (categories,
// freshness, reports, MCP tools) is provider-agnostic, so adding a data source
// means implementing this interface and nothing else.
//
// See docs/writing-a-provider.md for a worked example.

import type { IncomingAccount, IncomingTransaction } from '../core/ledger.js';
import type { SecretsBackend } from '../core/secrets.js';

export interface ProviderCapabilities {
  transactions: boolean;
  balances: boolean;
  investments: boolean;
  /**
   * True when the provider can fetch on its own (an API). False for sources
   * that need the user to drop a file in (CSV) — the scheduler skips those
   * rather than reporting a failed sync every morning.
   */
  automatic: boolean;
}

export interface ProviderContext {
  /** Stable id for this configured instance, e.g. "csv:checking". */
  providerId: string;
  /** Per-provider scratch dir; created on demand. Never holds secrets. */
  stateDir: string;
  /** IANA timezone from config — for resolving relative date windows. */
  timezone: string;
  /** Read a stored credential. Returns null when unset. */
  getSecret(key: string): string | null;
  secretsBackend?: SecretsBackend;
}

/**
 * What a provider returns for ONE connection.
 *
 * Grouped by connection rather than flat, because that is the unit a provider
 * actually authenticates and cursors against: a Plaid Item, a configured CSV
 * folder. The ledger maps each reported account onto the real account it
 * belongs to — a provider never needs to know that a re-link is a re-link.
 */
export interface ConnectionSync {
  /** The provider's own id for this connection: a Plaid item_id, a CSV key. */
  externalId: string;
  /** Accounts this connection reports, with the provider's ids for them. */
  accounts: IncomingAccount[];
  /** Transactions, each tagged with the account id the provider used. */
  added: Array<IncomingTransaction & { accountExternalId: string }>;
  modified: Array<IncomingTransaction & { accountExternalId: string }>;
  /**
   * Provider transaction ids that no longer exist. Matters more than it looks:
   * a pending transaction is commonly replaced by a posted one under a
   * different id, and without this the ledger keeps both.
   */
  removed: string[];
  balances: Array<{
    accountExternalId: string;
    asOf: string;
    currentCents?: number | null;
    availableCents?: number | null;
    limitCents?: number | null;
  }>;
  /** Opaque resume token for THIS connection. null when there is no cursor. */
  cursor: string | null;
}

/** A provider's whole sync: every connection it manages. */
export interface SyncResult {
  connections: ConnectionSync[];
  /**
   * Connections that could not be read, described for a person.
   *
   * Separate from throwing, because one dead connection must not discard the
   * data the healthy ones just returned — and separate from returning nothing,
   * because a connection that answers with no accounts is indistinguishable
   * from one that has none. Observed: a bank link expired, every daily sync
   * reported success with "+0 added" for ten days, and nothing said otherwise.
   */
  issues?: string[];
}

export interface LinkResult {
  ok: boolean;
  message: string;
  /** Accounts discovered during linking, if the provider reports them. */
  accounts?: IncomingAccount[];
}

export interface Provider {
  /** Instance id — matches ProviderContext.providerId. */
  readonly id: string;
  /** Implementation family: "plaid", "csv", … */
  readonly kind: string;
  readonly capabilities: ProviderCapabilities;

  /**
   * Interactive setup (OAuth, credential capture). Omit when a provider needs
   * only config — the CLI then tells the user to edit config.toml instead.
   */
  link?(ctx: ProviderContext): Promise<LinkResult>;

  /**
   * Fetch everything changed since each connection's cursor.
   *
   * Keyed by the provider's own connection id, because a cursor belongs to one
   * authenticated link — Plaid advances one per Item. A provider with no
   * incremental concept returns the full current view and null cursors; the
   * ledger derives identity from content, so re-reporting a row is safe.
   */
  sync(ctx: ProviderContext, cursors: Readonly<Record<string, string | null>>): Promise<SyncResult>;

  /**
   * Fetch an explicit date range, ignoring any cursor.
   *
   * Implement this whenever the incremental path can advance a cursor the
   * ledger does not control — then a failed sync is recoverable instead of
   * silently skipping the records it consumed. Also serves initial history
   * loads. Must be idempotent: the ledger upserts by id.
   */
  backfill?(ctx: ProviderContext, startDate: string, endDate: string): Promise<SyncResult>;

  /**
   * Wait until a newly created connection's history has actually arrived.
   *
   * Implement this when a provider fetches history ASYNCHRONOUSLY after
   * linking, which Plaid does: a backfill run the instant a link completes
   * returns roughly the last 90 days however much was requested, so the
   * feature looks broken when it is merely early. Measured on a real link —
   * 578 transactions over 90 days moments after, 1203 over two years a few
   * minutes later.
   *
   * Resolves when the count stops growing, or when the deadline passes.
   * Returning `settled: false` means the caller should say the history may
   * still be incomplete rather than report a shortfall as final.
   */
  awaitHistory?(
    ctx: ProviderContext,
    options: { startDate: string; endDate: string; timeoutMs?: number;
               onProgress?: (message: string) => void },
  ): Promise<{ settled: boolean; transactions: number }>;
}

export function emptySyncResult(): SyncResult {
  return { connections: [] };
}

export function emptyConnectionSync(externalId: string): ConnectionSync {
  return { externalId, accounts: [], added: [], modified: [], removed: [], balances: [], cursor: null };
}
