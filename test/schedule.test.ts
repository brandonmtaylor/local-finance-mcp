// Schedule file generation.
//
// Tested as pure string builders rather than by installing a real LaunchAgent —
// verification should not leave a daily background job on the machine running
// the tests.
//
// The absolute-node-path assertion is the important one: launchd and systemd do
// not inherit the shell PATH, and a bare "node" produces a schedule that silently
// never runs while every manual invocation works fine.

import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { buildLaunchAgent, buildSystemdUnits, parseTime, jobLabel, taskName } from '../src/core/schedule.js';

const target = {
  nodePath: '/opt/homebrew/Cellar/node/23.2.0/bin/node',
  cliPath: '/Users/someone/Projects/local-finance-mcp/dist/cli.js',
};

describe('parseTime', () => {
  it('parses 24-hour times', () => {
    expect(parseTime('07:00')).toEqual({ hour: 7, minute: 0 });
    expect(parseTime('23:59')).toEqual({ hour: 23, minute: 59 });
    expect(parseTime('7:30')).toEqual({ hour: 7, minute: 30 });
  });

  it('rejects malformed or out-of-range times', () => {
    for (const bad of ['25:00', '07:60', '7', 'noon', '', '07:0']) {
      expect(() => parseTime(bad)).toThrow();
    }
  });
});

describe('buildLaunchAgent', () => {
  const plist = buildLaunchAgent({ hour: 7, minute: 0 }, target);

  it('uses an absolute node path, never a bare command', () => {
    expect(plist).toContain(`<string>${target.nodePath}</string>`);
    expect(plist).not.toMatch(/<string>node<\/string>/);
  });

  it('schedules at the requested time', () => {
    expect(plist).toMatch(/<key>Hour<\/key>\s*<integer>7<\/integer>/);
    expect(plist).toMatch(/<key>Minute<\/key>\s*<integer>0<\/integer>/);
  });

  it('runs the full job by default — sync, report, deliver', () => {
    expect(plist).toContain('<string>run</string>');
  });

  it('can be installed sync-only', () => {
    const syncOnly = buildLaunchAgent({ hour: 7, minute: 0 }, target, ['sync', '--automatic-only']);
    expect(syncOnly).toContain('<string>sync</string>');
    expect(syncOnly).toContain('<string>--automatic-only</string>');
    expect(syncOnly).not.toContain('<string>run</string>');
  });

  it('does not run at load — a scheduled job should not fire on every login', () => {
    expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<false\/>/);
  });

  it('captures stdout and stderr for debugging a silent failure', () => {
    expect(plist).toContain('StandardOutPath');
    expect(plist).toContain('StandardErrorPath');
  });

  it('is well-formed plist XML', () => {
    expect(plist.startsWith('<?xml')).toBe(true);
    expect(plist).toContain('<!DOCTYPE plist');
    expect(plist.trimEnd().endsWith('</plist>')).toBe(true);
  });
});

describe('buildSystemdUnits', () => {
  const { service, timer } = buildSystemdUnits({ hour: 7, minute: 5 }, target);

  it('uses absolute paths in ExecStart', () => {
    expect(service).toContain(`ExecStart=${target.nodePath} ${target.cliPath} run`);
  });

  it('is a oneshot service driven by a calendar timer', () => {
    expect(service).toContain('Type=oneshot');
    expect(timer).toContain('OnCalendar=*-*-* 07:05:00');
  });

  it('is Persistent so a missed run catches up after the machine was off', () => {
    expect(timer).toContain('Persistent=true');
  });
});

describe('one job per data directory', () => {
  // A single fixed job name meant `schedule install` under a test FINANCE_HOME
  // replaced the real daily job — and the plist never passed FINANCE_HOME, so
  // the replacement ran against the real ledger anyway.
  const withHome = <T>(home: string | undefined, fn: () => T): T => {
    const saved = process.env.FINANCE_HOME;
    if (home === undefined) delete process.env.FINANCE_HOME; else process.env.FINANCE_HOME = home;
    try { return fn(); } finally {
      if (saved === undefined) delete process.env.FINANCE_HOME; else process.env.FINANCE_HOME = saved;
    }
  };

  it('keeps the bare name for the default directory, so an existing install is still found', () => {
    withHome(undefined, () => {
      expect(jobLabel()).toBe('com.finance-mcp.sync');
      expect(taskName()).toBe('finance-mcp-sync');
      expect(buildLaunchAgent({ hour: 7, minute: 0 }, target)).not.toContain('FINANCE_HOME');
    });
  });

  it('gives another directory its own job, which runs against that directory', () => {
    withHome('/tmp/profile-a', () => {
      const label = jobLabel();
      expect(label).toMatch(/^com\.finance-mcp\.sync-[0-9a-f]{8}$/);
      const plist = buildLaunchAgent({ hour: 7, minute: 0 }, target);
      expect(plist).toContain(`<string>${label}</string>`);
      // Resolved, so on Windows it is a drive path — the plist and unit are
      // only generated elsewhere, but the test still runs there.
      const home = resolve('/tmp/profile-a');
      expect(plist).toContain(`<key>FINANCE_HOME</key>\n    <string>${home}</string>`);
      expect(buildSystemdUnits({ hour: 7, minute: 0 }, target).service)
        .toContain(`Environment=FINANCE_HOME=${home}`);
    });
    expect(withHome('/tmp/profile-b', jobLabel)).not.toBe(withHome('/tmp/profile-a', jobLabel));
  });
});
