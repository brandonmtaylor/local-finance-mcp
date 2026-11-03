// Library entry point — a deliberate surface, not everything that happens to
// be exported.
//
// This was eleven `export *` lines, which made all 102 exported symbols across
// those modules public API: `resolveSource`, `upsertTransaction`, every
// internal helper. Each of those is a promise not to change it, and none was a
// promise anyone meant to make — renaming an internal function would have been
// a breaking release.
//
// What is here is what someone outside this package can actually use: write a
// provider, read a ledger, correct a transaction, or embed the sync. Anything
// else remains reachable by deep import for whoever insists, which is the
// conventional way of saying they are on their own.
//
// See docs/writing-a-provider.md for the extension point.

// ── Writing a provider ───────────────────────────────────────────────────────
// A provider maps a data source into these shapes; everything downstream stays
// source-agnostic.
export type {
  Provider,
  ProviderCapabilities,
  ProviderContext,
  ConnectionSync,
  SyncResult,
  LinkResult,
} from './providers/types.js';

export type { IncomingAccount, IncomingTransaction } from './core/ledger.js';

// The canonical category vocabulary a provider maps into, and the spend-group
// classification that decides what counts as spending at all.
export {
  CATEGORIES,
  isCategory,
  spendGroupFor,
  countsAsSpending,
  inferCategory,
  normalizeDescription,
} from './core/normalize.js';
export type { Category, SpendGroup } from './core/normalize.js';

// ── Reading a ledger ─────────────────────────────────────────────────────────
export { openLedger } from './core/ledger.js';
export {
  listAccounts,
  latestBalances,
  queryTransactions,
  getSpendingSummary,
  tagTotals,
  coverageGaps,
  runReadOnlyQuery,
  ledgerIsEmpty,
} from './core/queries.js';
export type {
  AccountSummary,
  LatestBalance,
  SpendingSummary,
  CoverageGap,
} from './core/queries.js';

export { collectInsights } from './core/insights.js';
// Splitting one brokerage merchant into the sub-accounts behind it — the
// difference between money genuinely arriving and your own savings making a
// round trip, which net out to nonsense if left together.
export { attributeTransfers, netByAccount, referenceTokens } from './core/attribution.js';
export type {
  BankTransfer, CashMovement, Attribution, AttributionResult,
} from './core/attribution.js';
export { computeBaseline, applyScenario, maxAffordable } from './core/afford.js';
export { runDiagnostics } from './core/diagnostics.js';
export type { Diagnostic } from './core/diagnostics.js';

// ── Corrections ──────────────────────────────────────────────────────────────
// The only writes a consumer has business making: these record a person's
// decision, where everything else in the write path records a provider's data.
export {
  setCategoryOverride,
  setNote,
  addTag,
  removeTag,
  tagsFor,
  normalizeTag,
} from './core/ledger.js';

// ── Embedding the sync ───────────────────────────────────────────────────────
export { syncAll, backfillProvider } from './core/sync.js';
export type { SyncOutcome } from './core/sync.js';
export { buildProviders } from './providers/registry.js';
export { createCsvProvider } from './providers/csv/index.js';

export { loadConfig, defaultConfig, ConfigSchema } from './core/config.js';
export type { Config } from './core/config.js';
export { financeHome, configPath, ledgerPath } from './core/paths.js';
export { decideFreshness } from './core/freshness.js';
