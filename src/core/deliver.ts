// Report delivery: notification and email.
//
// Email goes through Mail.app via AppleScript rather than SMTP. That is the
// whole point — it sends from an account you have already configured, so a
// finance tool never becomes a place where a mail password lives. The tradeoff
// is macOS-only; other platforms fall back to a clear "not supported" rather
// than pretending.
//
// Nothing here is fatal. A failed notification must never cost you the report,
// which is already on disk by the time any of this runs.

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { platform, homedir } from 'node:os';
import { basename, join } from 'node:path';
import { sendViaSmtp, type SmtpSettings } from './smtp.js';

export type DeliveryChannel = 'notify' | 'email' | 'smtp' | 'copy' | 'command' | 'open' | 'save-only';

export interface DeliveryOutcome {
  channel: DeliveryChannel;
  ok: boolean;
  detail: string;
}

/** AppleScript string literal — quotes and backslashes must be escaped. */
function osaString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * macOS notification.
 *
 * Via osascript rather than a dependency. Clicking a script-posted notification
 * cannot open a file, so the path goes in the body — the report is one click
 * away in the Notification Centre entry, and `open` is one command away.
 */
export function notify(title: string, message: string): DeliveryOutcome {
  if (platform() !== 'darwin') {
    return { channel: 'notify', ok: false, detail: `notifications are macOS-only (this is ${platform()})` };
  }
  const script = `display notification ${osaString(message)} with title ${osaString(title)}`;
  // MUST have a timeout. Posting a notification from a LaunchAgent can block
  // indefinitely, and without this the whole job wedges before any other
  // channel runs — the report is written, nothing is delivered, and the process
  // never exits.
  const res = spawnSync('osascript', ['-e', script], { encoding: 'utf8', timeout: 20_000 });
  if (res.status === null) {
    return { channel: 'notify', ok: false, detail: 'osascript did not return (timed out)' };
  }
  return res.status === 0
    ? { channel: 'notify', ok: true, detail: 'notification posted' }
    : { channel: 'notify', ok: false, detail: (res.stderr || '').trim() || `exit ${res.status}` };
}

export interface EmailOptions {
  to: string;
  subject: string;
  body: string;
  /** Absolute path to attach. The report is self-contained, so it renders anywhere. */
  attachment?: string;
  /** Send immediately, or leave the draft open for review. */
  send: boolean;
}

/**
 * Send through Mail.app.
 *
 * No SMTP, no credentials: this hands the message to a mail client the user has
 * already signed in to. Attaching the HTML rather than inlining it means the
 * report arrives intact — self-contained, so it opens on a phone with no app
 * and nothing hosted.
 */
export function emailViaMailApp(options: EmailOptions): DeliveryOutcome {
  if (platform() !== 'darwin') {
    return { channel: 'email', ok: false, detail: `Mail.app delivery is macOS-only (this is ${platform()})` };
  }

  const attach = options.attachment
    ? `\n    tell content of newMessage
      make new attachment with properties {file name:(POSIX file ${osaString(options.attachment)})} at after last paragraph
    end tell`
    : '';

  // `tell application "Mail"` LAUNCHES Mail.app if it is not already running.
  // On a schedule that means an app opening on your desktop every morning
  // without explanation — the same footgun as `tell application "Google
  // Chrome"`, which will open a window merely to be counted. Nothing here can
  // avoid it: driving Mail.app requires talking to Mail.app.
  //
  // The `smtp` channel exists because of this, and because this one also fails
  // with a bare -1712 when Mail is slow to respond. Prefer smtp; this stays for
  // anyone who genuinely wants the message in their Mail sent-items.
  const script = `
tell application "Mail"
  set newMessage to make new outgoing message with properties {subject:${osaString(options.subject)}, content:${osaString(options.body)}, visible:false}
  tell newMessage
    make new to recipient at end of to recipients with properties {address:${osaString(options.to)}}
  end tell${attach}
  ${options.send ? 'send newMessage' : 'set visible of newMessage to true'}
end tell`;

  const res = spawnSync('osascript', ['-e', script], { encoding: 'utf8', timeout: 120_000 });
  if (res.status !== 0) {
    const err = (res.stderr || '').trim();

    // A null status means the process was killed — for osascript talking to
    // Mail that is almost always a pending Automation permission, which blocks
    // the AppleEvent until someone clicks the dialog. "exit null" tells the
    // user nothing; name the actual cause.
    const timedOut = res.status === null || /-1712|timed out/i.test(err);
    const denied = /not authori[sz]ed|-1743/i.test(err);

    const hint = timedOut
      ? ' — Mail did not respond. This is usually a pending Automation prompt: '
        + 'open System Settings → Privacy & Security → Automation and allow this terminal '
        + 'to control Mail, then try again. If Mail is showing a dialog, dismiss it first.'
      : denied
        ? ' — permission denied. System Settings → Privacy & Security → Automation, '
          + 'allow this terminal to control Mail.'
        : '';

    return {
      channel: 'email',
      ok: false,
      detail: `${err || (timedOut ? 'no response from Mail (timed out)' : `exit ${res.status}`)}${hint}`,
    };
  }
  return {
    channel: 'email',
    ok: true,
    detail: options.send ? `sent to ${options.to}` : `draft opened for ${options.to}`,
  };
}

