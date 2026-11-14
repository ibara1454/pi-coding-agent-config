import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test as it,
  type Mock,
  spyOn,
} from "bun:test";
import { Code, ConnectError } from "@connectrpc/connect";
import { DEFAULT_SANDBOX_IMAGE } from "../../image/index.ts";
// biome-ignore lint/performance/noNamespaceImport: Scoped spies must replace workspace inspection without filesystem effects.
import * as workspaceBoundary from "../../workspace/index.ts";
import { unitRuntimeFixture } from "../test/index.helper.ts";
import { deadline } from "../work/index.ts";
// biome-ignore lint/performance/noNamespaceImport: Scoped spies must control native creation outcomes.
import * as provisionBoundary from "./provision.ts";
import {
  awaitGenerationReadiness,
  createGenerationSandbox,
  runGenerationSetup,
} from "./setup.ts";
import {
  gateway,
  generation,
  work,
  workspace,
} from "./test/generation.helper.ts";
import type { GenerationEvent } from "./types.ts";

const PREPARATION_DEADLINE_MS = 100;

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: This suite groups one operation's cases.
describe("runGenerationSetup", () => {
  let inspect: Mock<typeof workspaceBoundary.inspectWorkspace>;
  beforeEach(() => {
    inspect = spyOn(workspaceBoundary, "inspectWorkspace").mockResolvedValue(
      workspace,
    );
  });
  afterEach(() => {
    inspect.mockRestore();
  });

  it.each([
    ["the release-matched base", {}, DEFAULT_SANDBOX_IMAGE],
    ["a selected", { image: "selected:tag" }, "selected:tag"],
  ] as const)(
    "should choose %s image and return only locale without guest setup",
    async (_condition, imageSettings, expectedImage) => {
      const fixture = unitRuntimeFixture();
      const prepared = gateway(fixture);
      fixture.native.sandboxId = "sandbox-1";
      fixture.native.sandboxName = "test-sandbox";
      fixture.native.labels = { ...prepared.handle.labels };
      const { image: _selected, ...environment } = fixture.environment;
      const current = work(fixture, prepared);
      const events: GenerationEvent[] = [];
      let requestedImage: string | undefined;
      try {
        const ready = await runGenerationSetup({
          ...current,
          input: {
            ...current.input,
            environment: { ...environment, ...imageSettings },
          },
          createSandbox: (_gateway, _workspace, image) => {
            requestedImage = image;
            return Promise.resolve("sandbox-1");
          },
          report: (event) => events.push(event),
        });
        expect(requestedImage).toBe(expectedImage);
        expect(ready.environment).toEqual({
          ["LANG"]: "C.UTF-8",
          ["LC_ALL"]: "C.UTF-8",
        });
        expect(fixture.sdk.commands).toEqual([]);
        expect(events).toContainEqual({
          generation: current.generation,
          kind: "image",
          image: expectedImage,
        });
        expect(fixture.native.calls).toEqual([]);
      } finally {
        current.preparation.close();
        fixture.clock.restore();
      }
    },
  );
  it.each([
    ["id", { id: "replacement" }],
    ["name", { name: "replacement" }],
    ["labels", { labels: {} }],
  ] as const)(
    "should refuse readiness when the acknowledged sandbox %s changes",
    async (_condition, replacement) => {
      const fixture = unitRuntimeFixture();
      const prepared = gateway(fixture);
      const current = work(fixture, prepared);
      const ready = spyOn(
        fixture.sdk.client.sandbox,
        "waitReady",
      ).mockResolvedValue({
        id: "sandbox-1",
        name: current.generation.sandboxName,
        labels: { ...prepared.handle.labels },
        phase: "ready",
        resourceVersion: "1",
        workspace: "default",
        serviceUrls: {},
        ...replacement,
      });
      try {
        await expect(runGenerationSetup(current)).rejects.toThrow("identity");
        expect(fixture.sdk.commands).toEqual([]);
      } finally {
        current.preparation.close();
        ready.mockRestore();
        fixture.clock.restore();
      }
    },
  );
});

describe("awaitGenerationReadiness", () => {
  it("should publish SDK readiness and close its preparation timer", async () => {
    const fixture = unitRuntimeFixture();
    try {
      const handle = generation(fixture);
      const expected = await handle.readiness;
      const events: GenerationEvent[] = [];
      expect(
        await awaitGenerationReadiness({
          setup: handle.readiness,
          preparation: deadline(fixture.effects, PREPARATION_DEADLINE_MS),
          generation: handle,
          report: (event) => events.push(event),
          invalidate: () => Promise.reject(new Error("Unexpected cleanup")),
        }),
      ).toBe(expected);
      expect(events).toEqual([
        { kind: "ready", generation: handle, resources: expected },
      ]);
      expect(fixture.clock.pending()).toBe(0);
    } finally {
      fixture.clock.restore();
    }
  });
  it("should surface cleanup failure before preparation failure when SDK readiness fails", async () => {
    const fixture = unitRuntimeFixture();
    const current = work(fixture);
    const events: GenerationEvent[] = [];
    const failure = new Error("cleanup blocked");
    try {
      await expect(
        awaitGenerationReadiness({
          setup: Promise.reject(new Error("SDK readiness failed")),
          preparation: current.preparation,
          generation: current.generation,
          report: (event) => events.push(event),
          invalidate: () => Promise.reject(failure),
        }),
      ).rejects.toBe(failure);
      expect(events.some((event) => event.kind === "ready")).toBe(false);
      expect(fixture.clock.pending()).toBe(0);
    } finally {
      current.preparation.close();
      fixture.clock.restore();
    }
  });
});

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: This suite groups one operation's cases.
describe("createGenerationSandbox", () => {
  it.each([
    ["acknowledged", undefined, ["unknown", "acknowledged"]],
    [
      "rejected",
      new ConnectError("bad policy", Code.InvalidArgument),
      ["unknown", "rejected"],
    ],
    [
      "uncertain",
      new ConnectError("lost reply", Code.Unavailable),
      ["unknown"],
    ],
  ] as const)(
    "should record the %s native creation outcome only after raw settlement",
    async (_condition, error, expected) => {
      const fixture = unitRuntimeFixture();
      const prepared = gateway(fixture);
      const release = Promise.withResolvers<void>();
      const create = spyOn(
        provisionBoundary,
        "createNativeSandbox",
      ).mockImplementation(async (request) => {
        request.onCreateAttempt();
        await release.promise;
        if (error) {
          throw error;
        }
        return "sandbox-1";
      });
      const current = work(fixture, prepared);
      const recorded: { outcome: string; id?: string }[] = [];
      let creation: Promise<string> | undefined;
      try {
        creation = createGenerationSandbox({
          work: current,
          gateway: prepared,
          workspace,
          image: "selected:tag",
          record: (outcome, id) =>
            recorded.push({ outcome, ...(id ? { id } : {}) }),
        });
        expect(recorded).toEqual([{ outcome: "unknown" }]);
        release.resolve();
        const [result] = await Promise.allSettled([creation]);
        expect(result?.status).toBe(error ? "rejected" : "fulfilled");
        expect(
          result?.status === "rejected" ? result.reason : result?.value,
        ).toBe(error ?? "sandbox-1");
        expect(recorded.map(({ outcome }) => outcome)).toEqual([...expected]);
      } finally {
        release.resolve();
        await creation?.catch(() => undefined);
        current.preparation.close();
        create.mockRestore();
        fixture.clock.restore();
      }
    },
  );
});
