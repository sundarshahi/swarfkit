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
 * Note: Uses manual Promise wrapping instead of util.promisify(execFile) because
 * Bun v1.0.29's runtime lacks the custom promisify handler that Node.js v22+ has.
 * Node.js's promisify.custom handler correctly returns {stdout, stderr} on success;
 * Bun's returns stdout only. This manual wrapper ensures compatibility with both.
 */
export async function git(
  cwd: string,
  args: string[],
  env?: Record<string, string>,
): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    // Handles a spawn failure delivered either way execFile can deliver one:
    // via the callback's `error` (Node's documented behaviour), or as a
    // synchronous throw out of execFile() itself (Bun 1.0.29 does this for
    // both a missing cwd and a missing executable — see the try/catch below).
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
      // Bun 1.0.29 resolves the executable itself before spawning and throws
      // this synchronously (instead of Node's async ENOENT) when it isn't on
      // PATH. Treat it the same as a missing binary.
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
