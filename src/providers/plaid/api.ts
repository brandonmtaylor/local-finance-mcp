// Direct Plaid API calls, used for the one step the Plaid CLI cannot do.
//
// `plaid link` creates an Item with Plaid's default of ~90 days of history and
// exposes no way to change it. `days_requested` can only be set when the link
// token is created, so reaching further back means creating that token here
// instead. Everything else — listing items, fetching and syncing transactions —
// still goes through the CLI, which handles it fine.
//
// Hosted Link is deliberate: Plaid hosts the browser flow and we poll for the
// result, so this needs no local redirect server, no open port, and no callback
// URL registered anywhere.
//
// Credentials arrive as arguments and are never logged. Errors from Plaid are
// surfaced with their error_code and message, which name the actual problem
// (INVALID_API_KEYS, INSTITUTION_NOT_RESPONDING) far better than a status code.

export interface PlaidCredentials {
  clientId: string;
  secret: string;
  environment: 'sandbox' | 'production';
}

export interface HostedLinkSession {
  linkToken: string;
  hostedLinkUrl: string;
  /** When the link token stops being usable — Plaid expires these. */
  expiration: string;
}

export interface ExchangedItem {
  itemId: string;
  accessToken: string;
  institutionId: string | null;
}

/** Injected in tests so no test ever reaches the network. */
export type Fetcher = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const baseUrl = (environment: string) => `https://${environment}.plaid.com`;

interface PlaidErrorBody {
  error_code?: string;
  error_message?: string;
  display_message?: string;
}

