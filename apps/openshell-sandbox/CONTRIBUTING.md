# Contributing to OpenShell sandbox

For installation and use, see the [package README](README.md).

## Package structure

```text
openshell-sandbox/
|-- adr/                       # Architecture decisions
|-- assets/
|   |-- agent-in-sandbox.svg   # Documented agent-in-sandbox usage
|   |-- architecture.svg       # Pi host-agent usage
|   `-- policy.yaml            # Native policy
`-- src/                       # Implementation and colocated tests
    |-- index.ts               # Pi extension factory
    |-- configuration/         # Trusted settings and policy/profile mapping
    |   |-- native/
    |   `-- validation/
    |-- diagnostics/           # Sanitized failures
    |-- gateway/               # Private gateway, configuration, and TLS
    |-- host/                  # Host capabilities and owned resource handles
    |-- image/                 # Default image reference, not an image builder
    |-- pi/
    |   |-- bash.ts            # Model-Bash adapter
    |   |-- commands/          # Cached /sandbox status
    |   `-- session/           # Activation lifecycle, trust, and UI
    |-- providers/             # Credential profiles and native providers
    |-- runtime/               # Whole-runtime disposal
    |   |-- execution/         # Command streams
    |   |-- generation/        # Provisioning and cleanup
    |   `-- work/              # Raw-work settlement and bounded waits
    `-- workspace/             # Guarded project and Git mounts
```

## Module and test-helper conventions

Use explicit named `index.ts` exports across modules, including imports prefixed with `openshell-sandbox/`; import siblings directly within an owner. Nested modules are visible through their enclosing interface. Keep test helpers in the owning module's `test/*.helper.ts`; cross-module fixture imports use its fixture-only `test/index.helper.ts`. Production cannot import helpers or suites.
