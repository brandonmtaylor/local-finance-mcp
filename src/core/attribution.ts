// Working out WHICH brokerage sub-account a bank transfer came from.
//
// A brokerage shows up in a bank ledger as one merchant. Every transfer reads
// the same — same name, same category — whether it is proceeds from vested
// shares being sold or your own savings making a round trip. Netted together
// they are meaningless: on a real ledger the same merchant carried a large sum
// of genuine inbound money against roughly a third as much outbound
// round-tripping, and a summary that treats them alike is wrong about both.
//
// The brokerage itself knows the answer, because its own feed reports cash
// movements per sub-account. So: match bank transfers to brokerage cash
// movements on (date, signed amount), which gives ground truth for the overlap
// window, then LEARN the account reference the bank embeds in its description
// and use it to attribute the rows that fall outside that window.
//
// The learning step is what makes this general. Bank descriptions do embed an
// account reference, but it is an account number — it cannot be committed to a
// repository, and it differs for every user and institution. So nothing here
// knows any specific code: the mapping is derived at runtime from transfers
// that matched, and applied to ones that did not.

import { isInternalJournal } from './equity.js';

/** A cash movement reported by the brokerage, for one of its sub-accounts. */
export interface CashMovement {
  date: string;
  /**
   * Signed cents, from the BANK's point of view: positive means money arrived
   * in the bank. Providers vary, so callers normalize before calling — Plaid's
   * investments feed already uses this convention (a withdrawal from the
   * brokerage is positive), which is why the signs line up without adjustment.
   */
  amountCents: number;
  accountId: string;
  accountName: string;
  /**
   * The broker's own label, when the provider supplies one.
   *
   * Carried so a caller can tell a real bank transfer from an internal journal.
   * Tax withheld on a vest is reported as a cash withdrawal indistinguishable
   * in shape from a transfer out, and an equal amount on a nearby date will
   * pair with a genuine transfer and attribute it to the wrong account.
   */
  name?: string;
}

/** A transfer as the bank recorded it. */
export interface BankTransfer {
  txnId: string;
  date: string;
  amountCents: number;
  description: string;
}

export interface Attribution {
  txnId: string;
  accountId: string;
  accountName: string;
  /**
   * `matched` — a brokerage movement of the same amount on (or beside) the same
   * date. `inferred` — no such movement, but the description carries a
   * reference that matched rows proved belongs to this account.
   */
  basis: 'matched' | 'inferred';
  /** Days between the bank date and the brokerage date; 0 for a same-day match. */
  dayGap?: number;
}

export interface AttributionResult {
  attributions: Attribution[];
  /** Transfers no basis could explain — reported, never guessed at. */
  unattributed: BankTransfer[];
  /**
   * The learned reference prefixes, for display and debugging. These are
   * derived from the user's own data and are account identifiers: safe to show
   * the person they belong to, never to log or transmit.
   */
  learned: Array<{ prefix: string; accountId: string; accountName: string; from: number }>;
}

/**
 * ACH settles across a weekend often enough that same-day-only matching drops
 * real pairs, but a wide window invites false pairs between unrelated equal
 * amounts. Three days each way covers a Friday-to-Monday settle.
 */
const MAX_DAY_GAP = 3;

/** A reference has to be long enough that matching it is evidence, not luck. */
const MIN_PREFIX_LENGTH = 6;

