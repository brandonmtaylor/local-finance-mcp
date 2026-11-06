// The ledger: SQLite schema, migrations, and provider-neutral writes.
//
// SIGN CONVENTION (applies everywhere, no exceptions):
//   amount_cents > 0  → money INTO the account (income, refunds, transfers in)
//   amount_cents < 0  → money OUT of the account (purchases, bills, payments)
// Providers normalize into this. Plaid uses the opposite convention, so its
// adapter negates on the way in. Getting this wrong silently inverts every
// report, so it is asserted in tests.
//
// Money is INTEGER cents throughout. Floats are never used for currency.

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { ledgerPath } from './paths.js';
import {
  baseKey, txnId, mintAccountId, mintSourceId, mintConnectionId, naturalKey,
} from './identity.js';
import { spendGroupFor, type Category } from './normalize.js';

const SCHEMA_VERSION = 2;

// The schema is deliberately a single version rather than a migration chain.
// The previous design keyed accounts and transactions on the PROVIDER's ids,
// which are scoped to a connection — so a re-link produced a second copy of
// every account, and four separate mechanisms existed to paper over that.
// Nothing shipped on the old shape, so it is replaced rather than migrated;
// `openLedger` detects an old ledger and says what to do.

const MIGRATIONS: ReadonlyArray<(db: Database.Database) => void> = [
  (db) => {
    db.exec(`
      CREATE TABLE providers (
        provider_id  TEXT PRIMARY KEY,
        kind         TEXT NOT NULL,
        last_sync_at TEXT
      );

      -- A real-world account. Its id is ours and never changes, so everything
      -- a person attaches to it outlives any particular connection.
      CREATE TABLE accounts (
        account_id     TEXT PRIMARY KEY,
        name           TEXT NOT NULL,
        mask           TEXT,              -- last 4 only, by design
        type           TEXT,
        subtype        TEXT,
        currency       TEXT NOT NULL DEFAULT 'USD',
        institution_id TEXT,
        natural_key    TEXT,              -- how a new connection is recognised
        created_at     TEXT NOT NULL
      );
      CREATE INDEX idx_accounts_natural ON accounts(natural_key);

      -- One authenticated link to an institution: a Plaid Item, or a configured
      -- CSV folder. It owns what belongs to the CONNECTION rather than to any
      -- one account — the cursor above all.
      --
      -- This level exists because Plaid advances one cursor per Item while an
      -- Item covers several accounts. The previous schema had one cursor per
      -- PROVIDER, which fits neither, so cursors were delegated to the Plaid
      -- CLI's own config file — coupling this project to an undocumented
      -- third-party format for want of a table. Putting the cursor on a source
      -- would repeat that mistake one level down.
      CREATE TABLE connections (
        connection_id TEXT PRIMARY KEY,
        provider_id   TEXT NOT NULL REFERENCES providers(provider_id) ON DELETE CASCADE,
        external_id   TEXT NOT NULL,      -- Plaid item_id, or a CSV account key
        cursor        TEXT,
        -- Higher wins when two connections deliver the same transaction. A
        -- fresh re-link outranks what it supersedes, so its deeper history is
        -- preferred without anyone having to choose.
        priority      INTEGER NOT NULL DEFAULT 0,
        active        INTEGER NOT NULL DEFAULT 1,
        linked_at     TEXT NOT NULL,
        UNIQUE(provider_id, external_id)
      );

      -- One account as seen through one connection: the join between a real
      -- account and a link to the bank that reports it.
      CREATE TABLE sources (
        source_id     TEXT PRIMARY KEY,
        connection_id TEXT NOT NULL REFERENCES connections(connection_id) ON DELETE CASCADE,
        account_id    TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
        external_id   TEXT NOT NULL,      -- the provider's account id
        UNIQUE(connection_id, external_id)
      );
      CREATE INDEX idx_sources_account ON sources(account_id);

      -- Rows are stored per source, with full provenance. Which of them COUNT
      -- is decided by visible_transactions below, so nothing is ever deleted to
      -- resolve a duplicate.
      CREATE TABLE transactions (
        txn_id          TEXT NOT NULL,    -- ours: base_key:occurrence
        source_id       TEXT NOT NULL REFERENCES sources(source_id) ON DELETE CASCADE,
        account_id      TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
        external_id     TEXT NOT NULL,    -- the provider's transaction id
        base_key        TEXT NOT NULL,    -- content hash, before occurrence
        occurrence      INTEGER NOT NULL,
        date            TEXT NOT NULL,
        authorized_date TEXT,
        amount_cents    INTEGER NOT NULL,
        currency        TEXT NOT NULL DEFAULT 'USD',
        merchant_name   TEXT,
        description     TEXT NOT NULL,
        category        TEXT NOT NULL,
        category_source TEXT NOT NULL,
        spend_group     TEXT NOT NULL,
        pending         INTEGER NOT NULL DEFAULT 0,
        raw_json        TEXT,
        PRIMARY KEY (txn_id, source_id),
        -- Re-running a sync updates in place instead of duplicating.
        UNIQUE (source_id, external_id)
      );
      CREATE INDEX idx_txn_account_date ON transactions(account_id, date);
      -- Serves the view's dedup subquery: one row per (account, content,
      -- occurrence).
      CREATE INDEX idx_txn_dedup ON transactions(account_id, base_key, occurrence);
      -- Serves the occurrence COUNT on every insert. Without it that count
      -- scans every row the source has ever delivered, making a sync O(n²) in
      -- its own history: measured at 51s to write 60k rows, 0.6s with it.
      CREATE INDEX idx_txn_occurrence ON transactions(source_id, base_key);

      -- What a person decided, kept apart from what a provider delivered.
      --
      -- Separating them is what makes a correction durable: it is keyed on
      -- txn_id alone, which is content-derived, so it survives a re-link, a
      -- provider swap, and the row being re-delivered by a different source.
      -- In the previous schema these were columns on the transaction and were
      -- lost whenever the connection changed.
      CREATE TABLE annotations (
        txn_id            TEXT PRIMARY KEY,
        category_override TEXT,
        -- Derived from category_override when it is set, and the reason an
        -- override actually changes the totals: spend_group decides whether a
        -- row counts as spending at all, so a row reclassified as a card
        -- payment must leave the spending total, not merely display
        -- differently.
        spend_group_override TEXT,
        note              TEXT,
        updated_at        TEXT NOT NULL
      );

      CREATE TABLE tags (
        txn_id   TEXT NOT NULL,
        tag      TEXT NOT NULL,
        added_at TEXT NOT NULL,
        PRIMARY KEY (txn_id, tag)
      );
      CREATE INDEX idx_tags_tag ON tags(tag);

      CREATE TABLE balances (
        source_id       TEXT NOT NULL REFERENCES sources(source_id) ON DELETE CASCADE,
        account_id      TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
        as_of           TEXT NOT NULL,
        current_cents   INTEGER,
        available_cents INTEGER,
        limit_cents     INTEGER,
        PRIMARY KEY (source_id, as_of)
      );

      CREATE TABLE sync_log (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        provider_id TEXT NOT NULL,
        ran_at      TEXT NOT NULL,
        added       INTEGER NOT NULL DEFAULT 0,
        modified    INTEGER NOT NULL DEFAULT 0,
        removed     INTEGER NOT NULL DEFAULT 0,
        error       TEXT
      );

      -- Exactly one row per real transaction, with its annotation applied.
      --
      -- Deduplication falls out of identity rather than being a repair step:
      -- two sources delivering the same transaction produce the same txn_id, so
      -- picking one row per (account, base_key, occurrence) collapses them. The
      -- occurrence index is what keeps four identical donations as four.
      --
      -- Every read path uses this view. The base table exists for provenance
      -- and for diagnostics, whose job is to see what this hides.
      CREATE VIEW visible_transactions AS
        -- category and spend_group are the EFFECTIVE values here, with any
        -- correction already applied. Naming them the same as the base
        -- table's columns is deliberate: every read path already says
        -- t.spend_group, so no site can forget to resolve the override, and a
        -- site added later cannot get it wrong either. The provider's raw
        -- values stay reachable as provider_category / provider_spend_group,
        -- and diagnostics reads the base table when it needs the truth
        -- underneath.
        SELECT t.txn_id, t.source_id, t.account_id, t.external_id,
               t.base_key, t.occurrence, t.date, t.authorized_date,
               t.amount_cents, t.currency, t.merchant_name, t.description,
               t.category_source, t.pending, t.raw_json,
               t.category    AS provider_category,
               t.spend_group AS provider_spend_group,
               a.category_override,
               a.note,
               COALESCE(a.category_override, t.category)       AS category,
               COALESCE(a.spend_group_override, t.spend_group) AS spend_group
          FROM transactions t
          JOIN sources s ON s.source_id = t.source_id
          JOIN connections c ON c.connection_id = s.connection_id AND c.active = 1
          LEFT JOIN annotations a ON a.txn_id = t.txn_id
         WHERE t.source_id = (
                 SELECT t2.source_id
                   FROM transactions t2
                   JOIN sources s2 ON s2.source_id = t2.source_id
                   JOIN connections c2 ON c2.connection_id = s2.connection_id AND c2.active = 1
                  WHERE t2.account_id = t.account_id
                    AND t2.base_key   = t.base_key
                    AND t2.occurrence = t.occurrence
                  ORDER BY c2.priority DESC, c2.linked_at DESC, t2.source_id
                  LIMIT 1
               );
    `);
  },

  // ── v2: projects, vendors, line items ──────────────────────────────────────
  //
  // A project is something you want a running total for: a remodel, a car, a
  // DIY job. It stores the PLAN and a join key. It does NOT store what was
  // spent — that already exists as tagged transactions, and copying amounts
  // here would create a second set of books that disagrees with the first the
  // moment anything is recategorised.
  //
  // Vendors are their own table rather than fields repeated on every line item.
  // The rule: copy what is frozen, reference what changes. A transaction's date
  // and amount never change, so denormalising them is safe. A contractor's
  // phone number is current state — six copies means five of them go stale.
  (db) => {
    db.exec(`
      CREATE TABLE projects (
        project_id    TEXT PRIMARY KEY,
        name          TEXT NOT NULL,
        -- Free text on purpose: remodel, auto, diy, medical. A fixed list would
        -- be wrong within a year.
        type          TEXT,
        -- 'project' ends; 'ongoing' does not. A remodel finishes and can go
        -- over budget; a car costs what it costs every year forever, and the
        -- same budget number means different things to each.
        kind          TEXT NOT NULL CHECK (kind IN ('project','ongoing')),
        status        TEXT NOT NULL CHECK (status IN ('planning','active','done','cancelled')),
        -- The tag joining this project to the ledger. Not a foreign key: a
        -- project is usually created before anything is tagged into it.
        tag           TEXT NOT NULL,
        budget_cents  INTEGER,
        -- NULL for a project, where the budget is the whole job. 'monthly' or
        -- 'yearly' for something ongoing, where a lifetime total answers nothing.
        budget_period TEXT CHECK (budget_period IN ('monthly','yearly')),
        started_on    TEXT,
        target_end_on TEXT,
        ended_on      TEXT,
        note          TEXT,
        created_at    TEXT NOT NULL
      );
      CREATE UNIQUE INDEX idx_projects_tag ON projects(tag);

      CREATE TABLE vendors (
        vendor_id    TEXT PRIMARY KEY,
        company      TEXT NOT NULL,
        contact_name TEXT,
        phone        TEXT,
        email        TEXT,
        note         TEXT,
        created_at   TEXT NOT NULL
      );

      CREATE TABLE line_items (
        item_id      TEXT PRIMARY KEY,
        project_id   TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
        -- Nullable, and SET NULL on delete: plenty of costs have no vendor (a
        -- permit fee, materials), and a line item keeps its own label, so
        -- losing the vendor leaves it readable rather than orphaned.
        vendor_id    TEXT REFERENCES vendors(vendor_id) ON DELETE SET NULL,
        label        TEXT NOT NULL,
        amount_cents INTEGER NOT NULL,
        -- quoted    — priced, not agreed. Not money you owe.
        -- committed — agreed and unpaid. Exposure, never counted as spend:
        --             adding it would double-count the moment the payment
        --             lands and gets tagged.
        -- settled   — paid. The ledger is the record, so this stops counting
        --             here UNLESS off_ledger is set.
        -- cancelled — did not happen.
        status       TEXT NOT NULL CHECK (status IN ('quoted','committed','settled','cancelled')),
        -- Money that no linked account will ever show: cash, a cheque from an
        -- unlinked bank, someone else's card. Counted directly, because nothing
        -- else will ever count it. Every one of these is maintained by hand,
        -- so this is where drift lives.
        off_ledger   INTEGER NOT NULL DEFAULT 0 CHECK (off_ledger IN (0,1)),
        due_on       TEXT,
        settled_on   TEXT,
        note         TEXT,
        created_at   TEXT NOT NULL
      );
      CREATE INDEX idx_line_items_project ON line_items(project_id, status);
      CREATE INDEX idx_line_items_vendor ON line_items(vendor_id);
    `);
  },
];

