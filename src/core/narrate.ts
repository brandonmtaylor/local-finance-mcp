// Optional AI narration of the insights brief.
//
// Deliberately NOT an API client. The contract is a command: the brief goes in
// on stdin, markdown comes back on stdout. That means
//
//   claude -p            uses an existing Claude Code login — no API key here
//   llm                  any model that CLI is configured for
//   ollama run <model>   fully local; nothing leaves the machine at all
//   ./my-script.sh       anything you like
//
// so this file never handles a credential, and a finance tool never becomes a
// place where an API key lives.
//
// OFF by default. Enabling it sends the brief to whatever command you name —
// which for a hosted model means off the machine. The brief is aggregates plus
// a handful of flagged transactions, not the ledger, but that is still a
// decision the user makes rather than one made for them.

import { spawnSync } from 'node:child_process';
import type { InsightsBrief } from './insights.js';
import { readNotes } from './notes.js';

export interface NarrationConfig {
  enabled: boolean;
  command: string;
  args: string[];
  timeoutSeconds: number;
}

export interface NarrationResult {
  ok: boolean;
  markdown?: string;
  error?: string;
  /** What produced it — shown to the reader so AI text is never mistaken for computed. */
  producedBy: string;
}

const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/**
 * The prompt.
 *
 * Two constraints matter more than anything else in a finance report:
 * every figure must come from the brief (a model that computes its own totals
 * will produce confident wrong ones), and trends must be silent when the
 * comparison window is not covered.
 */
export function buildPrompt(brief: InsightsBrief, notes = readNotes()): string {
  const facts = {
    period: brief.period,
    spending: dollars(brief.spendingCents),
    income: dollars(brief.incomeCents),
    net: dollars(brief.netCents),
    comparisonAvailable: brief.priorPeriodComparable,
    ...(brief.priorPeriodComparable
      ? { priorSpending: dollars(brief.priorSpendingCents), changePct: brief.spendingChangePct }
      : {}),
    concentration: brief.concentration.map((c) => ({
      category: c.category, amount: dollars(c.cents), pctOfSpending: c.pctOfTotal,
    })),
    ...(brief.priorPeriodComparable
      ? {
        biggestChanges: brief.trends.slice(0, 6).map((t) => ({
          category: t.category, change: dollars(t.changeCents), changePct: t.changePct,
        })),
      }
      : {}),
    // Annual cost is computed HERE, not by the model. The rule below forbids it
    // from doing arithmetic, and the annual figure is the one that makes a
    // cancellation decision obvious — a $40 charge waves through, $1,040 a year
    // does not, and they are the same charge.
    recurring: brief.recurring.slice(0, 12).map((r) => ({
      merchant: r.merchant, typical: dollars(r.medianCents),
      times: r.occurrences, everyDays: r.cadenceDays, total: dollars(r.totalCents),
      ...(r.cadenceDays >= 1
        ? { costPerYear: dollars(Math.round((r.medianCents * 365.25) / r.cadenceDays)) }
        : {}),
    })),
    recurringTotalPerYear: dollars(brief.recurring.reduce(
      (sum, r) => sum + (r.cadenceDays >= 1 ? Math.round((r.medianCents * 365.25) / r.cadenceDays) : 0),
      0,
    )),
    unusualForCategory: brief.unusual.map((u) => ({
      date: u.date, description: u.description, amount: dollars(u.amountCents),
      timesTypicalForCategory: Number(u.multiple.toFixed(1)), category: u.category,
    })),
    firstSeenThisPeriod: brief.newMerchants.slice(0, 8).map((m) => ({
      merchant: m.merchant, total: dollars(m.totalCents), count: m.count,
    })),
    largest: brief.largest.slice(0, 6).map((l) => ({
      date: l.date, description: l.description, amount: dollars(l.amountCents), category: l.category,
    })),
  };

  // The user's own standing context, fenced so it is plainly separate from the
  // data and from the rules. It can only ADD context: the constraints that stop
  // the model inventing figures come after it, deliberately.
  const context = notes ? [
    '',
    'CONTEXT FROM THE ACCOUNT HOLDER — standing notes they maintain about their',
    'own finances. Use it to interpret the data: it explains what a bank',
    'descriptor cannot, and says what is deliberate rather than anomalous. It',
    'does not override the rules below, and it contains no figures you may',
    'quote — every number must still come from the DATA section.',
    '--- notes ---',
    notes.text,
    notes.truncated ? '(their notes were longer than this and were cut off)' : '',
    '--- end notes ---',
    '',
  ].join('\n') : '';

  return `You are reviewing a personal finance summary. Write a short, direct analysis.
${context}

RULES — these matter more than style:
- Use ONLY figures that appear in the JSON below. Never compute, estimate, sum
  or extrapolate a number yourself. A wrong figure in a finance report is worse
  than no analysis.
${brief.priorPeriodComparable
    ? '- Comparisons to the prior period ARE available; use them where useful.'
    : '- NO prior-period comparison is available. Do not describe any trend, increase, decrease or change over time. There is nothing to compare against.'}
- Do not moralise about spending. Observe, do not lecture.
- Say "worth checking" rather than asserting intent — you cannot know why a
  transaction happened.
- If something looks like a duplicate charge or an overlapping subscription,
  flag it as worth verifying, not as fact.

FORMAT — markdown, no top-level heading, at most ~320 words:
**What stands out** — 2-4 bullets on the most notable things.
**Worth a look** — 2-4 bullets: anomalies, duplicates, or things to verify.
**Where the money could go further** — 2-4 bullets on recurring costs worth
questioning. Quote costPerYear from the JSON for each one, because a yearly
figure is what makes the decision obvious. Name what stopping it would save,
using ONLY the numbers given. Do not add them together — no total is provided,
and inventing one breaks the first rule.

For that last section: recurring is not the same as wasteful. Utilities,
insurance and loan payments recur because they must. Point at things that look
optional, duplicated, or larger than their category warrants — and say plainly
when nothing does, rather than manufacturing a suggestion.

DATA:
${JSON.stringify(facts, null, 2)}`;
}

