// Report rendering. The chart is generated markup, so the things worth pinning
// are the ones that break silently: unreadable axes, HTML injection from bank
// data, and accidentally shipping a file that phones home.

import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { niceTicks, collectReportData, renderReport, monthlySeries, cumulativeSeries, resolveRange , isPartialPeriod, axisTickIndices } from '../src/core/report.js';
import {
  openLedger, 
} from '../src/core/ledger.js';
import { seedAccount, seedTxn, type Seeded } from './helpers.js';

let db: Database.Database;
let acct: Seeded;

const txn = (over: Parameters<typeof seedTxn>[2] = {}): string => seedTxn(db, acct, over);

beforeEach(() => {
  db = openLedger(':memory:');
  acct = seedAccount(db, 'a1');
});

describe('niceTicks', () => {
  it('produces round numbers, not max/n', () => {
    // The failure: $12,345 / 4 gave ticks of $3,086, $6,173, $9,259.
    const { ticks } = niceTicks(1_234_500, 4);
    expect(ticks.every((t) => t % 50_000 === 0)).toBe(true);
  });

  it('always covers the data', () => {
    for (const max of [1, 99, 100, 12_345, 1_475_600, 9_999_999]) {
      const { ticks, max: scaleMax } = niceTicks(max, 4);
      expect(scaleMax).toBeGreaterThanOrEqual(max);   // top gridline is never under the tallest bar
      expect(ticks[0]).toBe(0);
      expect(ticks[ticks.length - 1]).toBe(scaleMax); // last tick IS the scale max
    }
  });

  it('snaps the step to 1/2/2.5/5 × a power of ten', () => {
    const steps = [1, 99, 4_321, 88_888].map((m) => {
      const { ticks } = niceTicks(m, 4);
      return ticks[1]! / 10 ** Math.floor(Math.log10(ticks[1]!));
    });
    for (const s of steps) expect([1, 2, 2.5, 5, 10]).toContain(s);
  });

  it('degrades safely on empty or invalid input', () => {
    expect(niceTicks(0).max).toBe(1);
    expect(niceTicks(NaN).max).toBe(1);
    expect(niceTicks(-5).max).toBe(1);
  });

  it('never emits duplicate ticks', () => {
    // A tiny max drove the step below one cent; rounding for display then
    // collapsed the axis to 0, 0, 1, 1, 1.
    for (const max of [1, 2, 3, 7, 50, 99]) {
      const { ticks } = niceTicks(max, 4);
      expect(new Set(ticks).size).toBe(ticks.length);
    }
  });
});

describe('monthlySeries', () => {
  it('buckets by calendar month with spending and income separated', () => {
    txn(({ date: '2026-06-02', amountCents: -5_000 }));
    txn(({ date: '2026-06-20', amountCents: -3_000 }));
    txn(({ date: '2026-07-01', amountCents: 900_000, category: 'income' }));

    const series = monthlySeries(db, '2026-01-01', '2026-12-31');
    expect(series).toEqual([
      { month: '2026-06', spendingCents: 8_000, incomeCents: 0 },
      { month: '2026-07', spendingCents: 0, incomeCents: 900_000 },
    ]);
  });

  it('never emits negative zero', () => {
    txn(({ category: 'transfer', amountCents: -1_000 }));
    const [point] = monthlySeries(db, '2026-01-01', '2026-12-31');
    expect(Object.is(point!.spendingCents, -0)).toBe(false);
  });
});

