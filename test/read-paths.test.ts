// A guard on which table the analysis code reads.
//
// `visible_transactions` picks one row per real transaction and applies
// corrections; `transactions` holds every copy every connection delivered.
// Reading the base table by mistake does not fail — it silently doubles
// whatever it touches, and only where more than one connection feeds an
// account, so it survives every fixture that uses a single one.
//
// Three sites had exactly this defect after the identity rewrite, including
// tagTotals, which turned a $1,200 repair into $2,400. Naming the view's
// columns after the base table's protects against forgetting to resolve an
// override; nothing protects against selecting the wrong table, so this does.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const CORE = join(import.meta.dirname, '..', 'src', 'core');

/**
 * Files allowed to read the base table, and why.
 *
 * Anything else added here needs a reason that survives the question "what
 * happens when two connections feed this account?".
 */
const ALLOWED = new Set([
  // Owns the schema, the writes, and the view itself.
  'ledger.ts',
  // Its job is to see what the view hides — provenance, superseded
  // connections, rows the view rejects. Reading the view would blind it.
  'diagnostics.ts',
  // Writes rows; never aggregates them.
  'sync.ts',
]);

const readsBaseTable = (source: string): string[] =>
  source
    .split('\n')
    .filter((line) => /\b(FROM|JOIN)\s+transactions\b/.test(line))
    // A comment mentioning the table is not a query against it.
    .filter((line) => !/^\s*(\/\/|\*|--)/.test(line.trim()))
    .map((line) => line.trim());

describe('analysis reads the view, not the base table', () => {
  const files = readdirSync(CORE).filter((f) => f.endsWith('.ts'));

  it('has files to check', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it.each(files.filter((f) => !ALLOWED.has(f)))('%s', (file) => {
    const offending = readsBaseTable(readFileSync(join(CORE, file), 'utf8'));
    expect(offending).toEqual([]);
  });

  it('keeps the allow-list honest — every entry must still exist', () => {
    for (const allowed of ALLOWED) expect(files).toContain(allowed);
  });
});
