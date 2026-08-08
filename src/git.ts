import { execFile } from "node:child_process";
import { existsSync } from "node:fs";

export class GitMissingError extends Error {
  constructor() {
    super("git not found on PATH");
    this.name = "GitMissingError";
  }
}

export type GitResult = { stdout: string; stderr: string; code: number };

/**
 * Run git in `cwd`. A non-zero exit is returned as data, not thrown — git uses
 * exit status to answer questions (no upstream, not a repo) and those answers
 * are verdict inputs. Only a missing binary throws.
 *
 * Note: Uses manual Promise wrapping instead of util.promisify(execFile). This
 * was necessary on Bun v1.0.29, whose promisify.custom handler returned stdout
 * only instead of Node's {stdout, stderr}. Fixed in later Bun releases
 * (verified on 1.3.14, which matches Node). The manual wrapper is retained so
 * this still works for anyone running an older Bun.
 */
export async function git(
  cwd: string,
  args: string[],
  env?: Record<string, string>,
): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    // Handles a spawn failure delivered either way execFile can deliver one:
    // via the callback's `error` (Node's documented behaviour), or as a
    // synchronous throw out of execFile() itself. Bun v1.0.29 threw
    // synchronously for both a missing cwd and a missing executable; fixed in
    // later Bun releases (verified on 1.3.14: both now deliver via the
    // callback, like Node). The try/catch below is retained for anyone
    // running an older Bun.
    const handleSpawnError = (
      error: { code?: string | number; message?: string },
      stdout: string,
      stderr: string,
    ) => {
      if (error.code === "ENOENT") {
        // execFile reports the identical ENOENT whether the git binary is
        // missing or cwd doesn't exist. Only the former is fatal; the latter
        // is a normal failed invocation like any other non-zero exit.
        if (!existsSync(cwd)) {
          resolve({ stdout: stdout || "", stderr: stderr || "", code: 1 });
          return;
        }
        reject(new GitMissingError());
        return;
      }
      // Bun v1.0.29 resolved the executable itself before spawning and threw
      // this synchronously (instead of Node's async ENOENT) when it wasn't on
      // PATH. No longer reproduces on later Bun (verified on 1.3.14). Treat
      // it the same as a missing binary in case an older Bun hits this path.
      if (error.code === "ERR_INVALID_ARG_TYPE") {
        reject(new GitMissingError());
        return;
      }
      resolve({
        stdout: stdout || "",
        stderr: stderr || "",
        code: typeof error.code === "number" ? error.code : 1,
      });
    };

    try {
      execFile("git", args, {
        cwd,
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
        env: env ? { ...process.env, ...env } : process.env,
      }, (error, stdout, stderr) => {
        if (error) {
          handleSpawnError(error, stdout, stderr);
        } else {
          resolve({ stdout, stderr, code: 0 });
        }
      });
    } catch (error) {
      handleSpawnError(error as { code?: string | number; message?: string }, "", "");
    }
  });
}

/** Convenience: trimmed stdout, or null when the command failed. */
export async function gitOut(cwd: string, args: string[]): Promise<string | null> {
  const res = await git(cwd, args);
  return res.code === 0 ? res.stdout.trim() : null;
}
