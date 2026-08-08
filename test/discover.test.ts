import { describe, expect, test } from "bun:test";
import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { makeRepo } from "./fixtures";
import { findRepos, listWorktrees } from "../src/discover";

const DAY = 86_400;

describe("listWorktrees", () => {
  test("returns the main worktree plus each added worktree", async () => {
    const fx = await makeRepo();
    const a = await fx.addWorktree({ name: "alpha" });
    const wts = await listWorktrees(fx.root, fx.root);

    expect(wts.length).toBe(2);
    const main = wts.find((w) => w.isMain);
    expect(main?.branch).toBe("trunk");
    const alpha = wts.find((w) => w.branch === "alpha");
    // Resolve both paths canonically for comparison (handles /var vs /private/var)
    const expectedPath = await realpath(a);
    const actualPath = alpha?.path ? await realpath(alpha.path) : undefined;
    expect(actualPath).toBe(expectedPath);
    expect(alpha?.isMain).toBe(false);
    await fx.cleanup();
  });

  test("marks the worktree containing cwd as current", async () => {
    const fx = await makeRepo();
    const a = await fx.addWorktree({ name: "alpha" });
    const wts = await listWorktrees(fx.root, a);
    expect(wts.find((w) => w.isCurrent)?.branch).toBe("alpha");
    await fx.cleanup();
  });

  test("reports branch null for a detached worktree", async () => {
    const fx = await makeRepo();
    const a = await fx.addWorktree({ name: "alpha" });
    const { git } = await import("../src/git");
    await git(a, ["checkout", "-q", "--detach"]);
    const wts = await listWorktrees(fx.root, fx.root);
    // Resolve both paths canonically for comparison (handles /var vs /private/var)
    const expectedPath = await realpath(a);
    const resolvedWts = await Promise.all(
      wts.map(async (w) => ({
        ...w,
        resolvedPath: await realpath(w.path).catch(() => w.path),
      }))
    );
    const detached = resolvedWts.find((w) => w.resolvedPath === expectedPath);
    expect(detached?.branch).toBeNull();
    await fx.cleanup();
  });
});

