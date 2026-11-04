# What can I afford

Most tools tell you what you spent. The question people actually have is whether they can take
something on.

```bash
finance afford                                  # baseline and headroom
finance afford --add 650                        # a car payment
finance afford --replace-loan 2400              # a move swaps one mortgage for another
finance afford --buffer 1000 --replace-loan 0   # max payment leaving $1,000 spare
finance afford --exclude-tag move               # keep one-offs out of the baseline
finance afford --lump-net 17000                 # a bonus, AFTER tax, spread over 12 months
finance afford --lump-gross 25000 --tax-rate 32 # the same bonus before tax

# --lump-* is for a yearly EXTRA on top of your pay. Your salary is already
# counted — income is measured from real deposits, not entered by hand.
```

Income and spending are the **median** complete month, not the average. Household cash flow is
skewed — a bonus or a big repair is several times a normal month, with nothing equally far below to
cancel it — so an average describes a month that never happened, and errs optimistic. When the
average differs noticeably it is printed beside the median, because that gap is how much of the
picture is one-offs.

Built from actual income and spending over **complete calendar months** — a partial month
understates spending and overstates what you can afford. Tagged one-offs can be excluded, and loan
payments are reported separately because a move replaces them rather than stacking on top.

It reports what it does not know: how many months it rests on, whether income swung (which hides
bonus timing), and that this is monthly cash flow, **not underwriting** — no PMI, maintenance,
closing costs or tax changes. A shortfall is reported as a negative number rather than "$0
affordable", which would read as breaking even.

## Equity compensation

If you are paid partly in shares, a ledger built from bank data cannot see most of your income.
Shares vest at the broker, tax is withheld there, and only the slice you choose to sell and move
across ever reaches a bank. The result is an affordability baseline showing a permanent monthly
shortfall with no explanation for how the balances hold up.

With a brokerage linked through [Plaid](plaid.md#linking-a-bank), `finance afford` reports it
separately:

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