export function openLedger(path?: string): Database.Database {
  const file = path ?? ledgerPath();
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });

  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');

  assertNotLegacy(db, file);
  migrate(db);
  return db;
}

/**
 * Refuse to open a ledger built on the previous schema.
 *
 * That schema keyed accounts on the provider's ids, so it cannot express the
 * thing this one is built around. Migrating it would mean inventing account
 * identities for rows that never had them; saying so is more honest than
 * guessing, and no ledger has ever shipped that needs preserving.
 */
function assertNotLegacy(db: Database.Database, file: string): void {
  const hasTables = (db.prepare(
    "SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name IN ('accounts','sources')",
  ).get() as { n: number }).n;
  if (hasTables === 0) return; // fresh database

  const hasSources = (db.prepare(
    "SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='sources'",
  ).get() as { n: number }).n;
  if (hasSources > 0) return; // already the current shape

  throw new Error(
    `The ledger at ${file} uses the previous schema, which keyed accounts on the\n`
    + 'provider\'s own ids and so duplicated every account on a re-link.\n\n'
    + 'It cannot be migrated: the new model needs account identities the old rows\n'
    + 'never had. Start a fresh ledger, then re-link:\n\n'
    + `  mv "${file}" "${file}.legacy"\n`
    + '  finance init\n'
    + '  finance link --days 730\n\n'
    + 'Export any category overrides first:\n'
    + `  sqlite3 "${file}" "SELECT date, description, category_override, note FROM transactions `
    + 'WHERE category_override IS NOT NULL OR note IS NOT NULL;"',
  );
}

