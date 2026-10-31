const PI_LOGO = [
  "▀██████████▀",
  " ╘██    ██  ",
  "  ██    ██  ",
  "  ██    ██  ",
  " ▄██▄  ▄██▄ ",
] as const;

const RGB_CHANNEL_MAX = 255;
const GRADIENT_PINK_RED = RGB_CHANNEL_MAX;
const GRADIENT_PINK_GREEN = 92;
const GRADIENT_PINK_BLUE = 200;
const GRADIENT_PURPLE_RED = 200;
const GRADIENT_PURPLE_GREEN = 110;
const GRADIENT_PURPLE_BLUE = RGB_CHANNEL_MAX;
const GRADIENT_BLUE_VIOLET_RED = 120;
const GRADIENT_BLUE_VIOLET_GREEN = 130;
const GRADIENT_BLUE_VIOLET_BLUE = RGB_CHANNEL_MAX;
const GRADIENT_CYAN_RED = 60;
const GRADIENT_CYAN_GREEN = 200;
const GRADIENT_CYAN_BLUE = RGB_CHANNEL_MAX;
const GRADIENT_MINT_RED = 120;
const GRADIENT_MINT_GREEN = RGB_CHANNEL_MAX;
const GRADIENT_MINT_BLUE = 220;
const GRADIENT_RAMP_MAGENTA = 199;
const GRADIENT_RAMP_VIOLET = 171;
const GRADIENT_RAMP_BLUE_VIOLET = 135;
const GRADIENT_RAMP_BLUE = 99;
const GRADIENT_RAMP_CYAN = 75;
const GRADIENT_RAMP_TEAL = 51;
const GRADIENT_RAMP_LILAC = 87;
const GRADIENT_STOPS = [
  [GRADIENT_PINK_RED, GRADIENT_PINK_GREEN, GRADIENT_PINK_BLUE],
  [GRADIENT_PURPLE_RED, GRADIENT_PURPLE_GREEN, GRADIENT_PURPLE_BLUE],
  [
    GRADIENT_BLUE_VIOLET_RED,
    GRADIENT_BLUE_VIOLET_GREEN,
    GRADIENT_BLUE_VIOLET_BLUE,
  ],
  [GRADIENT_CYAN_RED, GRADIENT_CYAN_GREEN, GRADIENT_CYAN_BLUE],
  [GRADIENT_MINT_RED, GRADIENT_MINT_GREEN, GRADIENT_MINT_BLUE],
] as const;
const GRADIENT_RAMP_256 = [
  GRADIENT_RAMP_MAGENTA,
  GRADIENT_RAMP_VIOLET,
  GRADIENT_RAMP_BLUE_VIOLET,
  GRADIENT_RAMP_BLUE,
  GRADIENT_RAMP_CYAN,
  GRADIENT_RAMP_TEAL,
  GRADIENT_RAMP_LILAC,
];
const SHINE_HALF_WIDTH = 0.18;
const SHINE_REPLACEMENT_THRESHOLD = 0.5;
const GRADIENT_INDEX_ROUNDING_OFFSET = 0.5;
const INTRO_MS = 3000;
const INTRO_TICK_MS = 33;
const INTRO_EASING_EXPONENT = 3;
const INTRO_PHASE_CYCLE = 2.5;
const SHINE_PHASE_CYCLE = 3;
const SHINE_STRENGTH_EXPONENT = 1.5;

interface ShineConfig {
  strength: number;
  pos: number;
}

export type ColorMode = "truecolor" | "256color";

function wrappedUnit(value: number): number {
  return ((value % 1) + 1) % 1;
}

/**
 * Samples the five-stop RGB gradient or nearest entry of its 256-color ramp.
 * @param t Gradient position in [0, 1], not a terminal-cell coordinate.
 * @param colorMode Selects 0–255 RGB channels or an indexed ANSI palette color.
 * @param shine Optional position and strength in [0, 1]; brightens a narrow band.
 * @returns Foreground escape only; the caller owns the eventual color reset.
 * @example gradientEscape(0, "truecolor"); // "\x1b[38;2;255;92;200m"
 */
