// Scheduled syncs.
//
// The MCP server runs over stdio, so it lives and dies with the client session
// and cannot hold a timer. Background refresh therefore belongs to the OS
// scheduler, invoking the CLI directly with no agent involved.
//
// Two macOS specifics are the reason this is generated rather than documented:
//   - A LaunchAgent (not a LaunchDaemon) runs inside the logged-in session, so
//     it can reach the login keychain. A Daemon cannot, and the failure looks
//     like a credential error rather than a scheduling one.
//   - launchd does not inherit the shell PATH, so the plist needs an absolute
//     path to node. This is the usual cause of "works by hand, fails on cron".

import { execFileSync as execFileSyncUntimed, type ExecFileSyncOptions } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync, unlinkSync, readFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join, dirname } from 'node:path';
import { financeHome, customHome, homeSuffix } from './paths.js';

// The scheduler's job label, deliberately unchanged by the rename. A new
// label would install a SECOND agent beside the one already running — two
// syncs, two reports, two emails every morning — while `schedule uninstall`
// looked for the new one and left the old in place.
const LABEL = 'com.finance-mcp.sync';
const TASK = 'finance-mcp-sync';

/** launchd label for this data directory. */
export function jobLabel(env: NodeJS.ProcessEnv = process.env): string {
  return `${LABEL}${homeSuffix(env)}`;
}

/** systemd unit / Task Scheduler name for this data directory. */
export function taskName(env: NodeJS.ProcessEnv = process.env): string {
  return `${TASK}${homeSuffix(env)}`;
}

export interface ScheduleSpec {
  /** 24-hour local time. */
  hour: number;
  minute: number;
}

export interface ScheduleTarget {
  /** Absolute path to the node binary — never bare "node". */
  nodePath: string;
  /** Absolute path to the CLI entry point. */
  cliPath: string;
  /**
   * PATH for the job. launchd supplies only /usr/bin:/bin:/usr/sbin:/sbin, so
   * anything in Homebrew or ~/.local — `plaid`, `claude` — is invisible and the
   * job fails with "command not found" for tools that work fine by hand.
   */
  path?: string;
}

/** A PATH that covers the usual install locations plus whatever launchd gives. */
export function schedulePath(env: NodeJS.ProcessEnv = process.env): string {
  const extras = [
    '/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin',
    join(homedir(), '.local', 'bin'), join(homedir(), 'bin'),
  ];
  const base = (env.PATH ?? '').split(':').filter(Boolean);
  return [...new Set([...extras, ...base, '/usr/bin', '/bin', '/usr/sbin', '/sbin'])].join(':');
}

export function parseTime(value: string): ScheduleSpec {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) throw new Error(`invalid time "${value}" — expected HH:MM (24-hour)`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error(`invalid time "${value}" — out of range`);
  return { hour, minute };
}

export function launchAgentPath(): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${jobLabel()}.plist`);
}

export function buildLaunchAgent(
  spec: ScheduleSpec,
  target: ScheduleTarget,
  command: string[] = ['run'],
): string {
  const logDir = join(financeHome(), 'logs');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${jobLabel()}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${target.nodePath}</string>
    <string>${target.cliPath}</string>
${command.map((c) => `    <string>${c}</string>`).join('\n')}
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>${spec.hour}</integer>
    <key>Minute</key><integer>${spec.minute}</integer>
  </dict>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${target.path ?? schedulePath()}</string>
    <key>HOME</key>
    <string>${homedir()}</string>${customHome() ? `
    <key>FINANCE_HOME</key>
    <string>${customHome()}</string>` : ''}
  </dict>
  <key>StandardOutPath</key>
  <string>${join(logDir, 'sync.log')}</string>
  <key>StandardErrorPath</key>
  <string>${join(logDir, 'sync.error.log')}</string>
  <key>RunAtLoad</key>
  <false/>
</dict>
</plist>
`;
}

export function buildSystemdUnits(
  spec: ScheduleSpec,
  target: ScheduleTarget,
  command: string[] = ['run'],
): { service: string; timer: string } {
  const time = `${String(spec.hour).padStart(2, '0')}:${String(spec.minute).padStart(2, '0')}`;
  return {
    service: `[Unit]
Description=finance-mcp scheduled sync

[Service]
Type=oneshot
Environment=PATH=${target.path ?? schedulePath()}
${customHome() ? `Environment=FINANCE_HOME=${customHome()}\n` : ''}ExecStart=${target.nodePath} ${target.cliPath} ${command.join(' ')}
`,
    timer: `[Unit]
Description=finance-mcp daily sync

[Timer]
OnCalendar=*-*-* ${time}:00
Persistent=true

[Install]
WantedBy=timers.target
`,
  };
}

export interface ScheduleStatus {
  installed: boolean;
  platform: string;
  path?: string;
  detail?: string;
}

/**
 * Every scheduler command gets a timeout. `systemctl --user` can block on a
 * missing user bus and `launchctl` on a wedged launchd; a hung install is the
 * same stuck process as a hung job, just interactive.
 */
