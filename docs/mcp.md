# Asking Claude

The MCP server lets Claude — or any MCP client — read and correct your ledger, so you can ask
questions in plain English instead of SQL. It is optional: every report and command works without
it.

```jsonc
// ~/.claude.json  (or your MCP client's config)
{
  "mcpServers": {
    "finance": { "command": "finance", "args": ["mcp"] }
  }
}
```

Things to ask: "what did the move cost us?", "which subscriptions went up this year?", "can we
afford a $600 car payment?", "tag everything from the contractor as the deck project".

**What the model sees.** A tool's *result* goes into the conversation, and therefore to whoever runs
the model — an AI cannot analyse what it cannot see. Transaction descriptions and amounts cross;
credentials and full account numbers never do, and no tool returns a secret. See
[Privacy](privacy.md).

## Twenty-four tools, in six groups

| | |
|---|---|
| **Read** | `list_accounts`, `get_balances`, `query_transactions`, `get_spending_summary` |
| **Analyse** | `get_insights`, `get_affordability`, `get_tag_totals`, `get_brokerage_transfers` |
| **Check** | `run_diagnostics` — what `finance doctor` flags: numbers that are wrong but look plausible |
| **Correct** | `set_category`, `set_note`, `add_tag`, `remove_tag` |
| **Projects** | `list_projects`, `get_project`, `create_project`, `update_project`, `add_project_item`, `update_project_item`, `upsert_vendor`, `list_vendors`, `close_project` |
| **Escape hatch** | `sql_query` (SELECT-only, on a read-only connection), `sync_accounts` |

`sql_query` is the one that makes open-ended analysis work — you don't have to anticipate every
question in a tool schema.

## How it fits with the report

The report and the MCP server read the same ledger file. The report comes to you on a schedule, and
needs no AI at all. The MCP server is for questions. Corrections work in both directions too: when
Claude recategorizes a transaction or tags an episode, it writes to the ledger, so tomorrow's report
already reflects the fix. Nothing is copied between them, and neither needs the other running.

**The server is stdio-local.** It runs as a subprocess of your client. There is no network listener
and nothing hosted.

## Freshness

MCP is request/response — a server cannot push work to an agent, and asking a model to *remember* to
sync is unreliable. So reads refresh themselves according to a policy in your config:

```toml
[freshness]
balanceTtlMinutes = 15      # balances are billed per call by some providers
transactionTtlHours = 6     # transaction syncs are usually flat-rate, so stay current
settledAfterDays = 3        # windows older than this never trigger a sync
staleWhileRevalidate = false
```

The `settledAfterDays` rule matters more than it looks: most budget questions are about closed
periods, which can't change, so they never sync at all. Ask about last July and you get an instant
answer from cache; ask about this week and it syncs first.

Every read returns a `freshness` note saying whether it synced or served from the ledger, so the
model can tell you which it was rather than implying data is live when it is not.
