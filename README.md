# local-finance-mcp

A local-first personal finance ledger with a pluggable provider model, exposed to AI agents over MCP.

Your transactions live in a SQLite file on your machine. There is no hosted account, no service
holding your ledger, and no vendor to trust with it — and the CLI answers every question with no
model and no network involved.

```bash
npm install -g local-finance-mcp
finance setup           # point it at a CSV export from your bank — no account needed
finance report --open   # a self-contained HTML report
```

![The HTML report: spending, income and net tiles, monthly bars, and running totals](docs/images/report.png)

*A report built from a made-up ledger. Then [connect it to Claude](#connect-it-to-claude) to ask
questions in English.*

> **Not financial advice.** This computes numbers from what your bank exports, and works hard to
> get them right — but check anything you act on against your statements.

```
                    ┌─ CLI ──────────────┐
  OS scheduler ────►│ finance sync       │
                    │ summary, report,   │──► core ──► ledger.db (SQLite)
                    │ insights, afford   │      │
                    ├─ MCP server ───────┤      └──► providers (plaid, csv, …)
  Claude / agent ──►│ stdio, 22 tools    │
                    └────────────────────┘
```

## What "local-first" does and does not mean

Worth being exact, because this is money.

**Local, always:** the ledger, your Plaid API keys (OS keystore, handed to a subprocess by
environment and never written to a file), and every CLI answer. `finance summary`, `finance report`,
`finance insights` and `finance afford` involve no model and no network. That is the fully private
path and it is the complete feature set — nothing is held back for the AI.

**Local, but on disk in the clear:** the per-bank access tokens Plaid issues when you link an
account. The Plaid CLI stores those in its own JSON file at mode 0600 — not encrypted, not in the
keystore. See [Credentials](#credentials). It is the weakest link in this setup and it is named
here rather than buried, because "local-first" should not be read as "safe by default".

**Not local:** two things, both opt-in.

- **MCP.** When you ask Claude a question, the tool's *result* goes into the conversation, and
  therefore to whoever runs the model. An AI cannot analyse what it cannot see. Your ledger stays
  here; the answer it reads does not. Credentials and full account numbers never cross, ever.
- **`finance sync`** talks to your provider, because that is where the data comes from. Plaid
  already has this data — that is what linking a bank means.

So: use the CLI and nothing leaves except the provider fetch. Add MCP and you are choosing to show
a model your transactions, in exchange for asking questions in English instead of SQL. Both are
legitimate; the point is that it is your call per query, not a property of the tool.

## How it works

[docs/architecture.md](docs/architecture.md) walks the whole path from bank export to
answered question. The short version is the diagram above: providers normalize
into one shape, the ledger stores it, and both the CLI and the MCP server read
from the same place.

## Why it's shaped this way

**The MCP server is stdio-local.** It runs as a subprocess of your client. There is no network
listener and nothing hosted, so your bank data never leaves your machine.

**Freshness is decided by the server, not the model.** MCP is request/response — a server cannot
push work to an agent, and asking a model to *remember* to sync is unreliable. So reads refresh
themselves according to a policy in your config. Ask about last July and you get an instant answer
from cache; ask about this week and it syncs first. See [freshness](#freshness).

**Scheduling lives outside MCP.** A stdio server dies with the session, so it can't hold a timer.
`finance schedule install` generates a real LaunchAgent / systemd timer / Scheduled Task that
invokes the CLI directly, with no agent involved.

**Spending excludes internal money movement.** If you link a credit card *and* the checking account
that pays it, counting the card payment as spending double-counts every purchase the card already
reported. Payments and transfers are tracked and reported, but never folded into the headline
number. This is the single most important correctness property in the project.

## How this compares

Several MCP servers already connect Claude to Plaid, YNAB or Monarch. Most pass along what the
provider returns. This one keeps a ledger, and most of its code exists to make the numbers right:

- **No double counting by construction.** Transaction ids are derived from content, so re-linking a
  bank, overlapping CSV exports, or two people linking one joint account do not duplicate anything.
- **Corrections that last.** A category fix, note or tag survives re-syncs, re-links and a provider
  swap.
- **Checks for wrong-but-plausible numbers.** `finance doctor` flags a card payment with no card
  behind it, a superseded connection still syncing, accounts that do not cover the window, and a
  zero that means "no data" rather than "spent nothing".
- **The spending rules people get wrong.** Card payments and transfers are excluded; loan payments
  are counted.
- **No Plaid account required.** CSV import covers every feature.
- **Useful without the AI.** Reports, insights, affordability and projects all run with no model.

If you only want a model to read your YNAB budget, one of those is simpler. If you want totals you
can act on, that is what this is for.

## What this needs from you

Before you spend time on it, the honest version of what is involved:

| | |
|---|---|
| **Node 20+, and a terminal** | this is a CLI. There is no app. |
| **Ten minutes** for the CSV path | download an export from your bank, point the config at it, done. No account anywhere, no third party. |
| **About fifteen more** for automatic sync | your own Plaid account, and connecting each bank. See [Plaid](#plaid) for exactly what that exposes. |
| **Optional: an MCP client** | Claude or similar, if you want to ask questions in English rather than SQL. |
| **Optional: a command that talks to a model** | for the AI section of the report. Off by default. `ollama` keeps it on your machine. |

**The CSV path is the whole tool.** Every report, every number, every command works with no Plaid
account at all — you just download the export yourself instead of it arriving. Automatic sync is a
convenience, not the product, and it is worth trying the free half first.

## Install

```bash
npm install -g local-finance-mcp
# or straight from GitHub:
npm install -g github:brandonmtaylor/local-finance-mcp

finance setup
```

`finance setup` checks the machine, reads a CSV export from your bank, shows you
three rows as it would import them, and writes the config. It offers CSV before
Plaid on purpose — no account, no keys, no third party, so you can see your own
numbers before deciding whether the rest is worth it.

Already know what you want? `finance init` writes a starter config and stops.
Then edit the config it prints, add an account, and:

```bash
finance sync
finance summary --start 2026-07-01 --end 2026-07-31
```

`finance doctor` tells you what's missing at any point.

## Connect it to Claude

```jsonc
// ~/.claude.json  (or your MCP client's config)
{
  "mcpServers": {
    "finance": { "command": "finance", "args": ["mcp"] }
  }
}
```

Twenty-two tools, in five groups:

| | |
|---|---|
| **Read** | `list_accounts`, `get_balances`, `query_transactions`, `get_spending_summary` |
| **Analyse** | `get_insights`, `get_affordability`, `get_tag_totals` |
| **Correct** | `set_category`, `set_note`, `add_tag`, `remove_tag` |
| **Projects** | `list_projects`, `get_project`, `create_project`, `update_project`, `add_project_item`, `update_project_item`, `upsert_vendor`, `list_vendors`, `close_project` |
| **Escape hatch** | `sql_query` (SELECT-only, on a read-only connection), `sync_accounts` |

`sql_query` is the one that makes open-ended analysis work — you don't have to anticipate every
question in a tool schema.

Every read returns a `freshness` note saying whether it synced or served from the ledger, so the
model can tell you which it was rather than implying data is live when it is not.

## Providers

| Provider | Data | Cost | Automatic |
|---|---|---|---|
| `csv` | Any bank's transaction export | Free | No — you download the file |
| `plaid` | Automatic bank sync | Plaid account required | Yes |

Adding your own is one interface: see [docs/writing-a-provider.md](docs/writing-a-provider.md).

### Plaid

**You need your own Plaid account.** There is no shared service behind this — no server of ours, no
pooled credentials, nothing to sign up to. You create a Plaid team, you get your own `client_id` and
secret, and your banks connect to *your* Plaid account. Nobody else can see them, and you cannot use
somebody else's keys: their team would own your Items, your bank data would flow through their
account, and their billing would carry it.

That is the same property as the rest of this tool rather than an inconvenience bolted on — it is
why "local-first" is true here and not a slogan. It also means the free tier is yours: Plaid's trial
plan allows a number of live connections per team, and you are not sharing that with anyone.

#### What you are actually signing up for

Plaid is the company that sits between this tool and your bank. Banks do not offer an API to
individuals; Plaid has the agreements that make one exist. That is the service, and it is why this
step cannot be skipped.

**What it means in practice, plainly:**

- You sign in to your bank **through Plaid's flow**, not through this tool. Either you enter bank
  credentials into Plaid's screen, or your bank redirects you to its own OAuth page — increasingly
  the latter, and better when it is.
- **Plaid can then read your transactions and balances** for the accounts you selected, for as long
  as the connection lives. Not this tool's doing and not something it can limit — that is what
  linking a bank means.
- **This tool never sees your bank password.** It receives an access token that fetches data.
- Nothing goes to *us* — there is no us. Your data goes to Plaid and to your machine.
- To end it, remove the connection (`plaid item remove --item <id> --force`) and revoke the app at
  your bank if it offers that.

If handing a third party read access to your accounts is not something you want, **the CSV provider
does all of this with no Plaid account, no tokens and no third party** — you download your bank's
export yourself. It is the same ledger and the same reports, minus the automatic sync.

#### The signup, end to end

Roughly **fifteen minutes**, most of it waiting on an email and a form.

```bash
brew install plaid/plaid-cli/plaid

plaid register      # opens the signup page; create the account, verify the email
plaid login         # browser sign-in — selects your team AND fetches your API keys for you
plaid trial         # opens the Trial Plan page: this is what grants production access
```

`plaid login` is the one that saves the tedium — no copying keys out of a dashboard by hand.

Production access is a separate step from having an account. Sandbox works immediately and lets you
exercise the whole pipeline against fake banks; the Trial Plan is what lets you connect a real one.
Approval timing, the number of live connections included, and pricing beyond it are Plaid's and
change — check [plaid.com/pricing](https://plaid.com/pricing) rather than trusting a number written
here. A personal setup of a handful of accounts is what the trial is shaped for.

Then hand the keys to this tool. `plaid login` has already fetched them; these commands store them
in your OS keystore, which is separate from the Plaid CLI's own config:

```bash
plaid config                        # shows the client_id it fetched
finance secret set plaid client_id  # prompts; not passed as an argument
finance secret set plaid secret
```

**Start in sandbox.** `environment = "sandbox"` in your config, then `plaid sandbox link` creates
test Items with no browser and no real bank. It costs nothing, exercises every code path, and means
your first real link is not also your first time running any of this.

Then enable it in the config and `finance sync`. Start in `environment = "sandbox"` — `plaid sandbox
link` creates test Items with no browser and no real bank.

**Ask for the history you want, at link time.** This is the one setting you cannot
change later:

```bash
finance link --days 730          # two years, the maximum
```

Without `--days`, Plaid applies its own default — commonly about 90 days — and
that window is **fixed for the life of that connection**. No later `sync` or
`backfill` can reach further back, because the institution never sent it. The
only remedy is removing the connection and linking again, which is why it is
worth getting right the first time. Asking for 730 is not a guarantee either:
Plaid asks the institution and the institution decides, so the report tells you
the range that actually arrived rather than the one you requested.

History also arrives **asynchronously**. A sync run seconds after linking
returns roughly 90 days however much you asked for; the rest lands minutes
later. `finance link` waits for the count to settle rather than reporting the
early number as final.

**Brokerages need a different product.** Not every institution offers every
Plaid product, and a brokerage commonly offers `investments` but *not*
`transactions`:

```bash
finance link --products investments --days 730
```

Requesting a product an institution lacks does not fail loudly — it makes that
institution **unselectable in the Link UI**, which is a confusing way to find
out. If your brokerage is missing from the list, this is usually why.

Once linked, see what it actually sends before relying on it:

```bash
finance connections list
finance connections probe <connection_id>
```

**If the browser flow times out**, the connection still exists at the provider —
Link creates it the moment you finish signing in, whatever the CLI is doing.
Claim it rather than linking again, which would create a second one:

```bash
finance link --resume
```

**Splitting brokerage transfers.** A brokerage appears in a bank ledger as one
merchant, so proceeds arriving and your own savings going the other way read
identically and cancel out. With the brokerage linked, they can be told apart:

```bash
finance transfers            # net per sub-account
finance transfers --detail   # every transfer, and how it was attributed
```

Transfers are matched to the brokerage's own cash movements on date and amount.
Where the brokerage's history is shorter than the bank's, the account reference
the bank puts in the description carries the rest. Anything neither explains is
reported as unattributed rather than guessed at.

**Backfill.** The Plaid CLI owns the sync cursor and advances it as soon as its own API call
succeeds. If a sync fails afterwards, those transactions are invisible to every later `sync`. Use:

```bash
finance backfill --since 2026-01-01
```

which fetches by date range instead of cursor. It's also how you load history for an account linked
before the ledger existed. Idempotent — safe to re-run.

### CSV

Every bank has a "Download transactions" button. Point the config at the file or a directory of
them:

```toml
[[providers.csv.accounts]]
accountId = "checking"
name = "Checking"
mask = "1234"                    # last 4 only; full numbers are never stored
path = "~/Documents/statements/checking"
dateFormat = "MM/DD/YYYY"
negativeIsSpending = true

  [providers.csv.accounts.columns]
  date = "Date"
  amount = "Amount"
  description = "Description"
```

Split debit/credit columns work too — set `debit` and `credit` instead of `amount`.

Because a CSV has no stable transaction ids, identity is derived from the content
(account + date + amount + normalized description) plus an occurrence index, so two identical $4
coffees on the same day stay two rows and re-importing an overlapping export doesn't duplicate
anything.

## Projects

A tag already gives you a running total. What it cannot give you is what the job was *supposed* to
cost, what you paid in cash, or what you have signed for and not yet paid. A committed $9,800 job
with a deposit due shows in a ledger as **$0** until money moves — correct, and useless for deciding
whether to take on anything else.

```bash
finance project new "Deck Rebuild" --type remodel --budget 9800 --start 2026-08-01
finance project item deck-rebuild "30% deposit" 2940 --committed \
  --vendor "Acme Decking" --phone "555-0100"
finance project show deck-rebuild
finance project list
```

Costs flow in on their own once you tag transactions into the project:

```bash
finance tag add --match "acme decking" deck-rebuild
```

**Use `--ongoing` for something that never ends.** A remodel finishes and can go over budget; a car
costs what it costs every year forever. The same budget number means different things to each, so an
ongoing project takes a period and a bounded one does not:

```bash
finance project new "Car" --type auto --ongoing --budget 500 --period monthly
```

### The two rules it is built on

**Spend is never copied into a project.** It stays in the ledger as tagged transactions and is summed
when you read it. A project that stored its own amounts would be a second set of books, and the two
would disagree the first time you recategorised anything.

**Committed money is never spend.** A deposit you have agreed but not paid is *exposure*, reported
beside spend and never added to it — because when the payment lands and gets tagged, adding both
counts it twice. Mark it settled once it is paid and in the ledger:

```bash
finance project settle itm_...
```

Four statuses, and the difference matters:

| | |
|---|---|
| `quoted` | priced, not agreed. **Not** counted as owed — otherwise every estimate you collect looks like a debt. |
| `committed` | agreed and unpaid. Exposure, never spend. |
| `settled` | paid. The ledger is the record, so it stops counting here. |
| `--offledger` | really spent, through something no account will show: cash, a cheque from an unlinked bank. Counted directly, because nothing else ever will. |

Keep the off-ledger bucket small. Every entry in it is maintained by hand, which is where drift
lives.

### Vendors

Contact details are stored once and referenced, not copied onto each line item:

```bash
finance project vendors
```

The rule is *copy what is frozen, reference what changes*. A transaction's date and amount never
change, so storing them directly is safe. A contractor's phone number is current state — six copies
means five of them go stale.

## Notes for the analysis

The AI analysis sees aggregates and flagged transactions. It has no way to know that a large
recurring transfer is your mortgage, that one subscription is a business expense, or that you are
saving for a deposit and every suggestion should be read against that. Without that it states the
obvious and misreads the deliberate — a savings plan looks like a spending problem.

```bash
finance notes          # creates the file and tells you what helps
finance notes --show   # exactly what is being sent
```

It is plain markdown, read on every report. Worth writing down: what a large recurring payment
actually **is**, what is deliberate so it stops being flagged as an anomaly, what you are saving for,
and what **not** to suggest cutting.

The notes sit before the rules in the prompt, not after: they may add context, they may not loosen
the constraint that every figure comes from your data.

## What can I afford

Most tools tell you what you spent. The question people actually have is
whether they can take something on.

```bash
finance afford                                  # baseline and headroom
finance afford --add 650                        # a car payment
finance afford --replace-loan 2400              # a move swaps one mortgage for another
finance afford --buffer 1000 --replace-loan 0   # max payment leaving $1,000 spare
finance afford --exclude-tag move              # keep one-offs out of the baseline
finance afford --lump-net 17000                # a bonus, AFTER tax, spread over 12 months
finance afford --lump-gross 25000 --tax-rate 32 # the same bonus before tax

# --lump-* is for a yearly EXTRA on top of your pay. Your salary is already
# counted — income is measured from real deposits, not entered by hand.
```

Income and spending are the **median** complete month, not the average. Household cash flow is
skewed — a bonus or a big repair is several times a normal month, with nothing equally far below
to cancel it — so an average describes a month that never happened, and errs optimistic. When the
average differs noticeably it is printed beside the median, because that gap is how much of the
picture is one-offs.

Built from actual income and spending over **complete calendar months** — a
partial month understates spending and overstates what you can afford. Tagged
one-offs can be excluded, and loan payments are reported separately because a
move replaces them rather than stacking on top.

It reports what it does not know: how many months it rests on, whether income
swung (which hides bonus timing), and that this is monthly cash flow, **not
underwriting** — no PMI, maintenance, closing costs or tax changes. A shortfall
is reported as a negative number rather than "$0 affordable", which would read
as breaking even.

### Equity compensation

If you are paid partly in shares, a ledger built from bank data cannot see most of your income.
Shares vest at the broker, tax is withheld there, and only the slice you choose to sell and move
across ever reaches a bank. The result is an affordability baseline showing a permanent monthly
shortfall with no explanation for how the balances hold up.

With a brokerage linked, `finance afford` reports it separately:

```
Shortfall         SHORT $850.00/mo

Equity vested      $2,100.00/mo  NOT counted above
  4 vest(s), sized from federal withholding at the 22% supplemental rate
  3 of 4 corroborated by the Medicare line
```

Vests leave no transaction anywhere. The only trace is tax withholding, reported by the broker as
cash movements — and US federal withholding on supplemental wages is a flat statutory rate, so the
federal line implies the gross behind it. Medicare only corroborates; it gains a surtax above a wage
threshold, and trusting it overstates a vest above that threshold by a wide margin.

It is reported **beside** the baseline and never added into it, so the affordability figure stays
conservative — the right direction for a loan, and lenders discount equity heavily anyway. Where the
withholding cannot be parsed it says so, rather than returning zero: a silent zero is
indistinguishable from having no equity, which is the wrong thing to tell someone sizing a loan.

One honest limit: this reads one broker's labelling convention, verified against one account. Other
brokers word it differently.

## Every command

| | |
|---|---|
| `init` · `setup` · `doctor` | get started, and find out what is missing |
| `link` · `sync` · `backfill` | connect accounts and pull data |
| `connections` | list, disable, enable, probe a connection |
| `accounts` · `summary` · `insights` · `report` · `run` | what is linked, and what happened |
| `afford` | what you can take on |
| `project` · `notes` | plan, and brief the analysis |
| `transfers` | split brokerage transfers by the sub-account behind them |
| `query` · `categorize` · `note` · `tag` | correct and interrogate |
| `secret` · `schedule` · `prune` · `mcp` | plumbing |

`finance <command> --help` for any of them.

## Which accounts to link

**Link your checking accounts AND every credit card you use.** Not one or the
other — the two answer different questions, and linking only one produces a
number that is wrong rather than merely incomplete.

| Linked | You get | You lose |
|---|---|---|
| Checking only | income, mortgage, utilities, true cash flow | **spending is badly understated** — see below |
| Cards only | detailed categorised spending | no income, no fixed costs, no net |
| Both | the real picture | — |

### If you only want to link checking

That works, and the total stays roughly honest — but the detail does not.

A credit-card payment is normally excluded from spending, because the card's
purchases are counted **on the card**. With no card linked those purchases were
never recorded, so excluding the payment as well makes the money vanish. The
tool detects this and **counts the payments instead**, since the payment is
then the only evidence of what was spent on that card.

Measured on a real ledger, same 30-day window, scaled so the truth is 100:

```
checking only, payments excluded       33   ← what it used to report
checking only, payments counted       150   ← what it reports now
both linked                           100   ← the truth
```

Counting payments overshoots here because a payment settles *last* month's
balance and does not line up with the window. It is an approximation — but a
close one, where excluding was off by a factor of three.

**What you lose without the cards** is the breakdown. Payments arrive as one
lump, so you see only that a lump left for a credit card, and nothing about whether
it was groceries or flights. Categories, merchants, recurring charges and
outliers all live on the card.

The switch is automatic — link a card later and the tool stops counting
payments, with no re-sync. Both the summary and the report say which rule is in
force, so the change is never unexplained. There is no setting to pin it one
way or the other yet.

### A reasonable order

1. **Primary checking** — income and fixed costs land here
2. **Every credit card with activity** — this is where discretionary spending lives
3. **Savings** — for net worth over time; it holds few transactions
4. **Mortgage / loan accounts** — optional. The *payment* already appears in
   checking; linking the loan adds the balance, not the spending
5. **Investment accounts** — optional, and not what this tool is for

Skip cards you no longer use: each linked account is a Plaid Item, and Items
are what the free tier counts.

### Joint accounts, if two people are linking

If you each link the same bank with your own login — necessary when neither can
see the other's card — the joint checking account arrives under **both**
logins. Nothing needs doing: an account is matched across connections on its
institution, last four and type, so both logins resolve to one account and the
joint transactions are counted once.

The same machinery is why **re-linking a bank is safe**. Providers issue new
ids for the same accounts when you re-authenticate, and transaction identity
here is derived from content rather than from those ids, so the old and new
connections resolve to the same rows. Your category corrections survive it.

## Freshness

```toml
[freshness]
balanceTtlMinutes = 15      # balances are billed per call by some providers
transactionTtlHours = 6     # transaction syncs are usually flat-rate, so stay current
settledAfterDays = 3        # windows older than this never trigger a sync
staleWhileRevalidate = false
```

The `settledAfterDays` rule matters more than it looks: most budget questions are about closed
periods, which can't change, so they never sync at all.

## The report

```bash
finance report                    # writes an HTML file
finance report --range last-90-days
finance run                       # sync, report, deliver — what the scheduler calls
```

One self-contained HTML file. **No scripts, no external requests, no fonts, nothing fetched.** It
opens offline, in a mail client, on a plane, and in five years. That constraint is why the
interactive parts are built on `<details>` and CSS rather than JavaScript — a mail client will not
run a script, and a drill-down built on one would be dead exactly where the report is most often
read.

What is in it:

| | |
|---|---|
| **By month / Running totals** | inline SVG, four date ranges behind CSS-only tabs |
| **Where it came from** | income by payer, with the median gap between payments — which is what shows a payer that quietly stopped |
| **Where it went** | categories and merchants, each expanding to the transactions behind it |
| **What changed** | category deltas against the preceding period, suppressed entirely when the ledger does not cover it |
| **Unusual for their category** | measured against the median in the *same* category, since a big grocery run and a big mortgage payment are not comparably surprising. Where a duplicate charge shows up first |
| **First seen this period** | merchants with no prior history — a new recurring charge is cheapest to cancel while it is new. Left out until the ledger reaches back past the period, when everything would qualify |
| **Recurring** | with cost per year, which is the number that decides anything: $40 waves through and $1,040 a year does not, and they are the same charge |
| **Where you stand** | balances, with cash, investments and debt kept apart — brokerage holdings are not spendable money |
| **Not counted as spending** | transfers and card payments, and why |

### The AI section

Optional and off by default. It runs a **command**, not an API — so no key lives here:

```toml
[report]
ai = true          # must be under [report], NOT under [report.smtp]

[narration]
enabled = true
command = "claude"
args = ["-p"]
```

`claude -p` uses an existing login. `ollama run <model>` keeps it entirely on your machine. Anything
that reads stdin and writes markdown works.

It is told to use only figures from the brief and never to compute one, because a wrong number in a
finance report is worse than no analysis. Savings figures — cost per year, and what stopping
something would save — are computed in code and handed over for exactly that reason. It is also told
that recurring is not the same as wasteful, and to say plainly when nothing is worth cutting rather
than inventing a suggestion.

The analysis reads **at least 90 days** regardless of the range on display: recurring detection needs
a charge to appear more than once, and over 30 days a monthly subscription appears exactly once and
is invisible.

## Scheduling

```bash
finance schedule install --daily 07:00
finance schedule status
finance schedule uninstall
```

On macOS this generates a **LaunchAgent** — not a LaunchDaemon, because an Agent runs inside your
logged-in session and can therefore reach the login keychain. The generated job uses an absolute
path to `node`, since launchd doesn't inherit your shell `PATH`.

## Credentials

Secrets go in the OS keystore (macOS Keychain, libsecret on Linux, DPAPI on Windows), never in the
config file:

```bash
finance secret set plaid client_id     # prompts; not passed as an argument
finance secret check plaid client_id   # reports set/not-set, never the value
```

An `env` backend (`FINANCE_<PROVIDER>_<KEY>`) is available for headless and CI use.

**Where the bank tokens live, precisely.** The above covers your Plaid API keys. It does not cover
Plaid *access tokens* — the per-bank credentials created when you link an account, which are what
actually reach your accounts. Those are stored by the Plaid CLI, not by this tool, in a plain JSON
file:

```
~/Library/Application Support/plaid-cli/config.json     # mode 0600, your user only
```

They are not encrypted and not in the keystore. That file is the most sensitive thing this setup
creates: anything holding it can read your transactions until the Items are removed. It is worth
knowing before you decide this is for you, and it is why the sentence above says *secrets* rather
than *everything*.

If that is not acceptable for you, the CSV provider needs no tokens at all.

The MCP server can trigger a sync but has no tool that returns a credential, so secrets stay out of
agent transcripts and session logs. To be clear about the limit: that's a guardrail, not a sandbox —
anything with arbitrary shell access could read the keystore directly. Its value is closing the
realistic leak path for an agent-driven tool, not defending against a local attacker.

## What it stores

| | |
|---|---|
| **Credentials** | OS keystore. Never in config, never in the ledger, never returned by a tool. |
| **Financial data** | `ledger.db` in your platform data dir. Sensitive, but not *actionable* — read-only bank data grants no ability to move money. |
| **Never stored** | Full account numbers (last 4 only), bank login credentials. |

Data lives outside the repo by default — `~/Library/Application Support/finance-mcp` on macOS,
`$XDG_DATA_HOME/finance-mcp` on Linux. Override with `FINANCE_HOME`.

## Conventions

- **Money is integer cents.** Floats are never used for currency.
- **Signed amounts: positive is money IN, negative is money OUT.** Providers normalize to this.
- **Corrections are user-owned** and survive re-syncs and re-links. They are stored apart from
  the provider's data and applied in the `visible_transactions` view, whose `category` column is
  already the corrected value — so a correction applies everywhere at once.

## Development

```bash
npm install
npm test
npm run build
npm run typecheck
```

## Security

Report vulnerabilities privately — see [SECURITY.md](SECURITY.md).

## License

MIT
