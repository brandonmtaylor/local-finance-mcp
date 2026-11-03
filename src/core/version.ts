// The package version, read from package.json rather than restated.
//
// The CLI and the MCP server each hard-coded '0.1.0', so the first release
// bump would have left both reporting the old version. src/core and
// dist/core sit at the same depth, so one relative path serves both.

import { readFileSync } from 'node:fs';

export const VERSION: string = (JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as { version: string }).version;
