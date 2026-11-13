---
status: accepted
---

# Keep sandbox permissions and credential authority explicit

Global and trusted-project settings select one complete native permission policy and declare credential profiles/providers. Project trust includes authority over named host credential sources, attached profile grants, destination bindings, and image. We retain OpenShell's trusted gateway and separate supervisor/proxy container instead of introducing another credential broker. This isolates **model Bash**, not user Bash (`!`/`!!`), Pi, file tools, or the whole agent.

The [package README](../README.md#configuration) owns setup and migration instructions; [ADR-0002](0002-openshell-runtime-and-lifecycle.md) owns resource lifetimes.

## Configuration and policy authority

Global and trusted-project fields select `policyPath`, `profilePaths`, `providers`, and optional `image`; arrays and the selected policy replace rather than merge across settings layers. OpenShell separately composes the selected policy with attached provider-profile grants. [Settings precedence and examples](../README.md#configuration) describe the concrete configuration.

Native YAML maps to the pinned SDK 0.1.8 schema with explicit types/defaults. Unknown or unrepresentable fields fail rather than disappearing; native validation and enforcement remain authoritative. Removed `harness` fields and `tls: terminate`/`passthrough` modes are rejected, never translated into less restrictive inspection. This is not another permission language.

### Explicit filesystem and network grants

The [baseline](../assets/policy.yaml) grants tool paths and selected public GitHub/npm/PyPI operations, not the current project. Native filesystem grants are separate from bind mounts and execution working directories. Exact canonical project and external Git metadata paths avoid granting unrelated worktrees; follow the README's [inspect/edit/reload sequence](../README.md#configuration).

Do not mount the host home, SSH credentials, Docker socket, or arbitrary external symlink targets. The supplied policy uses `landlock.compatibility: hard_requirement`; unavailable required isolation is an error, not an automatic downgrade. An explicitly selected custom native policy remains the user's security choice and is not silently rewritten.

Network rules in the selected policy or attached provider profiles must explicitly permit each destination, operation, and executable as it exists in the selected image. Registry redirects, publishing/audit operations, and extra artifact hosts may need distinct grants. Neither mounts nor native readiness prove usable host/guest permissions or tool availability.

## Credential authority and isolation

Only explicitly mapped host environment variables are read. Tokens do not belong in settings, profile YAML, command arguments, image layers, or diagnostics; the full host environment is not forwarded. A missing selected variable fails rather than selecting anonymous access. Explicit credentials are the default; effective `credentialMode: "native-refresh"` is recognized but rejected before credential lookup, without fallback. Profile refresh metadata does not enable automatic renewal.

Custom profiles are imported through the native SDK once, without a duplicate pre-import lint RPC: native import already validates them. Import must acknowledge success and exactly the selected profile IDs. Before secret reads, local validation requires selected environment keys to be unambiguously declared, exactly one selected alias per required credential, no multiple selected aliases for one credential, and unique environment keys across providers. This prevents ambiguous credential selection before disclosure to native provisioning. Configured provider `name` values are policy-facing identities; provisioning translates explicit `credentialBinding.provider` references to unique native instances without changing the selected policy's grants.

OpenShell 0.1.8 adds attached provider-profile grants to the selected policy; it does not intersect them, and the former `providers_v2_enabled` toggle is gone. Existing policy rules stay in the policy; attaching a profile need not move or duplicate them. Import alone adds no permissions. A credential binding is separate from a network grant: both effective network permission and endpoint-scoped credential binding must pass. Profiles with endpoints supply their own bindings; explicit policy bindings may select only endpointless profiles. Do not disable TLS verification for authenticated traffic or claim a binary-bound credential secrecy guarantee.

The trusted host gateway and separate supervisor/proxy container handle real credentials; ordinary workload children receive **opaque credential handles**, not a universal non-disclosure guarantee. Allowed endpoints may return credentials, and granted project directories expose raw `.env`/`.npmrc` files. Use narrowly scoped credentials and trust those endpoints and native components.

## Custom credential profiles and authenticated clients

OpenShell 0.1.8 serves only imported profiles, including for GitHub and PyPI. Review and import a suitable profile through `profilePaths`; another gateway's catalog is not the extension's private catalog. Authenticated npm/PyPI registries need profiles that declare the required credential environment keys. For example, `work-npm.yaml` below grants read-only registry access to `/usr/bin/node` when its provider is attached; other selected-policy grants remain in place:

```yaml
id: work-npm
resource_version: 1
display_name: Work npm
category: other
credentials:
  - name: npm_token
    env_vars: [NPM_TOKEN]
    required: true
    auth_style: bearer
    header_name: authorization
    refresh:
      strategy: static
discovery:
  credentials: [npm_token]
endpoints:
  - host: registry.npmjs.org
    port: 443
    protocol: rest
    access: read-only
    enforcement: enforce
binaries:
  - /usr/bin/node
```

`refresh` is nested under the credential, not the profile root. Select the document with `profilePaths` relative to the declaring settings file, then include this entry in the effective `providers` array:

```json
{
  "name": "work-npm",
  "profile": "work-npm",
  "credentialsFromEnv": { "NPM_TOKEN": "WORK_NPM_TOKEN" }
}
```

This is illustrative configuration, not fresh native default-image acceptance. The host variable `WORK_NPM_TOKEN` supplies the value; `NPM_TOKEN` must match the profile's environment key. Keep any other needed providers/profiles when replacing arrays. The `/usr/bin/node` profile entry scopes native enforcement; it neither installs Node nor makes it a startup requirement.

Providers supply credential environment placeholders, not client configuration. Workloads must configure Git/npm/pip manually while preserving TLS/proxy settings. The README owns the rejected [`providers[].client` migration and path-specific Git trust caveats](../README.md#configuration).

## Trade-off and sources

Machine-local native paths avoid a portable-policy translation layer; manual review plus `/reload` avoids a second policy-authoring product. Runtime approvals, automatic credential renewal, and custom loopback forwarding are not implemented.

- [Pinned native policy schema](https://github.com/NVIDIA/OpenShell/blob/v0.1.8/docs/how-it-works/policies/schema.mdx)
- [Pinned Docker runtime model](https://github.com/NVIDIA/OpenShell/blob/v0.1.8/crates/openshell-driver-docker/README.md#runtime-model)
- [Native credential profiles](https://github.com/NVIDIA/OpenShell/blob/v0.1.8/crates/openshell-providers/src/profiles.rs)
