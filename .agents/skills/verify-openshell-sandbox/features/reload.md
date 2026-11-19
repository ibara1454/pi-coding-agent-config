# Policy snapshot and fail-closed reload

Policy changes take effect on a new activation. Selecting a missing policy blocks model Bash rather than running the command on the host.

## Sub-features

- `cached-status`: `/sandbox` still identifies the selected snapshot after an on-disk change.
- `reload`: `/reload` applies the new selection and reports a preparation failure.
- `blocked-bash`: an attempted model Bash write fails and leaves no file.
- `host-while-blocked`: user `!` still runs on the host during the failed activation.

## How to get to it (user POV)

Edit the scratch project's `.pi/settings.json`, inspect `/sandbox`, then `/reload`. Request a Bash tool call from the model in that same session.

## Driving it with the Pi terminal

Preconditions: Doctor shows the valid `policy.yaml` snapshot and `ready`. Neither `.pi/missing.yaml`, `host-while-blocked`, nor `blocked-write` exists in the scratch project. Only step 4 needs a model.

1. On the host, `printf '%s\n' '{"openShellSandbox":{"policyPath":"./missing.yaml","profilePaths":[],"providers":[]}}' > "$project/.pi/settings.json"`. In Pi, enter `/sandbox`; save the fresh reply as `$proof/before-reload.txt`. It must still show the original policy and `ready`.
2. Enter `/reload` and wait for reload to finish. Enter `/sandbox`; save the reply naming `$project/.pi/missing.yaml` and reporting `OpenShell: model Bash blocked` as `$proof/after-reload.txt`.
3. Enter `!printf '%s\n' "$OPENSHELL_VERIFY_HOST" | tee host-while-blocked`. Save the result; in the host shell, `printf '%s\n' "${run##*/}" | cmp - "$project/host-while-blocked" && cp "$project/host-while-blocked" "$proof/host-while-blocked.value"`.
4. Enter: `Call the bash tool exactly once. Do not retry. Command: printf blocked > blocked-write`. Save the tool call and its **own result** as `$proof/blocked-bash.txt`. Require the exact `bash` command and an OpenShell error naming `Cannot read selected OpenShell native document: ` followed by the absolute `$project/.pi/missing.yaml`. A cancellation, model error, or the earlier status reply does not count. From the host, `test ! -e "$project/blocked-write" && printf 'blocked-write absent\n' > "$proof/blocked-write.txt"`.

## Gotchas

An assistant refusing to call Bash is not a fail-closed tool result. Missing model credentials block the tool-call check, not the independently observed snapshot checks. Use an absent policy file, not malformed Pi settings that could prevent Pi itself from launching. Reload is not recovery for resources left by a failed shutdown.
