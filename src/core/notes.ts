// Standing context for the analysis, written by the person it is about.
//
// The brief the model receives is aggregates and flagged transactions. It has
// no idea that a large recurring Zelle is a mortgage, that one subscription is
// a business expense, or that a big purchase is six months out and every
// suggestion should be read against that. Without it the analysis states the
// obvious and misreads the deliberate — a savings plan looks like a spending
// problem, and a mortgage looks like an anomaly worth investigating.
//
// So: a plain markdown file the user edits, appended to every prompt.
//
// It is TRUSTED INPUT in the ordinary sense — the user is writing to their own
// tool about their own money. But it is still text going into a prompt, so it
// is bounded in size and clearly fenced in the prompt, and it can only ever add
// context. The rules that stop the model inventing figures sit after it.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { financeHome } from './paths.js';

export function notesPath(): string {
  return join(financeHome(), 'insights-notes.md');
}

/**
 * How much of the notes file is used.
 *
 * Generous for context, bounded so a runaway file cannot crowd out the actual
 * data or blow past a model's window. Truncation is reported rather than
 * silent — see readNotes.
 */
const MAX_NOTES_CHARS = 8_000;

export interface Notes {
  text: string;
  truncated: boolean;
}

/** Read the notes file. Returns null when there is none, which is the norm. */
export function readNotes(path = notesPath()): Notes | null {
  try {
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, 'utf8');
    // Strip comments so the template's own guidance never reaches the model
    // as if the user had written it. Whole blocks, not lines that START with
    // `<!--`: the template is one multi-line comment, and filtering by line
    // removed only its first line and sent the other 1 KB with every report.
    // An unclosed comment runs to the end, as it would in HTML.
    const body = raw
      .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
      .trim();
    if (!body) return null;
    return body.length > MAX_NOTES_CHARS
      ? { text: body.slice(0, MAX_NOTES_CHARS), truncated: true }
      : { text: body, truncated: false };
  } catch {
    // A note file that cannot be read must not cost someone their analysis.
    return null;
  }
}

const TEMPLATE = `<!--
Notes for the analysis in your report.

Everything here is sent to the analysis command every time a report runs, so
this is where standing context lives — the things the numbers cannot show.
Delete these comment lines or leave them; they are stripped either way.

What actually helps, in rough order:

  - What a big recurring payment IS, when the description does not say.
      "The monthly Zelle to J. Smith is rent."
  - What is deliberate, so it stops being reported as an anomaly.
      "Large transfers to the brokerage are planned investing, not a leak."
  - What you are aiming at, so suggestions are useful rather than generic.
      "Saving for a deposit in about a year. Cash matters more than optimising."
  - What NOT to suggest cutting, and why.
      "The coffee subscription is a business expense. Leave it alone."
  - Anything seasonal or one-off that would otherwise read as a trend.
      "December is high every year — gifts, travel and insurance renewals."

Keep it short. Six good lines beat two pages.
-->

`;

/** Create the notes file with guidance in it. Never overwrites. */
export function ensureNotesFile(path = notesPath()): { path: string; created: boolean } {
  if (existsSync(path)) return { path, created: false };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, TEMPLATE, { mode: 0o600 });
  return { path, created: true };
}