/**
 * Copy the report into a synced folder.
 *
 * The most reliable route to a phone, and the one that needs no permissions
 * and no credentials: drop the file in iCloud Drive (or Dropbox, or anything
 * else that syncs) and it appears in the Files app minutes later. The report is
 * self-contained, so it opens there with no app and no network.
 *
 * Worth preferring over email on macOS — Mail's AppleScript interface is
 * unreliable enough that a scheduled job cannot depend on it.
 */
export function copyToFolder(
  reportPath: string,
  destination: string,
  timeoutSeconds = 30,
): DeliveryOutcome {
  try {
    const dir = expandHome(destination);
    mkdirSync(dir, { recursive: true });
    const target = join(dir, basename(reportPath));

    // Deliberately a SUBPROCESS, not fs.copyFile. Writing into iCloud Drive
    // (~/Library/Mobile Documents) from a LaunchAgent blocks forever — the
    // background job lacks the session context iCloud wants, though the same
    // copy succeeds from an interactive shell.
    //
    // Neither fs.copyFileSync nor fs.promises.copyFile can be abandoned: both
    // occupy a libuv thread, and process.exit() WAITS for the threadpool to
    // drain, so one stuck copy makes the whole scheduled job unkillable. It
    // then never exits, and launchd skips the following days.
    //
    // A child process can simply be killed on timeout, leaving this process
    // free to finish and exit.
    const res = spawnSync('cp', [reportPath, target], {
      encoding: 'utf8',
      timeout: timeoutSeconds * 1_000,
    });
    if (res.status === null) {
      return {
        channel: 'copy', ok: false,
        detail: `copy to ${dir} did not complete in ${timeoutSeconds}s `
          + '(iCloud Drive blocks writes from background jobs — use a plain local folder)',
      };
    }
    if (res.status !== 0) {
      return { channel: 'copy', ok: false, detail: (res.stderr || '').trim() || `cp exit ${res.status}` };
    }
    return { channel: 'copy', ok: true, detail: target };
  } catch (err) {
    return { channel: 'copy', ok: false, detail: (err as Error).message };
  }
}

/** Default synced folder per platform — iCloud Drive on macOS. */
export function defaultSyncFolder(): string | null {
  if (platform() !== 'darwin') return null;
  return join(homedir(), 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'Finance');
}

function expandHome(p: string): string {
  const t = p.trim();
  if (t === '~') return homedir();
  if (t.startsWith('~/')) return join(homedir(), t.slice(2));
  return t;
}

export function openInBrowser(path: string): DeliveryOutcome {
  try {
    const os = platform();
    const [command, args] = os === 'darwin' ? ['open', [path]]
      : os === 'win32' ? ['cmd', ['/c', 'start', '""', path]]
        : ['xdg-open', [path]];
    execFileSync(command, args, { stdio: 'ignore', timeout: 15_000 });
    return { channel: 'open', ok: true, detail: 'opened' };
  } catch (err) {
    return { channel: 'open', ok: false, detail: (err as Error).message };
  }
}

