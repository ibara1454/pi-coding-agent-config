/** Timer capabilities; each bounded operation owns its returned timer handle. */
export type TimerEffects = Readonly<{
  setTimer: (callback: () => void, milliseconds: number) => unknown;
  clearTimer: (handle: unknown) => void;
}>;
