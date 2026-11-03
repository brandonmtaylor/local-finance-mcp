// The published surface, pinned.
//
// index.ts was eleven `export *` lines, which made 102 symbols public API —
// including resolveSource, upsertTransaction and every internal helper. Each
// was a promise not to change it, and none was meant. This test exists so the
// surface is a decision rather than an accident: adding to it should require
// editing this list and thinking about the commitment.

import { describe, it, expect } from 'vitest';
import * as api from '../src/index.js';

/** Everything a consumer may rely on. Adding here is a versioning decision. */
const SURFACE = [
  // provider contract
  'CATEGORIES', 'isCategory', 'spendGroupFor', 'countsAsSpending',
  'inferCategory', 'normalizeDescription',
  // reading
  'openLedger', 'listAccounts', 'latestBalances', 'queryTransactions',
  'getSpendingSummary', 'tagTotals', 'coverageGaps', 'runReadOnlyQuery',
  'ledgerIsEmpty', 'collectInsights', 'computeBaseline', 'applyScenario',
  'attributeTransfers', 'netByAccount', 'referenceTokens',
  'maxAffordable', 'runDiagnostics',
  // corrections
  'setCategoryOverride', 'setNote', 'addTag', 'removeTag', 'tagsFor', 'normalizeTag',
  // embedding
  'syncAll', 'backfillProvider', 'buildProviders', 'createCsvProvider',
  'loadConfig', 'defaultConfig', 'ConfigSchema',
  'financeHome', 'configPath', 'ledgerPath', 'decideFreshness',
].sort();

describe('the published API', () => {
  it('exports exactly what it means to', () => {
    expect(Object.keys(api).sort()).toEqual(SURFACE);
  });

  it('does NOT expose the ledger write path', () => {
    // A consumer writing transactions directly would bypass identity
    // derivation, which is the one thing this project cannot allow to be
    // bypassed — it is where deduplication comes from.
    for (const internal of ['resolveSource', 'resolveConnection', 'upsertTransaction',
      'upsertProvider', 'setConnectionActive', 'removeTransaction']) {
      expect(api).not.toHaveProperty(internal);
    }
  });

  it('does NOT expose secrets or locking', () => {
    // Credential handling is not a library feature. Nothing outside this
    // package should be reading the keystore through it.
    for (const internal of ['getSecretsStore', 'readSecret', 'withLock']) {
      expect(api).not.toHaveProperty(internal);
    }
  });

  it('keeps corrections available, because they are a person\'s decisions', () => {
    // The counterpart to hiding the write path: what a USER decided must stay
    // reachable, or an embedder cannot offer categorisation at all.
    expect(typeof api.setCategoryOverride).toBe('function');
    expect(typeof api.addTag).toBe('function');
  });
});