describe('resolveRange', () => {
  const today = new Date('2026-08-12T00:00:00Z');

  it('resolves fixed-length windows inclusively', () => {
    expect(resolveRange('last-7-days', today)).toEqual({ start: '2026-08-06', end: '2026-08-12' });
    expect(resolveRange('last-30-days', today)).toEqual({ start: '2026-07-14', end: '2026-08-12' });
  });

  it('resolves calendar-anchored windows', () => {
    expect(resolveRange('month-to-date', today)).toEqual({ start: '2026-08-01', end: '2026-08-12' });
    expect(resolveRange('year-to-date', today)).toEqual({ start: '2026-01-01', end: '2026-08-12' });
  });

  it('uses the ledger\'s earliest transaction for "all"', () => {
    // Not an arbitrary far-past date — that would render an empty left half of
    // every chart.
    txn(({ date: '2026-05-14' }));
    txn(({ date: '2026-08-01' }));
    expect(resolveRange('all', today, db)).toEqual({ start: '2026-05-14', end: '2026-08-12' });
  });

  it('falls back sanely when "all" has no data or no db', () => {
    expect(resolveRange('all', today, db).start).toBe('2026-07-14');  // empty ledger
    expect(resolveRange('all', today).start).toBe('2026-07-14');      // no db passed
  });
});

describe('cumulativeSeries', () => {
  it('accumulates forward, never decreasing', () => {
    txn(({ date: '2026-06-01', amountCents: -1_000 }));
    txn(({ date: '2026-06-02', amountCents: -2_000 }));
    txn(({ date: '2026-06-03', amountCents: 500_000, category: 'income' }));

    const series = cumulativeSeries(db, '2026-01-01', '2026-12-31');
    expect(series.map((p) => p.spendingCents)).toEqual([1_000, 3_000, 3_000]);
    expect(series.map((p) => p.incomeCents)).toEqual([0, 0, 500_000]);
  });

  it('is empty for a range with no transactions', () => {
    expect(cumulativeSeries(db, '2020-01-01', '2020-12-31')).toEqual([]);
  });

  it('ends where the headline does when card payments are folded in', () => {
    // Checking only: the card payment IS the record of card spending, so the
    // headline counts it. The charts once counted purchases and bills only,
    // and finished $2,100 short of the number printed above them.
    txn(({ date: '2026-06-01', amountCents: -1_000, category: 'groceries' }));
    txn(({ date: '2026-06-20', amountCents: -210_000, category: 'credit_card_payment' }));
    const headline = collectReportData(db, '2026-06-01', '2026-06-30').summary;
    expect(headline.cardPaymentsCounted).toBe(true);

    const series = cumulativeSeries(db, '2026-06-01', '2026-06-30');
    expect(series[series.length - 1]!.spendingCents).toBe(headline.spendingCents);
    const months = monthlySeries(db, '2026-06-01', '2026-06-30');
    expect(months.reduce((t, m) => t + m.spendingCents, 0)).toBe(headline.spendingCents);
  });
});

