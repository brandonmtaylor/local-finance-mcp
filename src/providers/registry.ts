// Build the active provider set from config.
//
// The one place that knows which implementations exist. Adding a provider means
// adding a case here and a directory under src/providers/ — nothing else in the
// project changes.

import type { Config } from '../core/config.js';
import { createCsvProvider, type CsvParseIssue } from './csv/index.js';
import { createPlaidProvider } from './plaid/index.js';
import type { Provider } from './types.js';

export interface RegistryOptions {
  /**
   * History to request when linking, in days. Set only by `finance link
   * --days`; leaving it undefined keeps the CLI's default path.
   */
  daysRequested?: number;
  /** Progress for flows that wait on a human. */
  onProgress?: (message: string) => void;
  /** Open the link URL in a browser. Off unless the user asked for it. */
  openBrowser?: boolean;
  /** Plaid products to request when linking. */
  linkProducts?: string[];
  /** Claim a timed-out link session instead of starting a new one. */
  resume?: boolean;
  onCsvIssues?: (issues: CsvParseIssue[]) => void;
}

export function buildProviders(config: Config, options: RegistryOptions = {}): Provider[] {
  const providers: Provider[] = [];

  if (config.providers.csv.enabled && config.providers.csv.accounts.length > 0) {
    providers.push(createCsvProvider({
      id: 'csv',
      accounts: config.providers.csv.accounts,
      onIssues: options.onCsvIssues,
    }));
  }

  if (config.providers.plaid.enabled) {
    providers.push(createPlaidProvider({
      id: 'plaid',
      environment: config.providers.plaid.environment,
      binary: config.providers.plaid.binary,
      ignoreAccounts: config.providers.plaid.ignoreAccounts,
      daysRequested: options.daysRequested,
      linkProducts: options.linkProducts,
      resume: options.resume,
      onProgress: options.onProgress,
      ...(options.openBrowser ? {} : { linkDeps: { openUrl: () => {} } }),
    }));
  }

  return providers;
}
