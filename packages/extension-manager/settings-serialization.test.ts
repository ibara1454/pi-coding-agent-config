import { describe, expect, test } from "bun:test";
import { serializeSettings } from "./settings-serialization.ts";
import type { JsonObject } from "./types.ts";

const settings: JsonObject = { extensions: ["./extensions"] };

const twoSpace = ["{", '  "extensions": [', '    "./extensions"', "  ]", "}"]
  .join("\n")
  .concat("\n");

const fourSpace = [
  "{",
  '    "extensions": [',
  '        "./extensions"',
  "    ]",
  "}",
]
  .join("\n")
  .concat("\n");

const tabbed = ["{", '\t"extensions": [', '\t\t"./extensions"', "\t]", "}"]
  .join("\n")
  .concat("\n");

const indentations: [string, string | undefined, string][] = [
  ["defaults to two spaces without previous content", undefined, twoSpace],
  [
    "reuses two-space previous indentation",
    '{\n  "extensions": []\n}\n',
    twoSpace,
  ],
  [
    "reuses four-space previous indentation",
    '{\n    "extensions": []\n}\n',
    fourSpace,
  ],
  ["reuses tab previous indentation", '{\n\t"extensions": []\n}\n', tabbed],
  [
    "falls back to two spaces for minified content",
    '{"extensions":[]}\n',
    twoSpace,
  ],
  [
    "takes the first indented line as the indentation",
    '{\n\t"outer": {\n        "inner": 1\n\t}\n}\n',
    tabbed,
  ],
];

const trailingNewlines: [string, string | undefined, string][] = [
  ["appends a newline without previous content", undefined, "{}\n"],
  ["keeps a previous final newline", "{}\n", "{}\n"],
  ["omits a newline the previous content lacked", "{}", "{}"],
  ["omits a newline for empty previous content", "", "{}"],
];

describe("serializeSettings", () => {
  test.each(indentations)(
    "should preserve the expected indentation for: %s",
    (_label: string, previousContent: string | undefined, expected: string) => {
      expect(serializeSettings(settings, previousContent)).toBe(expected);
    },
  );

  test.each(trailingNewlines)(
    "should preserve the expected final newline for: %s",
    (_label: string, previousContent: string | undefined, expected: string) => {
      expect(serializeSettings({}, previousContent)).toBe(expected);
    },
  );

  test("should render nested package entries with the detected indentation", () => {
    const document: JsonObject = {
      packages: [
        { source: "npm:kit", extensions: ["-extensions/alpha.ts"] },
        "npm:other",
      ],
    };

    expect(serializeSettings(document, '{\n  "packages": []\n}\n')).toBe(
      [
        "{",
        '  "packages": [',
        "    {",
        '      "source": "npm:kit",',
        '      "extensions": [',
        '        "-extensions/alpha.ts"',
        "      ]",
        "    },",
        '    "npm:other"',
        "  ]",
        "}",
        "",
      ].join("\n"),
    );
  });

  test("should preserve key insertion order", () => {
    expect(
      serializeSettings({ theme: "dark", extensions: [], packages: [] }, "{}"),
    ).toBe('{\n  "theme": "dark",\n  "extensions": [],\n  "packages": []\n}');
  });

  test("should omit keys whose value is undefined", () => {
    expect(
      serializeSettings({ extensions: undefined, theme: "dark" }, undefined),
    ).toBe('{\n  "theme": "dark"\n}\n');
  });
});