describe('renderReport', () => {
  const panel = (id = 'primary', label = 'Primary') =>
    ({ id, label, data: collectReportData(db, '2026-01-01', '2026-12-31') });
  const render = () => renderReport([panel()]);

  beforeEach(() => {
    txn(({ category: 'groceries', amountCents: -8_432, merchantName: 'Kroger' }));
    txn(({ category: 'income', amountCents: 500_000 }));
    txn(({ category: 'credit_card_payment', amountCents: -210_000 }));
  });

  it('is self-contained — no scripts and no external requests', () => {
    const html = render();
    expect(html).not.toMatch(/<script/i);
    // Only the SVG/XHTML namespace URLs are allowed to look like links.
    const external = html.replace(/https?:\/\/www\.w3\.org[^"'\s]*/g, '');
    expect(external).not.toMatch(/https?:\/\//);
  });

  it('escapes merchant names — bank data is untrusted input', () => {
    txn(({
      category: 'shopping', amountCents: -100,
      description: '<img src=x onerror=alert(1)>', merchantName: '<script>bad()</script>',
    }));
    const html = render();
    expect(html).not.toMatch(/<script>bad/);
    expect(html).not.toMatch(/<img src=x/);
    expect(html).toContain('&lt;');
  });

  it('counts the card payment when no card is linked', () => {
    // The fixture has a card payment and no credit account, so the payment IS
    // the only evidence of that spending — excluding it would understate the
    // total by $2,100.
    const html = render();
    expect(html).toMatch(/Spending<\/div>\s*<div class="tile-value">\$2,184</);
  });

  it('excludes it once a card is linked to account for it', () => {
    // The card is its own account, and its purchases belong to it — which is
    // what makes excluding the payment correct rather than a hole.
    const card = seedAccount(db, 'visa', { name: 'Visa', mask: '9999', type: 'credit' });
    seedTxn(db, card, { category: 'shopping', amountCents: -200_000 });

    const html = render();
    expect(html).toContain('Not counted as spending');
    expect(html).toMatch(/\$2,100/);   // reported, but as movement
  });

  it('defines dark values under both the media query and a theme stamp', () => {
    const html = render();
    expect(html).toContain('prefers-color-scheme: dark');
    expect(html).toContain('[data-theme="dark"]');
    // A light stamp must beat OS dark.
    expect(html).toContain(':root:not([data-theme="light"])');
  });

  it('separates the stat tiles from the first section', () => {
    // .tiles is a sibling of <section>, so without its own margin it sits flush
    // against the next block. Caught by eye, not by geometry checks.
    const html = render();
    const tiles = /\.tiles\s*\{[^}]*\}/.exec(html)?.[0] ?? '';
    expect(tiles).toMatch(/margin-bottom/);
  });

  it('shows the date range and a per-month figure on the tiles', () => {
    // "$45,000" means nothing until you know whether it covers one month or six.
    const html = render();
    expect(html).toContain('2026-01-01 → 2026-12-31');
    expect(html).toMatch(/\/mo/);
  });

  it('shows a total beside the percentages', () => {
    expect(render()).toContain('section-total');
  });

  it('renders a script-free range selector when several panels are given', () => {
    // Radio inputs + sibling selectors, so the page stays inert and still opens
    // offline and in a mail client.
    const html = renderReport([panel('primary', 'Last 30 days'), panel('all', 'All time')]);
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain('type="radio"');
    expect(html).toContain('for="tab-primary"');
    expect(html).toContain('for="tab-all"');
    expect(html).toMatch(/#tab-all:checked ~ \.panel-all \{ display: block; \}/);
  });

  it('omits the selector markup for a single panel', () => {
    // The .tabstrip and input[type="radio"] CSS rules are always in the
    // stylesheet and harmless; what must not appear is the control itself.
    const html = render();
    expect(html).not.toContain('<input type="radio"');
    expect(html).not.toContain('<div class="tabstrip">');
  });

  it('refuses to render with no panels', () => {
    expect(() => renderReport([])).toThrow(/at least one panel/);
  });

  it('labels which range the AI analysis describes', () => {
    const html = renderReport(
      [panel('primary', 'Last 30 days'), panel('all', 'All time')],
      { ok: true, markdown: '- a point', producedBy: 'claude -p' },
    );
    expect(html).toMatch(/Analysis <span class="ai-range">Last 30 days<\/span>/);
  });

  it('states the range inside each panel, not only in the page header', () => {
    // The header sits before the radio inputs, so it cannot change per tab —
    // switching to "All time" used to leave the original dates on screen.
    const html = renderReport([panel('primary', 'Last 30 days'), panel('all', 'All time')]);
    const inPanels = html.split('<div class="panel-range">').length - 1;
    expect(inPanels).toBe(2);
    expect(html).not.toMatch(/<div class="sub">2026-01-01 to/);
  });

  it('ships a table view so identity is never color-alone', () => {
    expect(render()).toContain('Table view');
  });

  it('renders with no data at all', () => {
    const empty = openLedger(':memory:');
    expect(() => renderReport([{ id: 'p', label: 'P', data: collectReportData(empty, '2026-01-01', '2026-12-31') }])).not.toThrow();
  });
});

describe('a period that has not finished', () => {
  it('marks month-to-date and year-to-date as partial', () => {
    expect(isPartialPeriod('month-to-date')).toBe(true);
    expect(isPartialPeriod('year-to-date')).toBe(true);
  });

  it('does not mark a completed window as partial', () => {
    // These end today too, but they cover a full span by construction — 30
    // days is 30 days regardless of where the month boundary falls.
    for (const r of ['last-7-days', 'last-30-days', 'last-90-days', 'all'] as const) {
      expect(isPartialPeriod(r)).toBe(false);
    }
  });

  it('says so in the rendered panel', () => {
    // Month-to-date on the 14th is fourteen days, shown beside three complete
    // windows. "$2,000 this month" against "$3,000 last 30 days" reads as
    // spending down a third; the month is half over.
    const data = collectReportData(db, '2026-08-01', '2026-08-14');
    const html = renderReport([{ id: 'mtd', label: 'Month to date', data, partial: true }]);

    expect(html).toContain('This period is not over yet');
    expect(html).toContain('(so far)');
  });

  it('stays quiet for a complete one', () => {
    const data = collectReportData(db, '2026-07-01', '2026-07-31');
    const html = renderReport([{ id: 'p', label: 'July', data }]);
    expect(html).not.toContain('This period is not over yet');
    expect(html).not.toContain('(so far)');
  });
});

describe('drill-down', () => {
  it('renders transactions inside <details>, with no script', () => {
    // The report is read in a mail client as often as a browser, and mail
    // clients do not run JavaScript. A drill-down built on a script would be
    // dead exactly where the report is most often opened.
    for (let i = 0; i < 3; i += 1) {
      txn({
        date: `2026-06-0${i + 1}`, amountCents: -10_000 * (i + 1),
        description: `MERCHANT ${i}`, category: 'groceries',
      });
    }

    const html = renderReport([{
      label: 'test', id: 't',
      data: collectReportData(db, '2026-06-01', '2026-06-30', new Date('2026-07-01T00:00:00Z')),
    }]);

    expect(html).not.toMatch(/<script/i);
    expect(html).toMatch(/class="drill"/);
    expect(html).toContain('3 transactions');
    expect(html).toContain('MERCHANT 0');
  });

  it('caps how many it inlines and says it capped them', () => {
    // A twelve-month window has thousands of rows; inlining all of them turns a
    // report you can email into one you cannot.
    for (let i = 0; i < 40; i += 1) {
      txn({
        date: '2026-06-15', amountCents: -1_000 - i,
        description: `ROW ${i}`, category: 'groceries',
      });
    }

    const data = collectReportData(db, '2026-06-01', '2026-06-30', new Date('2026-07-01T00:00:00Z'));
    expect(data.categoryDetail.groceries!.total).toBe(40);
    expect(data.categoryDetail.groceries!.shown).toBeLessThan(40);

    const html = renderReport([{ label: 'test', id: 't', data }]);
    expect(html).toMatch(/showing the \d+ largest of 40/);
  });
});

describe('axisTickIndices', () => {
  // Labels are ~40 viewBox units wide; two closer than half a stride overlap.
  it('never puts a label right beside the forced last one', () => {
    for (let n = 2; n <= 400; n++) {
      const t = axisTickIndices(n);
      expect(t[0]).toBe(0);
      expect(t[t.length - 1]).toBe(n - 1);
      const stride = Math.max(1, Math.round((n - 1) / 5));
      for (let k = 1; k < t.length; k++) {
        expect(t[k]! - t[k - 1]!, `n=${n}`).toBeGreaterThanOrEqual(Math.min(stride, Math.ceil(stride * 0.6)));
      }
    }
  });

  it('drops the tick that collided on the reported ledger', () => {
    // 52 days with activity: stride 10 put ticks at 50 and 51.
    expect(axisTickIndices(52)).toEqual([0, 10, 20, 30, 40, 51]);
  });

  it('handles degenerate sizes', () => {
    expect(axisTickIndices(0)).toEqual([]);
    expect(axisTickIndices(1)).toEqual([0]);
    expect(axisTickIndices(2)).toEqual([0, 1]);
  });
});
