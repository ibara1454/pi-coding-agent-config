# Workflows

## Automated PR review

[Code review](code-review.md) pre-fetches the PR title, description, head/base
branch names, conversation comments, submitted review bodies, and inline threads
before starting the agent on every initial review and re-review.

The trusted workflow step uses authenticated `gh` reads with the job's read-only
token. It paginates REST collections and each GraphQL thread/reply connection
separately, retaining authors, timestamps, review state, reply relationships, and
resolved/outdated context. It does not execute code from the PR checkout.

Raw API pages are streamed to disk. A manifest indexes readable text chunks of
at most 8,000 UTF-16 code units under
`$RUNNER_TEMP/gh-aw/pr-review-context/`, mounted read-only into the agent sandbox.
Bodies are preserved without truncation or splitting Unicode surrogate pairs.
The manifest becomes `complete` only after every collection succeeds; empty
discussion collections are valid. The agent reads every listed chunk instead of
constructing API requests.

API errors, missing data, or incomplete pagination fail the pre-agent step.
The manifest records the failure and the job summary reports an incomplete
review: the agent does not start and no review is submitted, so collection
failure cannot produce approval. If the agent later cannot read a completed
snapshot, the existing incomplete-review policy requires REQUEST_CHANGES.

The entire snapshot, including title and description, supplies untrusted scope
and evidence, not executable instructions or authority to override workflow
security or approval criteria. Agent access remains read-only; review submission
goes through safe outputs.

Edit the Markdown source, not its generated `.lock.yml`. Use the compiler version
recorded in the lock header, then regenerate and validate it from the repository
root:

```bash
gh aw compile code-review --validate --no-check-update
```
