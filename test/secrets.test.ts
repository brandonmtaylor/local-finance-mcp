// Keystore commands run on the scheduled path, where a hang is permanent:
// launchd will not start the next run while the last is alive. So every one
// is timed, and a timeout must read as a timeout — not as "not set", which
// sends someone to re-enter a credential sitting in a locked keychain.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { runKeystore, readSecret, serviceName } from '../src/core/secrets.js';

describe('runKeystore', () => {
  it('gives up on a command that never answers, and says why', () => {
    const started = Date.now();
    expect(() => runKeystore('sleep', ['5'], {}, 200)).toThrow(/did not answer within 0.2s.*locked or waiting on a prompt/);
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it('passes an ordinary result through', () => {
    const res = runKeystore('sh', ['-c', 'cat; exit 3'], { input: 'x' });
    expect(res.status).toBe(3);
    expect(res.stdout).toBe('x');
  });

  it('is the only way the stores reach a subprocess', () => {
    // A new backend calling spawnSync directly would reintroduce the hang.
    const src = readFileSync(new URL('../src/core/secrets.ts', import.meta.url), 'utf8');
    expect(src.match(/spawnSync\(/g)).toHaveLength(1);
  });
});

describe('readSecret', () => {
  it('prefers the environment, without touching the keystore', () => {
    expect(readSecret('plaid', 'client_id', 'keychain', { FINANCE_PLAID_CLIENT_ID: 'from-env' })).toBe('from-env');
  });
});

describe('one set of keys per data directory', () => {
  it('keeps the existing name for the default directory, so stored keys are still found', () => {
    expect(serviceName('plaid', { ...process.env, FINANCE_HOME: '' })).toBe('finance-mcp.plaid');
  });

  it('gives any other FINANCE_HOME its own, so a test profile cannot replace the real keys', () => {
    // A sandbox secret stored from a test profile used to overwrite the real
    // production one, and the next morning's sync failed.
    const a = serviceName('plaid', { ...process.env, FINANCE_HOME: '/tmp/profile-a' });
    const b = serviceName('plaid', { ...process.env, FINANCE_HOME: '/tmp/profile-b' });
    expect(a).toMatch(/^finance-mcp-[0-9a-f]{8}\.plaid$/);
    expect(a).not.toBe(b);
  });
});
