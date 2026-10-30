import { describe, expect, test as it } from "bun:test";
import { fileURLToPath } from "node:url";
import {
  loadSandboxEnvironment,
  type SettingsFilesystem,
} from "./selection.ts";
import {
  CONTEXT,
  files,
  GLOBAL,
  POLICY,
  settings,
} from "./test/selection.helper.ts";

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: Groups all loadSandboxEnvironment cases for one operation.
describe("loadSandboxEnvironment", () => {
  it("should combine fields and resolve paths from their declaring directories when trusted settings override global fields", async () => {
    const filesystem = files({
      "/agent/settings.json": settings({
        policyPath: "policy.yaml",
        profilePaths: ["profiles/shared.yaml"],
        image: "global-image",
        providers: [
          {
            name: "global",
            profile: "github",
            credentialsFromEnv: { ["GITHUB_TOKEN"]: "GLOBAL_TOKEN" },
          },
        ],
      }),
      "/project/.pi/settings.json": settings({
        policyPath: "../project-policy.yaml",
        providers: [
          {
            name: "project",
            profile: "github",
            credentialsFromEnv: { ["GITHUB_TOKEN"]: "PROJECT_TOKEN" },
          },
        ],
      }),
      "/project/project-policy.yaml": POLICY,
      "/agent/profiles/shared.yaml": "id: github\ndisplay_name: GitHub\n",
    });
    const environment = await loadSandboxEnvironment(CONTEXT, filesystem);
    expect(environment).toMatchObject({
      policy: { sourcePath: "/project/project-policy.yaml" },
      profiles: [{ sourcePath: "/agent/profiles/shared.yaml" }],
      image: "global-image",
      providers: [
        {
          name: "project",
          profile: "github",
          credentialMode: "explicit",
          credentialsFromEnv: { ["GITHUB_TOKEN"]: "PROJECT_TOKEN" },
        },
      ],
    });
    expect(Object.isFrozen(environment.providers[0]?.credentialsFromEnv)).toBe(
      true,
    );
  });
  it.each([
    ["agent directory", { ...CONTEXT, agentDir: "relative" }],
    ["working directory", { ...CONTEXT, cwd: "relative" }],
  ])(
    "should reject settings before reading files when the %s is relative",
    async (_name, context) => {
      const filesystem = files({});
      await expect(
        loadSandboxEnvironment(context, filesystem),
      ).rejects.toMatchObject({
        code: "configuration-invalid",
      });
      expect(filesystem.reads).toEqual([]);
    },
  );
  it.each([
    ["a non-array profile list", { profilePaths: "profile.yaml" }],
    // biome-ignore lint/plugin/biome-rules/use-undefined: Settings JSON may contain a null profile path; it must not be treated as omission.
    ["an invalid profile path", { profilePaths: [null] }],
    ["an empty policy path", { policyPath: "" }],
    ["a control character in the image name", { image: "image\nsecret" }],
  ])(
    "should reject settings before reading native documents when they contain %s",
    async (_name, setting) => {
      const filesystem = files({ "/agent/settings.json": settings(setting) });
      await expect(
        loadSandboxEnvironment(CONTEXT, filesystem),
      ).rejects.toMatchObject({
        code: "configuration-invalid",
      });
      expect(
        filesystem.reads.every((path) => path.endsWith("settings.json")),
      ).toBe(true);
    },
  );

  it("should sanitize unreadable trusted project settings without using the global layer as fallback", async () => {
    const filesystem: SettingsFilesystem = {
      readFile(path) {
        if (path === "/project/.pi/settings.json") {
          return Promise.reject(new Error("private filesystem payload"));
        }
        return Promise.reject(
          Object.assign(new Error("missing"), { code: "ENOENT" }),
        );
      },
    };
    await expect(
      loadSandboxEnvironment(CONTEXT, filesystem),
    ).rejects.toMatchObject({
      code: "configuration-read-failed",
      safeMessage: expect.not.stringContaining("private filesystem payload"),
    });
  });
  it("should reject duplicate profile identities across different selected files", async () => {
    const filesystem = files({
      "/agent/settings.json": settings({
        policyPath: "policy.yaml",
        profilePaths: ["first.yaml", "second.yaml"],
      }),
      "/agent/policy.yaml": POLICY,
      "/agent/first.yaml": "id: work\ndisplay_name: Work\n",
      "/agent/second.yaml": "id: work\ndisplay_name: Work\n",
    });
    await expect(
      loadSandboxEnvironment(CONTEXT, filesystem),
    ).rejects.toMatchObject({
      code: "configuration-invalid",
      safeMessage: expect.stringContaining("duplicate profile ids"),
    });
  });

  it("should fail closed without leaking filesystem details when a selected profile cannot be read", async () => {
    const filesystem = files({
      "/agent/settings.json": settings({
        policyPath: "policy.yaml",
        profilePaths: ["missing.yaml"],
      }),
      "/agent/policy.yaml": POLICY,
    });
    await expect(
      loadSandboxEnvironment(CONTEXT, filesystem),
    ).rejects.toMatchObject({
      code: "configuration-read-failed",
      safeMessage: expect.stringContaining("/agent/missing.yaml"),
    });
  });
  it.each(["{", "null", "[]", "42"])(
    "should reject malformed settings without source payloads when the document is %s",
    async (document) => {
      const filesystem = files({ "/agent/settings.json": document });
      await expect(
        loadSandboxEnvironment(CONTEXT, filesystem),
      ).rejects.toMatchObject({
        code: "configuration-invalid",
        safeMessage:
          "Invalid OpenShell settings document: /agent/settings.json",
      });
    },
  );
  it("should ignore unrelated settings and retain defaults when the extension field is absent", async () => {
    const policyPath = fileURLToPath(
      new URL("../../assets/policy.yaml", import.meta.url),
    );
    const filesystem = files({
      "/agent/settings.json": '{"theme":"dark"}',
      [policyPath]: POLICY,
    });
    const environment = await loadSandboxEnvironment(CONTEXT, filesystem);
    expect(environment.profiles).toEqual([]);
    expect(environment.providers).toEqual([]);
    expect(environment.image).toBeUndefined();
    expect(environment.policy.sourcePath).toBe(policyPath);
  });
  it("should read each selected document once and freeze a provenance snapshot when profiles and image are supplied", async () => {
    const filesystem = files({
      "/agent/settings.json": settings({
        policyPath: "/policy.yaml",
        profilePaths: ["/profile.yaml"],
        image: "selected-image",
      }),
      "/policy.yaml": "version: 1",
      "/profile.yaml": "id: work\ndisplay_name: Work",
    });
    const result = await loadSandboxEnvironment(CONTEXT, filesystem);
    expect(result.image).toBe("selected-image");
    expect(result.policy.sourcePath).toBe("/policy.yaml");
    expect(
      result.profiles.map(({ sourcePath, sdkProfiles }) => ({
        sourcePath,
        ids: sdkProfiles.map(({ id }) => id),
      })),
    ).toEqual([{ sourcePath: "/profile.yaml", ids: ["work"] }]);
    expect(
      filesystem.reads.filter((path) => path === "/policy.yaml"),
    ).toHaveLength(1);
    expect(
      filesystem.reads.filter((path) => path === "/profile.yaml"),
    ).toHaveLength(1);
    expect(Object.isFrozen(result.profiles[0]?.sdkProfiles[0])).toBe(true);
  });
  it("should exclude all project configuration when the project is untrusted", async () => {
    const filesystem = files({
      "/agent/settings.json": GLOBAL,
      "/agent/policy.yaml": POLICY,
      "/project/.pi/settings.json": "malformed project secrets",
    });
    const environment = await loadSandboxEnvironment(
      { ...CONTEXT, projectTrusted: false },
      filesystem,
    );
    expect(environment.policy.sdkPolicy.filesystem?.readWrite).toEqual([
      "/explicit",
    ]);
    expect(filesystem.reads.some((path) => path.startsWith("/project/"))).toBe(
      false,
    );
  });
  it("should preserve declaring-directory provenance when trusted settings inherit profiles", async () => {
    const filesystem = files({
      "/agent/settings.json": settings({
        policyPath: "policy.yaml",
        profilePaths: ["profiles/work.yaml"],
      }),
      "/agent/profiles/work.yaml": "id: work\ndisplay_name: Work\n",
      "/project/.pi/settings.json": settings({ policyPath: "project.yaml" }),
      "/project/.pi/project.yaml":
        "version: 1\nfilesystem_policy:\n  read_write: [/project]\n",
    });
    const environment = await loadSandboxEnvironment(CONTEXT, filesystem);
    expect(environment.policy.sourcePath).toBe("/project/.pi/project.yaml");
    expect(environment.profiles[0]?.sourcePath).toBe(
      "/agent/profiles/work.yaml",
    );
    expect(environment.policy.sdkPolicy.filesystem?.readWrite).toEqual([
      "/project",
    ]);
    expect(filesystem.reads).not.toContain("/agent/policy.yaml");
  });
  it("should replace unsupported inherited providers and missing profiles when trusted arrays are empty", async () => {
    const filesystem = files({
      "/agent/settings.json": settings({
        policyPath: "policy.yaml",
        profilePaths: ["missing.yaml"],
        providers: [
          {
            name: "renew",
            profile: "github",
            credentialMode: "native-refresh",
          },
        ],
      }),
      "/project/.pi/settings.json": settings({
        profilePaths: [],
        providers: [],
      }),
      "/agent/policy.yaml": POLICY,
    });
    const environment = await loadSandboxEnvironment(CONTEXT, filesystem);
    expect(environment.providers).toEqual([]);
    expect(environment.profiles).toEqual([]);
    expect(filesystem.reads).not.toContain("/agent/missing.yaml");
  });
  it("should reject every effective renewal request before YAML or explicit credential requirements", async () => {
    const filesystem = files({
      "/agent/settings.json": settings({
        policyPath: "missing.yaml",
        providers: [
          { name: "missing-mapping", profile: "github" },
          {
            name: "renew",
            profile: "github",
            credentialMode: "native-refresh",
          },
        ],
      }),
    });
    await expect(
      loadSandboxEnvironment(CONTEXT, filesystem),
    ).rejects.toMatchObject({
      code: "credential-mode-unsupported",
      safeMessage: expect.stringContaining("native-refresh"),
    });
    expect(filesystem.reads.some((path) => path.endsWith(".yaml"))).toBe(false);
  });
  it.each([
    ["malformed JSON", "{"],
    ["null settings", "null"],
    // biome-ignore lint/plugin/biome-rules/use-undefined: Settings JSON may explicitly set extension configuration to null; it must fail closed.
    ["null extension settings", settings(null)],
    ["unsupported security switch", settings({ enabled: false })],
    [
      "unknown credential mode",
      settings({
        providers: [
          { name: "work", profile: "github", credentialMode: "auto" },
        ],
      }),
    ],
  ])(
    "should fail closed when global settings contain %s",
    async (_label, document) => {
      const filesystem = files({ "/agent/settings.json": document });
      await expect(
        loadSandboxEnvironment(CONTEXT, filesystem),
      ).rejects.toThrow();
      expect(filesystem.reads.some((path) => path.endsWith(".yaml"))).toBe(
        false,
      );
    },
  );
  it("should fail closed when a selected policy is missing", async () => {
    const filesystem = files({ "/agent/settings.json": GLOBAL });
    await expect(loadSandboxEnvironment(CONTEXT, filesystem)).rejects.toThrow(
      "/agent/policy.yaml",
    );
  });

  it("should reject an obsolete client setting before reading native configuration", async () => {
    const providers = [
      {
        name: "work",
        profile: "github",
        credentialsFromEnv: { ["GITHUB_TOKEN"]: "WORK_TOKEN" },
        client: { type: "git", host: "github.com" },
      },
    ];
    const filesystem = files({
      "/agent/settings.json": settings({ providers }),
    });
    await expect(
      loadSandboxEnvironment(CONTEXT, filesystem),
    ).rejects.toMatchObject({ code: "configuration-invalid" });
    expect(filesystem.reads.some((path) => path.endsWith(".yaml"))).toBe(false);
  });
  it("should retain an immutable snapshot when source files and nested consumers change", async () => {
    const documents = {
      "/agent/settings.json": GLOBAL,
      "/agent/policy.yaml": POLICY,
    };
    const filesystem = files(documents);
    const environment = await loadSandboxEnvironment(CONTEXT, filesystem);
    documents["/agent/policy.yaml"] = "version: 1";
    expect(() =>
      environment.policy.sdkPolicy.filesystem?.readWrite.push("/unexpected"),
    ).toThrow();
    expect(environment.policy.sdkPolicy.filesystem?.readWrite).toEqual([
      "/explicit",
    ]);
    expect(Object.isFrozen(environment)).toBe(true);
  });
  it("should reject unreadable settings without exposing filesystem payloads", async () => {
    const filesystem: SettingsFilesystem = {
      readFile() {
        return Promise.reject(
          Object.assign(new Error("secret filesystem payload"), {
            code: "EACCES",
          }),
        );
      },
    };
    await expect(
      loadSandboxEnvironment(CONTEXT, filesystem),
    ).rejects.toMatchObject({
      code: "configuration-read-failed",
      safeMessage: expect.not.stringContaining("secret filesystem payload"),
    });
  });
  it.each([
    ["policy", "/agent/policy.yaml"],
    ["profile", "/agent/profile.yaml"],
  ])(
    "should fail closed without exposing filesystem errors when selected %s cannot be read",
    async (_case, missingPath) => {
      const reads: string[] = [];
      const documents: Record<string, string> = {
        "/agent/settings.json": JSON.stringify({
          openShellSandbox: {
            policyPath: "policy.yaml",
            profilePaths: ["profile.yaml"],
          },
        }),
        "/agent/policy.yaml": "version: 1",
        "/agent/profile.yaml": "id: work\ndisplay_name: Work",
      };
      await expect(
        loadSandboxEnvironment(
          { ...CONTEXT, projectTrusted: false },
          {
            readFile(path) {
              reads.push(path);
              if (path === missingPath) {
                return Promise.reject(new Error("secret filesystem failure"));
              }
              return Promise.resolve(documents[path] ?? "");
            },
          },
        ),
      ).rejects.toMatchObject({
        code: "configuration-read-failed",
        safeMessage: expect.not.stringContaining("secret filesystem failure"),
      });
      expect(reads).toContain(missingPath);
      expect(reads).not.toContain("/project/.pi/settings.json");
    },
  );
});
