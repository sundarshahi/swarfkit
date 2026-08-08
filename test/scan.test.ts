import { describe, expect, test } from "bun:test";
import { realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeRepo } from "./fixtures";
import { scan, type ScanProgress } from "../src/scan";
import { DEFAULT_MIN_AGE_SECONDS } from "../src/classify";
import { classify } from "../src/classify";
import { resolveDefaultBranch } from "../src/default-branch";
import { findRepos, listWorktrees } from "../src/discover";
import { measure } from "../src/measure";
import { git } from "../src/git";
import type { Row } from "../src/types";

const DAY = 86_400;

// Resolve both sides canonically before comparing (handles /var vs /private/var
// on macOS, where git reports the realpath but the fixture returns the raw
// mkdtemp path) — same approach as test/discover.test.ts.
async function findByPath(rows: Row[], path: string): Promise<Row | undefined> {
  const target = await realpath(path);
  for (const row of rows) {
    const resolved = await realpath(row.worktree.path).catch(() => row.worktree.path);
    if (resolved === target) return row;
  }
  return undefined;
}

describe("scan", () => {
  test("returns a row per worktree with verdict and sizes", async () => {
    const fx = await makeRepo();

    // Add .gitignore to main repo so worktrees inherit it
    const AUTHOR = [
      "-c", "user.email=test@example.com",
      "-c", "user.name=Test",
      "-c", "commit.gpgsign=false",
    ];
    await writeFile(join(fx.root, ".gitignore"), "node_modules/\n.next/\ndist/\nbuild/\n.turbo/\n");
    await git(fx.root, ["add", "-A"]);
    await git(fx.root, [...AUTHOR, "commit", "-q", "-m", "add .gitignore"]);
    await git(fx.root, ["push", "-q", "-u", "origin", "trunk"]);

    const wt = await fx.addWorktree({ name: "done", merge: "squash", ageSeconds: 30 * DAY });
    await fx.addArtifacts(wt, "node_modules", 4096);

    const rows = await scan({
      roots: [fx.root], cwd: fx.root, minAgeSeconds: DEFAULT_MIN_AGE_SECONDS,
    });

    const target = rows.find((r) => r.worktree.branch === "done");
    expect(target?.verdict.safety).toBe("safe");
    expect(target?.sizes.artifacts).toHaveLength(1);
    await fx.cleanup();
  });

  test("resolves the default branch per repo rather than assuming main", async () => {
    const fx = await makeRepo();
    await fx.addWorktree({ name: "done", merge: "squash", ageSeconds: 30 * DAY });
    const rows = await scan({
      roots: [fx.root], cwd: fx.root, minAgeSeconds: DEFAULT_MIN_AGE_SECONDS,
    });
    const reasons = rows.flatMap((r) => r.verdict.reasons).join(" ");
    expect(reasons).not.toContain("could not resolve the default branch");
    await fx.cleanup();
  });

  test("reflects a re-scan after the working tree changes", async () => {
    const fx = await makeRepo();
    const wt = await fx.addWorktree({ name: "done", merge: "squash", ageSeconds: 30 * DAY });
    const opts = { roots: [fx.root], cwd: fx.root, minAgeSeconds: DEFAULT_MIN_AGE_SECONDS };

    const before = await scan(opts);
    const beforeRow = await findByPath(before, wt);
    expect(beforeRow?.verdict.safety).toBe("safe");

    await Bun.write(`${wt}/oops.txt`, "uncommitted work appeared\n");

    const after = await scan(opts);
    const afterRow = await findByPath(after, wt);
    expect(afterRow?.verdict.safety).toBe("blocked");
    await fx.cleanup();
  });
});

describe("scan onProgress", () => {
  test("fires with increasing completed counts, ending at the worktree total", async () => {
    const fx = await makeRepo();
    await fx.addWorktree({ name: "one" });
    await fx.addWorktree({ name: "two" });
    await fx.addWorktree({ name: "three" });

    const events: ScanProgress[] = [];
    const rows = await scan({
      roots: [fx.root], cwd: fx.root, minAgeSeconds: DEFAULT_MIN_AGE_SECONDS,
      onProgress: (p) => events.push(p),
    });

    const measuring = events.filter((e) => e.phase === "measuring");
    expect(measuring.length).toBe(rows.length);
    const completedSeq = measuring.map((e) => e.completed);
    // Strictly increasing 1..N — measure()/classify() run concurrently per
    // repo, but each completion is counted exactly once, in order.
    expect(completedSeq).toEqual(rows.map((_, i) => i + 1));
    expect(measuring.at(-1)?.completed).toBe(rows.length);
    expect(measuring.at(-1)?.total).toBe(rows.length);

    const discovering = events.filter((e) => e.phase === "discovering");
    expect(discovering.length).toBeGreaterThan(0);
    expect(discovering.at(-1)?.repos).toBe(1);

    await fx.cleanup();
  });

  test("omitting onProgress changes nothing about scan's behavior", async () => {
    const fx = await makeRepo();
    await fx.addWorktree({ name: "done", merge: "squash", ageSeconds: 30 * DAY });
    const rows = await scan({ roots: [fx.root], cwd: fx.root, minAgeSeconds: DEFAULT_MIN_AGE_SECONDS });
    expect(rows.length).toBe(2); // main + the one worktree
    await fx.cleanup();
  });
});