/**
 * Run the narration command.
 *
 * Failure is never fatal — the report is fully useful without narration, so a
 * missing command or a timeout degrades to "not available" rather than
 * costing the user their report.
 */
export function narrate(brief: InsightsBrief, config: NarrationConfig): NarrationResult {
  const producedBy = `${config.command} ${config.args.join(' ')}`.trim();
  if (!config.enabled) return { ok: false, error: 'narration is disabled', producedBy };

  const prompt = buildPrompt(brief);
  const res = spawnSync(config.command, config.args, {
    input: prompt,
    encoding: 'utf8',
    timeout: config.timeoutSeconds * 1_000,
    maxBuffer: 8 * 1024 * 1024,
  });

  if (res.error) {
    const err = res.error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      return { ok: false, producedBy, error: `command not found: ${config.command}` };
    }
    if (err.code === 'ETIMEDOUT') {
      return { ok: false, producedBy, error: `timed out after ${config.timeoutSeconds}s` };
    }
    // EPIPE means the child exited before reading the prompt — a CLI that
    // rejects its arguments, or one not logged in, both land here. The raw
    // "spawnSync <cmd> EPIPE" tells the reader nothing about which, and it is
    // what surfaces in the report when the analysis goes missing.
    if (err.code === 'EPIPE') {
      return {
        ok: false,
        producedBy,
        error: `${config.command} exited before reading the prompt — check it runs and is `
          + `authenticated (try: ${config.command} ${config.args.join(' ')} <<< hello)`,
      };
    }
    return { ok: false, producedBy, error: err.message };
  }
  if (res.status !== 0) {
    return { ok: false, producedBy, error: (res.stderr || '').trim().slice(0, 300) || `exit ${res.status}` };
  }

  const markdown = (res.stdout || '').trim();
  if (!markdown) return { ok: false, producedBy, error: 'command produced no output' };
  return { ok: true, markdown, producedBy };
}

/**
 * Minimal markdown → HTML for the narration block.
 *
 * Deliberately tiny and escape-first: this is model output going into an HTML
 * document, so everything is escaped before any formatting is re-introduced.
 * Only bold, bullets, and paragraphs are supported — enough for the prompt's
 * format, and nothing that can carry markup.
 */
export function markdownToHtml(markdown: string): string {
  const esc = (s: string) => s
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const inline = (s: string) => esc(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|\s)\*([^*]+)\*/g, '$1<em>$2</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');

  const out: string[] = [];
  let inList = false;
  for (const raw of markdown.split('\n')) {
    const line = raw.trim();
    if (!line) { if (inList) { out.push('</ul>'); inList = false; } continue; }

    const bullet = /^[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push(`<li>${inline(bullet[1]!)}</li>`);
      continue;
    }
    if (inList) { out.push('</ul>'); inList = false; }

    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    out.push(heading ? `<h3>${inline(heading[1]!)}</h3>` : `<p>${inline(line)}</p>`);
  }
  if (inList) out.push('</ul>');
  return out.join('\n');
}