async function call<T>(
  path: string,
  credentials: PlaidCredentials,
  body: Record<string, unknown>,
  fetcher: Fetcher,
): Promise<T> {
  const response = await fetcher(`${baseUrl(credentials.environment)}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: credentials.clientId,
      secret: credentials.secret,
      ...body,
    }),
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = (payload ?? {}) as PlaidErrorBody;
    // Plaid's error_code is the actionable part; a bare 400 is not.
    const detail = error.error_code
      ? `${error.error_code}: ${error.error_message ?? error.display_message ?? ''}`.trim()
      : `HTTP ${response.status}`;
    throw new Error(`Plaid ${path} failed — ${detail}`);
  }
  return payload as T;
}

/**
 * Create a Hosted Link session asking for `daysRequested` of history.
 *
 * `days_requested` is a request, not a guarantee: Plaid asks the institution,
 * and the institution decides. Asking for 730 commonly yields less, which is
 * why the caller reports the range that actually arrives rather than the one
 * it asked for.
 */
export async function createHostedLink(
  credentials: PlaidCredentials,
  options: {
    daysRequested: number;
    clientUserId: string;
    clientName?: string;
    countryCodes?: string[];
    language?: string;
    /**
     * Which Plaid products to request. Defaults to transactions.
     *
     * Not every institution supports every product: many brokerages
     * offer `investments` and do NOT offer `transactions`, so a brokerage can only
     * be linked by asking for something else. Requesting a product an
     * institution lacks makes it unselectable in Link rather than failing
     * loudly, which is a confusing way to discover the limitation.
     */
    products?: string[];
  },
  fetcher: Fetcher = globalThis.fetch as unknown as Fetcher,
): Promise<HostedLinkSession> {
  if (!Number.isInteger(options.daysRequested)
      || options.daysRequested < 1 || options.daysRequested > 730) {
    throw new Error('daysRequested must be a whole number of days between 1 and 730.');
  }

  const payload = await call<{
    link_token: string;
    expiration: string;
    hosted_link_url?: string;
  }>('/link/token/create', credentials, {
    user: { client_user_id: options.clientUserId },
    client_name: options.clientName ?? 'local-finance-mcp',
    products: options.products ?? ['transactions'],
    country_codes: options.countryCodes ?? ['US'],
    language: options.language ?? 'en',
    // Only meaningful when transactions is among the products; Plaid rejects
    // the key otherwise.
    ...((options.products ?? ['transactions']).includes('transactions')
      ? { transactions: { days_requested: options.daysRequested } }
      : {}),
    hosted_link: {},
  }, fetcher);

  if (!payload.hosted_link_url) {
    // Hosted Link is not enabled on every team. Say so plainly rather than
    // failing later with an undefined URL.
    throw new Error(
      'Plaid did not return a hosted link URL. Hosted Link may not be enabled for '
      + 'this team — check the Plaid dashboard, or link through the CLI and accept '
      + 'the default history window.',
    );
  }

  return {
    linkToken: payload.link_token,
    hostedLinkUrl: payload.hosted_link_url,
    expiration: payload.expiration,
  };
}

interface LinkTokenGetResponse {
  link_sessions?: Array<{
    results?: {
      item_add_results?: Array<{
        public_token?: string;
        institution_id?: string;
      }>;
    };
  }>;
}

/**
 * Check whether the browser flow has completed, without blocking.
 *
 * Returns null while the session is still open, so the caller controls the
 * polling cadence and can stay interruptible.
 */
export async function pollLinkSession(
  credentials: PlaidCredentials,
  linkToken: string,
  fetcher: Fetcher = globalThis.fetch as unknown as Fetcher,
): Promise<{ publicToken: string; institutionId: string | null } | null> {
  const payload = await call<LinkTokenGetResponse>(
    '/link/token/get', credentials, { link_token: linkToken }, fetcher,
  );

  for (const session of payload.link_sessions ?? []) {
    for (const result of session.results?.item_add_results ?? []) {
      if (result.public_token) {
        return {
          publicToken: result.public_token,
          institutionId: result.institution_id ?? null,
        };
      }
    }
  }
  return null;
}

/** Trade the short-lived public token for the durable access token. */
export async function exchangePublicToken(
  credentials: PlaidCredentials,
  publicToken: string,
  institutionId: string | null,
  fetcher: Fetcher = globalThis.fetch as unknown as Fetcher,
): Promise<ExchangedItem> {
  const payload = await call<{ access_token: string; item_id: string }>(
    '/item/public_token/exchange', credentials, { public_token: publicToken }, fetcher,
  );
  return {
    itemId: payload.item_id,
    accessToken: payload.access_token,
    institutionId,
  };
}

/**
 * Check whether a client_id and secret actually work, and against which
 * environment.
 *
 * Storing a credential that turns out to be wrong is cheap to do and expensive
 * to notice: the failure surfaces on the next sync as Plaid's raw
 * INVALID_API_KEYS, which names neither the key nor the environment, and a
 * sandbox secret pointed at production looks exactly like a typo.
 *
 * `/institutions/get` is the probe because it authenticates without touching
 * an Item — nothing is created, nothing is billed.
 */
export async function verifyCredentials(
  credentials: PlaidCredentials,
  fetcher: Fetcher = globalThis.fetch as unknown as Fetcher,
): Promise<{ ok: true } | { ok: false; reason: string; wrongEnvironment?: 'sandbox' | 'production' }> {
  const probe = async (environment: 'sandbox' | 'production') => {
    try {
      await call('/institutions/get', { ...credentials, environment }, {
        count: 1, offset: 0, country_codes: ['US'],
      }, fetcher);
      return null;
    } catch (err) {
      return (err as Error).message;
    }
  };

  const failure = await probe(credentials.environment);
  if (failure === null) return { ok: true };

  // Only worth a second call when the first failed on the keys themselves —
  // a network error says nothing about which environment they belong to.
  if (/INVALID_API_KEYS|INVALID_SECRET|UNAUTHORIZED/i.test(failure)) {
    const other = credentials.environment === 'production' ? 'sandbox' : 'production';
    if (await probe(other) === null) {
      return {
        ok: false,
        reason: `these credentials are for ${other}, not ${credentials.environment}`,
        wrongEnvironment: other,
      };
    }
  }
  return { ok: false, reason: failure };
}

/**
 * The institution behind an Item, from Plaid rather than from local state.
 *
 * Needed because `item_add_results` frequently omits `institution_id`, so an
 * Item created through this path lands with none recorded — and the natural key
 * that recognises an account across a re-link is (institution, mask, type).
 * Without the institution the key becomes "?|5555|credit", which does not match
 * "ins_000001|5555|credit", and the re-link creates a SECOND copy of the
 * account it was supposed to join. Measured on a real re-link: two credit
 * cards both duplicated, silently, with the totals doubling behind them.
 */
export async function getItemInstitution(
  credentials: PlaidCredentials,
  accessToken: string,
  fetcher: Fetcher = globalThis.fetch as unknown as Fetcher,
): Promise<string | null> {
  try {
    const payload = await call<{ item?: { institution_id?: string | null } }>(
      '/item/get', credentials, { access_token: accessToken }, fetcher,
    );
    return payload.item?.institution_id ?? null;
  } catch {
    // Not worth failing a link over. The account still resolves on mask and
    // type; it is simply weaker, and `doctor` reports the ambiguity.
    return null;
  }
}

/** Plaid's per-call maximum for /investments/transactions/get. */
const PROBE_PAGE_SIZE = 500;
/** Backstop against a bad total looping forever. Two years of a busy brokerage
 *  is in the hundreds, so this is far above any real window. */
const MAX_PROBE_ROWS = 20_000;

export interface InvestmentProbe {
  accounts: Array<{ accountId: string; name: string; type: string; subtype: string | null }>;
  transactions: Array<{
    accountId: string; date: string; name: string; amount: number;
    type: string; subtype: string | null; quantity?: number;
  }>;
  total: number;
}

/**
 * Fetch raw investment activity, for LOOKING at before anything is built on it.
 *
 * Plaid's subtype enum has 48 values including `stock distribution`, `deposit`
 * and `withdrawal` — in principle enough to tell an RSU vest from your own cash
 * arriving. Whether a given institution populates them, or flattens everything
 * into `transfer`, is institution-dependent and undocumented.
 *
 * The Plaid CLI omitting personal_finance_category is the precedent: a parser
 * written from the documentation would have silently filed every transaction
 * as `other`. So this exists to answer "what does this brokerage actually send"
 * before a single mapping is written.
 */
export async function probeInvestments(
  credentials: PlaidCredentials,
  accessToken: string,
  startDate: string,
  endDate: string,
  fetcher: Fetcher = globalThis.fetch as unknown as Fetcher,
): Promise<InvestmentProbe> {
  // account_id is carried through because attributing a bank transfer to the
  // sub-account it came from is the whole reason to fetch these.
  type Row = {
    account_id: string; date: string; name: string; amount: number;
    type: string; subtype: string | null; quantity?: number;
  };
  type Page = {
    accounts?: Array<{ account_id: string; name: string; type: string; subtype: string | null }>;
    investment_transactions?: Row[];
    total_investment_transactions?: number;
  };

  const transactions: Row[] = [];
  let accounts: Page['accounts'] = [];
  let total = 0;

  // Page. 500 is the API maximum per call, and a real two-year brokerage window
  // came back as 508 — one call short by eight rows, which is exactly the size
  // of gap nobody notices. Truncating here would understate cash movements and
  // silently break any reconciliation built on them.
  for (let offset = 0; ; offset += PROBE_PAGE_SIZE) {
    if (offset >= MAX_PROBE_ROWS) break;
    const payload = await call<Page>('/investments/transactions/get', credentials, {
      access_token: accessToken,
      start_date: startDate,
      end_date: endDate,
      options: { count: PROBE_PAGE_SIZE, offset },
    }, fetcher);

    // Accounts repeat on every page; the first page's copy is enough.
    if (offset === 0) {
      accounts = payload.accounts ?? [];
      total = payload.total_investment_transactions ?? 0;
    }

    const page = payload.investment_transactions ?? [];
    transactions.push(...page);
    // Stop on a short page as well as on the count, so a total that disagrees
    // with what is actually returned cannot spin this forever.
    if (page.length < PROBE_PAGE_SIZE || transactions.length >= total) break;
  }

  return {
    accounts: (accounts ?? []).map((a) => ({
      accountId: a.account_id, name: a.name, type: a.type, subtype: a.subtype,
    })),
    transactions: transactions.map((t) => ({
      accountId: t.account_id, date: t.date, name: t.name, amount: t.amount,
      type: t.type, subtype: t.subtype, quantity: t.quantity,
    })),
    total,
  };
}
