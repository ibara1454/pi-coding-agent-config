import { describe, expect, test as it } from "bun:test";
import { ok } from "node:assert/strict";
import { create } from "@bufbuild/protobuf";
import {
  type SandboxPolicy,
  SandboxPolicySchema,
} from "@nvidia/openshell-sdk/raw";
import type { SandboxEnvironment } from "../../configuration/index.ts";
import { provisionProviders } from "../../providers/index.ts";
import {
  environment,
  gateway,
  profile,
} from "../../providers/test/index.helper.ts";
import { createNativeSandbox } from "./provision.ts";

const HTTPS_PORT = 443;

/** Selects explicit credentials and both bound and unbound network grants.
 * @example boundEnvironment().policy.sdkPolicy retains the configured "registry" name.
 */
function boundEnvironment(): SandboxEnvironment {
  return {
    ...environment(),
    profiles: [],
    policy: {
      sourcePath: "/policy.yaml",
      sdkPolicy: create(SandboxPolicySchema, {
        version: 1,
        filesystem: { readOnly: ["/etc"], readWrite: ["/project"] },
        process: { runAsUser: "sandbox", runAsGroup: "sandbox" },
        networkPolicies: {
          registry: {
            name: "registry",
            binaries: [{ path: "/usr/bin/curl" }],
            endpoints: [
              {
                host: "registry.example",
                ports: [HTTPS_PORT],
                protocol: "rest",
                enforcement: "enforce",
                credentialBinding: { provider: "registry" },
              },
              { host: "public.example", ports: [HTTPS_PORT] },
            ],
          },
        },
      }),
    },
  };
}

/** Records native submissions while provisioning a real endpointless profile mapping.
 * @example endpointlessProfileFixture().submissions starts empty until createNativeSandbox runs.
 */
function endpointlessProfileFixture() {
  const selectedProfile = profile();
  selectedProfile.endpoints = [];
  const fixture = gateway({ selected: selectedProfile });
  const { handle } = fixture;
  Object.assign(handle, {
    labels: { ["openshell.ai/instance-id"]: handle.instanceId },
  });
  const selected = boundEnvironment();
  const submissions: { policy?: SandboxPolicy; providers?: string[] }[] = [];
  Object.assign(handle.client.raw, {
    createSandbox: (request: {
      spec?: { policy?: SandboxPolicy; providers?: string[] };
    }) => {
      submissions.push(request.spec ?? {});
      return Promise.resolve({
        sandbox: {
          metadata: {
            id: "native-sandbox",
            name: "chosen",
            labels: handle.labels,
          },
        },
      });
    },
  });
  return {
    ...fixture,
    selected,
    submissions,
    request: {
      input: {
        environment: selected,
        preparedGateway: undefined,
        signal: handle.signal,
      },
      gateway: handle,
      sandboxName: "chosen",
      workspace: {
        projectRoot: "/project",
        mounts: [],
        requiredNativeReadWritePaths: [],
      },
      image: "selected:tag",
      signal: handle.signal,
    },
  };
}

describe("createNativeSandbox", () => {
  it("should bind an endpointless profile to its attached native provider without changing selected grants", async () => {
    const { handle, selected, owned, capture, calls, submissions, request } =
      endpointlessProfileFixture();
    const original = structuredClone(selected);
    let attempted = false;
    try {
      const providerNames = await provisionProviders(
        handle,
        selected,
        () => "secret",
        capture,
      );
      await createNativeSandbox({
        ...request,
        providerNames,
        onCreateAttempt: () => {
          expect(submissions).toHaveLength(0);
          attempted = true;
        },
      });
      expect(attempted).toBe(true);
      const [submitted] = submissions;
      if (!submitted?.policy) {
        throw new Error("Missing submitted policy.");
      }
      const { policy: submittedPolicy, providers: attachments } = submitted;
      const registry = submittedPolicy.networkPolicies["registry"];
      ok(registry, "Missing submitted registry policy.");
      const binding = registry.endpoints[0]?.credentialBinding;
      if (!binding) {
        throw new Error("Missing submitted credential binding.");
      }
      expect(providerNames["registry"]).toBe(binding.provider);
      expect(attachments).toEqual([binding.provider]);
      expect(binding.provider).not.toBe("registry");
      expect(submittedPolicy).not.toBe(selected.policy.sdkPolicy);
      expect(Object.isFrozen(submittedPolicy)).toBe(true);
      expect(Object.isFrozen(binding)).toBe(true);
      const restoredPolicy = structuredClone(submittedPolicy);
      const restoredBinding =
        restoredPolicy.networkPolicies["registry"]?.endpoints[0]
          ?.credentialBinding;
      if (!restoredBinding) {
        throw new Error("Missing copied credential binding.");
      }
      restoredBinding.provider = "registry";
      expect(restoredPolicy).toEqual(original.policy.sdkPolicy);
      expect(selected).toEqual(original);
      expect(calls).not.toContain("delete");
    } finally {
      await Promise.all(owned.map((resource) => resource.release()));
    }
    expect(calls.filter((call) => call === "delete")).toHaveLength(1);
  });
});
