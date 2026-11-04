# Importing CSV exports

Every bank has a "Download transactions" button. No signup, no API keys, no third party — and every
feature works from it. `finance setup` reads an export, shows you three rows as it would import
them, and writes the block below for you. This page is for checking or editing it by hand.

```toml
[[providers.csv.accounts]]
accountId = "checking"
name = "Checking"
mask = "1234"                    # last 4 only; full numbers are never stored
type = "depository"              # depository (checking, savings) or credit (a card)
path = "~/Documents/statements/checking"   # a folder of .csv files, or one file
dateFormat = "MM/DD/YYYY"
negativeIsSpending = true        # true when a negative number means money left the account

  [providers.csv.accounts.columns]
  date = "Date"
  amount = "Amount"
  description = "Description"
  category = "Category"          # if the export has one — see below
```

**One block per account.** A checking account and a card are two exports with two layouts, so each
gets its own `[[providers.csv.accounts]]` with its own folder. `finance setup` offers to add another
after the first, and running it again later adds to the config rather than replacing it. Add every
account money moves through — see [Which accounts to link](accounts.md).

**Map the bank's Category column if there is one.** Card exports nearly always have it. Without it,
categories are guessed from descriptions alone, and most purchases land in `other`. `finance setup`
detects it, and `finance doctor` says so when most spending is uncategorised. Adding it later is
fine: the next `finance sync` recategorises what is already there.

**A CSV is a snapshot.** It holds what you downloaded and nothing newer, so the reports go stale
until you drop a newer export in the same folder and sync again. The summary, the report and
`finance doctor` all say when the newest transaction is well before the period you asked about.

**Split debit/credit columns** work too — set `debit` and `credit` instead of `amount`, and leave out
`negativeIsSpending`, since the columns already say which side is which.

**Overlapping exports are safe.** A CSV has no stable transaction ids, so identity is derived from
the content (account + date + amount + normalized description) plus an occurrence index. Two
identical $4 coffees on the same day stay two rows, and re-importing an overlapping export doesn't
duplicate anything.