/**
 * Hand the report to an arbitrary command.
 *
 * Same reasoning as narration: a command beats a vendor integration. One
 * implementation covers every push service, and no service-specific code or
 * SDK lands in this project.
 *
 *   ntfy      curl -T {file} https://ntfy.sh/your-topic
 *   Telegram  curl -F document=@{file} https://api.telegram.org/bot<token>/sendDocument?chat_id=<id>
 *   anything  ./my-script.sh {file} {headline}
 *
 * Placeholders are substituted per argument, never through a shell — the
 * command runs directly, so a filename cannot become shell syntax.
 */
export function runDeliveryCommand(
  command: string,
  args: string[],
  substitutions: Record<string, string>,
  timeoutSeconds = 120,
): DeliveryOutcome {
  const substitute = (arg: string) =>
    arg.replace(/\{(\w+)\}/g, (whole, key: string) => substitutions[key] ?? whole);

  const finalArgs = args.map(substitute);
  const res = spawnSync(substitute(command), finalArgs, {
    encoding: 'utf8',
    timeout: timeoutSeconds * 1_000,
    maxBuffer: 8 * 1024 * 1024,
  });

  if (res.error) {
    const err = res.error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      return { channel: 'command', ok: false, detail: `command not found: ${command}` };
    }
    if (err.code === 'ETIMEDOUT') {
      return { channel: 'command', ok: false, detail: `timed out after ${timeoutSeconds}s` };
    }
    return { channel: 'command', ok: false, detail: err.message };
  }
  if (res.status !== 0) {
    return {
      channel: 'command',
      ok: false,
      detail: (res.stderr || res.stdout || '').trim().slice(0, 300) || `exit ${res.status}`,
    };
  }
  return { channel: 'command', ok: true, detail: `${command} ok` };
}

export interface DeliverySummary {
  /** Diagnostics worth seeing beside the figures — errors and warnings only. */
  problems?: string[];
  spendingCents: number;
  incomeCents: number;
  netCents: number;
  startDate: string;
  endDate: string;
  reportPath: string;
}

