import type { ChildProcess, spawn } from "node:child_process";
import { processScenario } from "../../host/test/index.helper.ts";
import { unitRuntimeFixture as runtimeFixture } from "../../runtime/test/index.helper.ts";

/** Supplies a failed spawn whose simulated process remains owned until signals are allowed.
 * @returns Isolated host effects, child, signal history, and a termination gate.
 * @example failedGatewayLaunch().allowTermination() permits captured-resource cleanup.
 */
export function failedGatewayLaunch() {
  const fixture = runtimeFixture();
  const scenario = processScenario(() => undefined);
  let refuseTermination = true;
  const host = {
    ...fixture.effects.host,
    processEffects: {
      ...scenario.effects,
      spawn: (() => {
        queueMicrotask(() =>
          scenario.child.emit("error", new Error("private launch detail")),
        );
        return scenario.child;
      }) as typeof spawn,
      signal: (child: ChildProcess, signal: NodeJS.Signals) => {
        if (refuseTermination) {
          throw new Error("private signal detail");
        }
        scenario.effects.signal(child, signal);
      },
    },
  };
  return {
    fixture,
    scenario,
    host,
    allowTermination: () => {
      refuseTermination = false;
    },
  };
}