export function migrate(db: Database.Database): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  if (current >= SCHEMA_VERSION) return;
  const run = db.transaction(() => {
    for (let v = current; v < MIGRATIONS.length; v++) MIGRATIONS[v]!(db);
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  });
  run();
}

export function upsertProvider(db: Database.Database, providerId: string, kind: string): void {
  db.prepare(
    `INSERT INTO providers (provider_id, kind) VALUES (?, ?)
     ON CONFLICT(provider_id) DO UPDATE SET kind = excluded.kind`,
  ).run(providerId, kind);
}

// ── accounts and sources ─────────────────────────────────────────────────────

export interface IncomingAccount {
  /** The provider's id for this account — scoped to the connection. */
  externalId: string;
  name: string;
  mask?: string | null;
  type?: string | null;
  subtype?: string | null;
  currency?: string;
  institutionId?: string | null;
}

export interface ResolvedSource {
  sourceId: string;
  accountId: string;
  /** True when this connection was recognised as an account already known. */
  matchedExisting: boolean;
  /** Set when more than one account matched — recorded rather than asked about. */
  ambiguous?: string[];
}

/**
 * Register a connection, or return the one already recorded.
 *
 * A connection is one authenticated link: a Plaid Item, a configured CSV
 * folder. Priority increases with each new connection to the same provider, so
 * a re-link automatically outranks what it supersedes and its transactions win
 * where both deliver the same row.
 */
