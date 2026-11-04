// Credential storage.
//
// Two rules shape this file:
//   1. Secrets never touch a config file or the ledger. They live in the OS
//      keystore, and are read into a child process's environment only for the
//      moment a provider needs them.
//   2. Secrets are never logged, echoed, or returned through an MCP tool. The
//      agent can trigger a sync; it cannot read what authenticates that sync.
//
// Rule 2 is a guardrail, not a sandbox — anything with arbitrary shell access
// could work around it. Its real value is keeping credentials out of transcripts
// and session logs, which is the realistic leak path for an agent-driven tool.

import { spawnSync, type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns } from 'node:child_process';
import { platform } from 'node:os';
import { homeSuffix } from './paths.js';

export type SecretsBackend = 'keychain' | 'secret-service' | 'dpapi' | 'env';

/** Namespace for stored items, so uninstalling can find everything we created. */
// The keychain service name, deliberately still `finance-mcp` after the
// package was renamed. Changing it makes every stored credential invisible —
// they remain in the keystore under the old name, so nothing is lost and
// nothing works, which is hard to diagnose from the outside.
const SERVICE_PREFIX = 'finance-mcp';

export function defaultBackend(): SecretsBackend {
  switch (platform()) {
    case 'darwin': return 'keychain';
    case 'win32': return 'dpapi';
    case 'linux': return 'secret-service';
    default: return 'env';
  }
}

// Per data directory, like the scheduled job: the keystore is shared by every
// FINANCE_HOME, so without this a test profile's keys replace the real ones.
// The default directory keeps the bare prefix, so stored keys are still found.
const prefix = (env: NodeJS.ProcessEnv = process.env) => `${SERVICE_PREFIX}${homeSuffix(env)}`;

/** The keystore service a provider's secrets are stored under, for this data directory. */
export function serviceName(providerId: string, env: NodeJS.ProcessEnv = process.env): string {
  return `${prefix(env)}.${providerId}`;
}

/**
 * How long a keystore command may take. Generous — an unlock prompt answered by
 * a person takes seconds — but finite. Without it a keychain waiting on a
 * dialog nobody will see (a LaunchAgent has no one watching) blocks `finance
 * run` forever, and launchd will not start the next run while it lives.
 */
export const KEYSTORE_TIMEOUT_MS = 30_000;

/**
 * Run a keystore command with a timeout, and fail loudly when it hangs.
 *
 * A timeout must not look like "not set": that sends someone to re-enter a
 * credential that is sitting in a locked keychain.
 */
