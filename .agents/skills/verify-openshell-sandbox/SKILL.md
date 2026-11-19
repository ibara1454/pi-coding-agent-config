---
name: verify-openshell-sandbox
description: Verify the OpenShell sandbox extension in a real Pi terminal after changes to host versus model Bash routing, project writes, policy status, or reload and fail-closed behavior.
---

# Verify OpenShell sandbox

## Launch

Run on the target where Pi would execute. If the native preflight below prints `NOT RUN` (exit 77), report that reason and stop **all** journeys, including host Bash. Nothing has been created to clean up. Do not install prerequisites, substitute the SDK or a mock, or switch hosts to obtain a pass.

Run this block from the repository root in a fresh interactive Bash terminal. For automation, use a persistent PTY that lets you send keys and capture output. Keep a second host shell for file checks. Use the locked workspace dependencies and the [package's native prerequisites](../../../apps/openshell-sandbox/README.md#installation-and-prerequisites). Each journey mounts only its disposable project, with no sandbox credential profiles or providers. Model journeys need a provider available to the host Pi process; never copy credentials into the project or transcript.

**Write-fixture prerequisite:** the bundled workload runs as UID/GID `1000:1000`. On Linux, `id -u` should print `1000` for the owner-private fixture below (or confirm equivalent writable UID mapping on your Docker host). Otherwise mark project-write journeys blocked by fixture ownership; don't widen the policy or change the checkout's permissions. Host Bash and status checks do not require guest write access.

```bash
(
set -eu
not_run() { printf 'NOT RUN: %s\n' "$1" >&2; exit 77; }
for tool in openshell openshell-gateway; do
  binary=$(type -P "$tool") || not_run "$tool missing from PATH"
  version=$("$binary" --version) || not_run "$tool --version failed"
  [[ $version == "$tool 0.1.8" ]] || not_run "$tool: expected 0.1.8, got '$version'"
done
repo=$(pwd -P)
umask 077
proof=$(mktemp -d /var/tmp/openshell-proof.XXXXXXXX)
printf 'proof=%q\n' "$proof"
run=$(mktemp -d /var/tmp/openshell-verify.XXXXXXXX)
trap 'rm -r -- "${run:?}"' EXIT  # Setup only: Pi has not started.
printf 'run=%q\n' "$run"
mkdir -p "$run/project/.pi" "$run/agent"
project=$(cd "$run/project" && pwd -P)
bun -e 'const y = require("yaml"), p = y.parse(require("node:fs").readFileSync(0,"utf8")); p.filesystem_policy.read_write.push(process.argv[1]); process.stdout.write(y.stringify(p))' "$project" \
  < apps/openshell-sandbox/assets/policy.yaml > "$project/.pi/policy.yaml"
printf '%s\n' '{"openShellSandbox":{"policyPath":"./policy.yaml","profilePaths":[],"providers":[]}}' > "$project/.pi/settings.json"
printf 'project=%q\n' "$project"
cd -- "$project"
trap 'printf "%s\n" "$?" > "$proof/pi.exit"' EXIT
PI_CODING_AGENT_DIR="$run/agent" OPENSHELL_VERIFY_HOST="${run##*/}" \
  bun --bun "$repo/node_modules/.bin/pi" --approve --offline --no-mcp --no-context-files \
  --no-skills --no-extensions -e "$repo/apps/openshell-sandbox/src/index.ts" \
  --tools bash --session-dir "$proof/sessions" --tui-mode regular
)
```

Copy the printed `run`, `project`, and `proof` assignments into the host shell. Wait for Pi's editor to show the scratch project. Send the journey's literal input to **that editor**, followed by Enter, not to host Bash. If Pi exits before the editor appears, save the terminal error rather than sending more input.

## Doctor

Enter `/sandbox`. Save its reply from the terminal as `$proof/doctor.txt`. Require `Selected policy snapshot:` naming `$project/.pi/policy.yaml`, the bundled image, and the quoted `$project` under `Required explicit native read_write grants`. Start every journey from `OpenShell: ready`; if still preparing, wait and request `/sandbox` again. If initial preparation is blocked, record the reason, skip all journeys, and go to Cleanup. Record the TLS bundle directory for each prepared activation, including after a successful reload.

## Drive

Choose a journey from the [feature map](features/README.md); wait for each result before the next action. Select an authenticated model with `/model` if needed. Without a provider, run the user Bash or status checks and report the model tool calls as **not run**.

## Evidence

Record the literal inputs in `$proof/actions.txt`. Save each requested result from the PTY output or terminal scrollback under `$proof`, outside the mount, alongside the independent file readbacks. For model Bash, capture the **actual Bash tool call, command, and result**, not the assistant's explanation. Report the entry points proved and the evidence path. Review before sharing: transcripts can contain tool output and local recovery coordinates.

## Cleanup

If setup failed **before Pi was launched**, the setup trap removes the scratch directory; keep the printed proof path and error. No Doctor transcript is expected. If Pi started, enter `/quit` when idle. Save the final output as `$proof/shutdown.txt`; check `$proof/pi.exit`, shutdown diagnostics, and that each recorded private TLS bundle directory is gone on the host. A zero exit alone does not prove disposal. If native cleanup is uncertain, preserve scratch and follow the [recovery procedure](../../../apps/openshell-sandbox/README.md#after-failed-shutdown); do not sweep Docker or kill gateways by name.

After confirmed non-launch or disposal, remove any remaining scratch directory even if a journey failed or produced no evidence. Missing proof means **not verified**, not **skip cleanup**:

```bash
if test -d "${run:?}"; then rm -r -- "$run"; fi && ls -l "${proof:?}"
```
