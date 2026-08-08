import { readdir, lstat } from "node:fs/promises";
import { join } from "node:path";
import type { ArtifactDir, Sizes } from "./types";

/** Fixed in v1. Widening this is a v2 decision, not a config option. */
export const ARTIFACT_DIRS = [
  "node_modules",
  ".next",
  "dist",
  "build",
  ".turbo",
] as const;

const ARTIFACT_SET = new Set<string>(ARTIFACT_DIRS);

/**
 * Sum apparent file sizes under `dir`, staying on `device` and never
 * following symlinks. Unreadable subtrees contribute 0 rather than aborting
 * the walk — a partial number beats no report.
 */
async function walkSize(dir: string, device: number): Promise<number> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }

  let total = 0;
  for (const entry of entries) {
    const full = join(dir, entry.name);
    let st;
    try {
      st = await lstat(full); // lstat: a symlink is counted as itself, never followed
    } catch {
      continue;
    }
    if (st.dev !== device) continue; // never cross a filesystem boundary
    if (st.isSymbolicLink()) { total += st.size; continue; }
    if (st.isDirectory()) { total += await walkSize(full, device); continue; }
    total += st.size;
  }
  return total;
}

/**
 * Measure a worktree: its total apparent size, plus each top-level artifact
 * directory found inside it.
 */
export async function measure(worktreePath: string): Promise<Sizes> {
  let root;
  try {
    root = await lstat(worktreePath);
  } catch {
    return { total: -1, artifacts: [] };
  }

  const device = root.dev;
  const artifacts: ArtifactDir[] = [];

  let entries;
  try {
    entries = await readdir(worktreePath, { withFileTypes: true });
  } catch {
    return { total: -1, artifacts: [] };
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!ARTIFACT_SET.has(entry.name)) continue;
    const full = join(worktreePath, entry.name);
    artifacts.push({ path: full, bytes: await walkSize(full, device) });
  }

  const total = await walkSize(worktreePath, device);
  return { total, artifacts };
}
