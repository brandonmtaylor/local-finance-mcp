# Automatic sync with Plaid

CSV exports cover every feature. Plaid is the convenience on top: your transactions arrive every
morning without you downloading anything.

## Your own Plaid account, your own keys

**You need your own Plaid account.** There is no shared service behind this — no server of ours, no
pooled credentials, nothing to sign up to. You create a Plaid team, you get your own `client_id` and
secret, and your banks connect to *your* Plaid account. Nobody else can see them, and you cannot use
somebody else's keys: their team would own your Items, your bank data would flow through their
account, and their billing would carry it.

That is the same property as the rest of this tool rather than an inconvenience bolted on — it is
why "local-first" is true here and not a slogan. It also means the free tier is yours: Plaid's trial
plan allows a number of live connections per team, and you are not sharing that with anyone.

## What you are actually signing up for

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
- **This tool never sees your bank password.** It receives an access token that fetches data. Where
  that token is stored is covered in [Privacy](privacy.md#credentials).
- Nothing goes to *us* — there is no us. Your data goes to Plaid and to your machine.
- To end it, remove the connection (`plaid item remove --item <id> --force`) and revoke the app at
  your bank if it offers that.

If handing a third party read access to your accounts is not something you want, **the
[CSV provider](csv.md) does all of this with no Plaid account, no tokens and no third party** — you
download your bank's export yourself. It is the same ledger and the same reports, minus the
automatic sync.

## The signup, end to end

Roughly **fifteen minutes**, most of it waiting on an email and a form.

**`finance setup` does all of this for you**: it runs the signup and sign-in, copies the keys into
your keychain, switches Plaid on, and links each bank in turn. The steps below are what it does,
for doing them by hand.

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

Then set `enabled = true` under `[providers.plaid]` in the config and `finance sync`.

## Linking a bank

**Ask for the history you want, at link time.** This is the one setting you cannot change later:

```bash
finance link --days 730          # two years, the maximum
```

Without `--days`, Plaid applies its own default — commonly about 90 days — and that window is
**fixed for the life of that connection**. No later `sync` or `backfill` can reach further back,
because the institution never sent it. The only remedy is removing the connection and linking again,
which is why it is worth getting right the first time. Asking for 730 is not a guarantee either:
Plaid asks the institution and the institution decides, so the report tells you the range that
actually arrived rather than the one you requested.

History also arrives **asynchronously**. A sync run seconds after linking returns roughly 90 days
however much you asked for; the rest lands minutes later. `finance link` waits for the count to
settle rather than reporting the early number as final.

Link every account money moves through — see [Which accounts to link](accounts.md).

**Brokerages need a different product.** Not every institution offers every Plaid product, and a
brokerage commonly offers `investments` but *not* `transactions`:

```bash
finance link --products investments --days 730
```

Requesting a product an institution lacks does not fail loudly — it makes that institution
**unselectable in the Link UI**, which is a confusing way to find out. If your brokerage is missing
from the list, this is usually why.

Once linked, see what it actually sends before relying on it:

```bash
finance connections list
finance connections probe <connection_id>
```

**If the browser flow times out**, the connection still exists at the provider — Link creates it the
moment you finish signing in, whatever the CLI is doing. Claim it rather than linking again, which
would create a second one:

```bash
finance link --resume
```

## Splitting brokerage transfers

A brokerage appears in a bank ledger as one merchant, so proceeds arriving and your own savings going
the other way read identically and cancel out. With the brokerage linked, they can be told apart:

```bash
finance transfers            # net per sub-account
finance transfers --detail   # every transfer, and how it was attributed
```

Transfers are matched to the brokerage's own cash movements on date and amount. Where the
brokerage's history is shorter than the bank's, the account reference the bank puts in the
description carries the rest. Anything neither explains is reported as unattributed rather than
guessed at.

## Backfill

The Plaid CLI owns the sync cursor and advances it as soon as its own API call succeeds. If a sync
fails afterwards, those transactions are invisible to every later `sync`. Use:

```bash
finance backfill --since 2026-01-01
```

which fetches by date range instead of cursor. It's also how you load history for an account linked
before the ledger existed. Idempotent — safe to re-run.
