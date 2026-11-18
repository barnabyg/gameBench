# GitHub Issues

Publish specs and tickets in [barnabyg/gameBench Issues](https://github.com/barnabyg/gameBench/issues). Use the connected GitHub app when it supports the operation. For CLI commands, target the repository with `--repo barnabyg/gameBench`.

- Create issues with `gh issue create --title "..." --body-file <path>`. Fetch a ticket and its discussion with `gh issue view <number> --comments --json title,body,labels,comments`.
- List open work with `gh issue list --state open`. Use `--label` to filter by triage role.
- Link implementation tickets to their spec using GitHub sub-issues. Record prerequisites with GitHub issue dependencies. A ticket is unblocked when all its blockers are closed.
- When native links are unavailable, put `Part of #<parent>` or `Blocked by: #<blocker>` at the top of the ticket body.
- Apply or remove triage labels with `gh issue edit`. When closing an issue, post the resolution as a comment first.

**PRs as a request surface: no.**
