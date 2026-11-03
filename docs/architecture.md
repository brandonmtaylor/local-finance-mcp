# How it works, end to end

From bank to answered question. Nothing here is magic; the whole point is that
every step is inspectable and runs on your machine.

```
  ┌── ACQUIRE ─────────────────────────────────────────────────────────┐
  │                                                                    │
  │  CSV (manual)                    Plaid (automatic)                 │
  │  you download an export          plaid CLI, cursor-based           │
  │  → drop in a watched folder      → credentials from OS keystore    │
  │            │                              │                        │
  └────────────┼──────────────────────────────┼────────────────────────┘
               │                              │
               ▼                              ▼
  ┌── NORMALIZE (provider adapter) ────────────────────────────────────┐
  │  • one canonical row shape, whatever the source                    │
  │  • integer cents; positive = money IN  (Plaid is negated here)     │
  │  • stable txn id  (Plaid: theirs · CSV: content hash + occurrence) │
  │  • category: merchant patterns → bank's own label → "other"        │
  │  • spend_group derived from category                               │
  └────────────────────────────┬───────────────────────────────────────┘
                               ▼
  ┌── WRITE (sync engine) ─────────────────────────────────────────────┐
  │  advisory lock  →  one SQL transaction  →  upsert by txn id        │
  │  never touches annotations — the user's corrections                │
  └────────────────────────────┬───────────────────────────────────────┘
                               ▼
                    ╔══════════════════════╗
                    ║      ledger.db       ║   accounts · transactions
                    ║   (SQLite, on disk)  ║   balances · providers · sync_log
                    ╚══════════╤═══════════╝
                               │
            ┌──────────────────┴───────────────────┐
            ▼                                      ▼
  ┌── CLI (no model) ─────────┐      ┌── MCP server (stdio) ───────────┐
  │  finance summary          │      │  Claude calls a tool            │
  │  finance query            │      │    ↓                            │
  │  finance categorize       │      │  freshness check → maybe sync   │
  │                           │      │    ↓                            │
  │  stays on your machine    │      │  results returned to the model  │
  └───────────────────────────┘      └─────────────────────────────────┘
```

---

## 1. Acquire

**CSV.** You download an export and drop it in the folder named in config. One
folder per account — everything inside is attributed to that account. Manual by
nature, which is why the provider declares `automatic: false` and the scheduler
skips it instead of reporting a failure every morning.

**Plaid.** `plaid link` once per institution. After that `finance sync` shells
out to the Plaid CLI. Credentials come from the OS keystore and are handed to
the child process through its environment — never written to a file by us, never
returned through any tool.

## 2. Normalize

Each adapter converts its source into one canonical row shape. Four things are
enforced here because getting any of them wrong corrupts everything downstream:

| | |
|---|---|
| **Integer cents** | `19.99 * 100` is `1998.999…` in floating point |
| **Sign convention** | positive = money IN. Plaid uses the opposite, so its adapter negates |
| **Stable ids** | Provider ids are per-connection, so the ledger derives its own: a hash of (account, date, amount, normalized description) plus an occurrence index. That index is what keeps two identical $4 coffees on the same day as two rows — and what makes a re-link collapse onto the rows it already has |
| **Category** | merchant patterns first, then the bank's own category column, else `other` |

`spend_group` is derived from the category, and it is what decides whether a row
counts as spending at all.

## 3. Write

The sync engine takes an advisory lock (a 7am cron and an on-demand query can
collide), then writes everything in one SQLite transaction so a provider failing
halfway cannot leave a half-written ledger.

Rows upsert by transaction id, so **re-running a sync is always safe** — the same
transaction updates in place instead of duplicating.

The upsert writes only the provider's side of a row. Corrections live in
`annotations` and are applied by the `visible_transactions` view, so a sync
cannot reach them. An override stores the category **and the `spend_group`
derived from it** — skipping the second part is subtle and costly: the
override survives but stops having any effect, so a card payment you
reclassified out of spending quietly returns to it.

## 4. Store

One SQLite file, built around a separation that most of this project's early
bugs came from collapsing:

| | |
|---|---|
| `accounts` | a real-world account. Our id, stable forever |
| `connections` | one authenticated link — a Plaid Item, a CSV folder. **Owns the cursor** |
| `sources` | one account as seen through one connection |
| `transactions` | stored per source, with full provenance |
| `annotations` | what a person decided, keyed on `txn_id` alone |
| `balances` | append-only, so net worth over time is free |

A provider's ids are scoped to a **connection**: re-linking a bank yields new
account and transaction ids for the same real things. So identity is ours —
`txn_id` is a hash of (account, date, amount, normalised description) plus an
occurrence index — and a re-link adds a *source*, never a second account.

`visible_transactions` is what every read path uses. It picks one row per
(account, base_key, occurrence), preferring the higher-priority connection, and
applies any correction. Deduplication is therefore a consequence of identity
rather than a repair run afterwards.

WAL mode, so a background sync can write while a query reads.

## 5. Read

**The CLI** answers from the ledger with no model involved and no network. This
is the fully private path — `finance summary` never leaves your machine.

**The MCP server** exposes seven tools to Claude. Whatever a tool returns goes
into the conversation, and therefore to the model. Credentials and full account
numbers never do; transaction descriptions and amounts do, because an AI cannot
analyze what it cannot see.

## 6. Freshness — why nothing has to "remember" to sync

MCP is request/response. A server cannot push work to a model, and asking a model
to remember to sync before answering is unreliable. So the read path decides,
from config:

| Query touches | Behavior |
|---|---|
| Balances | serve cache ≤ 15 min — some providers bill per call |
| Recent transactions | sync if older than ~6 h — transaction syncs are flat-rate, so refreshing is free |
| A window that closed > 3 days ago | **never sync** — settled data cannot change |

That last rule is why "what did we spend in June" answers instantly while
"what hit this week" refreshes first.

## 7. Schedule

The MCP server runs over stdio, so it lives and dies with the client session and
cannot hold a timer. Background refresh is therefore a real OS job —
`finance schedule install` writes a LaunchAgent (macOS), systemd timer (Linux),
or Scheduled Task (Windows) that invokes the CLI directly, with no agent
involved.

macOS specifics that are easy to get wrong and are handled for you: a
**LaunchAgent**, not a Daemon (an Agent runs in your logged-in session and can
therefore reach the login keychain), and an **absolute path to node** (launchd
does not inherit your shell `PATH`).

## 8. Corrections

Categorization will be wrong sometimes — no pattern list knows that "LAWN SERVICE"
is your lawn service.

```bash
finance categorize --match "LAWN SERVICE" --category housing --dry-run
finance categorize --match "LAWN SERVICE" --category housing
```

That writes an annotation keyed on the transaction's content-derived id, and
the `visible_transactions` view every query reads applies it. It is permanent
and survives every future sync — and a re-link, because the id never came
from the connection. Claude can do the same thing through the `set_category` tool.

Decide once, stored forever — which is also why an LLM is the last categorization
layer rather than the first. A budget whose numbers move between runs is
worthless.

## What crosses which boundary

| | Stays on your machine | Goes to the model |
|---|---|---|
| `finance sync` | ✓ everything | — |
| `finance summary` / `query` | ✓ everything | — |
| MCP tool call | ledger stays local | the tool's result |
| Credentials | ✓ OS keystore, always | never |
| Full account numbers | never stored at all (last 4 only) | never |