export function runKeystore(
  command: string,
  args: string[],
  opts: Omit<SpawnSyncOptionsWithStringEncoding, 'encoding'> = {},
  timeoutMs = KEYSTORE_TIMEOUT_MS,
): SpawnSyncReturns<string> {
  const res = spawnSync(command, args, { ...opts, encoding: 'utf8', timeout: timeoutMs });
  if ((res.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT') {
    throw new Error(
      `${command} did not answer within ${timeoutMs / 1000}s — the keystore may be `
      + 'locked or waiting on a prompt. Unlock it, or use the env backend for unattended runs.',
    );
  }
  return res;
}

/** Env var a secret falls back to, e.g. FINANCE_PLAID_CLIENT_ID. */
export function envVarFor(providerId: string, key: string): string {
  const norm = (s: string) => s.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase();
  return `FINANCE_${norm(providerId)}_${norm(key)}`;
}

export interface SecretsStore {
  readonly backend: SecretsBackend;
  get(providerId: string, key: string): string | null;
  set(providerId: string, key: string, value: string): void;
  delete(providerId: string, key: string): void;
}

// ── macOS Keychain ───────────────────────────────────────────────────────────

const keychainStore: SecretsStore = {
  backend: 'keychain',
  get(providerId, key) {
    const res = runKeystore('security', [
      'find-generic-password', '-s', serviceName(providerId), '-a', key, '-w',
    ]);
    if (res.status !== 0) return null;
    // -w prints the raw secret plus a trailing newline.
    return res.stdout.replace(/\n$/, '');
  },
  set(providerId, key, value) {
    // -U updates in place if the item exists. Value goes via argv here; the CLI
    // reads it from a prompt rather than a shell argument so it never lands in
    // shell history.
    const res = runKeystore('security', [
      'add-generic-password', '-s', serviceName(providerId), '-a', key, '-w', value, '-U',
    ]);
    if (res.status !== 0) {
      throw new Error(`keychain write failed: ${res.stderr.trim() || `exit ${res.status}`}`);
    }
  },
  delete(providerId, key) {
    runKeystore('security', [
      'delete-generic-password', '-s', serviceName(providerId), '-a', key,
    ]);
  },
};

// ── Linux secret-service (libsecret) ─────────────────────────────────────────

const secretServiceStore: SecretsStore = {
  backend: 'secret-service',
  get(providerId, key) {
    const res = runKeystore('secret-tool', [
      'lookup', 'service', serviceName(providerId), 'account', key,
    ]);
    if (res.status !== 0 || !res.stdout) return null;
    return res.stdout.replace(/\n$/, '');
  },
  set(providerId, key, value) {
    const res = runKeystore('secret-tool', [
      'store', '--label', `${serviceName(providerId)}:${key}`,
      'service', serviceName(providerId), 'account', key,
    ], { input: value });
    if (res.status !== 0) {
      throw new Error(
        `secret-tool write failed: ${res.stderr.trim() || `exit ${res.status}`}. ` +
        'Install libsecret-tools, or set secretsBackend = "env".',
      );
    }
  },
  delete(providerId, key) {
    runKeystore('secret-tool', ['clear', 'service', serviceName(providerId), 'account', key]);
  },
};

// ── Windows DPAPI via PowerShell ─────────────────────────────────────────────
//
// No native module: a tiny PowerShell shim encrypts to the current user with
// DPAPI and stores the ciphertext under the user profile.

const dpapiStore: SecretsStore = {
  backend: 'dpapi',
  get(providerId, key) {
    const script = `
      $p = Join-Path $env:APPDATA '${prefix()}\\secrets\\${providerId}.${key}.dat'
      if (!(Test-Path $p)) { exit 1 }
      $sec = Get-Content $p | ConvertTo-SecureString
      [Runtime.InteropServices.Marshal]::PtrToStringAuto(
        [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))`;
    const res = runKeystore('powershell', ['-NoProfile', '-Command', script]);
    if (res.status !== 0) return null;
    return res.stdout.replace(/\r?\n$/, '');
  },
  set(providerId, key, value) {
    const script = `
      $dir = Join-Path $env:APPDATA '${prefix()}\\secrets'
      New-Item -ItemType Directory -Force -Path $dir | Out-Null
      $p = Join-Path $dir '${providerId}.${key}.dat'
      $input | ConvertTo-SecureString -AsPlainText -Force | ConvertFrom-SecureString | Set-Content $p`;
    const res = runKeystore('powershell', ['-NoProfile', '-Command', script], { input: value });
    if (res.status !== 0) {
      throw new Error(`DPAPI write failed: ${res.stderr.trim() || `exit ${res.status}`}`);
    }
  },
  delete(providerId, key) {
    const script = `
      $p = Join-Path $env:APPDATA '${prefix()}\\secrets\\${providerId}.${key}.dat'
      if (Test-Path $p) { Remove-Item $p -Force }`;
    runKeystore('powershell', ['-NoProfile', '-Command', script]);
  },
};

// ── Environment variables ────────────────────────────────────────────────────
//
// For headless/CI/container use where no keystore exists. Read-only: writing a
// secret to the environment would not persist, and pretending otherwise would
// silently lose it.

function envStore(env: NodeJS.ProcessEnv = process.env): SecretsStore {
  return {
    backend: 'env',
    get(providerId, key) {
      return env[envVarFor(providerId, key)] ?? null;
    },
    set(providerId, key) {
      throw new Error(
        `the 'env' secrets backend is read-only — export ${envVarFor(providerId, key)} instead`,
      );
    },
    delete() {
      /* nothing persisted to remove */
    },
  };
}

export function getSecretsStore(backend: SecretsBackend = defaultBackend()): SecretsStore {
  switch (backend) {
    case 'keychain': return keychainStore;
    case 'secret-service': return secretServiceStore;
    case 'dpapi': return dpapiStore;
    case 'env': return envStore();
  }
}

/**
 * Read a secret, preferring an explicit env var over the keystore.
 *
 * The env override exists so CI and containers work without a keystore, and so
 * a user can shim a value without re-running setup.
 */
export function readSecret(
  providerId: string,
  key: string,
  backend?: SecretsBackend,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const fromEnv = env[envVarFor(providerId, key)];
  if (fromEnv) return fromEnv;
  return getSecretsStore(backend).get(providerId, key);
}
