---
status: accepted
---

# Own private activations and cancel complete sandbox generations

Each `session_start` creates a fresh private OpenShell activation; only commands in that activation share its resources. Shutdown attempts bounded owned-resource cleanup. A later activation does not adopt, discover, or recover an older stack. This trades control-plane overhead and disposable container state for simple ownership and explicit configuration cutover with `/reload`.

The [package README](../README.md) owns setup/module conventions and operator actions; [ADR-0001](0001-openshell-configuration-and-trust-boundaries.md) owns permissions and credential validation. Production modules and colocated tests define the algorithms; this decision records their lifetime invariants.

## Isolation and preparation

- Register fail-closed model Bash before SDK/configuration loading. Required failures never fall back to host execution. User Bash (`!`/`!!`), Pi, file tools, model traffic, and unrelated host execution are outside this boundary and remain unchanged.
- Create private gateway endpoint/state/database/TLS, Docker network/namespace, provider instances, and sandbox identities. Do not use the operator's active/shared gateway. Use SDK resource APIs where available; native host operations still generate certificates, launch the gateway, and prepare its network. Leave supervisor selection and extraction to OpenShell, without `supervisor_bin` or `supervisor_image` overrides. Native temporary-extractor cleanup is best-effort and can warn without blocking startup; the extension does not retain extraction-resource recovery handles.
- Use SDK 0.0.116's mutable default image unless trusted settings select an override; [image and toolchain limitations](../README.md#installation-and-prerequisites) are operator constraints, not extra readiness checks.
- Snapshot trusted settings and selected native YAML on activation. After create acknowledgment, await SDK `waitReady` and verify identity before admitting Bash, without guest bootstrap. Readiness is native lifecycle availability, not permission, toolchain, privilege-separation, or project-write proof.
- Retain the create acknowledgment's immutable `sandboxId` in the ready resource bundle. Model Bash calls SDK `client.raw.execSandbox` with that ID, not a curated execution helper that resolves a mutable name again. Name-based readiness verifies the returned ID and labels before admitting Bash. Only `LANG`/`LC_ALL` locale overrides are added to execution.

## Lifetimes and cancellation

Startup creates, quit disposes, and new/resume/fork replace resources rather than treating conversation history as a container checkpoint. Reload also recreates because Pi replaces the extension owner and reload activates changed policy/provider/image inputs. Preserving unchanged resources across reload would require a surviving owner and a new cutover contract; skipping lifecycle hooks is not a safe handoff.

One sandbox generation includes one creation attempt, its concurrent model Bash and background work, and cleanup. Install the preparing generation before scheduling setup or publishing facts so concurrent calls share readiness and stale results cannot revive it. Cancellation/timeout or indeterminate execution invalidates the entire generation; commands are never replayed. A known nonzero exit remains an ordinary command failure, not automatic evidence of native denial or a broken sandbox.

Count raw work before launch and capture acquired resources before settling that work. Caller-facing timeout/cancellation and SDK stream aborts do not prove raw task or backend completion. Retain setup/create/exec requests until actual settlement; do not close their gateway, publish readiness into a retired generation, or let old cleanup overwrite a newer activation/footer. The runtime detaches its observer synchronously on activation abort or disposal.

Activation prerequisite work is owned too: a failed Docker-discovery child is retained before its error is sanitized. Shutdown waits for pending prerequisite capture and uses bounded termination; failed cleanup retains the handle until actual close. Late retired failures clean only their originating activation and publish safe transcript-only diagnostics, never a stale notification/footer over the current activation.

After confirmed generation cleanup, the same activation may create another generation using its prepared private gateway/providers. Uncertain creation or cleanup blocks that activation's model Bash. A later fresh activation is independent; it does not certify or repair the old cleanup failure.

## Ordinary retained-session cleanup

Track acquisition intents, handles, native names/IDs, and release capabilities in private live memory. Generic `OwnedResource` contains only readonly `kind: string` and `release: () => Promise<void>`; exact native identities remain in the owning closures, not generic bookkeeping. There is no persistent inventory or recovery sweep; native gateway files are protected operational state, not an ownership ledger.

- Track create as `not-sent`, `unknown`, `rejected`, or `acknowledged`; record an unpredictable sandbox name and unknown outcome before sending. Only a matching acknowledgment supplies the native ID. Native metadata and Docker template ownership labels are both checked. Providers likewise have unique native names and acknowledged IDs. Names aid identification, never authorize deleting replacements.
- Cleanup waits for raw work settlement under its own deadline. Never infer an unknown create's settlement from `Ready`, `NotFound`, deletion flags, or gateway exit. An authenticated pinned native `INVALID_ARGUMENT` can prove pre-acquisition rejection; arbitrary errors cannot.
- For acknowledged sandboxes, SDK queries must match the owned name, ID, and labels before phase-aware stop/delete and deletion confirmation. SDK provider lookup/deletion likewise preserves same-name replacements. There is no Docker container-name sweep or guessed-identity cleanup.
- Delete the sandbox before retiring providers/gateway. Retain the gateway's direct `ChildProcess` handle; `ManagedProcess` exposes only readonly `closed: Promise<ProcessClose>` and `terminate: () => Promise<void>`. Idempotent termination requires observed `close`; signalling alone is not completion. No PID discovery, process-table inspection, or descendant-termination guarantee is provided.
- Once safe, remove only the exact owned empty Docker network and private state matching its retained device/inode/UID identity. Preserve Docker image caches, unrelated resources, mounted project files, and completed writes. Container-only files/installations are disposable.

Unconfirmed cleanup reports sanitized failure and available exact recovery coordinates to the transcript before retiring the activation. Retained prepared-gateway endpoint/TLS/network facts remain useful before create starts; `not-sent` is not a created sandbox. `/sandbox` displays only the current activation's cached status. Unknown creation requires independent backend-settlement proof before separate operator cleanup. A crash loses private ownership history; no orphan sweep or cross-session recovery is promised. Reload is configuration cutover, not orphan cleanup. See the [failed-shutdown procedure](../README.md#after-failed-shutdown).

## Shared project files and verification limits

Independent Pi instances own separate native stacks but can mount the same live project. They can overwrite edits, race package outputs, or contend on Git locks. Linked worktrees also share common Git metadata. Each stack needs explicit canonical filesystem grants and actual host/guest access; the extension does not grant ancestors or serialize cross-session file operations.

The [architecture diagram](openshell-architecture.svg) shows the accepted credential trust boundary, not a toolchain/identity guarantee. [Automatic tests](../README.md#automatic-tests) use controlled native effects; they do not establish Docker/default-image or macOS acceptance.