export function resolveConnection(
  db: Database.Database,
  providerId: string,
  externalId: string,
): string {
  const existing = db.prepare(
    'SELECT connection_id FROM connections WHERE provider_id = ? AND external_id = ?',
  ).get(providerId, externalId) as { connection_id: string } | undefined;
  if (existing) return existing.connection_id;

  const priority = ((db.prepare(
    'SELECT COALESCE(MAX(priority), -1) AS p FROM connections WHERE provider_id = ?',
  ).get(providerId) as { p: number }).p) + 1;

  const id = mintConnectionId(providerId, externalId);
  db.prepare(
    `INSERT INTO connections (connection_id, provider_id, external_id, priority, linked_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, providerId, externalId, priority, new Date().toISOString());
  return id;
}

/**
 * Attach an account seen through a connection to the real account it belongs
 * to, creating that account if it is genuinely new.
 *
 * This is where a re-link stops being a duplicate. The provider's account id
 * changes, so it identifies the SOURCE; the account it feeds is matched on a
 * natural key that survives re-linking. Match, and the new connection joins the
 * existing account with its history and corrections intact.
 *
 * Deliberately never prompts. Where more than one account matches it takes the
 * one with the most transactions and records that it was ambiguous, so
 * `finance doctor` can surface the decision after the fact. A question at sync
 * time would hang a scheduled job that runs with nobody watching.
 */
export function resolveSource(
  db: Database.Database,
  connectionId: string,
  incoming: IncomingAccount,
): ResolvedSource {
  const existing = db.prepare(
    'SELECT source_id, account_id FROM sources WHERE connection_id = ? AND external_id = ?',
  ).get(connectionId, incoming.externalId) as
    { source_id: string; account_id: string } | undefined;

  if (existing) {
    db.prepare(
      `UPDATE accounts SET name = ?, mask = ?, type = ?, subtype = ?, institution_id = ?
        WHERE account_id = ?`,
    ).run(
      incoming.name, incoming.mask ?? null, incoming.type ?? null,
      incoming.subtype ?? null, incoming.institutionId ?? null, existing.account_id,
    );
    return { sourceId: existing.source_id, accountId: existing.account_id, matchedExisting: true };
  }

  const key = naturalKey(incoming);
  const candidates = key
    ? db.prepare(`
        SELECT a.account_id, COUNT(t.txn_id) AS n
          FROM accounts a LEFT JOIN transactions t ON t.account_id = a.account_id
         WHERE a.natural_key = ?
         GROUP BY a.account_id ORDER BY n DESC, a.created_at
      `).all(key) as Array<{ account_id: string; n: number }>
    : [];

  let accountId: string;
  let matchedExisting = false;
  if (candidates.length > 0) {
    accountId = candidates[0]!.account_id;
    matchedExisting = true;
  } else {
    accountId = mintAccountId();
    db.prepare(
      `INSERT INTO accounts
         (account_id, name, mask, type, subtype, currency, institution_id, natural_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      accountId, incoming.name, incoming.mask ?? null, incoming.type ?? null,
      incoming.subtype ?? null, incoming.currency ?? 'USD',
      incoming.institutionId ?? null, key, new Date().toISOString(),
    );
  }

  const sourceId = mintSourceId(connectionId, incoming.externalId);
  db.prepare(
    'INSERT INTO sources (source_id, connection_id, account_id, external_id) VALUES (?, ?, ?, ?)',
  ).run(sourceId, connectionId, accountId, incoming.externalId);

  return {
    sourceId,
    accountId,
    matchedExisting,
    ...(candidates.length > 1 ? { ambiguous: candidates.map((c) => c.account_id) } : {}),
  };
}

