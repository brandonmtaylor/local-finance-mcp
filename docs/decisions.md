# Decision log

Why this project is shaped the way it is. Each entry records the decision, the
reasoning, and what would change it — so a future reader (or a future you) can
tell a deliberate choice from an accident.

Newest last.

---

## 1. Personal data gets its own Plaid team

**Decided:** 2026-08-11

If you also build something else on Plaid, keep your personal finances in a
separate Plaid **team**, not just a separate app inside the same one.

**Why:** a team is the unit Plaid's free Trial counts against — 10 Production
Items — and the unit credentials belong to. Sharing one with a product means
every user who links a bank spends from the same pool as your own accounts,
the same keys reach both, and a change made for one can break the other.

**Would change if:** Plaid stops scoping Item limits and credentials per team.

---

## 2. Local stdio MCP, never hosted

**Decided:** 2026-08-11

The MCP server runs as a subprocess of the client over stdio. No network
listener, no hosted component.

**Why:** the alternative means someone operating a server that holds other
people's bank data. Not worth it for any convenience gained.

**Consequence:** the server dies with the client session and cannot hold a
timer — which forces decision 3.

---

## 3. Freshness decided server-side; scheduling lives outside MCP

**Decided:** 2026-08-11

Reads refresh themselves according to a TTL policy in config
(`core/freshness.ts`). Background syncs come from a generated LaunchAgent /
systemd timer invoking the CLI directly.

**Why:** MCP is request/response — a server cannot push work to a model, and
asking a model to *remember* to sync is unreliable. Putting the policy in the
read path means it behaves identically from Claude Code, a phone, or a cron job.

Defaults encode a billing asymmetry: transaction syncs are subscription-priced
(flat monthly per Item, so refreshing is free), balances are per-call (so they
are cached hard). A query whose window closed more than `settledAfterDays` ago
never syncs at all — settled data cannot change, and most budget questions are
about closed periods.

---

## 4. Spending excludes internal money movement

**Decided:** 2026-08-11

`spending` = purchases + bills. Credit-card payments, loan payments and
transfers are tracked and reported separately, never folded into the headline.

**Why:** link a credit card *and* the checking account that pays it, and
counting the payment as spending double-counts every purchase the card already
reported.

**This is not theoretical.** The first real bank import classified eight
`CARD ISSUER MOBILE PMT` rows — a large sum — as purchases. Importing the card
would have counted its purchases twice.

**Subtlety learned the hard way:** a payment has two sides. Money OUT of the
checking account that sends it, money IN to the card that receives it. Both
belong in `payments`, where they net to zero. So "incoming money means refund"
holds only on asset accounts; on a card or loan, incoming IS the payment.
`inferCategory` therefore takes the account type.

---

## 5. Money is integer cents; positive is money IN

**Decided:** 2026-08-11

Every amount is an INTEGER of cents. Positive means money into the account.

**Why:** `19.99 * 100` is `1998.9999999999998` in IEEE754, and those errors
accumulate across a year. The sign convention is arbitrary but must be stated
once — Plaid uses the opposite (positive = outflow), so its adapter negates.
Getting it wrong silently inverts every report, so it is asserted in tests.

---

## 6. Corrections are user-owned and survive syncs

**Decided:** 2026-08-11 · **Revised:** with the identity rewrite

Provider categories land on the transaction row; user corrections land in the
`annotations` table, keyed on the content-derived `txn_id`. The
`visible_transactions` view applies them, and every read path reads the view —
so its `category` and `spend_group` already ARE the corrected values. The
provider's originals stay reachable as `provider_category` /
`provider_spend_group`.

**Why:** the classic mistake is letting a re-sync clobber a manual correction.
Separating them means a fix applies everywhere at once and is permanent.

*Originally the correction was a `category_override` column on the transaction
and every query read `COALESCE(category_override, category)`. That lost every
correction whenever a connection changed, because the row did; keeping
corrections in their own table, keyed on an id derived from content, is what
lets them outlive a re-link or a provider swap.*

---

## 7. Build the CSV provider before the Plaid one

**Decided:** 2026-08-11

**Why:** a CSV has no stable ids, no categories and no cursor. Building it first
kept Plaid's assumptions from leaking into the provider interface, and it gives
anyone a zero-cost, zero-signup way to try the tool.

It also forced the dedup design: identity is a hash of
(account, date, amount, normalized description) plus an occurrence index — so
two identical $4 coffees on the same day stay two rows.

---

## 8. Wrap the Plaid CLI rather than the REST API

**Decided:** 2026-08-11

**Why:** the CLI already owns hosted Link, item storage, and cursor management.

**Cost of the choice — real, and paid once:** the CLI owns the cursor and
advances it as soon as *its* call succeeds. When the adapter failed afterwards,
50 transactions became invisible to every future `sync`. Hence
`finance backfill --since`, which fetches by date range instead of cursor, and
the optional `backfill` on the Provider interface for any source whose cursor
lives somewhere the ledger does not control.

**Also learned:** never write a parser from the published API schema. Real CLI
output emits the LEGACY `category` array (never `personal_finance_category`),
omits `authorized_date`, and `sync --all` wraps results per Item in a shape a
single-Item sync does not use.

---

## 9. Categorization: deterministic sources first, LLM for the residue

**Decided:** 2026-08-11 · **Measured, not assumed**

Order is: description patterns → the bank's own category column → user override.
Regex is kept but **frozen** — no further investment.

**Measurement** (a few hundred card-export rows, scoring the patterns against
the bank's own label where both produced an answer): they agreed on about 81%
and disagreed on about 19%. Where only one produced an answer, the bank's
label filled noticeably more gaps than the patterns did.

**What the disagreements actually mean** — and this is the important part:

- **About four in five** are `groceries` (patterns) vs `shopping` (bank):
  grocery delivery, which the issuer files under "Merchandise". **The
  patterns are better.**
- A few were `groceries` vs `transportation`: a gas station with "market" in
  its name, claimed by the store-name pattern. **The bank was right**; fixed by
  checking fuel before store names.
- The rest are genuinely ambiguous.

**Conclusion: neither deterministic source dominates.** They are each roughly
80–95% accurate with *different* blind spots. That is the real argument for an
LLM — not that patterns are bad, but that both cheap sources have systematic
gaps an LLM would not share.

**Why LLM is nonetheless the last layer, not the first:** Plaid and the bank
already supply a category for free, deterministically, offline. Paying tokens to
re-derive it is waste. And a budget where the same transaction lands in
different categories across runs is untrustworthy — so whatever decides must
decide **once** and persist, which `category_override` already does.

**Why not automated LLM categorization (yet):** the scheduled sync runs from launchd
with no agent attached. Automating it means an API key inside the tool, a
network dependency in a background job, and a new failure mode. The manual path
— ask Claude to categorize the `other` bucket, it writes overrides — needs no
new code and covers the handful of rows that land there.

**Would change if:** the `other` bucket routinely exceeds ~20 rows a month. Then
build `finance categorize`, batching unknowns in one API call.

---

## 10. Silence is never an acceptable answer

**Decided:** 2026-08-11

Two bugs of the same shape, both found by running real data:

- A CSV path written as `~/Documents/...` matched nothing (Node treats `~` as a
  literal directory) and reported **success with 0 transactions**.
- An empty ledger returned `spendingCents: 0`, which an agent reads as "you
  spent nothing" rather than "nothing has been imported".

Both now report explicitly. The rule: **any code path that can produce a
legitimate-looking zero must be able to say why it is zero.**

The boundary matters — an account with no rows in a window IS a genuine zero.
Only a total absence of accounts is unknown.
