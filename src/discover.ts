import { readdir, realpath } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { gitOut } from "./git";
import type { Worktree } from "./types";

/** Directory names never worth descending into while looking for repos. */
const SKIP_DIRS = new Set([
  "node_modules", ".git", ".next", "dist", "build", ".turbo",
  "Library", ".Trash", ".cache",
]);

/**
 * Resolve the path of a repository's main worktree via git itself, not via
 * whichever directory the filesystem walk happened to visit first. The main
 * worktree is always the first record of `git worktree list --porcelain`,
 * and it is the one worktree `pruneWorktrees` can never remove (guarded by
 * `isMain`), so — unlike a directory-walk-order pick — it can't vanish
 * mid-run out from under a later `assertStillARealRegisteredWorktree` check.
 *
 * Returns null (never throws) so callers can fall back gracefully, same as
 * every other git lookup in this module.
 */
async function resolveMainWorktreeRoot(dir: string): Promise<string | null> {
  const out = await gitOut(dir, ["worktree", "list", "--porcelain"]);
  if (out === null) return null;
  for (const line of out.split("\n")) {
    // Returned verbatim, as git reported it — production code never
    // resolves/un-resolves paths (see repoRoot doc comment); that's a test-only
    // concern (e.g. macOS /var vs /private/var).
    if (line.startsWith("worktree ")) return line.slice(9);
  }
  return null;
}

/**
 * Walk each root looking for git repositories. A directory containing `.git`
 * is a repo and is not descended into — its worktrees come from git itself,
 * not from the filesystem.
 *
 * Deduplicates by repository identity (git-common-dir), not filesystem path,
 * to handle linked worktrees: a linked worktree has a `.git` FILE, and if both
 * the main repo and its linked siblings are under the same scanned root, they
 * would otherwise be discovered multiple times.
 */
export async function findRepos(roots: string[]): Promise<string[]> {
  const found: string[] = [];
  const reposByCommonDir = new Map<string, string>();

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory: skip, never abort
    }

    if (entries.some((e) => e.name === ".git")) {
      // Found a `.git` (file or directory). Deduplicate by the actual repository.
      const commonDirOut = await gitOut(dir, ["rev-parse", "--git-common-dir"]);
      if (commonDirOut !== null) {
        const commonDir = await realpath(join(dir, commonDirOut)).catch(
          () => realpath(commonDirOut).catch(() => commonDirOut)
        );
        if (!reposByCommonDir.has(commonDir)) {
          // Canonical root is the MAIN worktree per git, never whichever
          // directory this walk happened to reach first — directory order is
          // filesystem-dependent (e.g. alphabetical on APFS) and has no
          // relationship to git's own notion of which worktree is main.
          const mainRoot = (await resolveMainWorktreeRoot(dir)) ?? dir;
          reposByCommonDir.set(commonDir, mainRoot);
          found.push(mainRoot);
        }
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
 * Enumerate worktrees via `git worktree list --porcelain`. Records are
 * separated by blank lines; the first record is always the main worktree.
 */
export async function listWorktrees(repoRoot: string, cwd: string): Promise<Worktree[]> {
  const out = await gitOut(repoRoot, ["worktree", "list", "--porcelain"]);
  if (out === null) return [];

  // Resolve cwd once to handle symlinks in path comparisons
  const resolvedCwd = await realpath(cwd).catch(() => cwd);

  const worktrees: Worktree[] = [];
  let path = "";
  let head = "";
  let branch: string | null = null;
  let locked = false;

  const flush = async () => {
    if (!path) return;
    // Resolve paths canonically for isCurrent comparisons only
    const resolvedPath = await realpath(path).catch(() => path);
    worktrees.push({
      path,
      branch,
      head,
      repoRoot,
      isMain: worktrees.length === 0,
      isCurrent: isInside(resolvedCwd, resolvedPath),
      locked,
    });
    path = "";
    head = "";
    branch = null;
    locked = false;
  };

  for (const line of out.split("\n")) {
    if (line === "") { await flush(); continue; }
    if (line.startsWith("worktree ")) { await flush(); path = line.slice(9); continue; }
    if (line.startsWith("HEAD ")) { head = line.slice(5); continue; }
    if (line.startsWith("branch ")) {
      branch = line.slice(7).replace(/^refs\/heads\//, "");
      continue;
    }
    if (line === "detached") { branch = null; continue; }
    // `locked` appears bare or as `locked <reason>`.
    if (line === "locked" || line.startsWith("locked ")) locked = true;
  }
  await flush();

  // `isCurrent` must mark only the innermost containing worktree — a nested
  // path would otherwise match its parent too.
  const currents = worktrees.filter((w) => w.isCurrent);
  if (currents.length > 1) {
    const deepest = currents.reduce((a, b) => (b.path.length > a.path.length ? b : a));
    for (const w of currents) w.isCurrent = w === deepest;
  }

  return worktrees;
}
