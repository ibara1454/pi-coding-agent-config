# OpenShell: configuration to private resources

Model Bash follows this flow; user `!`/`!!` remains host-side. Start with the [package setup guide](../README.md#installation-and-prerequisites).

## Preparation

```text
Register fail-closed model Bash
  → snapshot trusted settings and selected native policy/profiles
  → inspect canonical project and required Git mounts
  → start private gateway/TLS/state/network
  → import profiles and validate credential declarations/aliases and ENV-key uniqueness
  → read explicitly named credentials and create unique native providers
  → create unique sandbox with selected policy, mounts and image
  → SDK waitReady + identity check (no guest bootstrap)
  → admit model Bash
```

## Activation and cleanup

```text
session_start (startup / reload / new / resume / fork)
  → fresh private activation → shared sandbox generation

cancellation / timeout / indeterminate execution
  → invalidate complete generation
  → confirmed cleanup: admit another generation, without replay
  → uncertain cleanup: block this activation's model Bash

shutdown / replacement
  → detach old publication → bounded owned disposal
  → failure: save available recovery coordinates to transcript
next activation → independent resources, not recovery
```

- [ADR-0001: permissions, credential validation, npm/PyPI profiles](0001-openshell-configuration-and-trust-boundaries.md)
- [ADR-0002: actual settlement, native identity and cleanup ownership](0002-openshell-runtime-and-lifecycle.md)
- [Operator recovery steps](../README.md#after-failed-shutdown)
- [Module/helper conventions](../README.md#package-structure)
- [Automatic tests and unverified native Docker/default-image/macOS limits](../README.md#automatic-tests)
- [Credential trust-boundary diagram](openshell-architecture.svg)
