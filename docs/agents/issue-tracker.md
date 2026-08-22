# Issue tracker: GitHub

Issues and specs for this repository live in GitHub Issues. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue:** `gh issue create --title "..." --body "..."`
- **Read an issue:** `gh issue view <number> --comments`
- **List issues:** `gh issue list --state open --json number,title,body,labels,comments`
- **Comment:** `gh issue comment <number> --body "..."`
- **Apply or remove labels:** `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close:** `gh issue close <number> --comment "..."`

Run `gh` inside this clone; it infers `ibara1454/pi-coding-agent-config` from the Git remote.

## Pull-request triage surface

**PRs request surface: no.**

External pull requests are not part of the triage queue. Change this flag to `yes` only if external PRs should be triaged as requests.