function dayGap(a: string, b: string): number {
  const ms = Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`));
  return Number.isFinite(ms) ? Math.round(ms / 86_400_000) : Number.POSITIVE_INFINITY;
}

/**
 * Reference-looking tokens in a bank description.
 *
 * A reference mixes letters and digits, or is a long run of digits. Words are
 * excluded (no digits), and so are short numbers — a posting date like `260429`
 * would otherwise look exactly like a reference, and being six digits it would
 * pass the length test. Requiring a letter alongside digits, or eight-plus
 * digits, keeps dates out.
 */
export function referenceTokens(description: string): string[] {
  return description
    .split(/[\s,;:/\\]+/)
    .map((t) => t.replace(/[^A-Za-z0-9]/g, ''))
    .filter((t) => {
      if (t.length < MIN_PREFIX_LENGTH) return false;
      const hasDigit = /\d/.test(t);
      const hasAlpha = /[A-Za-z]/.test(t);
      if (!hasDigit) return false;
      return hasAlpha || t.length >= 8;
    })
    .map((t) => t.toUpperCase());
}

function commonPrefix(values: string[]): string {
  if (values.length === 0) return '';
  let prefix = values[0]!;
  for (const value of values.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < value.length && prefix[i] === value[i]) i += 1;
    prefix = prefix.slice(0, i);
    if (prefix.length < MIN_PREFIX_LENGTH) return '';
  }
  return prefix;
}

/**
 * Attribute bank transfers to brokerage sub-accounts.
 *
 * Pure: no I/O, no clock. Callers supply both sides and decide what to do with
 * the result — this deliberately does not write to the ledger, because an
 * inference is a suggestion and overwriting a person's own correction with one
 * would be the wrong trade.
 */
export function attributeTransfers(
  transfers: BankTransfer[],
  allMovements: CashMovement[],
): AttributionResult {
  const attributions: Attribution[] = [];

  // Internal journals never reached a bank, so they cannot explain a bank
  // transfer — but they ARE cash withdrawals in the broker's feed, with the
  // same shape and often a similar size. Left in, a vest's tax journal pairs
  // with a genuine transfer of the same amount and attributes it to whichever
  // account happened to withhold the tax.
  const movements = allMovements.filter((m) => !m.name || !isInternalJournal(m.name));

  // ── Phase 1: match on (date, signed amount) ────────────────────────────────
  // Greedy, nearest date first, one-to-one. One-to-one matters: three separate
  // $500 transfers on one day must consume three movements, not match the same
  // movement three times and claim more evidence than exists.
  const claimed = new Set<number>();
  const matchedFor = new Map<string, { accountId: string; accountName: string }>();

  for (const transfer of transfers) {
    let best: { index: number; gap: number } | null = null;
    movements.forEach((movement, index) => {
      if (claimed.has(index)) return;
      if (movement.amountCents !== transfer.amountCents) return;
      const gap = dayGap(transfer.date, movement.date);
      if (gap > MAX_DAY_GAP) return;
      if (!best || gap < best.gap) best = { index, gap };
    });

    if (best) {
      const hit = best as { index: number; gap: number };
      const movement = movements[hit.index]!;
      claimed.add(hit.index);
      matchedFor.set(transfer.txnId, {
        accountId: movement.accountId, accountName: movement.accountName,
      });
      attributions.push({
        txnId: transfer.txnId,
        accountId: movement.accountId,
        accountName: movement.accountName,
        basis: 'matched',
        dayGap: hit.gap,
      });
    }
  }

  // ── Phase 2: learn the reference the bank embeds ───────────────────────────
  // Every token seen for an account, reduced to the prefix they share.
  const byAccount = new Map<string, { name: string; tokens: string[]; rows: number }>();
  const transferById = new Map(transfers.map((t) => [t.txnId, t]));

  for (const [txnId, account] of matchedFor) {
    const transfer = transferById.get(txnId);
    if (!transfer) continue;
    const entry = byAccount.get(account.accountId)
      ?? { name: account.accountName, tokens: [], rows: 0 };
    entry.tokens.push(...referenceTokens(transfer.description));
    entry.rows += 1;
    byAccount.set(account.accountId, entry);
  }

  const candidates: Array<{ prefix: string; accountId: string; accountName: string; from: number }> = [];
  for (const [accountId, entry] of byAccount) {
    // A single matched row gives a whole token with nothing to reduce against,
    // which would over-fit: the transaction-specific suffix would be treated as
    // part of the account reference and match nothing else. Two rows minimum.
    if (entry.rows < 2) continue;
    const prefix = commonPrefix(entry.tokens);
    if (prefix.length < MIN_PREFIX_LENGTH) continue;
    candidates.push({ prefix, accountId, accountName: entry.name, from: entry.rows });
  }

  // Drop any prefix that also prefixes another account's — it cannot decide
  // between them, and a confident wrong answer is worse than no answer.
  const learned = candidates.filter((c) => !candidates.some(
    (other) => other.accountId !== c.accountId
      && (other.prefix.startsWith(c.prefix) || c.prefix.startsWith(other.prefix)),
  ));

  // ── Phase 3: apply the learned references to everything unmatched ──────────
  const unattributed: BankTransfer[] = [];
  for (const transfer of transfers) {
    if (matchedFor.has(transfer.txnId)) continue;
    const tokens = referenceTokens(transfer.description);
    const hits = learned.filter((l) => tokens.some((t) => t.startsWith(l.prefix)));
    // Exactly one, or it is ambiguous and stays unattributed.
    if (hits.length === 1) {
      attributions.push({
        txnId: transfer.txnId,
        accountId: hits[0]!.accountId,
        accountName: hits[0]!.accountName,
        basis: 'inferred',
      });
    } else {
      unattributed.push(transfer);
    }
  }

  return { attributions, unattributed, learned };
}

/** Net cents per sub-account, for reporting. Positive means money reached the bank. */
export function netByAccount(
  transfers: BankTransfer[],
  result: AttributionResult,
): Array<{ accountId: string; accountName: string; netCents: number; count: number }> {
  const amountOf = new Map(transfers.map((t) => [t.txnId, t.amountCents]));
  const totals = new Map<string, { name: string; net: number; count: number }>();

  for (const a of result.attributions) {
    const cents = amountOf.get(a.txnId);
    if (cents === undefined) continue;
    const entry = totals.get(a.accountId) ?? { name: a.accountName, net: 0, count: 0 };
    entry.net += cents;
    entry.count += 1;
    totals.set(a.accountId, entry);
  }

  return [...totals].map(([accountId, e]) => ({
    accountId, accountName: e.name, netCents: e.net, count: e.count,
  })).sort((a, b) => b.netCents - a.netCents);
}
