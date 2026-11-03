// Delivery. The report is on disk before any of this runs, so nothing here may
// be fatal — a channel that fails must report why and let the others proceed.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyToFolder, headline, emailBody, deliver } from '../src/core/deliver.js';

const summary = {
  spendingCents: 500_000,
  incomeCents: 490_000,
  netCents: -10_000,
  startDate: '2026-07-14',
  endDate: '2026-08-12',
  reportPath: '',
};

function withReport(): typeof summary {
  const dir = mkdtempSync(join(tmpdir(), 'fin-'));
  const path = join(dir, 'report.html');
  writeFileSync(path, '<html>report</html>');
  return { ...summary, reportPath: path };
}

describe('headline', () => {
  it('carries the numbers, so the notification is useful unopened', () => {
    expect(headline(summary)).toBe('Spent $5,000 · in $4,900 · net -$100');
  });
});

describe('emailBody', () => {
  it('states the figures and that the attachment needs no network', () => {
    const body = emailBody(withReport());
    expect(body).toMatch(/Spending {2}\$5,000/);
    expect(body).toMatch(/self-contained/);
  });
});

describe('copyToFolder', () => {
  it('copies into a synced folder, creating it if needed', async () => {
    const s = withReport();
    const dest = join(mkdtempSync(join(tmpdir(), 'sync-')), 'Finance');
    const out = copyToFolder(s.reportPath, dest);

    expect(out.ok).toBe(true);
    expect(existsSync(join(dest, 'report.html'))).toBe(true);
    expect(readFileSync(join(dest, 'report.html'), 'utf8')).toBe('<html>report</html>');
  });

  it('expands ~ in the destination', () => {
    // The same trap as CSV paths: Node treats "~" as a literal directory.
    // HOME is redirected for the duration — a test must never write into the
    // real home directory, which this one did until it was caught.
    const realHome = process.env.HOME;
    const fakeHome = mkdtempSync(join(tmpdir(), 'home-'));
    process.env.HOME = fakeHome;
    try {
      const out = copyToFolder(withReport().reportPath, '~/Reports');
      expect(out.ok).toBe(true);
      expect(out.detail).not.toContain('~');
      expect(out.detail.startsWith(fakeHome)).toBe(true);
    } finally {
      process.env.HOME = realHome;
    }
  });

  it('bounds the copy so a blocked destination cannot wedge the process', () => {
    // The real failure: iCloud Drive blocks writes from a LaunchAgent, and
    // neither fs.copyFileSync nor fs.promises.copyFile can be abandoned —
    // both hold a libuv thread, and process.exit() waits for the threadpool to
    // drain. A killable subprocess is what makes the job survivable.
    const out = copyToFolder(withReport().reportPath, join(mkdtempSync(join(tmpdir(), 's-')), 'F'), 5);
    expect(out.ok).toBe(true);
  });

  it('reports the reason rather than throwing', async () => {
    const out = copyToFolder('/nonexistent/report.html', join(tmpdir(), 'x'));
    expect(out.ok).toBe(false);
    expect(out.detail).toBeTruthy();
  });
});

describe('deliver', () => {
  it('reports each channel independently, so one failure does not stop the rest', async () => {
    const s = withReport();
    const dest = join(mkdtempSync(join(tmpdir(), 'sync-')), 'Finance');
    const outcomes = await deliver(['save-only', 'copy', 'email'], s, { sendEmail: false, copyTo: dest });

    expect(outcomes.map((o) => o.channel)).toEqual(['save-only', 'copy', 'email']);
    expect(outcomes[0]!.ok).toBe(true);
    expect(outcomes[1]!.ok).toBe(true);
    // No emailTo — must say so rather than silently doing nothing.
    expect(outcomes[2]!).toMatchObject({ ok: false, detail: 'no emailTo configured' });
  });

  it('refuses smtp without user, recipient, or password — naming which', async () => {
    const s = withReport();
    const noConf = await deliver(['smtp'], s, { sendEmail: false });
    expect(noConf[0]).toMatchObject({ ok: false });
    expect(noConf[0]!.detail).toMatch(/user and report\.smtp\.to/);

    const noPw = await deliver(['smtp'], s, {
      sendEmail: false, smtp: { user: 'a@b.com', to: 'a@b.com' }, smtpPassword: null,
    });
    expect(noPw[0]!.detail).toMatch(/finance secret set smtp password/);
  });

  it('does nothing for an empty channel list', async () => {
    expect(await deliver([], withReport(), { sendEmail: false })).toEqual([]);
  });
});

describe('problems ride along with the figures', () => {
  // A diagnostic nobody reads is worthless, and the daily mail is the one
  // thing that definitely gets read. Anything known to make these numbers
  // wrong has to travel with them.
  const withProblems = (problems: string[]) => ({ ...summary, problems });

  it('puts them ABOVE the figures, not after', () => {
    // Anything after a number reads as context for that number rather than a
    // reason to doubt it — and the point of "a card stopped reporting" is that
    // the total below it is wrong.
    const body = emailBody(withProblems(['a card stopped reporting']));
    expect(body.indexOf('BEFORE YOU READ')).toBeLessThan(body.indexOf('Spending'));
    expect(body).toContain('! a card stopped reporting');
  });

  it('survives into the notification, which is often all that is read', () => {
    expect(headline(withProblems(['x', 'y']))).toMatch(/^⚠ 2 issue/);
  });

  it('stays out of the way when nothing is wrong', () => {
    expect(emailBody(summary)).not.toContain('BEFORE YOU READ');
    expect(headline(summary)).not.toContain('⚠');
  });
});
