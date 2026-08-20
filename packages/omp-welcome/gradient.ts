export const PI_LOGO = ["▀██████████▀", " ╘██    ██  ", "  ██    ██  ", "  ██    ██  ", " ▄██▄  ▄██▄ "] as const;

const GRADIENT_STOPS: ReadonlyArray<readonly [number, number, number]> = [
  [255, 92, 200],
  [200, 110, 255],
  [120, 130, 255],
  [60, 200, 255],
  [120, 255, 220],
];
const GRADIENT_RAMP_256 = [199, 171, 135, 99, 75, 51, 87];
const SHINE_HALF_WIDTH = 0.18;
export const INTRO_MS = 3_000;
export const INTRO_TICK_MS = 33;

export interface ShineConfig {
  strength: number;
  pos: number;
}

export type ColorMode = "truecolor" | "256color";

function wrappedUnit(value: number): number {
  return ((value % 1) + 1) % 1;
}

/** Exact OMP five-stop logo gradient with Pi's 256-color fallback ramp. */
export function gradientEscape(t: number, colorMode: ColorMode, shine?: ShineConfig): string {
  const shineStrength = shine && shine.strength > 0 ? shine.strength : 0;
  const shinePosition = shine?.pos ?? 0;
  if (colorMode === "truecolor") {
    const segment = t * (GRADIENT_STOPS.length - 1);
    const index = Math.min(GRADIENT_STOPS.length - 2, Math.floor(segment));
    const fraction = segment - index;
    const start = GRADIENT_STOPS[index] ?? GRADIENT_STOPS[0]!;
    const end = GRADIENT_STOPS[index + 1] ?? start;
    let red = start[0] + (end[0] - start[0]) * fraction;
    let green = start[1] + (end[1] - start[1]) * fraction;
    let blue = start[2] + (end[2] - start[2]) * fraction;
    if (shineStrength > 0) {
      const intensity = Math.max(0, 1 - Math.abs(t - shinePosition) / SHINE_HALF_WIDTH) * shineStrength;
      red += (255 - red) * intensity;
      green += (255 - green) * intensity;
      blue += (255 - blue) * intensity;
    }
    return `\x1b[38;2;${Math.round(red)};${Math.round(green)};${Math.round(blue)}m`;
  }

  let index = Math.min(GRADIENT_RAMP_256.length - 1, Math.max(0, Math.floor(t * (GRADIENT_RAMP_256.length - 1) + 0.5)));
  if (shineStrength > 0) {
    const intensity = Math.max(0, 1 - Math.abs(t - shinePosition) / SHINE_HALF_WIDTH) * shineStrength;
    if (intensity > 0.5) index = GRADIENT_RAMP_256.length - 1;
  }
  return `\x1b[38;5;${GRADIENT_RAMP_256[index]}m`;
}

export function gradientLogo(lines: readonly string[], colorMode: ColorMode, phase = 0, shine?: ShineConfig): string[] {
  const rowCount = lines.length;
  const columnCount = Math.max(...lines.map(line => line.length));
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


export function introFrame(progress: number, colorMode: ColorMode): string[] {
  const eased = 1 - (1 - Math.min(1, Math.max(0, progress))) ** 3;
  const phase = wrappedUnit((1 - eased) * 2.5);
  const shine = {
    pos: wrappedUnit(progress * 3),
    strength: (1 - eased) ** 1.5,
  };
  return gradientLogo(PI_LOGO, colorMode, phase, shine);
}

export type IntroTimerHandle = NodeJS.Timeout;

export interface IntroTimer {
  now(): number;
  setInterval(handler: () => void, milliseconds: number): IntroTimerHandle;
  clearInterval(timer: IntroTimerHandle): void;
}

const systemTimer: IntroTimer = {
  now: () => performance.now(),
  setInterval: (handler, milliseconds) => setInterval(handler, milliseconds),
  clearInterval: timer => clearInterval(timer),
};

/** One-shot ~30 FPS intro controller. Dispose is idempotent and releases its timer. */
export class IntroAnimation {
  private startedAt: number | undefined;
  private timer: IntroTimerHandle | undefined;

  constructor(private readonly requestRender: () => void, private readonly clock: IntroTimer = systemTimer) {}

  start(): void {
    this.dispose();
    this.startedAt = this.clock.now();
    this.requestRender();
    this.timer = this.clock.setInterval(() => this.tick(), INTRO_TICK_MS);
  }

  progress(): number | undefined {
    if (this.startedAt === undefined) return undefined;
    return Math.min(1, Math.max(0, (this.clock.now() - this.startedAt) / INTRO_MS));
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

  private tick(): void {
    const progress = this.progress();
    if (progress !== undefined && progress >= 1) this.dispose();
    this.requestRender();
  }
}
