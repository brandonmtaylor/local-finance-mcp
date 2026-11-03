// Transaction and account identity.
//
// The load-bearing decision in this project: a provider's ids are scoped to a
// CONNECTION, not to the thing they name. Plaid mints `account_id` and
// `transaction_id` per Item, so re-linking the same bank yields entirely new
// ids for the same real accounts and the same real transactions. Using them as
// primary keys makes a re-link look like a second bank.
//
// So identity is ours and derived from content:
//
//   base_key   hash(account, date, amount, normalized description)
//   occurrence which of several identical transactions this is (0, 1, 2…)
//   txn_id     base_key:occurrence
//
// The occurrence index is what makes this safe. Four identical small donations
// to one charity on the same day are genuinely four transactions with no distinguishing
// field — not even Plaid's full API returns one, having checked: no datetime,
// no reference_number, no check_number. Hashing content alone would merge them.
// Numbering them preserves all four, and — because they are interchangeable —
// it does not matter which copy gets which index.
//
// Two sources delivering the same real transaction therefore produce the same
// txn_id, so deduplication is a consequence of the identity scheme rather than
// a separate repair step. And a category override attached to a txn_id survives
// a re-link, because nothing about that id came from the connection.

import { createHash } from 'node:crypto';

/**
 * Strip the noise a bank adds between one rendering of a description and the
 * next, so the same transaction hashes identically across sources.
 *
 * Deliberately aggressive. Under-normalising splits one transaction into two
 * ids and silently duplicates it; over-normalising merges two transactions that
 * differ only in noise, which the occurrence index then separates anyway. The
 * failure modes are not symmetric, so this leans toward merging.
 */
export function normalizeDescription(description: string): string {
  return description
    .toLowerCase()
    // Collapse all whitespace — statement exports pad columns unpredictably.
    .replace(/\s+/g, ' ')
    // Trailing reference numbers vary in format between renderings of the same
    // row ("REF # BANKREF00001", "REF#BANKREF00001"). Normalise the marker but
    // KEEP the reference itself: it is the strongest signal available, present
    // on about a third of real rows, and it makes otherwise-identical
    // transactions distinguishable.
    .replace(/\bref\s*#\s*/g, 'ref#')
    .trim();
}

/** Content hash for a transaction, before the occurrence index is applied. */
export function baseKey(
  accountId: string,
  date: string,
  amountCents: number,
  description: string,
): string {
  return createHash('sha256')
    .update([accountId, date, String(amountCents), normalizeDescription(description)].join('\0'))
    .digest('hex')
    .slice(0, 32);
}

/** Full transaction id: the content hash plus which duplicate this is. */
export function txnId(base: string, occurrence: number): string {
  return `${base}:${occurrence}`;
}

/**
 * A minted account id.
 *
 * Random rather than derived: an account's name and mask can both change
 * (banks rename products, and a replaced card issues a new mask), and an
 * identity that moves is not an identity. The natural key is used to MATCH a
 * new connection to an existing account — see `matchAccount` — but never to
 * name it.
 */
export function mintAccountId(): string {
  return `acct_${createHash('sha256')
    .update(`${process.hrtime.bigint()}:${Math.trunc(performance.now() * 1e6)}`)
    .digest('hex')
    .slice(0, 20)}`;
}

/**
 * A minted connection id — one per authenticated link to an institution.
 *
 * Derived rather than random, so re-running a sync against the same Plaid Item
 * resolves to the same connection instead of accumulating one per run.
 */
export function mintConnectionId(providerId: string, externalId: string): string {
  return `conn_${createHash('sha256')
    .update(`${providerId}\0${externalId}`)
    .digest('hex')
    .slice(0, 20)}`;
}

/** A minted source id — one account as seen through one connection. */
export function mintSourceId(connectionId: string, externalId: string): string {
  return `src_${createHash('sha256')
    .update(`${connectionId}\0${externalId}`)
    .digest('hex')
    .slice(0, 20)}`;
}

/**
 * The natural key used to recognise an account arriving through a new
 * connection as one already known.
 *
 * Institution plus last-four plus type is near-unique in practice and, unlike
 * the account name, survives a bank's marketing renaming a product. Type and
 * subtype separate the checking and savings that a bank sometimes issues on one
 * number.
 */
export function naturalKey(account: {
  institutionId?: string | null;
  mask?: string | null;
  type?: string | null;
  subtype?: string | null;
}): string | null {
  // Without a mask there is nothing discriminating enough to match on, and a
  // wrong match silently merges two real accounts. Decline instead.
  if (!account.mask) return null;
  return [
    account.institutionId ?? '?',
    account.mask,
    account.type ?? '?',
    account.subtype ?? '?',
  ].join('|');
}
