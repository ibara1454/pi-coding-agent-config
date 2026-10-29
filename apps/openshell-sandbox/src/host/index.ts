export {
  captureHostContext,
  type HostCaptureEffects,
  resolveDockerHost,
  withGatewayExecutable,
} from "./context.ts";
export { dockerCommand } from "./ownership.ts";
export {
  defaultProcessEffects,
  nativeFailure,
  runHostProcess,
} from "./process.ts";
export {
  HostProcessError,
  type ManagedProcess,
  type ProcessClose,
  type ProcessEffects,
  type ProcessOptions,
  type ProcessResult,
} from "./process-types.ts";
export type {
  AcquisitionCapture,
  HostContext,
  HostPaths,
  OwnedResource,
} from "./types.ts";
