# Projects

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

Everything here is also available to Claude through the MCP project tools — see
[Asking Claude](mcp.md).

## The two rules it is built on

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

## Vendors

Contact details are stored once and referenced, not copied onto each line item:

```bash
finance project vendors
```

The rule is *copy what is frozen, reference what changes*. A transaction's date and amount never
change, so storing them directly is safe. A contractor's phone number is current state — six copies
means five of them go stale.
