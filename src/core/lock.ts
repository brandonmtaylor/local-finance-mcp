// Advisory lock around sync.
//
// Two writers are expected by design: a scheduled sync (launchd/systemd) and an
// on-demand sync triggered by a read. WAL handles concurrent SQLite access, but
// it does not stop two syncs hitting a provider's API at once and racing on the
// same cursor. This serializes them.
//
// Uses O_EXCL file creation, which is atomic on every platform we target. Stale
// locks (holder killed) are reclaimed by checking whether the recorded pid is
// still alive.

import { openSync, closeSync, readFileSync, unlinkSync, writeSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { lockPath } from './paths.js';

export interface LockHandle {
  release(): void;
}

interface LockFileContents {
  pid: number;
  acquiredAt: string;
  label: string;
}

function isProcessAlive(pid: number): boolean {
  try {
    // Signal 0 performs the permission/existence check without delivering.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readLock(path: string): LockFileContents | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as LockFileContents;
  } catch {
    return null;
  }
}

/**
 * Try to acquire the sync lock. Returns null if another live process holds it —
 * callers should skip rather than queue, since a sync already in flight will
 * produce the same freshness the caller wanted.
 */
/**
 * How old a lock may be before it is reclaimed regardless of its pid.
 *
 * The pid check alone is not enough, because pids are RECYCLED. A holder that
 * is SIGKILLed leaves its file behind; if an unrelated process later happens to
 * take that pid, `isProcessAlive` answers true forever and the lock is never
 * reclaimed — a scheduled sync reporting "another sync is already running"
 * every morning, silently, with no process to point at.
 *
 * An hour is far longer than any sync this project performs (the largest
 * observed is a two-year backfill of a couple of thousand transactions, in seconds) and far
 * shorter than the interval at which anyone would notice the job had stopped.
 */
const MAX_LOCK_AGE_MS = 60 * 60 * 1000;

function isStale(existing: LockFileContents, now: number): boolean {
  if (!isProcessAlive(existing.pid)) return true;
  const age = now - Date.parse(existing.acquiredAt);
  // An unparseable timestamp is itself evidence of a bad write.
  return !Number.isFinite(age) || age > MAX_LOCK_AGE_MS;
}

export function tryAcquireLock(
  label = 'sync',
  path = lockPath(),
  now = Date.now(),
): LockHandle | null {
  mkdirSync(dirname(path), { recursive: true });

  const attempt = (): number | null => {
    try {
      return openSync(path, 'wx');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return null;
      throw err;
    }
  };

  let fd = attempt();

  if (fd === null) {
    const existing = readLock(path);
    // No readable contents, the holder is gone, or the lock is older than any
    // sync could plausibly be. A lock file with an unparseable body is almost
    // always a crash mid-write.
    if (existing === null || isStale(existing, now)) {
      try {
        unlinkSync(path);
      } catch {
        // Someone else reclaimed it first; fall through and fail to acquire.
      }
      fd = attempt();
    }
    if (fd === null) return null;
  }

  const contents: LockFileContents = {
    pid: process.pid,
    acquiredAt: new Date().toISOString(),
    label,
  };
  writeSync(fd, JSON.stringify(contents));
  closeSync(fd);

  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      // Only remove the lock if it is still OURS — otherwise a reclaimed lock
      // held by a new process would be deleted out from under it.
      const current = readLock(path);
      if (current?.pid === process.pid) {
        try {
          unlinkSync(path);
        } catch {
          // Already gone. Nothing to do.
        }
      }
    },
  };
}

/** Run `fn` under the lock. Returns null without running if the lock is held. */
export async function withLock<T>(
  label: string,
  fn: () => Promise<T>,
  path = lockPath(),
): Promise<T | null> {
  const handle = tryAcquireLock(label, path);
  if (!handle) return null;
  try {
    return await fn();
  } finally {
    handle.release();
  }
}
