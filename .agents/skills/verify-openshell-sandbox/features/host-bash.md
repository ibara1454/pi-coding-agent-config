# Host Bash

Both Pi user-shell prefixes run on the host, independently of the model's sandbox. This journey uses only a synthetic marker; no account or provider is needed.

## Sub-features

- `user-bash`: `!` can read the marker Pi inherited from its host process.
- `user-bash-double-bang`: `!!` reads the same host marker through Pi's second user-shell entry point.

## How to get to it (user POV)

Type a command beginning with `!` or `!!` directly into Pi's editor and submit it. These are not prompts asking the model to run Bash.

## Driving it with the Pi terminal

Preconditions: Doctor identified this scratch project; neither output file exists.

1. In Pi, enter `!printf "%s\n" "$OPENSHELL_VERIFY_HOST" | tee host-one`. Wait for the marker in the result and save it as `$proof/host-one.txt`.
2. Enter `!!printf "%s\n" "$OPENSHELL_VERIFY_HOST" | tee host-two`. Wait for the marker and save the result as `$proof/host-two.txt`.
3. From the **host** shell, verify both writes and save the observed bytes:

   ```bash
   for f in host-one host-two; do
     printf '%s\n' "${run##*/}" | cmp - "$project/$f" || break
     cp "$project/$f" "$proof/$f.value"
   done
   test -s "$proof/host-one.value" && test -s "$proof/host-two.value"
   ```

## Gotchas

The prompt echo contains the variable name, not the marker value. Require the exact marker in both files. This proves routing through both host entries, not what the model can see in later conversation or where its Bash tool runs.
