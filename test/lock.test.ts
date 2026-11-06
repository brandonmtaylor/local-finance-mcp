// The advisory lock, and the way it can wedge permanently.
//
// Two writers are expected: a scheduled sync and an on-demand one. The lock
// serialises them. What makes it worth testing is the failure mode when it
// goes wrong — not an error, but a scheduled job reporting "another sync is
// already running" every morning forever, with no process to point at.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tryAcquireLock } from '../src/core/lock.js';
import { lockPath, financeHome } from '../src/core/paths.js';

let dir: string;
let path: string;
const NOW = Date.parse('2026-08-14T12:00:00.000Z');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lock-'));
  path = join(dir, 'sync.lock');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const writeLock = (pid: number, acquiredAt: string) =>
  writeFileSync(path, JSON.stringify({ pid, acquiredAt, label: 'sync' }));

describe('tryAcquireLock', () => {
  it('acquires when nothing holds it, and releases', () => {
    const held = tryAcquireLock('sync', path, NOW);
    expect(held).not.toBeNull();
    expect(existsSync(path)).toBe(true);

    held!.release();
    expect(existsSync(path)).toBe(false);
  });

  it('refuses while a live process holds it', () => {
    // Our own pid is unambiguously alive.
    writeLock(process.pid, new Date(NOW - 60_000).toISOString());
    expect(tryAcquireLock('sync', path, NOW)).toBeNull();
  });

  it('reclaims a lock whose holder is gone', () => {
    // A pid that cannot exist.
    writeLock(0x7ffffffe, new Date(NOW - 60_000).toISOString());
    expect(tryAcquireLock('sync', path, NOW)).not.toBeNull();
  });

  it('reclaims an OLD lock even when its pid is alive', () => {
    // The failure the age check exists for: pids are recycled, so a killed
    // holder's pid can be taken by an unrelated process, and the lock would
    // otherwise be held forever by something that never touched it.
    writeLock(process.pid, new Date(NOW - 2 * 60 * 60 * 1000).toISOString());
    expect(tryAcquireLock('sync', path, NOW)).not.toBeNull();
  });

  it('does NOT reclaim a lock that is merely a few minutes old', () => {
    // A long backfill must not have its lock stolen mid-run.
    writeLock(process.pid, new Date(NOW - 5 * 60_000).toISOString());
    expect(tryAcquireLock('sync', path, NOW)).toBeNull();
  });

  it('reclaims a lock with an unreadable body', () => {
    writeFileSync(path, 'not json at all');
    expect(tryAcquireLock('sync', path, NOW)).not.toBeNull();
  });

  it('reclaims a lock with an unparseable timestamp', () => {
    // Itself evidence of a bad write, and otherwise held forever.
    writeLock(process.pid, 'whenever');
    expect(tryAcquireLock('sync', path, NOW)).not.toBeNull();
  });

  it('does not delete a lock another process has since reclaimed', () => {
    // Releasing must check ownership, or a reclaimed lock held by a NEW
    // process gets deleted out from under it and two syncs run at once.
    const held = tryAcquireLock('sync', path, NOW)!;
    writeLock(999_999, new Date(NOW).toISOString());   // someone else took it

    held.release();

    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, 'utf8')).pid).toBe(999_999);
  });

  it('is idempotent on release', () => {
    const held = tryAcquireLock('sync', path, NOW)!;
    held.release();
    expect(() => held.release()).not.toThrow();
  });
});

describe('the test harness', () => {
  it('gives every test file its own data directory, so the lock is never shared', () => {
    // Two test files that both call syncAll ran in parallel workers against
    // ONE lock file — the real data directory's, since nothing set
    // FINANCE_HOME — and the loser got null back, failing about one run in
    // five. test/setup-env.ts isolates each file; this keeps it that way.
    const home = process.env.FINANCE_HOME;
    expect(home).toBeTruthy();
    expect(lockPath()).toBe(join(home!, 'sync.lock'));
    expect(home).not.toBe(financeHome({ ...process.env, FINANCE_HOME: '' }));
  });
});
