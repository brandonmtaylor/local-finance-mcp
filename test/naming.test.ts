// Three identifiers keep the OLD name after the package was renamed, and each
// one breaks an existing installation if it changes. A future reader tidying
// up the inconsistency would be doing real damage, so this states which is
// which and why.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { financeHome } from '../src/core/paths.js';

const src = (p: string) => readFileSync(join(import.meta.dirname, '..', 'src', p), 'utf8');

describe('identifiers that carry existing user state', () => {
  it('keeps the data directory, or every existing ledger is orphaned', () => {
    // On upgrade the tool would come up empty and behave exactly like a fresh
    // install — the worst available failure, because nothing looks broken.
    expect(financeHome()).toMatch(/finance-mcp$/);
    expect(financeHome()).not.toMatch(/local-finance-mcp$/);
  });

  it('keeps the keychain service name, or every credential goes invisible', () => {
    // They stay in the keystore under the old name: nothing is lost, nothing
    // works, and there is no error that says so.
    expect(src('core/secrets.ts')).toContain("const SERVICE_PREFIX = 'finance-mcp'");
  });

  it('keeps the scheduler label, or a second agent installs beside the first', () => {
    // Two syncs, two reports, two emails every morning — while `schedule
    // uninstall` looks for the new label and leaves the old one running.
    expect(src('core/schedule.ts')).toContain("const LABEL = 'com.finance-mcp.sync'");
  });
});

describe('identifiers that are only ever displayed', () => {
  it('uses the package name where a person reads it', () => {
    expect(src('mcp.ts')).toContain("name: 'local-finance-mcp'");
    // Shown to the user inside Plaid's own link UI.
    expect(src('providers/plaid/api.ts')).toContain("clientName ?? 'local-finance-mcp'");
  });
});
