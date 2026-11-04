# local-finance-mcp — project context

Local-first personal finance ledger with pluggable providers, exposed to agents
over MCP. Intended to be **published** — treat it as a library other people will
run, not a personal script.

Read [docs/decisions.md](docs/decisions.md) before changing anything structural,
and [docs/backlog.md](docs/backlog.md) for known gaps. Several entries in both
exist because a real bug was paid for once already.

## Layout

```
src/core/          the library — all logic lives here
  config.ts        TOML + zod; validation fails loudly at startup
  exampleConfig.ts the commented starter config `init` writes
  paths.ts         platform data dir; expandPath handles "~"
  version.ts       package version, read from package.json
  identity.ts      content-derived ids — the load-bearing decision
  ledger.ts        schema, accounts/connections/sources, upserts
  normalize.ts     canonical categories, spend groups, inference
  queries.ts       read paths, spending summary, tag totals, SQL guide
  insights.ts      deterministic trends/recurring/outliers/pay cadence
  afford.ts        median-month baseline and payment scenarios
  projects.ts      projects, vendors, line items, periodic budgets
  attribution.ts   which brokerage sub-account a transfer belongs to
  cashMovements.ts local cache of brokerage cash movements
  equity.ts        vests that never reach a bank account
  notes.ts         the user's standing context for the analysis
  narrate.ts       optional AI narration (a COMMAND, not an API client)
  report.ts        self-contained HTML: charts, tabs, no script
  diagnostics.ts   detectors for wrong-but-plausible numbers, prune
  deliver.ts       notify / smtp / copy / command channels
  smtp.ts          the one place a credential is used
  schedule.ts      LaunchAgent / systemd / schtasks generation
  freshness.ts     sync-on-read TTL policy
  sync.ts          provider → ledger, plus backfill
  secrets.ts       Keychain / secret-service / DPAPI / env, all timed
  setup.ts         the pieces of `finance setup`, apart from prompting
  lock.ts          advisory lock (cron and on-demand sync collide)
src/providers/     csv/, plaid/, types.ts (the extension point)
src/cli.ts         init setup doctor link sync backfill connections accounts
                   summary insights report run afford project notes transfers
                   query categorize note tag secret schedule prune mcp
src/mcp.ts         thin stdio MCP wrapper over core (24 tools)
```

CLI, MCP server, and cron are three thin consumers of `core`. **No logic in the
wrappers.**

## Invariants — violating these silently corrupts every report

- **Identity is OURS and derived from content, never from the provider.** Plaid
  mints `account_id` and `transaction_id` per Item, so re-linking a bank yields
  new ids for the same real accounts and transactions. `txn_id` is
  `hash(account, date, amount, normalised description)` plus an **occurrence
  index**, so two connections delivering one transaction produce one id and
  deduplication falls out of identity rather than being repaired afterwards.
  The occurrence index is counted **per source** — count it per account and the
  second connection's first copy of a repeated transaction looks like a third
  occurrence and duplicates the lot.
- **An account is not owned by a provider.** `accounts` is real-world and
  stable; `connections` is one authenticated link (a Plaid Item) and owns the
  cursor; `sources` joins the two. A re-link adds a source, never an account.
- **Read `visible_transactions`, never `transactions`.** The view picks one row
  per (account, base_key, occurrence) and applies corrections — its `category`
  and `spend_group` ARE the corrected values, deliberately sharing the base
  table's column names so no read path can forget to resolve an override. The
  provider's originals are `provider_category` / `provider_spend_group`.
  Diagnostics reads the base table on purpose: its job is to see what the view
  hides.
- **Money is INTEGER cents.** Never floats. `19.99 * 100` is `1998.999…`.
- **Positive is money IN, negative is money OUT.** Plaid uses the opposite
  convention and its adapter negates. Asserted in tests.
- **`spending` = purchases + bills.** Only **credit-card** payments and
  transfers are excluded, because a card's purchases are already counted on the
  card. **Loan payments COUNT** — a mortgage reports a balance, not purchases,
  so nothing else accounts for it. Getting this wrong hid every
  mortgage payment and overstated net income by the same amount.
- **A payment has two sides.** Money out of checking, money in to the card. Both
  are `payments` and they net to zero. `inferCategory` needs the account type to
  tell a refund from a payment.
