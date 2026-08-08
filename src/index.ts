#!/usr/bin/env bun
import { createInterface } from "node:readline/promises";
import { run } from "./cli";

const code = await run(process.argv.slice(2), {
  cwd: process.cwd(),
  out: (s) => process.stdout.write(s + "\n"),
  err: (s) => process.stderr.write(s + "\n"),
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
