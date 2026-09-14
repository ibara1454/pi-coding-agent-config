import { describe, expect, test } from "bun:test";
import { lintRule } from "./test-utils";

const invalid = `
// Unicode before and inside diagnostic spans exercises byte offsets.
// 日本語
export class Example {
  private méthode() {}
  #秘密() {}
  private static async generic<T>(value: T) { return value; }
  static async *#values() { yield 1; }
  private /* modifier trivia */ commented() {}
  private [Symbol.iterator]() { return []; }
  private overloaded(value: string): string;
  private overloaded(value: number): number;
  private overloaded(value: string | number) { return value; }
  public createNested() {
    return class Nested {
      #internal() {}
    };
  }
}

export declare class Declared {
  private method(): void;
}
`;

const valid = `
export class Example {
  private value = 1;
  #hidden = 2;
  private callback = () => 3;
  #callback = () => 4;

  private constructor(private readonly initial: number) {}

  public read() {
    return this.value + this.#hidden + this.callback() + this.#callback() + this.initial;
  }

  protected inherited() {}
  private() {}
  "#method"() {}

  createNested() {
    return class Nested {
      private value = 1;
      #hidden = 2;
      read() { return this.value + this.#hidden; }
    };
  }
}
`;

describe("no-private-methods", () => {
  test("should reject private method declarations and signatures", () => {
    expect(lintRule("no-private-methods", invalid)).toEqual(
      [
        "méthode",
        "#秘密",
        "generic",
        "#values",
        "commented",
        "[Symbol.iterator]",
        "overloaded",
        "overloaded",
        "overloaded",
        "#internal",
        "method",
      ].map((source) => ({ category: "plugin", severity: "error", source })),
    );
  });

  test("should allow fields, constructors, and nonprivate methods", () => {
    expect(lintRule("no-private-methods", valid)).toEqual([]);
  });
});
