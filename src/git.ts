import { execFile } from "node:child_process";

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
export async function git(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile("git", args, {
      cwd,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error) {
        if (error.code === "ENOENT") {
          reject(new GitMissingError());
        } else {
          resolve({
            stdout: stdout || "",
            stderr: stderr || "",
            code: typeof error.code === "number" ? error.code : 1,
          });
        }
      } else {
        resolve({ stdout, stderr, code: 0 });
      }
    });
  });
}

/** Convenience: trimmed stdout, or null when the command failed. */
export async function gitOut(cwd: string, args: string[]): Promise<string | null> {
  const res = await git(cwd, args);
  return res.code === 0 ? res.stdout.trim() : null;
}
