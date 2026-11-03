// The CLI and the MCP server each once hard-coded '0.1.0', so a release bump
// would have left both reporting the old version.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { VERSION } from '../src/core/version.js';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

describe('VERSION', () => {
  it('comes from package.json', () => {
    expect(VERSION).toBe((JSON.parse(read('../package.json')) as { version: string }).version);
  });

  it('is not restated in either consumer', () => {
    for (const file of ['../src/cli.ts', '../src/mcp.ts']) {
      expect(read(file), file).not.toMatch(/version[:(]\s*'\d+\.\d+\.\d+'/);
    }
  });
});
