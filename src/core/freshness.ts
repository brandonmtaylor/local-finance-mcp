// Sync-on-read policy.
//
// MCP is request/response: a server cannot push work to the model, and there is
// no reliable way to make an agent "remember" to sync. So freshness is decided
// HERE, inside the read path, from config — not by the model's judgment. The
// same rule then applies identically from Claude Code, remote control, a phone,
// or a cron job.
//
// The defaults encode a billing asymmetry worth understanding: transaction
// syncs are typically subscription-priced (flat monthly per linked account), so
// refreshing them is effectively free. Balance lookups are often billed per
// call, so they are cached hard.

import type { FreshnessConfig } from './config.js';

export type ReadKind = 'balances' | 'transactions';

export interface FreshnessQuery {
  kind: ReadKind;
  /** Last sync for the provider(s) this read touches; null = never synced. */
  lastSyncAt: Date | null;
  /**
   * End of the window being queried (YYYY-MM-DD). Omit for open-ended or
   * "current" reads. A window that closed long ago can never change, so it
   * never justifies a sync.
   */
  windowEnd?: string;
  now?: Date;
}

export type FreshnessDecision =
  | { sync: false; reason: string }
  | { sync: true; blocking: boolean; reason: string };

const DAY_MS = 86_400_000;

function daysBetween(from: Date, toYmd: string): number {
  const to = Date.parse(`${toYmd}T00:00:00Z`);
  if (Number.isNaN(to)) return 0;
  const fromUtc = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  return Math.floor((fromUtc - to) / DAY_MS);
}

/**
 * Decide whether a read should sync first.
 *
 * Order matters: the settled-window check runs before the staleness check, so a
 * question about last quarter stays instant no matter how stale the provider is.
 */
export function decideFreshness(
  query: FreshnessQuery,
  config: FreshnessConfig,
): FreshnessDecision {
  const now = query.now ?? new Date();

  // Never synced — there is nothing to serve, so this one is always blocking
  // regardless of window. Checked first: an empty ledger can't answer anything.
  if (query.lastSyncAt === null) {
    return { sync: true, blocking: true, reason: 'no sync has ever run' };
  }

  // Settled history can't change. Most budget questions land here.
  if (query.kind === 'transactions' && query.windowEnd) {
    const age = daysBetween(now, query.windowEnd);
    if (age > config.settledAfterDays) {
      return { sync: false, reason: `window closed ${age}d ago (settled)` };
    }
  }

  const ageMs = now.getTime() - query.lastSyncAt.getTime();
  const ttlMs = query.kind === 'balances'
    ? config.balanceTtlMinutes * 60_000
    : config.transactionTtlHours * 3_600_000;

  if (ageMs <= ttlMs) {
    return { sync: false, reason: `last synced ${Math.round(ageMs / 60_000)}m ago` };
  }

  // Stale-while-revalidate never applies to balances: serving a stale balance as
  // if it were current is materially misleading in a way stale spending is not.
  const blocking = query.kind === 'balances' ? true : !config.staleWhileRevalidate;
  return {
    sync: true,
    blocking,
    reason: `stale (${Math.round(ageMs / 60_000)}m old, ttl ${Math.round(ttlMs / 60_000)}m)`,
  };
}