const money = (cents: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
    .format(cents / 100);

/** One line carrying the numbers, so the notification is useful without opening anything. */
export function headline(s: DeliverySummary): string {
  const base = `Spent ${money(s.spendingCents)} · in ${money(s.incomeCents)} · net ${money(s.netCents)}`;
  // A notification is often the whole of what gets read. If the figures are
  // known to be incomplete, that has to survive the truncation.
  return s.problems?.length ? `⚠ ${s.problems.length} issue · ${base}` : base;
}

export function emailBody(s: DeliverySummary): string {
  // Problems go ABOVE the figures, deliberately. Anything reported after a
  // number has already been read as context for that number rather than as a
  // reason to doubt it — and the whole point of saying "a card stopped
  // reporting" is that the total below it is wrong.
  const problems = s.problems?.length
    ? [
      'BEFORE YOU READ THESE NUMBERS:',
      ...s.problems.map((p) => `  ! ${p}`),
      '',
    ]
    : [];

  return [
    `Finance report for ${s.startDate} to ${s.endDate}.`,
    '',
    ...problems,
    `  Spending  ${money(s.spendingCents)}`,
    `  Income    ${money(s.incomeCents)}`,
    `  Net       ${money(s.netCents)}`,
    '',
    'The attached HTML is self-contained — it opens on a phone with no app and',
    'loads nothing from the network.',
    '',
    `Generated locally by local-finance-mcp · ${basename(s.reportPath)}`,
  ].join('\n');
}

export interface DeliveryConfig {
  emailTo?: string;
  sendEmail: boolean;
  /** Where the `copy` channel puts it. Defaults to iCloud Drive on macOS. */
  copyTo?: string;
  /** The `command` channel: {file}, {headline}, {subject}, {start}, {end}. */
  command?: string;
  commandArgs?: string[];
  /** The `smtp` channel. The password comes from the keystore, never from here. */
  smtp?: Partial<SmtpSettings>;
  smtpPassword?: string | null;
}

/** Bound any channel, so one that never returns cannot wedge the whole job. */
async function withDeadline<T>(
  label: string,
  seconds: number,
  work: () => Promise<T> | T,
): Promise<T | DeliveryOutcome> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<DeliveryOutcome>((resolve) => {
    timer = setTimeout(
      () => resolve({ channel: label as DeliveryChannel, ok: false, detail: `timed out after ${seconds}s` }),
      seconds * 1_000,
    );
    timer.unref?.();   // must not itself keep the process alive
  });
  try {
    return await Promise.race([Promise.resolve().then(work), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface DeliverOptions {
  /** Called as each channel finishes, so a later hang cannot hide earlier results. */
  onOutcome?: (outcome: DeliveryOutcome) => void;
  /** Per-channel deadline. */
  timeoutSeconds?: number;
}

export async function deliver(
  channels: DeliveryChannel[],
  summary: DeliverySummary,
  config: DeliveryConfig,
  options: DeliverOptions = {},
): Promise<DeliveryOutcome[]> {
  const { emailTo, sendEmail } = config;
  const deadline = options.timeoutSeconds ?? 90;
  const outcomes: DeliveryOutcome[] = [];
  const record = (o: DeliveryOutcome) => { outcomes.push(o); options.onOutcome?.(o); };
  for (const channel of channels) {
    switch (channel) {
      case 'notify':
        record(await withDeadline('notify', deadline, () =>
          notify(`Finance · ${summary.startDate} → ${summary.endDate}`, headline(summary))) as DeliveryOutcome);
        break;
      case 'email':
        record(await withDeadline('email', deadline, () => emailTo
          ? emailViaMailApp({
            to: emailTo,
            subject: `Finance report ${summary.startDate} → ${summary.endDate}`,
            body: emailBody(summary),
            attachment: summary.reportPath,
            send: sendEmail,
          })
          : { channel: 'email', ok: false, detail: 'no emailTo configured' }) as DeliveryOutcome);
        break;
      case 'copy': {
        const dest = config.copyTo ?? defaultSyncFolder();
        record(await withDeadline('copy', deadline, () => dest
          ? copyToFolder(summary.reportPath, dest)
          : { channel: 'copy', ok: false, detail: 'no copyTo configured and no default sync folder' }) as DeliveryOutcome);
        break;
      }
      case 'smtp': {
        const { smtp, smtpPassword } = config;
        if (!smtp?.user || !smtp?.to) {
          record({ channel: 'smtp', ok: false, detail: 'report.smtp.user and report.smtp.to must both be set' });
          break;
        }
        if (!smtpPassword) {
          record({
            channel: 'smtp', ok: false,
            detail: 'no SMTP password in the keystore — run `finance secret set smtp password`',
          });
          break;
        }
        // Captured before the closure — the narrowing above does not survive
        // into a callback.
        const settings = {
          host: smtp.host ?? 'smtp.gmail.com', port: smtp.port ?? 587, secure: smtp.secure,
          user: smtp.user, to: smtp.to, from: smtp.from,
        };
        const result = await withDeadline('smtp', deadline, () => sendViaSmtp(
          settings,
          smtpPassword,
          {
            subject: `Finance report ${summary.startDate} → ${summary.endDate}`,
            body: emailBody(summary),
            attachment: summary.reportPath,
          },
        )) as { ok: boolean; detail: string };
        record({ channel: 'smtp', ok: result.ok, detail: result.detail });
        break;
      }
      case 'command':
        record(await withDeadline('command', deadline, () => config.command
          ? runDeliveryCommand(config.command, config.commandArgs ?? [], {
            file: summary.reportPath,
            headline: headline(summary),
            subject: `Finance report ${summary.startDate} → ${summary.endDate}`,
            start: summary.startDate,
            end: summary.endDate,
          })
          : { channel: 'command', ok: false, detail: 'no report.command configured' }) as DeliveryOutcome);
        break;
      case 'open':
        record(await withDeadline('open', deadline, () => openInBrowser(summary.reportPath)) as DeliveryOutcome);
        break;
      case 'save-only':
        record({ channel: 'save-only', ok: true, detail: summary.reportPath });
        break;
    }
  }
  return outcomes;
}
