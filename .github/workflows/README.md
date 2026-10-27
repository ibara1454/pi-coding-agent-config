# Workflows

## Code-review credit budgets

[Code review](code-review.md) sets workflow-local limits rather
than inheriting mutable repository defaults:

| Scope | Frontmatter field | AIC | USD list-price equivalent |
| --- | --- | ---: | ---: |
| Rolling 24-hour admission threshold | `max-daily-ai-credits` | 100 | $1.00 |
| Reviewer, per execution | `max-ai-credits` | 10 | $0.10 |
| Threat detector, per execution | `safe-outputs.threat-detection.max-ai-credits` | 5 | $0.05 |

[One AIC is $0.01 of model-priced usage](https://github.github.com/gh-aw/specs/ai-credits-specification/),
not an OpenCode Go subscription credit, quota reset, or billing guarantee. The
reviewer and detector have independent budgets, not one shared 10-AIC pool.
[Issue #64 triage](https://github.com/ibara1454/pi-coding-agent-config/issues/64#issuecomment-6422276351)
selected these limits using [a completed review](https://github.com/ibara1454/pi-coding-agent-config/actions/runs/40347514834):
0.412257 reviewer AIC and 0.211563 detector AIC, leaving over 20× component
headroom for larger changes and repeated reviews.

The selected `OPENAI_MODEL=muse-spark-1.3-contributor` uses
[Contributor pricing](https://opencode.ai/v2/docs/console/go):
$0.10 input, $0.20 output, and $0.002 cached input per million tokens. The
workflow records **USD per token** (`1e-7`, `2e-7`, `2e-9`) for both components;
these are not the standard, non-Contributor Muse Spark rates. Keep this metadata
aligned with any future model change. Provider subscription allowances and
privacy/eligibility requirements remain separate.

### Enforcement and limitations

- All current triggers—`pull_request` actions `opened`, `synchronize`, `reopened`,
  and `ready_for_review`—use daily admission before the reviewer starts.
  Repeated reviews are new runs and contribute reviewer **and** detector usage.
  At recorded/estimated daily usage **≥ 100 AIC**, the reviewer, detector, and
  safe-output publication are skipped; no new APPROVE is submitted.
- A PR workflow rerun retains its `pull_request` event, so it is not a manual
  dispatch exemption. Each execution gets fresh component allowances. The pinned
  v0.93.3 daily scanner selects completed runs by their original creation time
  within 24 hours and keeps one current observation per run ID, resolving the
  latest applicable component artifacts. Rerun usage can replace prior-attempt
  usage; this is **not** a cumulative ledger of every attempt.
- The [upstream daily guard](https://github.github.com/gh-aw/reference/rate-limiting-controls/#daily-ai-credits-guardrail)
  bypasses `workflow_dispatch`, slash/label commands, `workflow_call`, and
  `repository_dispatch`. None is currently configured here. Adding one requires
  reassessing daily admission; component limits still apply.
- Daily admission reserves no credits for the incoming run and excludes
  unfinished runs. Per-PR concurrency cancels superseded reviews but does not
  serialize different PRs. Concurrent admissions, reruns, and in-flight model
  requests can overshoot: AWF rejects subsequent model requests once a component
  reaches its allowance, not the request already running.
- Missing historical artifacts can use the reviewer maximum (10 AIC) as an
  estimate, not the combined 15-AIC allowance. Unverifiable history, access, or
  quota failures can instead block activation. These accounting limits are
  another reason the daily threshold is not a universal hard spending cap.
- Detection is fail-closed (`continue-on-error: false`): budget exhaustion,
  detector failure, or a threat verdict blocks all review publication rather
  than allowing an APPROVE without a successful security verdict. Successful
  reviews retain APPROVE/REQUEST_CHANGES and the reviewed-head commit pin.

### Precedence and diagnostics

[Precedence](https://github.github.com/gh-aw/reference/compiler-enterprise-environment-controls/#precedence)
for reviewer/daily limits is workflow frontmatter → first imported value →
`vars.GH_AW_DEFAULT_MAX_AI_CREDITS` /
`vars.GH_AW_DEFAULT_MAX_DAILY_AI_CREDITS` → built-ins (1000/5000).
Detection uses its explicit nested value before
`vars.GH_AW_DEFAULT_DETECTION_MAX_AI_CREDITS` → 400. The three explicit values
here win; changing those repository defaults alone cannot change this workflow.
No admission service is enabled to replace these allowances.

Inspect activation's **Check daily workflow token guardrail** logs and **Daily AI
Credits Usage (24h)** step summary for total, threshold, recorded versus estimated
usage, and `daily_ai_credits_guardrail_status` (`under_budget`, `exceeded`, or an
accounting error). Conclusion reports daily denial even when the agent is
skipped. Component exhaustion appears as `403` / `ai_credits_limit_exceeded` or
`Maximum AI credits exceeded`; inspect the agent/detection logs and `usage`
artifact, not provider quota counters.

After changing frontmatter, regenerate with gh-aw **v0.93.3**:

```sh
gh aw compile code-review --strict --validate --shellcheck --no-check-update
```

The issue's controlled smoke used the pinned daily runtime with synthetic
reviewer/detector artifacts, compiled job conditions, intercepted review writes,
and the pinned detector's conclusion command. It covered 99/100 admission,
100/100 and 101/100 denial, trigger exemptions, rerun replacement, access failure,
and detector exhaustion without provider inference. Compiler/schema and
shellcheck validation passed. Actionlint additionally reports eight pre-existing
compiler-generated references to undeclared admission outputs; they are not
introduced by these budget settings.

## Code-review ponytail plugin

The reviewer installs the [official ponytail plugin](https://github.com/DietrichGebert/ponytail)
through gh-aw's pinned `plugins:` entry; no additional secrets or manual setup
are needed. Keep the generated local marketplace: the upstream marketplace's
plugin entry follows `main`.

When upgrading ponytail/Codex or reordering `plugins:`, review the bundled hooks
and refresh `engine.config`'s `hooks.state` keys/hashes using Codex's
`app-server` → `hooks/list`. Verify enabled/trusted hooks and the enabled
`ponytail:ponytail-review` skill via `skills/list`, then recompile with the
command above. Never edit the lock file or bypass hook trust globally.

Installation and execution share `CODEX_HOME=/tmp/gh-aw/mcp-config` in the
existing AWF sandbox mount. A live PR run must show `PONYTAIL MODE ACTIVE` and
review-skill access inside the sandbox, not just a successful runner install.
Only local loading has been verified; live AWF verification remains outstanding.

