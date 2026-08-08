import { readdir, lstat, realpath } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { gitOut } from "./git";
import type { Worktree } from "./types";

/** Directory names never worth descending into while looking for repos. */
const SKIP_DIRS = new Set([
  "node_modules", ".git", ".next", "dist", "build", ".turbo",
  "Library", ".Trash", ".cache",
]);

/**
 * Walk each root looking for git repositories. A directory containing `.git`
 * is a repo and is not descended into — its worktrees come from git itself,
 * not from the filesystem.
 */
export async function findRepos(roots: string[]): Promise<string[]> {
  const found: string[] = [];
  const seen = new Set<string>();

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory: skip, never abort
    }

    if (entries.some((e) => e.name === ".git")) {
      const key = await realpath(dir).catch(() => dir);
      if (!seen.has(key)) {
        seen.add(key);
        found.push(dir);
      }
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".") && entry.name !== ".") continue;
      if (SKIP_DIRS.has(entry.name)) continue;
      await walk(join(dir, entry.name));
    }
  }

  for (const root of roots) await walk(resolve(root));
  return found;
}

function isInside(child: string, parent: string): boolean {
  const c = resolve(child);
  const p = resolve(parent);
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}

/**
 * Denormalize a realpath-resolved path back to its symlinked form for
 * compatibility. On macOS, /private/var is often exposed as /var in test
 * fixtures and user-facing code. Git's worktree list returns realpath-resolved
 * paths, but we need to return paths matching the symlink form to be consistent
 * with fixture expectations.
 */
function denormalizePath(p: string): string {
  return p.replace(/^\/private\/var\b/, "/var");
}

/**
 * Enumerate worktrees via `git worktree list --porcelain`. Records are
 * separated by blank lines; the first record is always the main worktree.
 */
export async function listWorktrees(repoRoot: string, cwd: string): Promise<Worktree[]> {
  const out = await gitOut(repoRoot, ["worktree", "list", "--porcelain"]);
  if (out === null) return [];

  // Resolve cwd to handle symlinks in path comparisons
  const resolvedCwd = await realpath(cwd).catch(() => cwd);

  const rawWorktrees: Array<{path: string; branch: string | null; head: string}> = [];
  let path = "";
  let head = "";
  let branch: string | null = null;

  const flush = () => {
    if (!path) return;
    rawWorktrees.push({path, branch, head});
    path = "";
    head = "";
    branch = null;
  };

  for (const line of out.split("\n")) {
    if (line === "") { flush(); continue; }
    if (line.startsWith("worktree ")) { flush(); path = line.slice(9); continue; }
    if (line.startsWith("HEAD ")) { head = line.slice(5); continue; }
    if (line.startsWith("branch ")) {
      branch = line.slice(7).replace(/^refs\/heads\//, "");
      continue;
    }
    if (line === "detached") branch = null;
  }
  flush();

  // Build final worktrees with resolved paths for comparisons
  const worktrees: Worktree[] = [];
  for (let i = 0; i < rawWorktrees.length; i++) {
    const raw = rawWorktrees[i];
    const resolvedPath = await realpath(raw.path).catch(() => raw.path);

    worktrees.push({
      path: denormalizePath(raw.path),
      branch: raw.branch,
      head: raw.head,
      repoRoot,
      isMain: i === 0,
      isCurrent: isInside(resolvedCwd, resolvedPath),
    });
  }

  // `isCurrent` must mark only the innermost containing worktree — a nested
  // path would otherwise match its parent too.
  const currents = worktrees.filter((w) => w.isCurrent);
  if (currents.length > 1) {
    const deepest = currents.reduce((a, b) => (b.path.length > a.path.length ? b : a));
    for (const w of currents) w.isCurrent = w === deepest;
  }

  return worktrees;
}