/** Retire a connection without deleting anything it delivered. */
export function setConnectionActive(
  db: Database.Database,
  connectionId: string,
  active: boolean,
): void {
  db.prepare('UPDATE connections SET active = ? WHERE connection_id = ?')
    .run(active ? 1 : 0, connectionId);
}

export interface ConnectionRow {
  connectionId: string;
  providerId: string;
  externalId: string;
  cursor: string | null;
  priority: number;
  active: number;
  linkedAt: string;
}

export function listConnections(db: Database.Database, providerId?: string): ConnectionRow[] {
  const sql = `SELECT connection_id AS connectionId, provider_id AS providerId,
                      external_id AS externalId, cursor, priority, active, linked_at AS linkedAt
                 FROM connections ${providerId ? 'WHERE provider_id = ?' : ''}
                ORDER BY priority DESC`;
  return (providerId ? db.prepare(sql).all(providerId) : db.prepare(sql).all()) as ConnectionRow[];
}

// ── transactions ─────────────────────────────────────────────────────────────

export interface IncomingTransaction {
  /** The provider's transaction id — unique within its source, not beyond it. */
  externalId: string;
  date: string;
  authorizedDate?: string | null;
  amountCents: number;
  currency?: string;
  merchantName?: string | null;
  description: string;
  category: Category;
  categorySource: string;
  pending?: boolean;
  rawJson?: string;
}

