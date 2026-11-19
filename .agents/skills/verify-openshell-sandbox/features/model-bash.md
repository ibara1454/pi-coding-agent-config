# Model Bash and project writes

The model's Bash tool executes in the workload, with the canonical project mounted; it does not inherit Pi's arbitrary host environment.

## Sub-features

- `model-bash`: the workload sees the project but not a known host-only sibling file or Pi's host environment marker.
- `project-write`: output written by that command is visible from the host.

## How to get to it (user POV)

Ask the model to call Bash in Pi's editor; use `/sandbox` to inspect the same activation.

## Driving it with the Pi terminal

Preconditions: Doctor shows `ready`, the write-fixture prerequisite in [Launch](../SKILL.md#launch) holds, a model is available, and `model-write` does not exist. In the host shell:

```bash
printf '%s\n' "${run##*/}" > "$project/model-input"
printf 'host only\n' > "$run/host-only"
```

1. In Pi, enter `!cat ../host-only`. Require `host only` in the **result** and save it as `$proof/host-control.txt`. This confirms the same relative path works from Pi's host shell.
2. Enter: `Call the bash tool once with this exact command: pwd -P && test ! -e ../host-only && test -z "${OPENSHELL_VERIFY_HOST+x}" && cat model-input | tee model-write`
3. Wait for the tool result. If collapsed, press Ctrl+O. Save the call and result as `$proof/model-bash.txt`. Require the exact call, canonical project path, seed value, and no tool error.
4. Read the mounted write independently from the host: `cmp "$project/model-input" "$project/model-write" && cp "$project/model-write" "$proof/model-write.value"`. Enter `/sandbox` and save the `ready` reply as `$proof/model-status.txt`.

## Gotchas

Both host and workload see the same project path. `pwd` alone does not distinguish them. `!` and `!!` would take the wrong route; never use either as a substitute if the model cannot call the tool. This journey does not exercise credential providers or network access.
