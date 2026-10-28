---
name: Code review
inlined-imports: true
imports:
    - shared/mcp/context7.md
    - shared/pr-review-context.md
on:
    pull_request:
        types: [opened, synchronize, reopened, ready_for_review]
if: github.event.pull_request.draft == false
runs-on-slim: ubuntu-latest
# AIC policy, trigger exemptions, and overshoot: .github/workflows/README.md#code-review-credit-budgets
max-daily-ai-credits: 100
max-ai-credits: 10
permissions:
    contents: read
    issues: read
    pull-requests: read
    actions: read
# How do I supply pricing for a custom or private model?
# https://github.github.com/gh-aw/reference/faq/#how-do-i-supply-pricing-for-a-custom-or-private-model
# Go Contributor prices and data use: https://opencode.ai/v2/docs/console/go
# Meta terms: https://dev.meta.ai/docs/pricing-rate-limits#contributor-tier
# USD/token: $0.10 input, $0.20 output, $0.002 cached input per million tokens.
# Contributor permits training on prompts/completions and is not ZDR; requires
# workspace privacy opt-in and geographic eligibility before OPENAI_MODEL cutover.
models:
    providers:
        openai:
            models:
                muse-spark-1.3-contributor:
                    cost:
                        input: "1e-7"
                        output: "2e-7"
                        cache_read: "2e-9"
checkout:
    fetch-depth: 0
runtimes:
    bun:
        version: "1.4.4"
plugins:
    # Official ponytail v5.3.2; keep hook trust below aligned with this revision.
    - DietrichGebert/ponytail@16352ac229eb08a9598dcae48fe9f2b342567d86
pre-agent-steps:
    # AWF hides ~/.bun; /usr/local/bin is mounted read-only inside the sandbox.
    - name: Expose Bun to AWF
      run: sudo install -m 755 "$HOME/.bun/bin/bun" /usr/local/bin/bun
    - name: Install dependencies
      working-directory: ${{ github.workspace }}
      run: bun install --frozen-lockfile
engine:
    id: codex
    version: "0.163.0"
    model: ${{ vars.OPENAI_MODEL }}
    config: |
        # Trust only the reviewed hooks from the pinned plugin, not all hooks.
        [hooks.state."ponytail@gh-aw-plugin-0:hooks/claude-codex-hooks.json:session_start:0:0"]
        trusted_hash = "sha256:55a39116e94ed8399271043701d3e9b8859aee77c30ef85529e7eab067d8acd9"
        [hooks.state."ponytail@gh-aw-plugin-0:hooks/claude-codex-hooks.json:user_prompt_submit:0:0"]
        trusted_hash = "sha256:29dcb3bf3cd3d77af301058521d2fd4e414c523345f8fe70942f7f30027acc94"
        [hooks.state."ponytail@gh-aw-plugin-0:hooks/claude-codex-hooks.json:subagent_start:0:0"]
        trusted_hash = "sha256:6e210f506560ddd14e490c7dd80623572d504b8f0cfcf8c64c4d4c2ab4d23ae1"
    env:
        OPENAI_BASE_URL: ${{ vars.OPENAI_BASE_URL }}
        # Preserve the URL path when AWF resolves a runtime variable.
        OPENAI_BASE_URL_ENV: OPENAI_BASE_URL
        OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
network:
    allowed:
        - github
        - node
        - opencode.ai
tools:
    github:
        mode: gh-proxy
        toolsets: [repos, pull_requests, actions]
    # Codex cannot enforce per-command shell allowlists.
    bash: [":*"]
safe-outputs:
    threat-detection:
        max-ai-credits: 5
        continue-on-error: false
    submit-pull-request-review:
        allowed-events: [APPROVE, REQUEST_CHANGES]
        commit-id: ${{ github.event.pull_request.head.sha }}
timeout-minutes: 15
---

<!-- Keep this workflow concise; consider skills for reusable instructions. -->

# Review the pull request

Review pull request #${{ github.event.pull_request.number }} in
`${{ github.repository }}`. Use the pre-fetched PR metadata and discussion to
check that the changes match their stated scope and behavior. Report material
mismatches or missing promised behavior.

Work in `$GITHUB_WORKSPACE`, the PR-head checkout. Use local Git to inspect the
complete three-dot diff from base `${{ github.event.pull_request.base.sha }}`
to head `${{ github.event.pull_request.head.sha }}`, plus relevant surrounding
source. Use `git show <head-sha>:<path>` for PR contents where gh-aw restored
base-branch configuration. Read large outputs in chunks. Follow
`CODING_STANDARDS.md` and applicable repository instructions.

Focus on actionable correctness, security, and regression bugs introduced by
this PR. Skip style preferences, speculative issues, and problems caught by CI.

Read and apply the installed `ponytail:ponytail-review` skill before reviewing.
Its minimal-change guidance supplements, but never overrides,
`CODING_STANDARDS.md`, applicable repository instructions, the actionable-bug
focus above, or the review format and approval/request-changes rules below.
Do not turn lean-code suggestions into unsolicited refactoring or cleanup.
If the plugin or its review skill cannot load inside the sandbox, the review
is incomplete; name the missing evidence rather than approving.

## Submit the review

Submit exactly one review using `submit_pull_request_review`. Use APPROVE when
the review is complete, all necessary checks succeeded, and there are no
critical findings, even if non-critical findings remain. Use REQUEST_CHANGES
for critical findings or an incomplete review, naming the failed check or
missing evidence. Include check results or explain why no execution was needed.
Do not merge the PR.

If cancellation or publication failure prevents a review, report that no review
was submitted.

For each finding, include severity, file and line, a concrete failure scenario,
and a concise fix. Order findings by severity and include non-critical findings
in the approval body. If there are no actionable findings, say so briefly.
