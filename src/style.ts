// Terminal styling for the interactive commands.
//
// No dependency: these are the standard ANSI codes. Off when output is not a
// terminal — a log file or a pipe should get plain text — and whenever NO_COLOR
// is set (https://no-color.org). FORCE_COLOR turns it back on.

const enabled = !process.env.NO_COLOR
  && (Boolean(process.env.FORCE_COLOR) || process.stdout.isTTY === true);

const wrap = (open: number, close: number) => (s: string) =>
  enabled ? `\x1b[${open}m${s}\x1b[${close}m` : s;

export const bold = wrap(1, 22);
export const dim = wrap(2, 22);
export const green = wrap(32, 39);
export const red = wrap(31, 39);
export const yellow = wrap(33, 39);
export const cyan = wrap(36, 39);

/** A numbered section header, so a long wizard reads as a few short steps. */
export function step(n: number, total: number, title: string): string {
  return `\n${cyan(bold(`Step ${n} of ${total}`))}  ${bold(title)}\n${dim('─'.repeat(60))}`;
}

/** Make any URL in a message stand out — it is the thing to click. */
export const links = (message: string) =>
  message.replace(/https?:\/\/\S+/g, (url) => cyan(url));
