# Which accounts to link

**Link your checking accounts AND every credit card you use.** Not one or the other — the two answer
different questions, and linking only one produces a number that is wrong rather than merely
incomplete. This applies equally to CSV exports and Plaid: anything you leave out is invisible.

| Linked | You get | You lose |
|---|---|---|
| Checking only | income, mortgage, utilities, true cash flow | **spending is badly understated** — see below |
| Cards only | detailed categorised spending | no income, no fixed costs, no net |
| Both | the real picture | — |

`finance doctor` flags the commonest gap: payments going to a card that is not linked.

## A reasonable order

1. **Primary checking** — income and fixed costs land here
2. **Every credit card with activity** — this is where discretionary spending lives
3. **Savings** — for net worth over time; it holds few transactions
4. **Mortgage / loan accounts** — optional. The *payment* already appears in checking; linking the
   loan adds the balance, not the spending
5. **Investment accounts** — optional, and not what this tool is for. Worth it if you are paid in
   shares — see [Equity compensation](afford.md#equity-compensation)

With Plaid, skip cards you no longer use: each linked account is a Plaid Item, and Items are what the
free tier counts.

## If you only want to link checking

That works, and the total stays roughly honest — but the detail does not.

A credit-card payment is normally excluded from spending, because the card's purchases are counted
**on the card**. With no card linked those purchases were never recorded, so excluding the payment
as well makes the money vanish. The tool detects this and **counts the payments instead**, since the
payment is then the only evidence of what was spent on that card.

Measured on a real ledger, same 30-day window, scaled so the truth is 100:

```
checking only, payments excluded       33   ← what it used to report
checking only, payments counted       150   ← what it reports now
both linked                           100   ← the truth
```

Counting payments overshoots here because a payment settles *last* month's balance and does not line
up with the window. It is an approximation — but a close one, where excluding was off by a factor of
three.

**What you lose without the cards** is the breakdown. Payments arrive as one lump, so you see only
that a lump left for a credit card, and nothing about whether it was groceries or flights.
Categories, merchants, recurring charges and outliers all live on the card.

The switch is automatic — link a card later and the tool stops counting payments, with no re-sync.
Both the summary and the report say which rule is in force, so the change is never unexplained.
There is no setting to pin it one way or the other yet.

## Joint accounts, if two people are linking

If you each link the same bank with your own login — necessary when neither can see the other's
card — the joint checking account arrives under **both** logins. Nothing needs doing: an account is
matched across connections on its institution, last four and type, so both logins resolve to one
account and the joint transactions are counted once.

The same machinery is why **re-linking a bank is safe**. Providers issue new ids for the same
accounts when you re-authenticate, and transaction identity here is derived from content rather than
from those ids, so the old and new connections resolve to the same rows. Your category corrections
survive it.
