import { describe, expect, test as it } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import {
  NetworkPolicyRuleSchema,
  SandboxPolicySchema,
} from "@nvidia/openshell-sdk/raw";
import { runtimeFixture, unitRuntimeFixture } from "../test/index.helper.ts";
import { createNativeSandbox, isRejectedCreate } from "./provision.ts";
import { gateway, input, workspace } from "./test/generation.helper.ts";

/** Captures ownership transition and native submission with one selected binding and no SDK I/O.
 * @example boundProviderFixture().captured.events records "attempt" before "create".
 */
function boundProviderFixture() {
  const fixture = unitRuntimeFixture();
  const prepared = gateway(fixture);
  const { sdkPolicy: policy } = fixture.environment.policy;
  policy.networkPolicies["registry"] = create(NetworkPolicyRuleSchema, {
    endpoints: [
      {
        host: "registry.example",
        credentialBinding: { provider: "registry" },
      },
    ],
  });
  const originalPolicy = structuredClone(policy);
  const captured: { request?: unknown; events: string[] } = { events: [] };
  const { createSandbox } = prepared.handle.client.raw;
  prepared.handle.client.raw.createSandbox = ((...[first]) => {
    captured.events.push("create");
    captured.request = first;
    return Promise.resolve({
      sandbox: {
        metadata: {
          id: "native-1",
          name: "chosen",
          labels: { ...prepared.handle.labels },
        },
      },
    });
  }) as typeof createSandbox;
  return { fixture, prepared, policy, originalPolicy, captured };
}

const BAD_ACKNOWLEDGMENTS = [
  ["missing id", { id: "" }],
  ["wrong name", { name: "foreign" }],
  ["wrong labels", { labels: {} }],
] as const;

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: This suite groups one operation's cases.
describe("createNativeSandbox", () => {
  it("should submit matching attachment and credential binding without changing selected policy or mounts", async () => {
    const { fixture, prepared, policy, originalPolicy, captured } =
      boundProviderFixture();
    try {
      expect(
        await createNativeSandbox({
          input: input(fixture),
          gateway: prepared.handle,
          sandboxName: "chosen",
          workspace,
          image: "image:tag",
          providerNames: { registry: "unique-provider" },
          signal: fixture.activation.signal,
          onCreateAttempt: () => captured.events.push("attempt"),
        }),
      ).toBe("native-1");
      expect(captured.events).toEqual(["attempt", "create"]);
      expect(captured.request).toMatchObject({
        name: "chosen",
        workspace: "default",
        labels: prepared.handle.labels,
        spec: {
          policy: {
            networkPolicies: {
              registry: {
                endpoints: [
                  {
                    host: "registry.example",
                    credentialBinding: { provider: "unique-provider" },
                  },
                ],
              },
            },
          },
          providers: ["unique-provider"],
          template: {
            image: "image:tag",
            labels: prepared.handle.labels,
            driverConfig: {
              docker: {
                mounts: [
                  {
                    type: "bind",
                    source: "/project",
                    target: "/project",
                    ["read_only"]: false,
                  },
                ],
              },
            },
          },
        },
      });
      expect(policy).toEqual(originalPolicy);
    } finally {
      fixture.clock.restore();
    }
  });
  it.each(["missing", "toString"])(
    "should reject unknown credential provider %s without a create attempt or sandbox RPC",
    async (provider) => {
      const fixture = unitRuntimeFixture();
      try {
        const prepared = gateway(fixture);
        const selected = input(fixture);
        const policy = create(SandboxPolicySchema, {
          version: 1,
          networkPolicies: {
            registry: {
              endpoints: [
                { host: "registry.example", credentialBinding: { provider } },
              ],
            },
          },
        });
        const original = structuredClone(policy);
        const { createSandbox } = prepared.handle.client.raw;
        let sent = false;
        let attempted = false;
        prepared.handle.client.raw.createSandbox = ((...args) => {
          sent = true;
          return createSandbox(...args);
        }) as typeof createSandbox;
        await expect(
          createNativeSandbox({
            input: {
              ...selected,
              environment: {
                ...selected.environment,
                policy: { sourcePath: "/policy.yaml", sdkPolicy: policy },
              },
            },
            gateway: prepared.handle,
            sandboxName: "chosen",
            workspace,
            image: "image:tag",
            providerNames: { registry: "unique-provider" },
            signal: fixture.activation.signal,
            onCreateAttempt: () => {
              attempted = true;
            },
          }),
        ).rejects.toThrow("unconfigured provider");
        expect(sent).toBe(false);
        expect(attempted).toBe(false);
        expect(policy).toEqual(original);
      } finally {
        fixture.clock.restore();
      }
    },
  );
  it.each(BAD_ACKNOWLEDGMENTS)(
    "should reject native acknowledgment when %s prevents matching immutable identity",
    async (_condition, fields) => {
      const fixture = runtimeFixture();
      const prepared = gateway(fixture);
      const original = fixture.sdk.client.raw.createSandbox;
      let attempted = false;
      fixture.sdk.client.raw.createSandbox = async (...args) => {
        expect(attempted).toBe(true);
        const response = await original(...args);
        const metadata = response.sandbox?.metadata;
        if (!metadata) {
          throw new Error("Fixture metadata missing");
        }
        Object.assign(metadata, fields);
        return response;
      };
      await expect(
        createNativeSandbox({
          input: input(fixture),
          gateway: prepared.handle,
          sandboxName: "test-sandbox",
          workspace,
          image: "selected:tag",
          providerNames: {},
          signal: fixture.activation.signal,
          onCreateAttempt: () => {
            attempted = true;
          },
        }),
      ).rejects.toThrow("acknowledgment");
      expect(attempted).toBe(true);
    },
  );
});

describe("isRejectedCreate", () => {
  it.each([
    [
      "invalid argument",
      new ConnectError("policy", Code.InvalidArgument),
      true,
    ],
    ["transport failure", new ConnectError("lost", Code.Unavailable), false],
    ["structural lookalike", { code: Code.InvalidArgument }, false],
  ] as const)(
    "should classify native %s without inferring absence from lookalikes",
    async (_condition, error, expected) => {
      expect(await isRejectedCreate(error)).toBe(expected);
    },
  );
});
