// SMTP delivery. No network here — the parts worth pinning are the ones that
// produce confusing failures: a wrong TLS mode for the port, an unnamed
// attachment, and provider errors that send people to fix the wrong thing.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sendMail = vi.fn();
const close = vi.fn();
const createTransport = vi.fn(() => ({ sendMail, close }));
vi.mock('nodemailer', () => ({ createTransport: (...args: unknown[]) => createTransport(...(args as [])) }));

const { sendViaSmtp, explainSmtpError } = await import('../src/core/smtp.js');

const settings = { host: 'smtp.example.com', port: 587, user: 'me@example.com', to: 'me@example.com' };

function report(): string {
  const dir = mkdtempSync(join(tmpdir(), 'smtp-'));
  const path = join(dir, 'report-2026-08-12.html');
  writeFileSync(path, '<html>report</html>');
  return path;
}

beforeEach(() => {
  sendMail.mockReset().mockResolvedValue({ messageId: 'x' });
  close.mockReset();
  createTransport.mockClear();
});

describe('TLS mode', () => {
  it('uses STARTTLS on 587 and implicit TLS on 465', async () => {
    // Getting this backwards hangs rather than failing, so it is derived
    // from the port rather than left to the user.
    await sendViaSmtp(settings, 'pw', { subject: 's', body: 'b' });
    expect(createTransport.mock.calls[0]![0]).toMatchObject({ port: 587, secure: false });

    await sendViaSmtp({ ...settings, port: 465 }, 'pw', { subject: 's', body: 'b' });
    expect(createTransport.mock.calls[1]![0]).toMatchObject({ port: 465, secure: true });
  });

  it('honours an explicit secure flag over the port default', async () => {
    await sendViaSmtp({ ...settings, port: 587, secure: true }, 'pw', { subject: 's', body: 'b' });
    expect(createTransport.mock.calls[0]![0]).toMatchObject({ secure: true });
  });
});

describe('attachment', () => {
  it('carries a real filename and content type', async () => {
    // Without both, clients show an unnamed MIME blob instead of a file you can
    // open — the exact bug found in the mailer this replaces.
    await sendViaSmtp(settings, 'pw', { subject: 's', body: 'b', attachment: report() });

    const attachments = sendMail.mock.calls[0]![0].attachments;
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({
      filename: 'report-2026-08-12.html',
      contentType: 'text/html; charset=utf-8',
    });
    // Basename only — never the sender's full home path.
    expect(attachments[0].filename).not.toContain('/');
  });

  it('sends without an attachment when none is given', async () => {
    await sendViaSmtp(settings, 'pw', { subject: 's', body: 'b' });
    expect(sendMail.mock.calls[0]![0].attachments).toBeUndefined();
  });

  it('defaults From to the authenticated user', async () => {
    await sendViaSmtp(settings, 'pw', { subject: 's', body: 'b' });
    expect(sendMail.mock.calls[0]![0].from).toBe('me@example.com');
  });
});

describe('failure handling', () => {
  it('returns a result rather than throwing', async () => {
    sendMail.mockRejectedValue(new Error('boom'));
    const result = await sendViaSmtp(settings, 'pw', { subject: 's', body: 'b' });
    expect(result).toMatchObject({ ok: false });
    expect(result.detail).toContain('boom');
  });

  it('always closes the transport, even on failure', async () => {
    sendMail.mockRejectedValue(new Error('boom'));
    await sendViaSmtp(settings, 'pw', { subject: 's', body: 'b' });
    expect(close).toHaveBeenCalled();
  });
});

describe('explainSmtpError', () => {
  it('points a rejected password at app passwords, not a password reset', () => {
    // Gmail says "Username and Password not accepted" for a correct account
    // password, which sends people to reset something that was never wrong.
    const out = explainSmtpError(new Error('535-5.7.8 Username and Password not accepted'));
    expect(out).toMatch(/app password/i);
    expect(out).toMatch(/finance secret set smtp password/);
  });

  it('names the TLS/port mismatch on a timeout', () => {
    const out = explainSmtpError(Object.assign(new Error('Greeting never received'), { code: 'ETIMEDOUT' }));
    expect(out).toMatch(/465/);
    expect(out).toMatch(/587/);
  });

  it('names the setting to check on a refused connection', () => {
    const out = explainSmtpError(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
    expect(out).toMatch(/smtp\.host/);
  });

  it('passes an unrecognised error through unchanged', () => {
    expect(explainSmtpError(new Error('something odd'))).toBe('something odd');
  });
});
