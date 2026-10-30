export type FailureCode =
  | "aborted"
  | "timeout"
  | "admission"
  | "preparation"
  | "execution"
  | "cleanup"
  | "validation";
export type SafeFailure = Readonly<{
  code: FailureCode;
  operation: string;
  safeMessage: string;
  recovery?: string;
}>;