/**
 * Write a transaction, deriving its identity from its content.
 *
 * The occurrence index is assigned by counting how many transactions with the
 * same content this SOURCE has already delivered — not how many the account
 * holds. Counting per account would make the second source's first copy of a
 * repeated transaction look like a third occurrence, and duplicate it. Per
 * source, two connections each seeing two identical donations both number them
 * 0 and 1, so they collapse onto the same two ids.
 */
export function upsertTransaction(
  db: Database.Database,
  sourceId: string,
  accountId: string,
  txn: IncomingTransaction,
): string {
  const existing = db.prepare(
    'SELECT txn_id FROM transactions WHERE source_id = ? AND external_id = ?',
  ).get(sourceId, txn.externalId) as { txn_id: string } | undefined;

  const base = baseKey(accountId, txn.date, txn.amountCents, txn.description);
  const id = existing?.txn_id ?? txnId(base, (db.prepare(
    'SELECT COUNT(*) n FROM transactions WHERE source_id = ? AND base_key = ?',
  ).get(sourceId, base) as { n: number }).n);

  db.prepare(`
    INSERT INTO transactions (
      txn_id, source_id, account_id, external_id, base_key, occurrence,
      date, authorized_date, amount_cents, currency, merchant_name, description,
      category, category_source, spend_group, pending, raw_json
    ) VALUES (
      @txnId, @sourceId, @accountId, @externalId, @baseKey, @occurrence,
      @date, @authorizedDate, @amountCents, @currency, @merchantName, @description,
      @category, @categorySource, @spendGroup, @pending, @rawJson
    )
    ON CONFLICT(source_id, external_id) DO UPDATE SET
      date = excluded.date, authorized_date = excluded.authorized_date,
      amount_cents = excluded.amount_cents, merchant_name = excluded.merchant_name,
      description = excluded.description, category = excluded.category,
      category_source = excluded.category_source, spend_group = excluded.spend_group,
      pending = excluded.pending, raw_json = excluded.raw_json
  `).run({
    txnId: id,
    sourceId,
    accountId,
    externalId: txn.externalId,
    baseKey: base,
    occurrence: Number(id.split(':')[1]),
    date: txn.date,
    authorizedDate: txn.authorizedDate ?? null,
    amountCents: txn.amountCents,
    currency: txn.currency ?? 'USD',
    merchantName: txn.merchantName ?? null,
    description: txn.description,
    category: txn.category,
    categorySource: txn.categorySource,
    spendGroup: spendGroupFor(txn.category),
    pending: txn.pending ? 1 : 0,
    rawJson: txn.rawJson ?? null,
  });
  return id;
}

/** Remove a transaction a provider says no longer exists, within one source. */
export function removeTransaction(
  db: Database.Database,
  sourceId: string,
  externalId: string,
): boolean {
  // Returns whether a row was actually deleted. Callers sweep every source of
  // a connection looking for the id — a provider reports removals per
  // connection, not per account — so without this they would count one removal
  // per account rather than one per transaction.
  return db.prepare('DELETE FROM transactions WHERE source_id = ? AND external_id = ?')
    .run(sourceId, externalId).changes > 0;
}

export interface BalanceRow {
  sourceId: string;
  accountId: string;
  asOf: string;
  currentCents?: number | null;
  availableCents?: number | null;
  limitCents?: number | null;
}

export function appendBalance(db: Database.Database, balance: BalanceRow): void {
  db.prepare(
    `INSERT INTO balances (source_id, account_id, as_of, current_cents, available_cents, limit_cents)
     VALUES (@sourceId, @accountId, @asOf, @currentCents, @availableCents, @limitCents)
     ON CONFLICT(source_id, as_of) DO UPDATE SET
       current_cents = excluded.current_cents,
       available_cents = excluded.available_cents,
       limit_cents = excluded.limit_cents`,
  ).run({
    ...balance,
    currentCents: balance.currentCents ?? null,
    availableCents: balance.availableCents ?? null,
    limitCents: balance.limitCents ?? null,
  });
}

// ── annotations: what a person decided ───────────────────────────────────────
//
// Keyed on txn_id alone, in their own table. Because txn_id is derived from
// content rather than from a connection, a correction survives a re-link, a
// provider swap, and the same transaction being re-delivered by a different
// source. In the previous schema these were columns on the transaction row and
// were lost with it.

