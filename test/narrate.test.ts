// AI narration. Two risks dominate: the model inventing figures for a finance
// report, and its output being injected into an HTML document unescaped.
// Everything else degrades to "no analysis", which is fine.

import { describe, it, expect } from 'vitest';
import { buildPrompt, narrate, markdownToHtml } from '../src/core/narrate.js';
import type { InsightsBrief } from '../src/core/insights.js';

const brief = (over: Partial<InsightsBrief> = {}): InsightsBrief => ({
  period: { start: '2026-06-01', end: '2026-06-30' },
  priorPeriod: { start: '2026-05-02', end: '2026-05-31' },
  priorPeriodComparable: true,
  spendingCents: 500_000,
  priorSpendingCents: 400_000,
  spendingChangePct: 25,
  incomeCents: 900_000,
  netCents: 400_000,
  largest: [],
  trends: [{ category: 'dining', currentCents: 50_000, priorCents: 20_000, changeCents: 30_000, changePct: 150 }],
  recurring: [],
  unusual: [],
  newMerchants: [],
  concentration: [{ category: 'groceries', cents: 200_000, pctOfTotal: 40 }],
  ...over,
});

describe('buildPrompt', () => {
  it('forbids the model computing its own figures', () => {
    // A confidently wrong number in a finance report is worse than no analysis.
    const p = buildPrompt(brief());
    expect(p).toMatch(/Use ONLY figures that appear in the JSON/);
    expect(p).toMatch(/Never compute, estimate, sum/);
  });

  it('forbids describing trends when there is nothing to compare against', () => {
    const p = buildPrompt(brief({ priorPeriodComparable: false }));
    expect(p).toMatch(/NO prior-period comparison is available/);
    expect(p).toMatch(/Do not describe any trend/);
  });

  it('omits comparison data entirely when it is not comparable', () => {
    const p = buildPrompt(brief({ priorPeriodComparable: false }));
    expect(p).not.toMatch(/priorSpending/);
    expect(p).not.toMatch(/biggestChanges/);
  });

  it('includes comparison data when it is comparable', () => {
    const p = buildPrompt(brief());
    expect(p).toMatch(/priorSpending/);
    expect(p).toMatch(/biggestChanges/);
  });

  it('formats money as dollars, not raw cents', () => {
    // Handing a model "500000" invites it to report five hundred thousand.
    const p = buildPrompt(brief());
    expect(p).toContain('$5000.00');
    expect(p).not.toMatch(/"spending":\s*500000/);
  });
});

describe('narrate', () => {
  const cfg = { enabled: true, command: 'echo', args: ['ok'], timeoutSeconds: 10 };

  it('returns the command output', () => {
    expect(narrate(brief(), cfg)).toMatchObject({ ok: true, markdown: 'ok' });
  });

  it('does nothing when disabled', () => {
    expect(narrate(brief(), { ...cfg, enabled: false }).ok).toBe(false);
  });

  it('reports a missing command by name instead of crashing', () => {
    const r = narrate(brief(), { ...cfg, command: 'definitely-not-a-real-command-xyz' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/command not found: definitely-not-a-real-command-xyz/);
  });

  it('treats empty output as failure rather than an empty analysis', () => {
    // Reads the prompt, so the result does not depend on a race with stdin.
    const r = narrate(brief(), { ...cfg, command: 'sh', args: ['-c', 'cat >/dev/null'] });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no output/);
  });

  it('keeps the answer of a command that exits before reading the prompt', () => {
    // `echo` ignores stdin. Whether writing the prompt hits EPIPE depends on
    // timing, so this must pass either way: the command succeeded and answered.
    for (let i = 0; i < 5; i++) {
      expect(narrate(brief(), { ...cfg, command: 'echo', args: ['ok'] })).toMatchObject({ ok: true, markdown: 'ok' });
    }
  });

  it('still fails a command that exits early with nothing to say', () => {
    const r = narrate(brief(), { ...cfg, command: 'true', args: [] });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no output|exited before reading the prompt/);
  });

  it('reports a non-zero exit', () => {
    expect(narrate(brief(), { ...cfg, command: 'false', args: [] }).ok).toBe(false);
  });

  it('names what produced the text, so AI output is attributable', () => {
    expect(narrate(brief(), cfg).producedBy).toBe('echo ok');
  });
});

describe('markdownToHtml', () => {
  it('escapes markup — model output is untrusted input', () => {
    const html = markdownToHtml('<script>alert(1)</script> and <img src=x onerror=y>');
    expect(html).not.toMatch(/<script>/);
    expect(html).not.toMatch(/<img/);
    expect(html).toContain('&lt;script&gt;');
  });

  it('escapes markup inside a bullet too', () => {
    expect(markdownToHtml('- <b>bad</b>')).not.toMatch(/<b>bad<\/b>/);
  });

  it('renders bullets, headings and bold', () => {
    const html = markdownToHtml('## Heading\n\n- one **bold**\n- two\n\nA paragraph.');
    expect(html).toContain('<h3>Heading</h3>');
    expect(html).toContain('<li>one <strong>bold</strong></li>');
    expect(html).toContain('<p>A paragraph.</p>');
    expect(html.match(/<ul>/g)).toHaveLength(1);
    expect(html.match(/<\/ul>/g)).toHaveLength(1);
  });

  it('closes a list that runs to the end of the text', () => {
    const html = markdownToHtml('- one\n- two');
    expect(html.match(/<ul>/g)).toHaveLength(1);
    expect(html.match(/<\/ul>/g)).toHaveLength(1);
  });

  it('survives empty input', () => {
    expect(markdownToHtml('')).toBe('');
  });
});

describe('standing notes', () => {
  it('is absent from the prompt when there are none', () => {
    const prompt = buildPrompt(brief(), null);
    expect(prompt).not.toContain('CONTEXT FROM THE ACCOUNT HOLDER');
  });

  it('fences the notes and keeps the rules after them', () => {
    // The notes may add context; they may not loosen the constraint that every
    // figure comes from the data. Order in the prompt is the guarantee.
    const prompt = buildPrompt(brief(), {
      text: 'The monthly transfer is rent.', truncated: false,
    });
    expect(prompt).toContain('--- notes ---');
    expect(prompt).toContain('The monthly transfer is rent.');
    expect(prompt.indexOf('--- end notes ---'))
      .toBeLessThan(prompt.indexOf('Never compute, estimate, sum'));
  });

  it('says so when the notes were cut off', () => {
    const prompt = buildPrompt(brief(), { text: 'x'.repeat(50), truncated: true });
    expect(prompt).toMatch(/were cut off/);
  });
});
