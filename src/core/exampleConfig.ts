// The starter config written by `finance init`.
//
// Kept as a string constant rather than a file so it survives bundling and the
// npm `files` allowlist without extra packaging rules.

export const EXAMPLE_CONFIG = `# local-finance-mcp configuration
#
# This file holds settings only — never credentials. Secrets live in the OS
# keystore; use \`finance secret set <provider> <key>\`.

timezone = "America/New_York"   # your IANA time zone, e.g. Europe/London
baseCurrency = "USD"

[freshness]
# Balances are billed per call by some providers, so they are cached hard.
balanceTtlMinutes = 15
# Transaction syncs are usually subscription-priced (flat monthly per account),
# so refreshing them costs nothing extra and this can stay short.
transactionTtlHours = 6
# A query whose window closed more than this many days ago never triggers a
# sync — settled data cannot change, so historical questions stay instant.
settledAfterDays = 3
# Answer immediately from cache and refresh in the background. Off by default:
# a fresh answer is usually worth a few seconds.
staleWhileRevalidate = false

# ── AI analysis (optional, off by default) ───────────────────────────────────
# A COMMAND, not an API client: the computed brief goes in on stdin, markdown
# comes back on stdout. So no API key is ever stored here.
#
#   command = "claude", args = ["-p"]              uses an existing Claude Code login
#   command = "ollama", args = ["run", "llama3"]   fully local, nothing leaves the machine
#   command = "llm",    args = []                  whatever that CLI is configured for
#
# Enabling this sends the brief (aggregates plus a handful of flagged
# transactions — not the ledger) to that command. With a hosted model that
# means off your machine. Off by default so it stays your choice.

[narration]
enabled = false
command = "claude"
args = ["-p"]
timeoutSeconds = 120

# ── Scheduled report ─────────────────────────────────────────────────────────
# Read by \`finance schedule install\`, so edit this and re-run the install —
# there are no flags to remember. \`finance run\` does the whole job by hand:
# sync, build the report, deliver it.

[report]
schedule = "off"                  # off | daily | weekly | monthly
# The headline window. 30 days is a poor fit for lumpy income — a bonus, a
# commission, or a quarterly vest lands in one window and none of the next
# three, so the same finances read as comfortably positive one month and
# negative the next. If your pay is not the same every month, prefer
# last-90-days: the report still shows the shorter windows as tabs.
range = "last-30-days"            # last-7-days | last-30-days | last-90-days | month-to-date
deliver = ["notify"]              # notify | smtp | copy | command | open | email | save-only
ai = false                        # include the AI analysis (needs [narration])

# Every report is saved to reports/ under the data directory first; these
# channels only decide how you hear about it.

# \`copy\` drops the report in another folder, such as Dropbox. Its default is
# iCloud Drive on macOS, but iCloud blocks writes from a scheduled job, so there
# it only works when you run \`finance run\` by hand. For a phone, prefer smtp.
# copyTo = "~/Dropbox/Finance"

# \`command\` hands the report to anything — the same contract as [narration],
# so no push service needs code in this project. Placeholders: {file}
# {headline} {subject} {start} {end}.
#   ntfy:     command = "curl", commandArgs = ["-T", "{file}", "https://ntfy.sh/your-topic"]
#   Telegram: command = "curl", commandArgs = ["-F", "document=@{file}",
#             "https://api.telegram.org/bot<token>/sendDocument?chat_id=<id>"]
# command = "curl"
# commandArgs = ["-T", "{file}", "https://ntfy.sh/your-topic"]

# \`smtp\` is the reliable way to reach a phone: mail clients render the attached
# HTML inline, it works away from home, and the notification comes free. The
# PASSWORD is not stored here — it goes in the OS keystore, same as Plaid:
#   finance secret set smtp password
# Gmail and most providers reject account passwords over SMTP; generate an app
# password (needs 2FA).
#
#   [report.smtp]
#   host = "smtp.gmail.com"
#   port = 587                    # 587 = STARTTLS, 465 = implicit TLS
#   user = "you@gmail.com"
#   to = "you@gmail.com"

# \`email\` goes through Mail.app, so no SMTP password is stored. Be warned that
# Mail's AppleScript interface is unreliable on some machines (AppleEvent
# -1712); \`smtp\` is the dependable option for a scheduled job.
# emailTo = "you@example.com"
#
# Channels: "notify" (a macOS notification), "smtp" (sends it yourself),
# "email" (drives Mail.app), "copy", "command", "open", "save-only".
#
# Prefer "smtp" over "email". Driving Mail.app LAUNCHES Mail.app, so on a
# daily schedule an app opens on your desktop every morning — and it fails
# with an unexplained -1712 when Mail is slow to answer.
# sendEmail = true                # false opens a draft instead of sending

# ── CSV ──────────────────────────────────────────────────────────────────────
# Import your bank's "Download transactions" export. No signup, no API cost,
# works with any institution. Manual: you download the file yourself.

[providers.csv]
enabled = true

# [[providers.csv.accounts]]
# accountId = "checking"
# name = "Checking"
# mask = "1234"                 # last 4 only; full numbers are never stored
# type = "depository"           # depository | credit | loan | investment | other
# path = "~/Documents/statements/checking"   # a directory of .csv files, or one file
# dateFormat = "MM/DD/YYYY"
# negativeIsSpending = true     # true when a negative number means money left the account
#
#   [providers.csv.accounts.columns]
#   date = "Date"
#   amount = "Amount"
#   description = "Description"

# Split debit/credit columns instead of one signed column:
#
# [[providers.csv.accounts]]
# accountId = "card"
# name = "Credit Card"
# type = "credit"
# path = "~/Documents/statements/card"
# dateFormat = "YYYY-MM-DD"
#
#   [providers.csv.accounts.columns]
#   date = "Transaction Date"
#   debit = "Debit"
#   credit = "Credit"
#   description = "Description"

# ── Plaid ────────────────────────────────────────────────────────────────────
# Automatic bank sync. Requires a Plaid account; start in sandbox.

[providers.plaid]
enabled = false
environment = "sandbox"
`;
