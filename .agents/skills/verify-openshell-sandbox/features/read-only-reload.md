# Reload a valid read-only policy

Change only the disposable project's native grant. Prove that a new activation can read the same file but cannot repeat a write that previously succeeded.

## Sub-features

- `writable-baseline`: model Bash writes to the project; the host reads the result.
- `read-only-cutover`: after `/reload`, the new policy is ready, reads work, and an attempted overwrite is denied without changing the file.

## How to get to it (user POV)

Select a policy in project settings, apply it with `/reload`, and request Bash tool calls in the same Pi terminal.

## Driving it with the Pi terminal

Preconditions: fresh [Launch and Doctor](../SKILL.md#launch), writable fixture ownership, authenticated model, no `policy-probe` file. Run the host commands **from the repository root**.

1. Ask Pi: `Call the bash tool once. Command: printf writable > policy-probe`. Require that exact successful tool call. On the host: `printf writable | cmp - "$project/policy-probe" && cp "$project/policy-probe" "$proof/before.value"`.
2. On the host, start from the bundled policy (not the writable copy) and add only the project's read grant:

   ```bash
   bun -e 'const y = require("yaml"), p = y.parse(require("node:fs").readFileSync(0,"utf8")); p.filesystem_policy.read_only.push(process.argv[1]); process.stdout.write(y.stringify(p))' "$project" < apps/openshell-sandbox/assets/policy.yaml > "$project/.pi/read-only.yaml" &&
     printf '%s\n' '{"openShellSandbox":{"policyPath":"./read-only.yaml","profilePaths":[],"providers":[]}}' > "$project/.pi/settings.json"
   ```

3. Enter `/reload`, wait for completion, then `/sandbox`. Require a **new reply** showing `OpenShell: ready` and `$project/.pi/read-only.yaml`. Save it and the new TLS directory. Ask: `Call the bash tool once. Command: cat policy-probe`. Require the successful result `writable`.
4. Ask: `Call the bash tool exactly once. Do not retry. Command: printf changed > policy-probe`. Require that exact call, a nonzero exit, and an access denial for `policy-probe` (not a missing file, cancellation, or preparation error). On the host, `cmp "$proof/before.value" "$project/policy-probe" && cp "$project/policy-probe" "$proof/after.value"`. Save all three calls and their own results beside the readbacks.

## Gotchas

The same file must be writable before reload and readable afterwards. Leave host modes, ownership, and the mount unchanged; changing them would not test the policy. A `ready` footer or an unchanged file without the denied tool result does not prove enforcement.
