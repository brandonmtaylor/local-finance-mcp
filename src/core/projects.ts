// Projects: a running total for a thing, with a plan around it.
//
// The ledger already answers "what did I spend" per tag. It cannot answer "what
// was this supposed to cost", "what did I pay in cash", or "what have I signed
// for and not yet paid". A signed $9,800 deck rebuild with a $2,940 deposit due
// shows as $0 until money moves — correct, and useless for deciding whether to
// take on anything else.
//
// Two rules hold this together.
//
// A project stores the PLAN and a join key, never a copy of what was spent.
// Spend lives in the ledger as tagged transactions and is summed at read time.
// Copying amounts here would create a second set of books, and the two would
// disagree the first time a transaction was recategorised.
//
// Committed money is NEVER spend. A deposit that is promised and then paid
// would otherwise count twice — once as the commitment, once as the
// transaction it becomes. Commitments are reported beside spend as exposure,
// and marked settled when the payment lands.

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

export type ProjectKind = 'project' | 'ongoing';
export type ProjectStatus = 'planning' | 'active' | 'done' | 'cancelled';
export type ItemStatus = 'quoted' | 'committed' | 'settled' | 'cancelled';

export interface Project {
  projectId: string;
  name: string;
  type: string | null;
  kind: ProjectKind;
  status: ProjectStatus;
  tag: string;
  budgetCents: number | null;
  budgetPeriod: 'monthly' | 'yearly' | null;
  startedOn: string | null;
  targetEndOn: string | null;
  endedOn: string | null;
  note: string | null;
}

export interface Vendor {
  vendorId: string;
  company: string;
  contactName: string | null;
  phone: string | null;
  email: string | null;
  note: string | null;
}

export interface LineItem {
  itemId: string;
  projectId: string;
  vendorId: string | null;
  vendor: Vendor | null;
  label: string;
  amountCents: number;
  status: ItemStatus;
  offLedger: boolean;
  dueOn: string | null;
  settledOn: string | null;
  note: string | null;
}

export interface ProjectReport {
  project: Project;
  /** Summed from tagged ledger rows. Positive cents. */
  ledgerCents: number;
  ledgerCount: number;
  firstDate: string | null;
  lastDate: string | null;
  /** Settled line items that no account will ever show. */
  offLedgerCents: number;
  /** ledger + off-ledger: what has actually left your hands. */
  spentCents: number;
  /** Agreed and unpaid. NOT part of spentCents. */
  committedCents: number;
  /** Priced but not agreed. Not money you owe yet. */
  quotedCents: number;
  /** spent + committed: what this costs you if nothing changes. */
  exposureCents: number;
  budgetCents: number | null;
  /**
   * The dates the budget is measured over. For an ongoing project with a
   * period and no explicit window, the current month or year — a $500 monthly
   * budget compared against lifetime spend reports nonsense. Null means the
   * budget covers everything counted in spentCents.
   */
  budgetWindow: { startDate: string; endDate: string } | null;
  /** What counts against the budget: spentCents, narrowed to budgetWindow. */
  budgetSpentCents: number;
  /** budget − budgetSpent. Null without a budget. Negative means over. */
  remainingCents: number | null;
  /** budget − budgetSpent − committed: what is left once commitments are honoured. */
  remainingAfterCommitmentsCents: number | null;
  items: LineItem[];
}

/**
 * Which ledger rows count toward a project.
 *
 * Everything tagged EXCEPT income. Deliberately wider than `tagTotals`, which
 * counts only `purchases` and `bills`: a contractor paid by cheque or transfer
 * categorises as `transfer`, and a card cleared for a job categorises as
 * `credit_card_payment`. Under the narrower filter a genuinely paid deposit
 * reports as zero — precisely the blindness a project exists to fix.
 *
 * Income is excluded so a rebate against the job reduces its cost (it does,
 * as a positive amount inside these groups) while a paycheque that happened to
 * be tagged does not.
 */
const COUNTED_GROUPS = "('purchases','bills','payments','transfers')";

