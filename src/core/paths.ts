// Where config and the ledger live.
//
// Deliberately OUTSIDE the repo: this project is meant to be published, and the
// one thing that must never end up in someone's git history is their bank data.
// Everything user-specific lives in a platform data dir instead.

import { homedir, platform } from 'node:os';
import { join } from 'node:path';

/** Root for all user state. Override with FINANCE_HOME (tests, multiple profiles). */
export function financeHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.FINANCE_HOME?.trim();
  if (override) return override;

  if (platform() === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'finance-mcp');
  }
  if (platform() === 'win32') {
    const appData = env.APPDATA?.trim();
    return appData ? join(appData, 'finance-mcp') : join(homedir(), 'AppData', 'Roaming', 'finance-mcp');
  }
  // Linux / BSD — XDG Base Directory.
  const xdg = env.XDG_DATA_HOME?.trim();
  return xdg ? join(xdg, 'finance-mcp') : join(homedir(), '.local', 'share', 'finance-mcp');
}

export function configPath(env?: NodeJS.ProcessEnv): string {
  return join(financeHome(env), 'config.toml');
}

export function ledgerPath(env?: NodeJS.ProcessEnv): string {
  return join(financeHome(env), 'ledger.db');
}

export function lockPath(env?: NodeJS.ProcessEnv): string {
  return join(financeHome(env), 'sync.lock');
}

/** State a provider owns (cursors, per-provider scratch). */
export function providerStateDir(providerId: string, env?: NodeJS.ProcessEnv): string {
  return join(financeHome(env), 'providers', providerId);
}

/**
 * Expand a user-supplied path.
 *
 * `~` is a shell convention — Node's fs treats it as a literal directory name,
 * so a config saying `~/Documents/statements` silently matches nothing. Config
 * files are hand-written and `~` is the natural thing to type, so expand it
 * here rather than making every caller remember.
 */
export function expandPath(path: string, env: NodeJS.ProcessEnv = process.env): string {
  const trimmed = path.trim();
  if (trimmed === '~') return homedir();
  if (trimmed.startsWith('~/')) return join(homedir(), trimmed.slice(2));
  if (trimmed.startsWith('$HOME/')) return join(homedir(), trimmed.slice(6));
  // Deliberately NOT expanding arbitrary $VARS — a config path is not a shell
  // command, and partial variable expansion is more surprising than none.
  void env;
  return trimmed;
}
