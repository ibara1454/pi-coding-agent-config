import { describe, expect, test as it } from "bun:test";
import {
  HostProcessError,
  type ManagedProcess,
  type ProcessClose,
} from "./process-types.ts";

describe("HostProcessError.constructor", () => {
  it("should identify a safe process failure without ownership when no process is supplied", () => {
    const error = new HostProcessError("Safe launch failure");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("HostProcessError");
    expect(error.message).toBe("Safe launch failure");
    expect(error.cause).toBeUndefined();
  });
  it("should retain the exact uncertain process and cause when the caller owns a child", () => {
    const process: ManagedProcess = {
      closed: Promise.withResolvers<ProcessClose>().promise,
      terminate: () => Promise.resolve(),
    };
    const cause = new HostProcessError("Safe native failure");
    const error = new HostProcessError("Cleanup uncertain", process, { cause });
    expect(error.process).toBe(process);
    expect(error.cause).toBe(cause);
    expect(error.message).toBe("Cleanup uncertain");
  });
});