- **Corrections live in `annotations`, keyed on `txn_id` alone.** Because that
  id is content-derived they survive a re-link, a provider swap, and the row
  being re-delivered by another source. They carry **no foreign key** — a
  correction must outlive the row it describes — so `addTag`/`setNote`/
  `setCategoryOverride` check the target exists, or a typo attaches a note to
  nothing. An override also stores `spend_group_override`: a correction that
  changes the label but not the group leaves a reclassified card payment inside
  the spending total.
- **Tags are orthogonal to categories.** One category per transaction; any
  number of tags. Tags exist for episodes that span categories and weeks.
- **Never return a bare zero that could mean "no data".** See decision 10.
- **Spending never goes below zero.** A refund reduces its own category to zero
  and no further; the excess is reported, not counted. Compute spending through
  `floorByCategory` so every consumer agrees. See decision 11.

## Working on it

```bash
npm test          # vitest
npm run build     # tsc
npm run typecheck
```

Data lives outside the repo (`~/Library/Application Support/finance-mcp` on
macOS). Override with `FINANCE_HOME` — always do this when testing, so a test
run cannot touch real financial data.

**Never commit:** anything under `data/`, `*.db`, a real `config.toml`, or a
fixture containing a live access token. Fixtures are redacted by hand.

**Backing up the ledger needs `sqlite3 … ".backup"`.** It is in WAL mode, so a
plain `cp` of `ledger.db` silently loses everything since the last checkpoint —
including every category correction.

## Adding a provider

Implement `Provider` in `src/providers/types.ts` and register it in
`registry.ts`. Nothing else changes. See
[docs/writing-a-provider.md](docs/writing-a-provider.md) — it lists the six
mistakes that are expensive to make, all of which were made here first.

## Testing rules learned the hard way

- **Never write a parser from a published API schema.** Capture real output
  first. Plaid's CLI omits `personal_finance_category` entirely; a mapper
  written from the docs would have silently categorised everything as `other`.
- **Fixtures must match the command actually used.** `sync --all` returns a
  different shape than a single-Item sync; a fixture from the wrong one hides
  the bug.
- **Check for silent caps.** `transactions list` defaults to 100 rows and pages
  via `--offset`. One page looked like success and truncated 24 months to 100
  transactions.
- **Run real data through it.** Every significant bug in this project was found
  by importing an actual bank export, not by unit tests.
- **Look at rendered output.** Geometry checks confirmed every bar sat inside the
  viewBox and still missed two blocks touching. A person saw it immediately.
- Do not install a real LaunchAgent to verify scheduling — test the generated
  plist as a string.
- The job name is per data directory: the default one keeps the bare
  `com.finance-mcp.sync`, any other `FINANCE_HOME` gets a hashed suffix and
  passes `FINANCE_HOME` to the job. A single name let a test profile replace
  the real daily job, which then ran against the real ledger anyway.
- Keystore entries are per data directory the same way (`homeSuffix` in
  `paths.ts`): the default keeps `finance-mcp.<provider>`. One shared name let
  a test profile's sandbox secret overwrite the real production one.

## Scheduled jobs (`finance run`)

Four rules, each learned from a job that ran, delivered nothing, and never
exited:

- **launchd supplies `PATH=/usr/bin:/bin:/usr/sbin:/sbin`.** Anything in
  Homebrew or `~/.local/bin` — `plaid`, `claude` — is invisible unless the plist
  sets PATH. Absolute paths for the interpreter are not enough; whatever it
  shells out to needs finding too.
- **Every subprocess needs a timeout.** `spawnSync` without one waits forever.
- **Log each step as it completes.** Collecting results and printing at the end
  means one hung step hides every success before it, and a partial run looks
  identical to one that never started.
- **Never block on a filesystem that can hang.** iCloud Drive
  (`~/Library/Mobile Documents`) blocks writes from a LaunchAgent while
  succeeding interactively. Neither `fs.copyFileSync` nor `fs.promises.copyFile`
  can be abandoned — both hold a libuv thread, and **`process.exit()` waits for
  the threadpool to drain**, so one stuck copy makes the process unkillable.
  Use a killable subprocess.

A wedged job is worse than a failed one: launchd will not start the next run
while the previous is alive, so it fails silently forever.
