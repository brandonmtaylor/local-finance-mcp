# Security

This tool holds bank data and sits next to the credentials that fetch it, so
security reports are taken seriously and handled privately.

## Reporting a vulnerability

**Do not open a public issue.** Use GitHub's private reporting instead:
**Security → Report a vulnerability** on this repository. Include what you
found, how to reproduce it, and what an attacker gains.

You should get an acknowledgement within a week. Fixes go out as a patch
release, and the advisory is published once one is available.

## What is in scope

- A credential (Plaid API keys, SMTP password, anything in the OS keystore)
  reaching a file, a log, the ledger, report output, or an MCP tool result.
- An MCP tool that can be made to write outside the ledger, run a command, or
  read files it should not.
- SQL reachable through MCP that can modify the ledger when it should only read.
- Generated schedule files (LaunchAgent / systemd / schtasks) that can be made
  to run something other than `finance run`.
- Report HTML that executes script.

## What is not

These are documented limits rather than bugs — see
[Credentials](docs/privacy.md#credentials):

- Plaid **access tokens** are stored by the Plaid CLI in a plain JSON file
  (mode 0600), not in the keystore. That is the Plaid CLI's storage, not this
  tool's.
- Anything already running as your user can read the ledger and the keystore.
  The MCP server's guardrails close the realistic agent leak path; they are not
  a sandbox against a local attacker.
- Data you choose to show a model through MCP leaves your machine by design.

## Supported versions

Only the latest release receives fixes.
