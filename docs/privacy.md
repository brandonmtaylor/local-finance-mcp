# Privacy and credentials

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

**Not local:** three things, all opt-in.

- **MCP.** When you ask Claude a question, the tool's *result* goes into the conversation, and
  therefore to whoever runs the model. An AI cannot analyse what it cannot see. Your ledger stays
  here; the answer it reads does not. Credentials and full account numbers never cross, ever.
- **The AI section of the report**, if you turn it on, sends a brief — aggregates plus a handful of
  flagged transactions, not the ledger — to the command you configure. `ollama` keeps that on your
  machine; a hosted model does not.
- **`finance sync`** talks to your provider, because that is where the data comes from. Plaid
  already has this data — that is what linking a bank means.

So: use the CLI and nothing leaves except the provider fetch. Add MCP and you are choosing to show
a model your transactions, in exchange for asking questions in English instead of SQL. Both are
legitimate; the point is that it is your call per query, not a property of the tool.

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

If that is not acceptable for you, the [CSV provider](csv.md) needs no tokens at all.

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

**Back it up with `sqlite3`**, not a file copy. The ledger runs in WAL mode, so a plain `cp` of
`ledger.db` can silently miss recent writes — including your category corrections:

```bash
sqlite3 ~/Library/Application\ Support/finance-mcp/ledger.db ".backup ledger-backup.db"
```