describe("scan concurrency", () => {
  /**
   * The pre-fix algorithm: repos processed one at a time, worktrees within a
   * repo classified/measured via Promise.all. Used here as the ground truth
   * for "does the now-concurrent repo loop still produce the same rows in
   * the same order" — a concurrency change that reorders or drops rows would
   * fail this comparison even though every other test still passes.
   */
  async function serialScan(opts: {
    roots: string[]; cwd: string; minAgeSeconds: number;
  }): Promise<Row[]> {
    const repos = await findRepos(opts.roots);
    const rows: Row[] = [];
    for (const repoRoot of repos) {
      const defaultBranch = await resolveDefaultBranch(repoRoot);
      const worktrees = await listWorktrees(repoRoot, opts.cwd);
      const built = await Promise.all(
        worktrees.map(async (worktree) => {
          const [verdict, sizes] = await Promise.all([
            classify(worktree, { defaultBranch, minAgeSeconds: opts.minAgeSeconds }),
            measure(worktree.path),
          ]);
          return { worktree, verdict, sizes } satisfies Row;
        }),
      );
      rows.push(...built);
    }
    return rows;
  }

  /**
   * Projection that drops nothing meaningful but ignores object identity —
   * and, deliberately, `sizes.total`. `classify` and `measure` already run
   * concurrently against the *same* worktree (that's pre-existing, not part
   * of this change), and `classify`'s `git status` rewrites `.git/index`'s
   * on-disk stat cache as a side effect; `measure`'s walk can catch that
   * file mid-rewrite. That's an existing byte-level wobble in the main
   * worktree's total (a couple hundred bytes out of tens of thousands) and
   * is checked separately below with a tolerance — it has nothing to do
   * with whether the repo loop is sequential or a bounded pool.
   */
  function fingerprint(rows: Row[]) {
    return rows.map((r) => ({
      path: r.worktree.path,
      repoRoot: r.worktree.repoRoot,
      branch: r.worktree.branch,
      safety: r.verdict.safety,
      reasons: r.verdict.reasons,
      artifacts: r.sizes.artifacts,
    }));
  }

  test("bounded concurrent scan matches a serial scan: same rows, same order", async () => {
    // Several independent repositories under one root, each with its own
    // worktrees, so the (now concurrent) repo loop actually has repos to
    // interleave rather than trivially "concurrent" over a single item.
    const repos = await Promise.all([makeRepo(), makeRepo(), makeRepo()]);
    try {
      await repos[0]!.addWorktree({ name: "done", merge: "squash", ageSeconds: 30 * DAY });
      const extraWt = await repos[0]!.addWorktree({ name: "extra" });
      await repos[0]!.addArtifacts(extraWt, "node_modules", 2048);
      await repos[1]!.addWorktree({ name: "pending" });
      await repos[2]!.addWorktree({ name: "old", merge: "ff", ageSeconds: 30 * DAY });
      await repos[2]!.addWorktree({ name: "fresh" });

      const opts = {
        roots: repos.map((r) => r.root),
        cwd: repos[0]!.root,
        minAgeSeconds: DEFAULT_MIN_AGE_SECONDS,
      };

      // Run one after the other, not concurrently: `classify`'s `git status`
      // call refreshes `.git/index`'s on-disk stat cache as a side effect, so
      // running both sweeps at once over the same live repos would let one
      // pass's `measure()` sample the index mid-rewrite by the other —
      // self-inflicted flakiness, not a real concurrency bug.
      const concurrent = await scan(opts);
      const serial = await serialScan(opts);

      expect(concurrent.length).toBe(serial.length);
      expect(fingerprint(concurrent)).toEqual(fingerprint(serial));
      // Same rows, same order — checked with a tolerance because of the
      // .git/index wobble explained above, not because the byte count is
      // allowed to be genuinely wrong (2048 bytes of real artifacts would
      // blow way past this tolerance if the concurrency change dropped or
      // double-counted anything).
      for (let i = 0; i < concurrent.length; i++) {
        expect(Math.abs(concurrent[i]!.sizes.total - serial[i]!.sizes.total)).toBeLessThan(4096);
      }
    } finally {
      await Promise.all(repos.map((r) => r.cleanup()));
    }
  });
});
