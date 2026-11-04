// Reading and writing the Plaid CLI's own config file.
//
// We create Items ourselves (the CLI cannot request more than ~90 days of
// history), but every other Plaid operation still goes through the CLI — which
// only knows about Items recorded in its own store. So a newly created Item has
// to be written there, or it exists at Plaid and is invisible locally.
//
// This is the one place coupled to a third-party file format, which is
// undocumented and can change. Everything here is therefore defensive: the
// shape is validated before any write, the file is copied to a timestamped
// backup first, and the write is atomic. Refusing to write is always better
// than corrupting the file that holds every access token.

import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join, dirname } from 'node:path';

export interface CliItem {
  item_id: string;
  access_token: string;
  sync_cursor?: string;
  institution_id?: string;
}

interface CliConfig {
  client_id?: string;
  env?: string;
  environments?: Record<string, { secret?: string; items?: CliItem[] }>;
  [key: string]: unknown;
}

/** Where plaid-cli keeps its config, per its own --help output. */
export function cliConfigPath(): string {
  return platform() === 'win32'
    ? join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'plaid-cli', 'config.json')
    : platform() === 'darwin'
      ? join(homedir(), 'Library', 'Application Support', 'plaid-cli', 'config.json')
      : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'plaid-cli', 'config.json');
}

export class CliStoreError extends Error {}

/**
 * Load and structurally validate the CLI config.
 *
 * Throws rather than returning a partial object: every caller is about to write
 * to this file, and guessing at an unfamiliar shape is how the token store gets
 * destroyed.
 */
export function readCliConfig(path = cliConfigPath()): CliConfig {
  if (!existsSync(path)) {
    throw new CliStoreError(
      `No Plaid CLI config at ${path}. Run \`plaid login\` once so the CLI creates it, `
      + 'then retry.',
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new CliStoreError(`Plaid CLI config at ${path} is not valid JSON: ${(err as Error).message}`);
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new CliStoreError(`Plaid CLI config at ${path} is not a JSON object.`);
  }
  const config = parsed as CliConfig;
  if (typeof config.environments !== 'object' || config.environments === null) {
    throw new CliStoreError(
      `Plaid CLI config at ${path} has no "environments" section — its format may have `
      + 'changed. Not writing to it.',
    );
  }
  return config;
}

/**
 * Add an Item to the CLI's store so every later CLI call can see it.
 *
 * Idempotent by item_id: re-recording the same Item updates it in place rather
 * than appending a duplicate, since two entries for one Item would sync it
 * twice and double every transaction it carries.
 */
export function addItemToCliConfig(
  environment: string,
  item: CliItem,
  path = cliConfigPath(),
): { backupPath: string; replaced: boolean } {
  const config = readCliConfig(path);

  const environments = config.environments!;
  const bucket = environments[environment];
  if (!bucket || typeof bucket !== 'object') {
    throw new CliStoreError(
      `Plaid CLI config has no "${environment}" environment. Run `
      + `\`plaid login\` against ${environment} first so the CLI records its secret.`,
    );
  }
  if (!Array.isArray(bucket.items)) bucket.items = [];

  // Copy the whole file before touching it — it holds every access token, and
  // a bad write costs a re-link of every account.
  const backupPath = `${path}.finance-mcp-backup`;
  copyFileSync(path, backupPath);

  const existing = bucket.items.findIndex((i) => i?.item_id === item.item_id);
  const replaced = existing >= 0;
  if (replaced) {
    bucket.items[existing] = { ...bucket.items[existing], ...item };
  } else {
    bucket.items.push(item);
  }

  // Atomic: write beside the target and rename, so an interrupted write cannot
  // leave a truncated token store behind.
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.finance-mcp-tmp`;
  writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);

  return { backupPath, replaced };
}

/** Item ids already recorded for an environment — used to spot re-links. */
export function listCliItems(environment: string, path = cliConfigPath()): CliItem[] {
  const config = readCliConfig(path);
  return config.environments?.[environment]?.items ?? [];
}

/**
 * The API keys `plaid login` saved, for one environment, or null.
 *
 * `finance setup` copies these into the OS keystore so nobody has to find them
 * in a dashboard and paste them. One client_id serves every environment; the
 * secret is per environment, so a sandbox secret is never handed back for
 * production. Never throws: a missing or unfamiliar file just means "not
 * signed in yet".
 */
export function readCliKeys(
  environment: string,
  path = cliConfigPath(),
): { clientId: string; secret: string } | null {
  try {
    const config = readCliConfig(path);
    const clientId = config.client_id;
    const secret = config.environments?.[environment]?.secret;
    return typeof clientId === 'string' && clientId && typeof secret === 'string' && secret
      ? { clientId, secret }
      : null;
  } catch {
    return null;
  }
}
