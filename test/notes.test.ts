// The notes file is appended to every analysis prompt, so what it strips
// matters: the template's guidance once reached the model in full, because
// only the first line of a multi-line comment was removed.

import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureNotesFile, readNotes } from '../src/core/notes.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'finance-notes-')); });

describe('readNotes', () => {
  it('treats the untouched template as no notes at all', () => {
    const { path } = ensureNotesFile(join(dir, 'notes.md'));
    expect(readFileSync(path, 'utf8')).toMatch(/stripped either way/);
    expect(readNotes(path)).toBeNull();
  });

  it('keeps what the user wrote around the template', () => {
    const { path } = ensureNotesFile(join(dir, 'notes.md'));
    writeFileSync(path, readFileSync(path, 'utf8') + 'The monthly Zelle to J. Smith is rent.\n');
    expect(readNotes(path)).toEqual({ text: 'The monthly Zelle to J. Smith is rent.', truncated: false });
  });

  it('strips inline and unclosed comments too', () => {
    const path = join(dir, 'n.md');
    writeFileSync(path, 'Saving for a car. <!-- private aside -->\nKeep the gym.\n<!-- half-written\nthoughts');
    expect(readNotes(path)!.text).toBe('Saving for a car. \nKeep the gym.');
  });
});
