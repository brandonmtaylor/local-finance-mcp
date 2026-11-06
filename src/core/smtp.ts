// SMTP delivery.
//
// The one place this project accepts a credential — and it goes where the Plaid
// secret goes: the OS keystore, never the config file. The principle has always
// been "no credentials in plaintext", not "no credentials".
//
// Email earns that exception because it is the only channel that reaches a phone
// with no new account, no third party holding the report, and no dependency on
// AppleScript (which times out on some machines) or a synced folder (which has
// no push). Mail clients render the attached HTML inline, so the report is
// readable without downloading anything.

import { createTransport } from 'nodemailer';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

export interface SmtpSettings {
  host: string;
  port: number;
  /** STARTTLS on 587, implicit TLS on 465. Derived from the port unless set. */
  secure?: boolean;
  user: string;
  to: string;
  from?: string;
}

export interface SmtpMessage {
  subject: string;
  body: string;
  /** Shown instead of `body` by any client that renders HTML, which is most. */
  html?: string;
  /** Path to the report. Attached with a real filename and content type. */
  attachment?: string;
}

export interface SmtpResult {
  ok: boolean;
  detail: string;
}

/**
 * Translate the failures people actually hit into something actionable.
 *
 * Gmail returns "Username and Password not accepted" for a normal password when
 * an app password is required — a message that sends people to reset a password
 * that was never wrong.
 */
export function explainSmtpError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: string } | null)?.code ?? '';

  if (/Username and Password not accepted|BadCredentials|535/i.test(message)) {
    return `${message} — Gmail and most providers reject account passwords over SMTP. `
      + 'Generate an app password (requires 2FA) and store it with '
      + '`finance secret set smtp password`.';
  }
  if (code === 'ECONNREFUSED' || /ECONNREFUSED/.test(message)) {
    return `${message} — nothing listening on that host/port. Check smtp.host and smtp.port.`;
  }
  if (code === 'ETIMEDOUT' || /ETIMEDOUT|Greeting never received/i.test(message)) {
    return `${message} — no response. Port 465 needs secure=true; port 587 needs secure=false (STARTTLS).`;
  }
  if (/self.signed|unable to verify/i.test(message)) {
    return `${message} — TLS certificate could not be verified.`;
  }
  return message;
}

export async function sendViaSmtp(
  settings: SmtpSettings,
  password: string,
  message: SmtpMessage,
): Promise<SmtpResult> {
  // 465 is implicit TLS; everything else (587, 25) negotiates with STARTTLS.
  // Getting this backwards hangs rather than failing, so derive it by default.
  const secure = settings.secure ?? settings.port === 465;

  const transport = createTransport({
    host: settings.host,
    port: settings.port,
    secure,
    auth: { user: settings.user, pass: password },
  });

  try {
    await transport.sendMail({
      from: settings.from ?? settings.user,
      to: settings.to,
      subject: message.subject,
      text: message.body,
      html: message.html,
      attachments: message.attachment
        ? [{
          // Real filename and content type — without them a client shows an
          // unnamed MIME blob rather than a file you can open.
          filename: basename(message.attachment),
          content: readFileSync(message.attachment),
          contentType: 'text/html; charset=utf-8',
        }]
        : undefined,
    });
    return { ok: true, detail: `sent to ${settings.to}` };
  } catch (err) {
    return { ok: false, detail: explainSmtpError(err) };
  } finally {
    transport.close();
  }
}
