import type { EventEmitter } from "node:events";
import { generation } from "../../generation/test/index.helper.ts";
import { unitRuntimeFixture } from "../../test/index.helper.ts";
import type { ExecutionEvents, RequestOwner } from "../types.ts";

/** Supplies a ready request owner with tracked raw work.
 * @returns Fixture, admitted generation, and captured raw work.
 * @example requestFixture().owner.admit() returns an owned ready generation.
 */
export function requestFixture() {
  const fixture = unitRuntimeFixture();
  const handle = generation(fixture);
  const raw: Promise<unknown>[] = [];
  const owner: RequestOwner = {
    effects: fixture.effects,
    admit: () => handle,
    trackRaw: (promise) => raw.push(promise),
  };
  return { fixture, owner, handle, raw };
}

interface Result {
  output: string;
  exitCode?: number;
  error?: Error;
  terminals: number;
}

/** Records public request events without replacing request settlement decisions.
 * @example completion(runtime.exec("exit 7", "/project")) yields exitCode 7 and one terminal.
 */
export function completion(
  emitter: EventEmitter<ExecutionEvents>,
): Promise<Result> {
  const settled = Promise.withResolvers<Result>();
  const result: Result = { output: "", terminals: 0 };
  emitter.on("data", (data) => {
    result.output += Buffer.from(data).toString();
  });
  emitter.on("exit", ({ exitCode }) => {
    result.exitCode = exitCode;
    result.terminals += 1;
    settled.resolve(result);
  });
  emitter.on("error", (error) => {
    result.error = error;
    result.terminals += 1;
    settled.resolve(result);
  });
  return settled.promise;
}
