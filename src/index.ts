#!/usr/bin/env bun
import { createInterface } from "node:readline/promises";
import { run } from "./cli";
import { shouldColor } from "./color";

// Piped or redirected stdout must stay plain — people grep this — so color
// is gated on stdout actually being a TTY, same as every other color-aware
// CLI, then overridden by NO_COLOR / FORCE_COLOR / TERM=dumb.
const color = shouldColor(process.env, process.stdout.isTTY === true);
const stderrIsTTY = process.stderr.isTTY === true;

const code = await run(process.argv.slice(2), {
  cwd: process.cwd(),
  out: (s) => process.stdout.write(s + "\n"),
  err: (s) => process.stderr.write(s + "\n"),
  color,
  // Omit entirely when stderr isn't a TTY, so a scan piped to a log file
  // never gets a progress line — `run()` treats an absent `progress` as
  // "print nothing", not "buffer it for later".
  ...(stderrIsTTY
    ? {
        progress: (s: string | null) => {
          // Clear the line, then draw the new label, if any: no spinner, no
          // animation dependency, just one line kept up to date in place.
          process.stderr.write(`\r\x1b[2K${s ?? ""}`);
        },
      }
    : {}),
  confirm: async (question) => {
    // No TTY (piped or CI): never assume yes.
    if (!process.stdin.isTTY) return false;
    // Prompt and readline's escape sequences go to stderr, not stdout, so
    // `--json` output on stdout stays pure JSON even when interactive.
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    const answer = await rl.question(question);
    rl.close();
    return /^y(es)?$/i.test(answer.trim());
  },
});

process.exit(code);
