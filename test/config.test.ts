// Config validation.
//
// The tests that matter here are about keys the schema does NOT know. A config
// file is hand-edited TOML, and TOML's sub-table rule is a trap: once
// `[report.smtp]` opens, every bare key below it belongs to that sub-table no
// matter how it is indented. `ai = true` written under the smtp block parsed as
// report.smtp.ai, the scheduled report ran for weeks with no AI analysis, and
// nothing anywhere said so — because an unknown key was silently discarded.

import { describe, it, expect } from 'vitest';
import { ConfigSchema, defaultConfig, parseConfig } from '../src/core/config.js';

const base = {
  timezone: 'America/Los_Angeles',
  report: { schedule: 'daily' as const, range: 'last-30-days' as const },
};

describe('ConfigSchema', () => {
  it('accepts a minimal valid config', () => {
    expect(() => ConfigSchema.parse(base)).not.toThrow();
  });

  it('rejects a time zone that is not an IANA name', () => {
    // "today" is resolved in this zone, so a typo would otherwise surface as a
    // RangeError inside the first summary rather than at startup.
    expect(() => ConfigSchema.parse({ ...base, timezone: 'Central' })).toThrow(/IANA/);
    expect(() => ConfigSchema.parse({ ...base, timezone: 'Europe/London' })).not.toThrow();
  });

  it('accepts ai on the report table, where it belongs', () => {
    const parsed = ConfigSchema.parse({ ...base, report: { ...base.report, ai: true } });
    expect(parsed.report.ai).toBe(true);
  });
});

describe('unknown keys', () => {
  it('rejects a key that landed in the wrong table', () => {
    // The exact failure, reproduced: ai on report.smtp instead of report.
    expect(() => ConfigSchema.parse({
      ...base,
      report: {
        ...base.report,
        smtp: {
          host: 'smtp.example.com', port: 587,
          user: 'u', to: 't@example.com', from: 'f@example.com',
          ai: true,
        },
      },
    })).toThrow();
  });

  it('rejects a typo rather than ignoring it', () => {
    expect(() => ConfigSchema.parse({
      ...base,
      report: { ...base.report, emailTdo: 'someone@example.com' },
    })).toThrow();
  });

  it('rejects an unknown key on a provider table', () => {
    expect(() => ConfigSchema.parse({
      ...base,
      providers: { plaid: { enabled: true, environment: 'sandbox', binry: 'plaid' } },
    })).toThrow();
  });
});

describe('defaults', () => {
  // zod 4 changed `.default({})` on an object to return `{}` without parsing
  // it, which would have emptied every section a config leaves out. The
  // sections use `.prefault({})`; this fails if one regresses.
  it('fill every nested section of an empty config', () => {
    const c = defaultConfig();
    expect(c.freshness).toEqual({
      balanceTtlMinutes: 15, transactionTtlHours: 6, settledAfterDays: 3, staleWhileRevalidate: false,
    });
    expect(c.narration).toMatchObject({ enabled: false, command: 'claude', args: ['-p'], timeoutSeconds: 120 });
    expect(c.report).toMatchObject({ range: 'last-30-days', deliver: ['notify'], sendEmail: true, ai: false });
    expect(c.report.smtp).toMatchObject({ host: 'smtp.gmail.com', port: 587 });
    expect(c.providers.plaid).toMatchObject({ enabled: false, environment: 'sandbox', ignoreAccounts: [] });
    expect(c.providers.csv).toEqual({ enabled: false, accounts: [] });
  });

  it('fill the rest of a section that is only partly written', () => {
    const c = parseConfig('[report]\nrange = "all"\n[report.smtp]\nport = 465\n');
    expect(c.report.range).toBe('all');
    expect(c.report.deliver).toEqual(['notify']);
    expect(c.report.smtp).toMatchObject({ host: 'smtp.gmail.com', port: 465 });
  });
});
