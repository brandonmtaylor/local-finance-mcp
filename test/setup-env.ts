// Every test file gets its own data directory.
//
// Two reasons, both learned from a failure. The sync lock lives in the data
// directory, and vitest runs files in parallel workers: with one shared
// directory, two files calling `syncAll` at the same moment contended for one
// lock file, the loser got `null` back, and a test failed perhaps one run in
// five with nothing in the test itself to explain it. And with no FINANCE_HOME
// at all, that shared directory was the REAL one — `npm test` on a fresh
// checkout wrote `sync.lock` and `providers/csv/` into the user's live data
// directory.
//
// A per-file temp dir fixes both. Tests that want the default location pass
// `{ ...process.env, FINANCE_HOME: '' }` explicitly.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

const home = mkdtempSync(join(tmpdir(), 'finance-mcp-test-'));
process.env.FINANCE_HOME = home;

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});
