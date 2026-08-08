/**
 * Hand-rolled ANSI helpers. Zero runtime dependencies — no chalk, no
 * picocolors. Every escape sequence closes with `reset` so segments never
 * bleed into whatever follows.
 */
export const ESC = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
} as const;

/** Wrap `s` in `code`, or return it unchanged when color is disabled. */
export function paint(code: string, s: string, enabled: boolean): string {
  return enabled ? `${code}${s}${ESC.reset}` : s;
}

/**
 * TTY + env → on/off, per https://no-color.org and the de facto FORCE_COLOR
 * convention. NO_COLOR (any value, even "") always wins — an explicit opt out
 * beats everything else. FORCE_COLOR then forces on, overriding even a dumb
 * terminal. Otherwise TERM=dumb forces off. Absent all three, follow the TTY.
 */
export function shouldColor(env: Record<string, string | undefined>, isTTY: boolean): boolean {
  if (env.NO_COLOR !== undefined) return false;
  if (env.FORCE_COLOR !== undefined) return true;
  if (env.TERM === "dumb") return false;
  return isTTY;
}
