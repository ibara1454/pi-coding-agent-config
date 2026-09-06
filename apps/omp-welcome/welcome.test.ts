import { describe, expect, test } from "bun:test";
import type { WelcomeExtension, WelcomeSession } from "./data.ts";
import { sanitizeInline, truncateToWidth, visibleWidth } from "./terminal.ts";
import { WelcomeHeader } from "./welcome.ts";

function required<T>(value: T): NonNullable<T> {
  expect(value).toBeDefined();
  expect(value).not.toBeNull();
  return value as NonNullable<T>;
}

function identityTheme(colorMode: "truecolor" | "256color" = "truecolor") {
  return {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
    italic: (text: string) => text,
    getColorMode: () => colorMode,
  } as const;
}

function header(
  overrides: Partial<ConstructorParameters<typeof WelcomeHeader>[0]> = {},
) {
  return new WelcomeHeader({
    version: "0.84.1",
    extensions: [],
    recentSessions: [],
    selectedTip: "Use /model to choose the active model.",
    theme: identityTheme(),
    requestRender: () => {},
    terminalRows: () => 40,
    ...overrides,
  });
}

function rawLines(component: WelcomeHeader, width: number): string[] {
  return component.render(width).map(sanitizeInline);
}

function sectionIndex(lines: readonly string[], heading: string): number {
  const index = lines.findIndex((line) => line.includes(heading));
  expect(index).toBeGreaterThanOrEqual(0);
  return index;
}

describe("wide welcome box", () => {
  test("should render OMP geometry, gradient logo, Pi tips, and ordered sections", () => {
    const extensions: WelcomeExtension[] = [
      { name: "project.ts", scope: "project" },
      { name: "user.ts", scope: "user" },
      { name: "npm:example", scope: "user" },
    ];
    const sessions: WelcomeSession[] = [
      { name: "Explicit session", timeAgo: "just now" },
      { name: "Prompt session", timeAgo: "2m ago" },
      { name: "Third", timeAgo: "1h ago" },
      { name: "Fourth", timeAgo: "3d ago" },
    ];
    const component = header({ extensions, recentSessions: sessions });
    const rendered = component.render(102);
    const lines = rendered.map(sanitizeInline);
    const first = required(lines[0]);
    const bottom = required(lines.find((line) => line.startsWith("╰")));

    expect(first).toBe(`╭─── pi v0.84.1 ${"─".repeat(83)}╮`);
    expect(visibleWidth(first)).toBe(100);
    expect(bottom).toMatch(/^╰─+┴─+╯$/);
    expect(visibleWidth(bottom)).toBe(100);
    expect(
      rendered.filter((line) => line.includes("\x1b[38;2;")),
    ).not.toHaveLength(0);
    expect(sectionIndex(lines, "Tips")).toBeLessThan(
      sectionIndex(lines, "Extensions"),
    );
    expect(sectionIndex(lines, "Extensions")).toBeLessThan(
      sectionIndex(lines, "Recent sessions"),
    );
    expect(
      lines.filter(
        (line) =>
          line.includes("for commands") ||
          line.includes("to run bash") ||
          line.includes("drop files to attach"),
      ),
    ).toHaveLength(4);
    expect(
      lines.filter(
        (line) =>
          line.includes("just now") ||
          line.includes("2m ago") ||
          line.includes("1h ago") ||
          line.includes("3d ago"),
      ),
    ).toHaveLength(4);
    expect(lines.some((line) => line.includes("Welcome back!"))).toBe(true);
    expect(lines.at(-1)).toContain("active model.");
    component.dispose();
  });

  test("should omit model details, keep list entries on separate rows, and use one-row vertical padding", () => {
    const extensions: WelcomeExtension[] = [
      { name: "first", scope: "user" },
      { name: "second", scope: "project" },
      { name: "third", scope: "user" },
    ];
    const sessions: WelcomeSession[] = [
      { name: "Session one", timeAgo: "just now" },
      { name: "Session two", timeAgo: "2m ago" },
      { name: "Session three", timeAgo: "1h ago" },
    ];
    const lines = rawLines(
      header({ extensions, recentSessions: sessions }),
      102,
    );
    const bottomIndex = lines.findIndex((line) => line.startsWith("╰"));
    const boxRows = lines.slice(1, bottomIndex);
    expect(
      lines.some(
        (line) => line.includes("Claude Sonnet") || line.includes("Anthropic"),
      ),
    ).toBe(false);
    expect(
      boxRows.filter((line) =>
        extensions.some((extension) => line.includes(extension.name)),
      ),
    ).toHaveLength(extensions.length);
    expect(
      boxRows.filter((line) =>
        sessions.some((session) => line.includes(session.name)),
      ),
    ).toHaveLength(sessions.length);
    expect(boxRows[0]?.replace(/[│ ]/g, "") ?? "").toBe("");
    expect(boxRows.at(-1)?.replace(/[│ ]/g, "") ?? "").toBe("");
    expect(boxRows.at(-2)?.replace(/[│ ]/g, "") ?? "").not.toBe("");
  });

  test("should preserve three extension names and overflow when the wide header must scroll", () => {
    const extensions = Array.from({ length: 6 }, (_, index) => ({
      name: `extension-${index + 1}.ts`,
      scope: "user" as const,
    }));
    const lines = rawLines(header({ extensions, terminalRows: () => 17 }), 102);

    expect(lines).toHaveLength(19);
    expect(
      lines
        .filter((line) => line.includes("extension-"))
        .map((line) => line.match(/extension-\d+\.ts/)?.[0]),
    ).toEqual(["extension-1.ts", "extension-2.ts", "extension-3.ts"]);
    expect(lines.some((line) => line.includes("… +3 more"))).toBe(true);
  });
});