describe("findRepos", () => {
  test("finds a repo and does not descend into it", async () => {
    const fx = await makeRepo();
    await mkdir(join(fx.root, "packages", "inner"), { recursive: true });
    const repos = await findRepos([fx.root]);
    // repoRoot is now resolved via git (the main worktree per
    // `git worktree list --porcelain`), which reports its own canonical
    // form — canonicalize both sides here rather than in production code.
    const expectedPath = await realpath(fx.root);
    const canonicalRepos = await Promise.all(repos.map((r) => realpath(r).catch(() => r)));
    expect(canonicalRepos).toContain(expectedPath);
    expect(repos.filter((r) => r.startsWith(join(fx.root, "packages")))).toHaveLength(0);
    await fx.cleanup();
  });

  test("skips node_modules while searching", async () => {
    const fx = await makeRepo();
    const buried = join(fx.root, "node_modules", "pkg");
    await mkdir(join(buried, ".git"), { recursive: true });
    const repos = await findRepos([fx.root]);
    expect(repos).not.toContain(buried);
    await fx.cleanup();
  });

  test("deduplicates linked worktrees with the main repo when sibling under scanned root", async () => {
    const fx = await makeRepo();
    // Create a linked worktree as a sibling in the filesystem (standard ~/dev layout)
    const baseDir = join(fx.root, "..");
    const linkedWt = join(baseDir, `${Math.random().toString(36).slice(2)}-feature`);
    const { git } = await import("../src/git");
    await git(fx.root, ["worktree", "add", "-q", "-b", "feature", linkedWt, "trunk"]);

    // Scan the parent directory that contains both main repo and linked worktree
    const repos = await findRepos([baseDir]);

    // Should find exactly one repository, not two
    const repoRoots = repos.map((r) => realpath(r).catch(() => r));
    const canonicalRoots = await Promise.all(repoRoots);
    const uniqueRoots = [...new Set(canonicalRoots)];
    expect(uniqueRoots).toHaveLength(1);

    // Scan returns the main worktree as canonical root
    expect(repos.length).toBe(1);

    // Verify that scan() produces one row per worktree with no duplicates
    const { scan } = await import("../src/scan");
    const { DEFAULT_MIN_AGE_SECONDS } = await import("../src/classify");
    const rows = await scan({
      roots: [baseDir],
      cwd: fx.root,
      minAgeSeconds: DEFAULT_MIN_AGE_SECONDS,
    });

    // Should have exactly 2 rows: main worktree + one created above
    expect(rows).toHaveLength(2);

    // All row paths must be unique
    const rowPaths = rows.map((r) => r.worktree.path);
    const uniquePaths = new Set(rowPaths);
    expect(uniquePaths.size).toBe(rowPaths.length);

    await git(fx.root, ["worktree", "remove", linkedWt]);
    await fx.cleanup();
  });

  test("discovers repo when --root is pointed directly at a linked worktree", async () => {
    const fx = await makeRepo();
    const linkedWt = await fx.addWorktree({ name: "feature" });

    // Scan with the linked worktree as the root (not its parent)
    const repos = await findRepos([linkedWt]);

    // Should still discover the underlying repository
    expect(repos.length).toBe(1);

    // List worktrees from the discovered repo should work
    const repoRoot = repos[0]!;
    const wts = await listWorktrees(repoRoot, fx.root);
    expect(wts.length).toBeGreaterThan(0);
    // Should include the feature branch we pointed at
    expect(wts.some((w) => w.branch === "feature")).toBe(true);

    await fx.cleanup();
  });

  test("repoRoot is always the main worktree, regardless of scan entry point", async () => {
    const fx = await makeRepo();
    const wtA = await fx.addWorktree({ name: "alpha" });
    const mainPath = await realpath(fx.root);

    // --root pointed at the repo itself
    const reposAtRepo = await findRepos([fx.root]);
    expect(reposAtRepo.length).toBe(1);
    expect(await realpath(reposAtRepo[0]!)).toBe(mainPath);
    const wtsAtRepo = await listWorktrees(reposAtRepo[0]!, fx.root);
    expect(wtsAtRepo.length).toBeGreaterThan(0);
    for (const w of wtsAtRepo) {
      expect(await realpath(w.repoRoot)).toBe(mainPath);
    }

    // --root pointed directly at a linked worktree
    const reposAtLinked = await findRepos([wtA]);
    expect(reposAtLinked.length).toBe(1);
    expect(await realpath(reposAtLinked[0]!)).toBe(mainPath);
    const wtsAtLinked = await listWorktrees(reposAtLinked[0]!, fx.root);
    expect(wtsAtLinked.length).toBeGreaterThan(0);
    for (const w of wtsAtLinked) {
      expect(await realpath(w.repoRoot)).toBe(mainPath);
    }

    await fx.cleanup();
  });

  test("prunes every safe linked worktree even when the alphabetically-first one would have become the canonical repoRoot", async () => {
    const fx = await makeRepo();
    // Names chosen so "aaa-alpha" sorts before "bbb-beta" — the order the old
    // directory-walk-order logic would have picked as the (wrong) repoRoot.
    const wtA = await fx.addWorktree({ name: "aaa-alpha", merge: "squash", ageSeconds: 30 * DAY });
    const wtB = await fx.addWorktree({ name: "bbb-beta", merge: "squash", ageSeconds: 30 * DAY });

    const { scan } = await import("../src/scan");
    const { pruneWorktrees } = await import("../src/reclaim");
    const { DEFAULT_MIN_AGE_SECONDS } = await import("../src/classify");

    // Passing the two linked worktrees as separate roots, in this order, is
    // what makes the walk visit "aaa-alpha" before the main worktree ever
    // comes up — the exact condition that used to poison every row's
    // repoRoot with the alphabetically-first worktree's own path.
    const rows = await scan({
      roots: [wtA, wtB],
      cwd: fx.root,
      minAgeSeconds: DEFAULT_MIN_AGE_SECONDS,
    });

    const targetRows = rows.filter(
      (r) => r.worktree.branch === "aaa-alpha" || r.worktree.branch === "bbb-beta",
    );
    expect(targetRows).toHaveLength(2);
    expect(targetRows.every((r) => r.verdict.safety === "safe")).toBe(true);

    const result = await pruneWorktrees(rows);
    expect(result.failed).toEqual([]);
    expect(result.deleted).toHaveLength(2);

    await fx.cleanup();
  });
});
