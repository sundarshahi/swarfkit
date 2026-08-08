import { rm, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { git } from "./git";
import type { Row, Worktree } from "./types";

export class PathInvariantError extends Error {
  constructor(target: string) {
    super(
      `refusing to delete ${target}: it does not resolve inside any discovered worktree`,
    );
    this.name = "PathInvariantError";
  }
}

export type ReclaimResult = {
  deleted: string[];
  failed: { path: string; error: string }[];
  bytes: number;
};

function contains(parent: string, child: string): boolean {
  const p = resolve(parent);
  const c = resolve(child);
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}

/**
 * The hard invariant. Resolves symlinks on both sides and confirms the target
 * really lives inside a discovered worktree. Called immediately before every
 * delete — never at plan time, because a symlink can appear in between.
 *
 * Not redundant with `rm`'s own symlink handling: `rm` never follows a
 * symlink it's given directly, and `measure()` never lists a symlinked
 * `node_modules` as an artifact (`Dirent.isDirectory()` is false for
 * symlinks) — so a bogus symlinked artifact mostly can't reach `cleanArtifacts`
 * at all. `pruneWorktrees` has no such luck: `row.worktree.path` is a real
 * directory and `git worktree remove` deletes the whole tree beneath it, so
 * this check is the only thing standing between a corrupted worktree record
 * and a wrong deletion.
 */
export async function assertInsideWorktree(
  target: string,
  worktrees: Worktree[],
): Promise<string> {
  let real: string;
  try {
    real = await realpath(target);
  } catch {
    throw new PathInvariantError(target);
  }

  for (const wt of worktrees) {
    const wtReal = await realpath(wt.path).catch(() => null);
    if (wtReal && contains(wtReal, real)) return target;
  }
  throw new PathInvariantError(target);
}

/** Tier 1 — build artifacts. Always permitted; regenerable by definition. */
export async function cleanArtifacts(rows: Row[]): Promise<ReclaimResult> {
  const worktrees = rows.map((r) => r.worktree);
  const result: ReclaimResult = { deleted: [], failed: [], bytes: 0 };

  for (const row of rows) {
    for (const artifact of row.sizes.artifacts) {
      try {
        await assertInsideWorktree(artifact.path, worktrees);
        await rm(artifact.path, { recursive: true, force: true });
        result.deleted.push(artifact.path);
        result.bytes += Math.max(0, artifact.bytes);
      } catch (err) {
        result.failed.push({
          path: artifact.path,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  return result;
}

/** Tier 2 — whole worktrees. Only rows already classified `safe`. */
export async function pruneWorktrees(rows: Row[]): Promise<ReclaimResult> {
  const worktrees = rows.map((r) => r.worktree);
  const result: ReclaimResult = { deleted: [], failed: [], bytes: 0 };

  for (const row of rows) {
    if (row.verdict.safety !== "safe") continue;
    if (row.worktree.isMain || row.worktree.isCurrent) continue;

    try {
      await assertInsideWorktree(row.worktree.path, worktrees);
      // `git worktree remove` deregisters and deletes in one step, keeping
      // git's metadata consistent. A plain rm would leave a stale registration.
      const res = await git(row.worktree.repoRoot, [
        "worktree", "remove", row.worktree.path,
      ]);
      if (res.code !== 0) throw new Error(res.stderr.trim() || "git worktree remove failed");
      result.deleted.push(row.worktree.path);
      result.bytes += Math.max(0, row.sizes.total);
    } catch (err) {
      result.failed.push({
        path: row.worktree.path,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return result;
}
