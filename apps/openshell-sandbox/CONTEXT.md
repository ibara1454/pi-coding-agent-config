# OpenShell sandbox

This context describes the model-Bash isolation boundary and the user's authority over permissions and credential bindings.

## Language

### Shell and resource lifetimes

**Model Bash**:
Shell commands requested through the model's Bash tool, forming the sandbox workload.

**User Bash**:
Shell commands explicitly entered with `!` or `!!`, retaining the user's normal host execution.
_Avoid_: sandbox workload

**Sandbox workload**:
Model-requested Bash commands and their children governed by the sandbox's restrictions, distinct from user Bash and the surrounding Pi session.
_Avoid_: sandboxed Pi

**Sandbox readiness**:
The sandbox's native lifecycle availability for model Bash, not a guarantee that a requested tool exists, client is configured, or permission/project write will succeed.
_Avoid_: permission proof, project-access proof

**Sandbox generation**:
One sandbox creation attempt and its shared model-Bash lifetime through cleanup. Commands sharing a generation also share its cancellation boundary.
_Avoid_: command, Pi session

**Runtime activation**:
One lifetime of private resources serving a Pi conversation. Successive activations, including for the same conversation, do not reuse the preceding activation's resources.
_Avoid_: conversation, Pi process, sandbox generation

**Sandbox environment**:
The resolved project, selected policy, credential declarations, and image choice for one activation.
_Avoid_: process environment variables, configuration file, running sandbox

**Project workspace**:
The selected host project directory and necessary Git metadata, shared as live files rather than an isolated copy.
_Avoid_: control-plane workspace, sandbox copy

### Permissions

**Permission policy**:
The permissions governing the sandbox workload's access to resources and operations.
_Avoid_: credential profile

**Selected policy**:
The permission policy designated for the next activation; selection does not make it active.

**Active policy**:
The permission policy governing a running sandbox workload; editing its source does not itself change it.

**Repository-local policy**:
A policy maintained for a repository rather than as a shared default; other configurations may still reference it.

**Machine-local policy**:
A policy tailored to a checkout's actual resource paths rather than intended to work unchanged across checkout locations.

### Credentials and authority

**Credential profile**:
A reusable description of credential inputs and the destinations to which they can be bound.
_Avoid_: provider instance, permission policy

**Provider configuration**:
A declaration selecting a credential profile and named credential sources for a native provider instance, not workload client configuration.
_Avoid_: credential profile, provider instance

**Provider instance**:
A configured native use of a credential profile with selected credential sources, distinct from its settings declaration.
_Avoid_: credential profile

**Workload client configuration**:
Workload-maintained Git/npm/pip or other client settings that use native credential environment placeholders; distinct from provider configuration and permission policy.
_Avoid_: provider configuration, automatic client bootstrap

**Credential authority**:
Permission to choose credential sources and their destination bindings.
_Avoid_: credential isolation

**Credential isolation**:
The boundary determining which actors may handle actual credential values.
_Avoid_: credential authority, universal credential non-disclosure

**Opaque credential handle**:
A workload-visible reference substituted for a real provider credential by the trusted native credential machinery.
_Avoid_: raw token, network permission

**Explicit credentials**:
Current credential values supplied by the user or external credential tooling; they may expire or be revoked.
