import { describe, expect, test as it } from "bun:test";
import { runtimeFixture } from "../test/index.helper.ts";
import { randomIdentity } from "./identity.ts";

const RANDOM_BYTES = 10;
const FULL_BYTE = 255;

describe("randomIdentity", () => {
  it("should encode supplied unpredictable bytes within native sandbox name bounds", () => {
    const fixture = runtimeFixture();
    expect(
      randomIdentity({
        ...fixture.effects,
        randomBytes: () => new Uint8Array(RANDOM_BYTES),
      }),
    ).toBe("aaaaaaaaaaaaaaaa");
    expect(
      randomIdentity({
        ...fixture.effects,
        randomBytes: () =>
          Uint8Array.from({ length: RANDOM_BYTES }, () => FULL_BYTE),
      }),
    ).toBe("7777777777777777");
  });
});