/**
 * Whether any source has ever delivered this transaction.
 *
 * Annotations carry no foreign key — they must OUTLIVE the row they describe,
 * since a re-link deletes nothing but can leave a transaction arriving from a
 * different source, and cascading would throw away the correction at exactly
 * that moment. But an id that never existed is a typo, and silently accepting
 * it would leave a correction attached to nothing, with no error to chase.
 */
function transactionExists(db: Database.Database, txnId: string): boolean {
  return db.prepare('SELECT 1 FROM transactions WHERE txn_id = ? LIMIT 1').get(txnId) !== undefined;
}

export function setCategoryOverride(
  db: Database.Database,
  txnId: string,
  category: Category | null,
): boolean {
  if (!transactionExists(db, txnId)) return false;
  db.prepare(`
    INSERT INTO annotations (txn_id, category_override, spend_group_override, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(txn_id) DO UPDATE SET
      category_override = excluded.category_override,
      spend_group_override = excluded.spend_group_override,
      updated_at = excluded.updated_at
  `).run(txnId, category, category ? spendGroupFor(category) : null, new Date().toISOString());
  return true;
}

export function setNote(db: Database.Database, txnId: string, note: string | null): boolean {
  if (!transactionExists(db, txnId)) return false;
  db.prepare(`
    INSERT INTO annotations (txn_id, note, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(txn_id) DO UPDATE SET note = excluded.note, updated_at = excluded.updated_at
  `).run(txnId, note, new Date().toISOString());
  return true;
}

/**
 * One spelling per tag, so an episode does not end up split across three.
 *
 * Punctuation is stripped rather than kept: a tag is typed by hand every time
 * it is used, and "tax/deductible" would otherwise never match
 * "tax-deductible". A tag that strips away to nothing is refused by addTag —
 * it would be unmatchable and invisible.
 */
export function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export function addTag(db: Database.Database, txnId: string, tag: string): boolean {
  const normalized = normalizeTag(tag);
  // A tag that normalizes away would be unmatchable and invisible.
  if (!normalized || !transactionExists(db, txnId)) return false;
  const result = db.prepare(
    'INSERT OR IGNORE INTO tags (txn_id, tag, added_at) VALUES (?, ?, ?)',
  ).run(txnId, normalized, new Date().toISOString());
  return result.changes > 0;
}

export function removeTag(db: Database.Database, txnId: string, tag: string): boolean {
  return db.prepare('DELETE FROM tags WHERE txn_id = ? AND tag = ?')
    .run(txnId, normalizeTag(tag)).changes > 0;
}

export function tagsFor(db: Database.Database, txnId: string): string[] {
  return (db.prepare('SELECT tag FROM tags WHERE txn_id = ? ORDER BY tag').all(txnId) as
    Array<{ tag: string }>).map((r) => r.tag);
}

// ── sync bookkeeping ─────────────────────────────────────────────────────────

export function recordSync(
  db: Database.Database,
  providerId: string,
  outcome: { added: number; modified: number; removed: number; error?: string },
): void {
  db.prepare(
    `INSERT INTO sync_log (provider_id, ran_at, added, modified, removed, error)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(providerId, new Date().toISOString(), outcome.added, outcome.modified,
    outcome.removed, outcome.error ?? null);
  if (!outcome.error) {
    db.prepare('UPDATE providers SET last_sync_at = ? WHERE provider_id = ?')
      .run(new Date().toISOString(), providerId);
  }
}

/** Cursors belong to the CONNECTION — Plaid advances one per Item. */
export function setCursor(db: Database.Database, connectionId: string, cursor: string | null): void {
  db.prepare('UPDATE connections SET cursor = ? WHERE connection_id = ?').run(cursor, connectionId);
}

export function getCursor(db: Database.Database, connectionId: string): string | null {
  return (db.prepare('SELECT cursor FROM connections WHERE connection_id = ?').get(connectionId) as
    { cursor: string | null } | undefined)?.cursor ?? null;
}

export function getLastSyncAt(db: Database.Database, providerId: string): Date | null {
  const row = db.prepare('SELECT last_sync_at FROM providers WHERE provider_id = ?')
    .get(providerId) as { last_sync_at: string | null } | undefined;
  return row?.last_sync_at ? new Date(row.last_sync_at) : null;
}