describe("narrow welcome box", () => {
  test("should stack left content then all named sections in one rounded box", () => {
    const lines = rawLines(
      header({
        extensions: [{ name: "local.ts", scope: "project" }],
        recentSessions: [{ name: "Saved work", timeAgo: "just now" }],
      }),
      32,
    );
    const first = required(lines[0]);
    const bottom = required(lines.find((line) => line.startsWith("╰")));
    const bottomIndex = lines.indexOf(bottom);
    const boxRows = lines.slice(1, bottomIndex);

    expect(first.startsWith("╭")).toBe(true);
    expect(bottom.includes("┴")).toBe(false);
    expect(sectionIndex(lines, "Welcome back!")).toBeLessThan(
      sectionIndex(lines, "Tips"),
    );
    expect(sectionIndex(lines, "Tips")).toBeLessThan(
      sectionIndex(lines, "Extensions"),
    );
    expect(sectionIndex(lines, "Extensions")).toBeLessThan(
      sectionIndex(lines, "Recent sessions"),
    );
    expect(lines.some((line) => line.includes("local.ts"))).toBe(true);
    expect(lines.some((line) => line.includes("Saved work"))).toBe(true);
    expect(boxRows[0]?.replace(/[│ ]/g, "") ?? "").toBe("");
    expect(boxRows.at(-1)?.replace(/[│ ]/g, "") ?? "").toBe("");
    expect(boxRows.at(-2)?.replace(/[│ ]/g, "") ?? "").not.toBe("");
  });

  test("should preserve three extension names and overflow when the stacked header must scroll", () => {
    const extensions = Array.from({ length: 6 }, (_, index) => ({
      name: `extension-${index + 1}.ts`,
      scope: "user" as const,
    }));
    const lines = rawLines(header({ extensions, terminalRows: () => 27 }), 32);

    expect(lines).toHaveLength(29);
    expect(
      lines
        .filter((line) => line.includes("extension-"))
        .map((line) => line.match(/extension-\d+\.ts/)?.[0]),
    ).toEqual(["extension-1.ts", "extension-2.ts", "extension-3.ts"]);
    expect(lines.some((line) => line.includes("… +3 more"))).toBe(true);
  });

  test("should show empty section rows and truncate values before trailing metadata", () => {
    const lines = rawLines(
      header({
        extensions: [
          {
            name: "an-exceptionally-long-extension-name-that-needs-truncation.ts",
            scope: "user",
          },
        ],
        recentSessions: [
          {
            name: "A session name that is intentionally too long to fit in this narrow row",
            timeAgo: "6d ago",
          },
        ],
      }),
      32,
    );

    expect(lines.some((line) => line.includes("… user"))).toBe(true);
    expect(lines.some((line) => line.includes("… (6d ago)"))).toBe(true);
    expect(lines.some((line) => line.includes("No extensions"))).toBe(false);
    expect(lines.some((line) => line.includes("No recent sessions"))).toBe(
      false,
    );
    expect(
      lines
        .filter((line) => line.startsWith("│"))
        .every((line) => visibleWidth(line) === 30),
    ).toBe(true);

    const empty = rawLines(header(), 32);
    expect(empty.some((line) => line.includes("No extensions"))).toBe(true);
    expect(empty.some((line) => line.includes("No recent sessions"))).toBe(
      true,
    );
  });
});

