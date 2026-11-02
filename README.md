# Claude Code Usage

Local dashboard of Claude Code spend, tokens, tool calls and plan usage, built on [ccusage](https://github.com/ryoppippi/ccusage), with a daily JSON history that outlives Claude Code's transcript cleanup.

## Install

Requires macOS, Node and [just](https://github.com/casey/just). Plan usage requires a Claude Code login: the server reads the login token that Claude Code keeps in the Keychain and asks Anthropic's usage endpoint. Claude Code renews the token while Claude Code runs; after a long pause, the plan card shows an error until Claude Code starts again. Everything else works without a login.

```sh
just collect    # installs ccusage on first use, takes the first snapshot
just schedule   # collects daily at 09:00 and at login
```

## Usage

```sh
just            # collects, serves the dashboard on localhost and opens it
```

The URL is printed in the terminal. The server uses port 4317, or the next free port; when the dashboard already runs, `just` opens the running one. While the server runs, the server collects every 10 minutes and the page reloads with the new data. `just serve` starts without collecting first, unless the data is older than 10 minutes; `just log` shows the daily job's recent runs, `just unschedule` removes the daily job.

History lives in `data/` as JSON. Each run keeps the larger of the stored and the fresh record for every day and session, so transcripts that Claude Code deletes never shrink the history. Set `cleanupPeriodDays` in `~/.claude/settings.json` to keep transcripts longer.