const newId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 16)}`;

/** Normalize a name into a tag: lowercase, hyphenated, no surprises. */
export function slugify(name: string): string {
  return name.toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function toProject(r: Record<string, unknown>): Project {
  return {
    projectId: r.project_id as string,
    name: r.name as string,
    type: (r.type as string | null) ?? null,
    kind: r.kind as ProjectKind,
    status: r.status as ProjectStatus,
    tag: r.tag as string,
    budgetCents: (r.budget_cents as number | null) ?? null,
    budgetPeriod: (r.budget_period as 'monthly' | 'yearly' | null) ?? null,
    startedOn: (r.started_on as string | null) ?? null,
    targetEndOn: (r.target_end_on as string | null) ?? null,
    endedOn: (r.ended_on as string | null) ?? null,
    note: (r.note as string | null) ?? null,
  };
}

function toVendor(r: Record<string, unknown>): Vendor {
  return {
    vendorId: r.vendor_id as string,
    company: r.company as string,
    contactName: (r.contact_name as string | null) ?? null,
    phone: (r.phone as string | null) ?? null,
    email: (r.email as string | null) ?? null,
    note: (r.note as string | null) ?? null,
  };
}

// ── projects ─────────────────────────────────────────────────────────────────

export function createProject(
  db: Database.Database,
  input: {
    name: string;
    type?: string | null;
    kind?: ProjectKind;
    tag?: string;
    budgetCents?: number | null;
    budgetPeriod?: 'monthly' | 'yearly' | null;
    startedOn?: string | null;
    targetEndOn?: string | null;
    note?: string | null;
  },
): Project {
  const name = input.name.trim();
  if (!name) throw new Error('a project needs a name');
  const kind = input.kind ?? 'project';
  const tag = (input.tag ?? slugify(name)).trim();
  if (!tag) throw new Error(`could not derive a tag from "${name}" — pass one explicitly`);

  if (kind === 'project' && input.budgetPeriod) {
    // A project's budget is the whole job. A period would silently redefine
    // what over-budget means.
    throw new Error('a project budget is the total for the job, so it takes no period');
  }
  if (db.prepare('SELECT 1 FROM projects WHERE tag = ?').get(tag)) {
    throw new Error(`tag "${tag}" already belongs to another project`);
  }

  const projectId = newId('prj');
  db.prepare(`
    INSERT INTO projects (project_id, name, type, kind, status, tag, budget_cents,
                          budget_period, started_on, target_end_on, note, created_at)
    VALUES (@projectId, @name, @type, @kind, 'active', @tag, @budgetCents,
            @budgetPeriod, @startedOn, @targetEndOn, @note, @createdAt)
  `).run({
    projectId, name, kind, tag,
    type: input.type ?? null,
    budgetCents: input.budgetCents ?? null,
    budgetPeriod: kind === 'ongoing' ? (input.budgetPeriod ?? null) : null,
    startedOn: input.startedOn ?? null,
    targetEndOn: input.targetEndOn ?? null,
    note: input.note ?? null,
    createdAt: new Date().toISOString(),
  });
  return getProject(db, projectId)!;
}

/** Look up by id, tag, or name — whichever the caller happens to have. */
export function getProject(db: Database.Database, key: string): Project | null {
  const row = db.prepare(`
    SELECT * FROM projects
     WHERE project_id = @k OR tag = @k OR lower(name) = lower(@k)
     LIMIT 1
  `).get({ k: key }) as Record<string, unknown> | undefined;
  return row ? toProject(row) : null;
}

export function listProjects(db: Database.Database, includeClosed = false): Project[] {
  const rows = db.prepare(`
    SELECT * FROM projects
     ${includeClosed ? '' : "WHERE status IN ('planning','active')"}
     ORDER BY status, created_at DESC
  `).all() as Array<Record<string, unknown>>;
  return rows.map(toProject);
}

/**
 * Change a project's plan after the fact.
 *
 * Every field is optional and an omitted one is left alone, so a caller can
 * correct a budget without knowing the note.
 *
 * `tag` is deliberately NOT updatable. It is the join key: changing it would
 * silently orphan every transaction already tagged into the project, and the
 * spend would drop to zero with nothing to explain why. Create a new project
 * and re-tag if the key really has to move.
 */
export function updateProject(
  db: Database.Database,
  key: string,
  patch: {
    name?: string;
    type?: string | null;
    budgetCents?: number | null;
    budgetPeriod?: 'monthly' | 'yearly' | null;
    startedOn?: string | null;
    targetEndOn?: string | null;
    status?: ProjectStatus;
    note?: string | null;
  },
): Project {
  const existing = getProject(db, key);
  if (!existing) throw new Error(`no project matching "${key}"`);

  const kind = existing.kind;
  if (kind === 'project' && patch.budgetPeriod) {
    throw new Error('a project budget is the total for the job, so it takes no period');
  }

  const merged = {
    projectId: existing.projectId,
    name: patch.name ?? existing.name,
    type: patch.type !== undefined ? patch.type : existing.type,
    budgetCents: patch.budgetCents !== undefined ? patch.budgetCents : existing.budgetCents,
    budgetPeriod: patch.budgetPeriod !== undefined ? patch.budgetPeriod : existing.budgetPeriod,
    startedOn: patch.startedOn !== undefined ? patch.startedOn : existing.startedOn,
    targetEndOn: patch.targetEndOn !== undefined ? patch.targetEndOn : existing.targetEndOn,
    status: patch.status ?? existing.status,
    note: patch.note !== undefined ? patch.note : existing.note,
  };

  db.prepare(`
    UPDATE projects SET name = @name, type = @type, budget_cents = @budgetCents,
           budget_period = @budgetPeriod, started_on = @startedOn,
           target_end_on = @targetEndOn, status = @status, note = @note
     WHERE project_id = @projectId
  `).run(merged);
  return getProject(db, existing.projectId)!;
}

export function closeProject(
  db: Database.Database, projectId: string, status: ProjectStatus = 'done',
): void {
  const info = db.prepare(
    'UPDATE projects SET status = ?, ended_on = ? WHERE project_id = ?',
  ).run(status, new Date().toISOString().slice(0, 10), projectId);
  if (info.changes === 0) throw new Error(`no project with id ${projectId}`);
}

// ── vendors ──────────────────────────────────────────────────────────────────

export function upsertVendor(
  db: Database.Database,
  input: {
    company: string; contactName?: string | null; phone?: string | null;
    email?: string | null; note?: string | null;
  },
): Vendor {
  const company = input.company.trim();
  if (!company) throw new Error('a vendor needs a company name');

  const existing = db.prepare(
    'SELECT * FROM vendors WHERE lower(company) = lower(?)',
  ).get(company) as Record<string, unknown> | undefined;

  if (existing) {
    // Update in place. One row is the point: a contractor's phone number is
    // current state, and six copies means five of them go stale.
    db.prepare(`
      UPDATE vendors SET
        contact_name = COALESCE(@contactName, contact_name),
        phone        = COALESCE(@phone, phone),
        email        = COALESCE(@email, email),
        note         = COALESCE(@note, note)
      WHERE vendor_id = @vendorId
    `).run({
      vendorId: existing.vendor_id as string,
      contactName: input.contactName ?? null,
      phone: input.phone ?? null,
      email: input.email ?? null,
      note: input.note ?? null,
    });
    return getVendor(db, existing.vendor_id as string)!;
  }

  const vendorId = newId('ven');
  db.prepare(`
    INSERT INTO vendors (vendor_id, company, contact_name, phone, email, note, created_at)
    VALUES (@vendorId, @company, @contactName, @phone, @email, @note, @createdAt)
  `).run({
    vendorId, company,
    contactName: input.contactName ?? null,
    phone: input.phone ?? null,
    email: input.email ?? null,
    note: input.note ?? null,
    createdAt: new Date().toISOString(),
  });
  return getVendor(db, vendorId)!;
}

export function getVendor(db: Database.Database, key: string): Vendor | null {
  const row = db.prepare(
    'SELECT * FROM vendors WHERE vendor_id = @k OR lower(company) = lower(@k) LIMIT 1',
  ).get({ k: key }) as Record<string, unknown> | undefined;
  return row ? toVendor(row) : null;
}

export function listVendors(db: Database.Database): Vendor[] {
  return (db.prepare('SELECT * FROM vendors ORDER BY company').all() as Array<Record<string, unknown>>)
    .map(toVendor);
}

// ── line items ───────────────────────────────────────────────────────────────

export function addLineItem(
  db: Database.Database,
  projectId: string,
  input: {
    label: string;
    amountCents: number;
    status?: ItemStatus;
    vendorId?: string | null;
    offLedger?: boolean;
    dueOn?: string | null;
    /** When a settled item was paid. Defaults to today. */
    settledOn?: string | null;
    note?: string | null;
  },
): LineItem {
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    // Every status here describes money going out. A negative would quietly
    // turn a commitment into a credit, which no caller means.
    throw new Error('amount must be a positive whole number of cents');
  }
  const status = input.status ?? 'quoted';
  const offLedger = input.offLedger ?? false;
  if (offLedger && status !== 'settled') {
    // Off-ledger means "already spent, and nothing will ever show it". That is
    // only coherent for money that has actually gone.
    throw new Error('off-ledger costs are money already spent, so they must be settled');
  }

  const itemId = newId('itm');
  db.prepare(`
    INSERT INTO line_items (item_id, project_id, vendor_id, label, amount_cents,
                            status, off_ledger, due_on, settled_on, note, created_at)
    VALUES (@itemId, @projectId, @vendorId, @label, @amountCents,
            @status, @offLedger, @dueOn, @settledOn, @note, @createdAt)
  `).run({
    itemId, projectId,
    vendorId: input.vendorId ?? null,
    label: input.label.trim(),
    amountCents: input.amountCents,
    status,
    offLedger: offLedger ? 1 : 0,
    dueOn: input.dueOn ?? null,
    settledOn: status === 'settled' ? (input.settledOn ?? new Date().toISOString().slice(0, 10)) : null,
    note: input.note ?? null,
    createdAt: new Date().toISOString(),
  });
  return listLineItems(db, projectId).find((i) => i.itemId === itemId)!;
}

export function listLineItems(db: Database.Database, projectId: string): LineItem[] {
  const rows = db.prepare(`
    SELECT i.*, v.vendor_id AS v_id, v.company, v.contact_name, v.phone, v.email,
           v.note AS v_note
      FROM line_items i
      LEFT JOIN vendors v ON v.vendor_id = i.vendor_id
     WHERE i.project_id = ?
     ORDER BY i.created_at
  `).all(projectId) as Array<Record<string, unknown>>;

  return rows.map((r) => ({
    itemId: r.item_id as string,
    projectId: r.project_id as string,
    vendorId: (r.vendor_id as string | null) ?? null,
    vendor: r.v_id
      ? toVendor({
        vendor_id: r.v_id, company: r.company, contact_name: r.contact_name,
        phone: r.phone, email: r.email, note: r.v_note,
      })
      : null,
    label: r.label as string,
    amountCents: r.amount_cents as number,
    status: r.status as ItemStatus,
    offLedger: (r.off_ledger as number) === 1,
    dueOn: (r.due_on as string | null) ?? null,
    settledOn: (r.settled_on as string | null) ?? null,
    note: (r.note as string | null) ?? null,
  }));
}

/**
 * Mark a committed item paid.
 *
 * The step that prevents double-counting. Once the payment lands and is tagged,
 * the ledger is the record; leaving the commitment open reports the same money
 * as both spent and still owed. Explicit rather than inferred, because guessing
 * which transaction discharged which commitment would be wrong quietly.
 */
export function settleLineItem(db: Database.Database, itemId: string, on?: string): void {
  const info = db.prepare(`
    UPDATE line_items SET status = 'settled', settled_on = ?
     WHERE item_id = ? AND status IN ('quoted','committed')
  `).run(on ?? new Date().toISOString().slice(0, 10), itemId);
  if (info.changes === 0) throw new Error(`no open line item with id ${itemId}`);
}

export function setLineItemStatus(
  db: Database.Database, itemId: string, status: ItemStatus,
): void {
  const info = db.prepare('UPDATE line_items SET status = ? WHERE item_id = ?')
    .run(status, itemId);
  if (info.changes === 0) throw new Error(`no line item with id ${itemId}`);
}

// ── reporting ────────────────────────────────────────────────────────────────

export function projectReport(
  db: Database.Database,
  key: string,
  window?: { startDate?: string; endDate?: string },
  now: Date = new Date(),
): ProjectReport | null {
  const project = getProject(db, key);
  if (!project) return null;

  const ledgerSpend = (w?: { startDate?: string; endDate?: string }) => {
    const where = [`t.spend_group IN ${COUNTED_GROUPS}`, 'g.tag = @tag'];
    const params: Record<string, unknown> = { tag: project.tag };
    if (w?.startDate) { where.push('t.date >= @startDate'); params.startDate = w.startDate; }
    if (w?.endDate) { where.push('t.date <= @endDate'); params.endDate = w.endDate; }
    return db.prepare(`
      SELECT COALESCE(-SUM(t.amount_cents), 0) AS cents, COUNT(*) AS n,
             MIN(t.date) AS first_date, MAX(t.date) AS last_date
        FROM visible_transactions t
        JOIN tags g ON g.txn_id = t.txn_id
       WHERE ${where.join(' AND ')}
    `).get(params) as { cents: number; n: number; first_date: string | null; last_date: string | null };
  };
  const led = ledgerSpend(window);

  const items = listLineItems(db, project.projectId);
  const sum = (pick: (i: LineItem) => boolean) =>
    items.filter(pick).reduce((total, i) => total + i.amountCents, 0);

  const offLedgerCents = sum((i) => i.status === 'settled' && i.offLedger);
  const committedCents = sum((i) => i.status === 'committed');
  const quotedCents = sum((i) => i.status === 'quoted');

  const spentCents = led.cents + offLedgerCents;
  const exposureCents = spentCents + committedCents;

  // A caller's explicit window wins: they chose what to measure. Otherwise a
  // periodic budget is measured over the period it is a budget FOR.
  const budgetWindow = window || !project.budgetPeriod
    ? null
    : currentPeriod(project.budgetPeriod, now);
  const budgetSpentCents = budgetWindow
    ? ledgerSpend(budgetWindow).cents + sum((i) => i.status === 'settled' && i.offLedger
      && i.settledOn !== null
      && i.settledOn >= budgetWindow.startDate && i.settledOn <= budgetWindow.endDate)
    : spentCents;

  return {
    project,
    ledgerCents: led.cents,
    ledgerCount: led.n,
    firstDate: led.first_date,
    lastDate: led.last_date,
    offLedgerCents,
    spentCents,
    committedCents,
    quotedCents,
    exposureCents,
    budgetCents: project.budgetCents,
    budgetWindow,
    budgetSpentCents,
    remainingCents: project.budgetCents === null ? null : project.budgetCents - budgetSpentCents,
    remainingAfterCommitmentsCents:
      project.budgetCents === null ? null : project.budgetCents - budgetSpentCents - committedCents,
    items,
  };
}

/** The calendar month or year containing `now`, as inclusive YYYY-MM-DD bounds. */
function currentPeriod(
  period: 'monthly' | 'yearly', now: Date,
): { startDate: string; endDate: string } {
  const y = now.getFullYear();
  const pad = (n: number) => String(n).padStart(2, '0');
  if (period === 'yearly') return { startDate: `${y}-01-01`, endDate: `${y}-12-31` };
  const m = now.getMonth() + 1;
  const last = new Date(y, m, 0).getDate();
  return { startDate: `${y}-${pad(m)}-01`, endDate: `${y}-${pad(m)}-${pad(last)}` };
}

export function allProjectReports(db: Database.Database, includeClosed = false): ProjectReport[] {
  return listProjects(db, includeClosed)
    .map((p) => projectReport(db, p.projectId))
    .filter((r): r is ProjectReport => r !== null);
}

/**
 * Total agreed and unpaid across live projects.
 *
 * What affordability actually wants: cash already spoken for. It is a one-off
 * drain rather than a monthly obligation, so it belongs against reserves and
 * not against monthly net.
 */
export function totalCommitted(db: Database.Database): number {
  const row = db.prepare(`
    SELECT COALESCE(SUM(i.amount_cents), 0) AS cents
      FROM line_items i JOIN projects p ON p.project_id = i.project_id
     WHERE i.status = 'committed' AND p.status IN ('planning','active')
  `).get() as { cents: number };
  return row.cents;
}