describe("terminal-cell-safe rendering", () => {
  test("should count graphemes in cells and close ANSI state before ellipsis", () => {
    const source = "\x1b[35m界e\u0301👩‍💻abcdef";
    const truncated = truncateToWidth(source, 6);

    expect(visibleWidth(source)).toBe(11);
    expect(visibleWidth(truncated)).toBe(6);
    expect(sanitizeInline(truncated)).toBe("界e\u0301👩‍💻…");
    expect(truncated.endsWith("\x1b[0m")).toBe(true);
  });

  test("should keep every box row within its terminal-cell budget for wide Unicode", () => {
    const component = header({
      extensions: [{ name: "拡張👩‍💻-長い名前.ts", scope: "user" }],
      recentSessions: [
        { name: "会話e\u0301👩‍💻-長い名前", timeAgo: "just now" },
      ],
      selectedTip: "Use 👩‍💻 and 界界 safely in a terminal-cell-aware tip.",
    });
    const lines = component.render(102);
    const box = lines.slice(
      0,
      lines.findIndex((line) => sanitizeInline(line).startsWith("╰")) + 1,
    );

    expect(box.every((line) => visibleWidth(line) === 100)).toBe(true);
    expect(
      lines.slice(box.length).every((line) => visibleWidth(line) <= 100),
    ).toBe(true);
    component.dispose();
  });

  test("should sanitize every rendered option string before terminal output", () => {
    const component = header({
      version: "\x1b[31m0.84.1\x1b[0m\nsafe",
      extensions: [
        {
          name: "\x1b]8;;https://evil.test\x07ext\x1b]8;;\x07\nname",
          scope: "user",
        },
      ],
      recentSessions: [
        { name: "session\u0007\n\u202Ename", timeAgo: "1m\rago" },
      ],
      selectedTip: "Use\u0000 controls\nsafely",
    });
    const rendered = component.render(102);
    const raw = rendered.join("\n");
    const plain = rendered.map(sanitizeInline).join("\n");

    expect(raw).not.toContain("https://evil.test");
    expect(raw).not.toContain("\u202E");
    expect(raw).not.toContain("\x1b[31m");
    expect(plain).toContain("pi v0.84.1 safe");
    expect(plain).toContain("ext name");
    expect(plain).toContain("session name (1m ago)");
    expect(plain).toContain("Use controls safely");
    component.dispose();
  });
});

describe("dynamic welcome behavior", () => {
  test("should use the 256-color logo fallback", () => {
    const component = header({ theme: identityTheme("256color") });
    const rendered = component.render(102).join("\n");

    expect(rendered).toContain("\x1b[38;5;");
    component.dispose();
  });
});
