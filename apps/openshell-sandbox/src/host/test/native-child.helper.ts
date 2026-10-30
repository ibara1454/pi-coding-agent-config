import { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";

/** Holds a synthetic subprocess response until the test releases completion.
 * @param output - Synthetic stdout reported before a successful close.
 * @param deferred - Optional gate delaying response after the child reports spawn.
 * @returns An in-memory child with observable spawn, output and close events.
 * @example nativeResponseChild("ok").stdout emits the supplied output before close.
 */
export function nativeResponseChild(
  output: string,
  deferred?: { entered: () => void; release: Promise<void> },
): ChildProcess {
  const child = new ChildProcess();
  Object.defineProperties(child, {
    stdout: { value: new PassThrough() },
    stderr: { value: new PassThrough() },
  });
  const settle = () => {
    child.stdout?.emit("data", Buffer.from(output));
    // biome-ignore lint/plugin/biome-rules/use-undefined: Node close reports a null signal after a numeric exit.
    child.emit("close", 0, null);
  };
  queueMicrotask(() => {
    child.emit("spawn");
    if (deferred) {
      deferred.entered();
      return deferred.release.then(settle);
    }
    return settle();
  });
  return child;
}