function gradientEscape(
  t: number,
  colorMode: ColorMode,
  shine?: ShineConfig,
): string {
  const shineStrength = shine && shine.strength > 0 ? shine.strength : 0;
  const shinePosition = shine?.pos ?? 0;
  if (colorMode === "truecolor") {
    const segment = t * (GRADIENT_STOPS.length - 1);
    const index = Math.min(GRADIENT_STOPS.length - 2, Math.floor(segment));
    const fraction = segment - index;
    const start = GRADIENT_STOPS[index] ?? GRADIENT_STOPS[0];
    const end = GRADIENT_STOPS[index + 1] ?? start;
    let red = start[0] + (end[0] - start[0]) * fraction;
    let green = start[1] + (end[1] - start[1]) * fraction;
    let blue = start[2] + (end[2] - start[2]) * fraction;
    if (shineStrength > 0) {
      const intensity =
        Math.max(0, 1 - Math.abs(t - shinePosition) / SHINE_HALF_WIDTH) *
        shineStrength;
      red += (RGB_CHANNEL_MAX - red) * intensity;
      green += (RGB_CHANNEL_MAX - green) * intensity;
      blue += (RGB_CHANNEL_MAX - blue) * intensity;
    }
    return `\x1b[38;2;${Math.round(red)};${Math.round(green)};${Math.round(blue)}m`;
  }

  let index = Math.min(
    GRADIENT_RAMP_256.length - 1,
    Math.max(
      0,
      Math.floor(
        t * (GRADIENT_RAMP_256.length - 1) + GRADIENT_INDEX_ROUNDING_OFFSET,
      ),
    ),
  );
  if (shineStrength > 0) {
    const intensity =
      Math.max(0, 1 - Math.abs(t - shinePosition) / SHINE_HALF_WIDTH) *
      shineStrength;
    if (intensity > SHINE_REPLACEMENT_THRESHOLD) {
      index = GRADIENT_RAMP_256.length - 1;
    }
  }
  return `\x1b[38;5;${GRADIENT_RAMP_256[index]}m`;
}

function gradientLogo(
  lines: readonly string[],
  colorMode: ColorMode,
  phase = 0,
  shine?: ShineConfig,
): string[] {
  const rowCount = lines.length;
  const columnCount = Math.max(...lines.map((line) => line.length));
  const span = Math.max(1, columnCount + rowCount - 1);
  return lines.map((line, y) => {
    let rendered = "";
    for (let x = 0; x < line.length; x++) {
      const character = line[x] ?? "";
      if (character === " ") {
        rendered += character;
        continue;
      }
      const base = (x + (rowCount - 1 - y)) / span;
      rendered += `${gradientEscape(wrappedUnit(base + phase), colorMode, shine)}${character}\x1b[0m`;
    }
    return rendered;
  });
}
export const RESTING_FRAMES: Readonly<Record<ColorMode, readonly string[]>> = {
  truecolor: gradientLogo(PI_LOGO, "truecolor"),
  "256color": gradientLogo(PI_LOGO, "256color"),
};

/**
 * Builds a fresh logo frame from normalized intro progress without reading a clock.
 * @param progress Elapsed fraction, normally [0, 1]; easing clamps at both ends.
 * @param colorMode Foreground encoding supported by the caller's terminal.
 * @returns ANSI-colored rows with resets; the caller owns timing and scheduling.
 * @example introFrame(1, "truecolor"); // Same row contents as RESTING_FRAMES.truecolor.
 */
export function introFrame(progress: number, colorMode: ColorMode): string[] {
  const eased =
    1 - (1 - Math.min(1, Math.max(0, progress))) ** INTRO_EASING_EXPONENT;
  const phase = wrappedUnit((1 - eased) * INTRO_PHASE_CYCLE);
  const shine = {
    pos: wrappedUnit(progress * SHINE_PHASE_CYCLE),
    strength: (1 - eased) ** SHINE_STRENGTH_EXPONENT,
  };
  return gradientLogo(PI_LOGO, colorMode, phase, shine);
}

type IntroTimerHandle = NodeJS.Timeout;

interface IntroTimer {
  now: () => number;
  setInterval: (handler: () => void, milliseconds: number) => IntroTimerHandle;
  clearInterval: (timer: IntroTimerHandle) => void;
}

const systemTimer: IntroTimer = {
  now: () => performance.now(),
  setInterval: (handler, milliseconds) => setInterval(handler, milliseconds),
  clearInterval: (timer) => clearInterval(timer),
};

/** One-shot ~30 FPS intro controller. Dispose is idempotent and releases its timer. */
export class IntroAnimation {
  private startedAt: number | undefined;
  private timer: IntroTimerHandle | undefined;
  private readonly requestRender: () => void;
  private readonly clock: IntroTimer;

  constructor(requestRender: () => void, clock: IntroTimer = systemTimer) {
    this.requestRender = requestRender;
    this.clock = clock;
  }

  /**
   * Restarts the intro, requesting an immediate frame and owning one timer.
   * Completion disposes the timer before requesting the resting frame.
   * @throws If a clock operation or the render callback throws.
   * @example With a clock starting at 0, start() requests a frame immediately;
   * a tick at 3000 ms clears the timer before requesting the resting frame.
   */
  start(): void {
    this.dispose();
    this.startedAt = this.clock.now();
    this.requestRender();
    this.timer = this.clock.setInterval(() => {
      const progress = this.progress();
      if (progress !== undefined && progress >= 1) {
        this.dispose();
      }
      this.requestRender();
    }, INTRO_TICK_MS);
  }

  progress(): number | undefined {
    if (this.startedAt === undefined) {
      return undefined;
    }
    return Math.min(
      1,
      Math.max(0, (this.clock.now() - this.startedAt) / INTRO_MS),
    );
  }

  isActive(): boolean {
    return this.startedAt !== undefined;
  }

  dispose(): void {
    if (this.timer !== undefined) {
      this.clock.clearInterval(this.timer);
      this.timer = undefined;
    }
    this.startedAt = undefined;
  }
}
