# Backlog

Known gaps, with the evidence that found them. Ordered by how much damage they
do if left alone.

Every item marked **silent** produces wrong numbers that look plausible — no
error, no warning. For a finance tool that is the worst failure mode there is:
you act on the number.

---

## Done

### The identity rewrite (supersedes several entries below)
Accounts and transactions were keyed on the PROVIDER's ids, which are scoped to
a connection — so re-linking a bank duplicated every account, orphaned every
correction, and left Plaid's per-Item cursors with nowhere to live but the
Plaid CLI's own config file. `accounts` / `connections` / `sources` now
separate the real account from the link that reports it, and `txn_id` is
derived from content plus an occurrence index.

Resolved by it, without separate work: duplicate-account detection and repair,
`ignoreAccounts` in every form, `account-remove`, and the proposed
dedupe/merge command. Corrections survive a re-link because nothing about
their id came from the connection.

### `finance setup` exists
Preflight, then CSV column detection with three real rows to eyeball, then the
config block written for you. CSV is offered first deliberately — it needs no
account, no keys and no third party, so someone can have real numbers on screen
before deciding whether Plaid is worth the setup at all.

### Overlapping CSV exports no longer double-count
Each FILE is now its own source, so two downloads covering an overlapping month
each number their copy of a shared transaction 0 and the view keeps one. This
replaces the planned per-account date bounds entirely — no ranges to declare,
nothing to get wrong. Two identical rows within one file still get 0 and 1 and
both survive, which is the case the occurrence index exists for.

### Credentials are checked when stored
`finance secret set plaid …` probes /institutions/get, which authenticates
without touching an Item. When the keys fail for the configured environment it
tries the other and, if that works, says which one they belong to — the case
that otherwise surfaces later as a bare INVALID_API_KEYS reading like a typo.

### An account returning nothing is distinguished from an unused one
Split on whether the institution reports a balance. Balance but no
transactions means the bank knows the account and is returning no activity, so
totals are missing whatever it holds — a warning. No balance is an unused or
closed account, and stays at info, because reporting both the same way trained
people to skim past the row that mattered.

### A superseded connection is now reported
A re-link leaves the old connection live: it keeps authenticating, keeps
syncing, and with Plaid keeps billing, while the newer one supplies every
figure that gets reported. `detectSupersededConnections` finds a connection
whose rows are uniformly rejected by the view — the exact shape of "you
replaced this and forgot to remove it" — and prints the removal command. A
connection carrying even one row of its own, or one that has never synced,
is left alone.

### `link --days` says the history has not arrived yet
Plaid fetches history asynchronously after creating an Item, so a backfill run
immediately after linking returns about 90 days and the request looks ignored.
Measured on a real link: 578 transactions covering 90 days moments after, 1203
covering two years a few minutes later. The link message now says so, and says
what a still-short range after ten minutes actually means.

### Institution recorded on the account
The Plaid provider now fetches `institution_id` per Item and stores it on the
account. It is part of the natural key that recognises an account across a
re-link, and the one piece of it no transaction payload carries — without it
the key falls back to mask and type alone.

### `--history` / `backfill` over-claimed coverage
`finance link --history 24` printed "Loading 24 months… ✓ 547 transactions"
while the data actually began 90 days earlier. Providers cap reachable history
at link time (Plaid: `days_requested`, not exposed by its CLI), so re-running
never went deeper. Both commands now print the range actually written and say
plainly how far short of the request it fell. Found in a live ledger whose
affordability baseline was silently only two complete months.

Items 1, 2, 3 and 6 shipped as `finance doctor` detectors plus `finance prune`
(`src/core/diagnostics.ts`). Verified by replaying the original bugs against a
copy of the real ledger:

```
[ERROR] "CHECKING ...1111" ••1111 appears 2 times — counted 2×
[ERROR] 30 transactions appear under more than one account (a large sum counted twice)
[ERROR] 31 transactions reference an account that no longer exists (a smaller sum still counted)
```

Also shipped: `unlinked-cards` — card payments excluded from spending with no
card linked to account for them. Not originally on this list, and the most
misleading state the ledger can hold: on real data a checking-only ledger
reported barely a third of true spending, with nothing appearing
broken.

Items 4 (history over-claiming) and 5 (credential verification) have since
shipped too — see above. What remains is below.

## P0 — silent wrong numbers

*Items 1–3 (duplicate institution links, joint accounts under multiple Items,
orphans after an Item is removed) are gone: all three were symptoms of keying
accounts on the provider's ids, and the identity rewrite makes them
unreachable rather than detectable.*

## P1 — bad errors, recoverable

## P2 — onboarding

## P3 — nice to have

### 11. A setting to pin the card-payment rule

`getSpendingSummary` accepts `'auto' | 'always' | 'never'`, but only library
callers can reach it: the CLI, MCP, insights and afford all use `'auto'`. The
README once documented a `report.cardPayments` key that did not exist. If it is
added it has to reach every consumer at once — a summary and a report that
disagree about what counts as spending is worse than no setting.

### 10. `finance categorize` from the MCP side, in bulk

`set_category` handles one transaction. Asking Claude to fix 40 rows means 40
tool calls. A match-based bulk tool would mirror the CLI.
