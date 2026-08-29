import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ExtensionCommandContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { ExtensionCatalog } from "./catalog.ts";
import { createDefaultRuntime } from "./extension-runtime.ts";
import type { PanelResult } from "./panel.ts";
import type { CatalogSeed } from "./types.ts";

// The panel restores the terminal by disabling mouse reporting on dispose.
const MOUSE_DISABLE = "?1000l";

const packageDir = dirname(fileURLToPath(import.meta.url));

interface PackageManifest {
  readonly pi?: {
    readonly extensions?: readonly string[];
  };
}

// Pi loads this package through the entry declared in its own manifest, so the
// self-disable comparison path has to match that declaration on disk.
function declaredEntryPath(): string {
  const manifest = JSON.parse(
    readFileSync(resolve(packageDir, "package.json"), "utf8"),
  ) as PackageManifest;
  const declared = manifest.pi?.extensions ?? [];
  const entry = declared[0];
  if (declared.length !== 1 || entry === undefined) {
    throw new Error(
      `Expected exactly one declared pi.extensions entry, found ${declared.length}`,
    );
  }
  return resolve(packageDir, entry);
}

interface PanelHost {
  readonly ctx: ExtensionCommandContext;
  readonly finish: (result: PanelResult) => void;
  readonly customOptions: () => unknown;
  readonly teardowns: () => number;
}

function emptySeed(): CatalogSeed {
  return {
    rows: [],
    targets: new Map(),
    settings: new Map(),
    diagnostics: [],
    projectTrusted: true,
    tuiMode: "regular",
    reloadPending: false,
  };
}

function panelHost(): PanelHost {
  const writes: string[] = [];
  let options: unknown;
  let finish: (result: PanelResult) => void = () => undefined;
  const tui = {
    mode: "regular",
    terminal: {
      columns: 80,
      rows: 24,
      write(data: string) {
        writes.push(data);
      },
    },
    requestRender() {},
  } as unknown as TUI;
  const theme = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
    italic: (text: string) => text,
    underline: (text: string) => text,
    inverse: (text: string) => text,
    strikethrough: (text: string) => text,
  } as unknown as Theme;
  const ctx = {
    ui: {
      custom<T>(
        factory: (
          value: TUI,
          valueTheme: Theme,
          keybindings: never,
          done: (result: T) => void,
        ) => unknown,
        customOptions?: unknown,
      ): Promise<T> {
        options = customOptions;
        const pending = Promise.withResolvers<T>();
        finish = (result) => pending.resolve(result as T);
        factory(tui, theme, undefined as never, pending.resolve);
        return pending.promise;
      },
    },
  } as unknown as ExtensionCommandContext;
  return {
    ctx,
    finish: (result) => finish(result),
    customOptions: () => options,
    teardowns: () =>
      writes.filter((write) => write.includes(MOUSE_DISABLE)).length,
  };
}

describe("createDefaultRuntime", () => {
  test("should return the package-manifest entry module as selfPath", () => {
    const runtime = createDefaultRuntime();

    expect(runtime.selfPath).toBe(declaredEntryPath());
    expect(existsSync(runtime.selfPath)).toBe(true);
  });

  test("should open the panel as a full-size top-left overlay", async () => {
    const runtime = createDefaultRuntime();
    const host = panelHost();

    const open = runtime.openPanel(
      host.ctx,
      new ExtensionCatalog(emptySeed(), runtime.commit),
      runtime.selfPath,
    );

    expect(host.customOptions()).toEqual({
      overlay: true,
      overlayOptions: {
        anchor: "top-left",
        margin: 0,
        width: "100%",
        maxHeight: "100%",
      },
    });

    host.finish({ type: "closed" });
    await open;
  });

  test("should return the panel result and tear the panel down once", async () => {
    const runtime = createDefaultRuntime();
    const host = panelHost();

    const open = runtime.openPanel(
      host.ctx,
      new ExtensionCatalog(emptySeed(), runtime.commit),
      runtime.selfPath,
    );

    expect(host.teardowns()).toBe(0);

    host.finish({
      type: "commit",
      selfDisableCommitted: false,
      result: {
        scopes: [{ scope: "global", status: "committed" }],
        committedScopes: ["global"],
      },
    });

    expect(await open).toEqual({
      type: "commit",
      selfDisableCommitted: false,
      result: {
        scopes: [{ scope: "global", status: "committed" }],
        committedScopes: ["global"],
      },
    });
    expect(host.teardowns()).toBe(1);

    runtime.dispose();

    expect(host.teardowns()).toBe(1);
  });

  test("should dispose only panels owned by the returned runtime", async () => {
    const first = createDefaultRuntime();
    const second = createDefaultRuntime();
    const firstHost = panelHost();
    const secondHost = panelHost();
    const firstOpen = first.openPanel(
      firstHost.ctx,
      new ExtensionCatalog(emptySeed(), first.commit),
      first.selfPath,
    );
    const secondOpen = second.openPanel(
      secondHost.ctx,
      new ExtensionCatalog(emptySeed(), second.commit),
      second.selfPath,
    );

    first.dispose();

    expect(firstHost.teardowns()).toBe(1);
    expect(secondHost.teardowns()).toBe(0);

    second.dispose();

    expect(secondHost.teardowns()).toBe(1);

    firstHost.finish({ type: "closed" });
    secondHost.finish({ type: "closed" });
    await Promise.all([firstOpen, secondOpen]);

    expect(firstHost.teardowns()).toBe(1);
    expect(secondHost.teardowns()).toBe(1);
  });

  test("should tear the panel down once when dispose is invoked repeatedly after closure", async () => {
    const runtime = createDefaultRuntime();
    const host = panelHost();
    const open = runtime.openPanel(
      host.ctx,
      new ExtensionCatalog(emptySeed(), runtime.commit),
      runtime.selfPath,
    );

    host.finish({ type: "closed" });
    await open;
    runtime.dispose();
    runtime.dispose();

    expect(host.teardowns()).toBe(1);
  });
});