const SCHEDULER_TIMEOUT_MS = 30_000;
function execFileSync(command: string, args: string[], opts: ExecFileSyncOptions = {}): string | Buffer {
  return execFileSyncUntimed(command, args, { timeout: SCHEDULER_TIMEOUT_MS, ...opts });
}

export function installSchedule(
  spec: ScheduleSpec,
  target: ScheduleTarget,
  command: string[] = ['run'],
): ScheduleStatus {
  const os = platform();

  if (os === 'darwin') {
    const path = launchAgentPath();
    mkdirSync(dirname(path), { recursive: true });
    mkdirSync(join(financeHome(), 'logs'), { recursive: true });
    writeFileSync(path, buildLaunchAgent(spec, target, command));
    // bootout first so re-installing picks up a changed schedule; it fails
    // harmlessly when nothing is loaded.
    const domain = `gui/${process.getuid?.() ?? 501}`;
    try {
      execFileSync('launchctl', ['bootout', `${domain}/${jobLabel()}`], { stdio: 'ignore' });
    } catch {
      /* not loaded */
    }
    execFileSync('launchctl', ['bootstrap', domain, path], { stdio: 'ignore' });
    return { installed: true, platform: os, path };
  }

  if (os === 'linux') {
    const unitDir = join(homedir(), '.config', 'systemd', 'user');
    mkdirSync(unitDir, { recursive: true });
    const units = buildSystemdUnits(spec, target, command);
    writeFileSync(join(unitDir, `${taskName()}.service`), units.service);
    writeFileSync(join(unitDir, `${taskName()}.timer`), units.timer);
    execFileSync('systemctl', ['--user', 'daemon-reload']);
    execFileSync('systemctl', ['--user', 'enable', '--now', `${taskName()}.timer`]);
    return { installed: true, platform: os, path: unitDir };
  }

  if (os === 'win32') {
    // Task Scheduler cannot set an environment variable for a task, so a job
    // for a non-default directory would run against the default ledger.
    // Refusing beats a schedule that quietly reads the wrong data.
    if (customHome()) {
      throw new Error('scheduling a non-default FINANCE_HOME is not supported on Windows yet — '
        + 'unset FINANCE_HOME, or schedule `finance run` yourself with it set');
    }
    const time = `${String(spec.hour).padStart(2, '0')}:${String(spec.minute).padStart(2, '0')}`;
    execFileSync('schtasks', [
      '/Create', '/F', '/SC', 'DAILY', '/TN', taskName(),
      '/TR', `"${target.nodePath}" "${target.cliPath}" ${command.join(' ')}`,
      '/ST', time,
    ]);
    return { installed: true, platform: os, detail: `Task Scheduler: ${taskName()}` };
  }

  throw new Error(`scheduling is not supported on ${os}`);
}

export function uninstallSchedule(): ScheduleStatus {
  const os = platform();

  if (os === 'darwin') {
    const path = launchAgentPath();
    const domain = `gui/${process.getuid?.() ?? 501}`;
    try {
      execFileSync('launchctl', ['bootout', `${domain}/${jobLabel()}`], { stdio: 'ignore' });
    } catch {
      /* not loaded */
    }
    if (existsSync(path)) unlinkSync(path);
    return { installed: false, platform: os, path };
  }

  if (os === 'linux') {
    try {
      execFileSync('systemctl', ['--user', 'disable', '--now', `${taskName()}.timer`], { stdio: 'ignore' });
    } catch {
      /* not enabled */
    }
    return { installed: false, platform: os };
  }

  if (os === 'win32') {
    try {
      execFileSync('schtasks', ['/Delete', '/F', '/TN', taskName()], { stdio: 'ignore' });
    } catch {
      /* not present */
    }
    return { installed: false, platform: os };
  }

  return { installed: false, platform: os };
}

export function scheduleStatus(): ScheduleStatus {
  const os = platform();

  if (os === 'darwin') {
    const path = launchAgentPath();
    if (!existsSync(path)) return { installed: false, platform: os };
    // Report the configured time back, so `doctor` can show it without the user
    // opening the plist.
    const plist = readFileSync(path, 'utf8');
    const hour = /<key>Hour<\/key>\s*<integer>(\d+)<\/integer>/.exec(plist)?.[1];
    const minute = /<key>Minute<\/key>\s*<integer>(\d+)<\/integer>/.exec(plist)?.[1];
    const detail = hour !== undefined && minute !== undefined
      ? `daily at ${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`
      : undefined;
    return { installed: true, platform: os, path, detail };
  }

  if (os === 'linux') {
    try {
      const out = execFileSync('systemctl', ['--user', 'is-enabled', `${taskName()}.timer`], {
        encoding: 'utf8',
      });
      return { installed: String(out).trim() === 'enabled', platform: os };
    } catch {
      return { installed: false, platform: os };
    }
  }

  if (os === 'win32') {
    try {
      execFileSync('schtasks', ['/Query', '/TN', taskName()], { stdio: 'ignore' });
      return { installed: true, platform: os };
    } catch {
      return { installed: false, platform: os };
    }
  }

  return { installed: false, platform: os };
}
