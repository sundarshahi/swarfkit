import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { makeRepo } from "./fixtures";
import { listWorktrees } from "../src/discover";
import { measure } from "../src/measure";
import {
  assertInsideWorktree, cleanArtifacts, pruneWorktrees, PathInvariantError,
} from "../src/reclaim";
import type { Row } from "../src/types";

const DAY = 86_400;

async function rowsFor(fx: Awaited<ReturnType<typeof makeRepo>>, safety: Row["verdict"]["safety"]) {
  const wts = await listWorktrees(fx.root, fx.root);
  const out: Row[] = [];
  for (const wt of wts) {
    if (wt.isMain) continue;
    out.push({ worktree: wt, verdict: { safety, reasons: [] }, sizes: await measure(wt.path) });
  }
  return out;
}

describe("assertInsideWorktree", () => {
  test("accepts a path inside a worktree", async () => {
    const fx = await makeRepo();
    const wt = await fx.addWorktree({ name: "alpha" });
    const wts = await listWorktrees(fx.root, fx.root);
    const target = join(wt, "node_modules");
    await mkdir(target, { recursive: true });
    expect(await assertInsideWorktree(target, wts)).toBe(target);
    await fx.cleanup();
  });

  test("throws for a path outside every worktree", async () => {
    const fx = await makeRepo();
    await fx.addWorktree({ name: "alpha" });
    const wts = await listWorktrees(fx.root, fx.root);
    await expect(assertInsideWorktree("/tmp", wts)).rejects.toThrow(PathInvariantError);
    await fx.cleanup();
  });

  test("throws when a symlink inside a worktree escapes it", async () => {
    const fx = await makeRepo();
    const wt = await fx.addWorktree({ name: "alpha" });
    // fx.root (base/repo) is itself the main worktree, so nesting "outside"
    // inside it wouldn't actually escape any discovered worktree. Put it as
    // a sibling of every worktree (directly under the fixture's temp base)
    // so it is genuinely outside all of them.
    const outside = join(dirname(fx.root), "outside");
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "keep.txt"), "do not delete\n");
    const link = join(wt, "node_modules");
    await symlink(outside, link);
    const wts = await listWorktrees(fx.root, fx.root);
    await expect(assertInsideWorktree(link, wts)).rejects.toThrow(PathInvariantError);
    expect(existsSync(join(outside, "keep.txt"))).toBe(true);
    await fx.cleanup();
  });
});

describe("cleanArtifacts", () => {
  test("deletes artifact directories and leaves source files", async () => {
    const fx = await makeRepo();
    const wt = await fx.addWorktree({ name: "alpha" });
    await fx.addArtifacts(wt, "node_modules", 4096);
    const rows = await rowsFor(fx, "blocked");

    const result = await cleanArtifacts(rows);
    // git canonicalizes worktree paths (macOS: /var -> /private/var); the
    // fixture returns the raw tmpdir path. Same pattern as Tasks 3/7.
    const resolvedWt = await realpath(wt);
    expect(result.deleted).toContain(join(resolvedWt, "node_modules"));
    expect(result.failed).toHaveLength(0);
    expect(existsSync(join(wt, "node_modules"))).toBe(false);
    expect(existsSync(join(wt, "alpha.txt"))).toBe(true);
    await fx.cleanup();
  });

  test("works on a blocked worktree, since artifacts are always regenerable", async () => {
    const fx = await makeRepo();
    const wt = await fx.addWorktree({ name: "dirty", dirty: true });
    await fx.addArtifacts(wt, ".next", 2048);
    const rows = await rowsFor(fx, "blocked");
    const result = await cleanArtifacts(rows);
    expect(existsSync(join(wt, ".next"))).toBe(false);
    expect(existsSync(join(wt, "dirty.txt"))).toBe(true);
    expect(result.bytes).toBeGreaterThan(0);
    await fx.cleanup();
  });

  test("refuses an artifact path equal to the worktree root", async () => {
    const fx = await makeRepo();
    const wt = await fx.addWorktree({ name: "alpha" });
    const rows = await rowsFor(fx, "blocked");
    // Not reachable through measure() — Row/Sizes are exported types, so a
    // hand-built row can put the worktree root itself in sizes.artifacts.
    // The guard must not depend on measure() never doing this.
    const row = rows[0]!;
    row.sizes.artifacts.push({ path: row.worktree.path, bytes: 0 });

    const result = await cleanArtifacts(rows);
    expect(result.deleted).not.toContain(row.worktree.path);
    expect(result.failed.some((f) => f.path === row.worktree.path)).toBe(true);
    expect(existsSync(wt)).toBe(true);
    expect(existsSync(join(wt, "alpha.txt"))).toBe(true);
    await fx.cleanup();
  });
});

describe("pruneWorktrees", () => {
  test("removes safe worktrees and deregisters them from git", async () => {
    const fx = await makeRepo();
    const wt = await fx.addWorktree({ name: "done", merge: "squash", ageSeconds: 30 * DAY });
    const rows = await rowsFor(fx, "safe");
    const resolvedWt = await realpath(wt);

    const result = await pruneWorktrees(rows);
    expect(result.deleted).toContain(resolvedWt);
    expect(existsSync(wt)).toBe(false);

    const after = await listWorktrees(fx.root, fx.root);
    expect(after.map((w) => w.path)).not.toContain(wt);
    await fx.cleanup();
  });

  test.each(["blocked", "caution"] as const)(
    "refuses to remove a row that is not safe (%s)",
    async (safety) => {
      const fx = await makeRepo();
      const wt = await fx.addWorktree({ name: "open" });
      const rows = await rowsFor(fx, safety);
      const result = await pruneWorktrees(rows);
      expect(result.deleted).toHaveLength(0);
      expect(existsSync(wt)).toBe(true);
      await fx.cleanup();
    },
  );

  test("includeCaution: true widens the gate to caution rows", async () => {
    const fx = await makeRepo();
    const wt = await fx.addWorktree({ name: "young", merge: "squash" });
    const rows = await rowsFor(fx, "caution");
    const result = await pruneWorktrees(rows, { includeCaution: true });
    expect(result.deleted).toHaveLength(1);
    expect(existsSync(wt)).toBe(false);
    await fx.cleanup();
  });

  test("includeCaution: true never widens the gate to blocked rows — this is pruneWorktrees's OWN gate, independent of whatever the caller already filtered", async () => {
    const fx = await makeRepo();
    const wt = await fx.addWorktree({ name: "open" });
    const rows = await rowsFor(fx, "blocked");
    const result = await pruneWorktrees(rows, { includeCaution: true });
    expect(result.deleted).toHaveLength(0);
    expect(existsSync(wt)).toBe(true);
    await fx.cleanup();
  });

  // These two cover `if (row.worktree.isMain || row.worktree.isCurrent) continue`.
  // Deleting that line left the rest of the suite green, yet it is the last
  // defence between a classifier bug and losing your primary checkout. Both
  // rows are hand-built as `safe` and pass every other guard — registered,
  // a real directory, inside itself — so ONLY that line can refuse them.
  test("refuses the MAIN worktree even when handed a safe row", async () => {
    const fx = await makeRepo();
    await fx.addWorktree({ name: "alpha" });
    // cwd outside every worktree, so isCurrent is false everywhere and isMain
    // is the only flag under test.
    const wts = await listWorktrees(fx.root, "/");
    const main = wts.find((w) => w.isMain)!;
    expect(main.isCurrent).toBe(false);

    const rows: Row[] = [
      { worktree: main, verdict: { safety: "safe", reasons: [] }, sizes: await measure(main.path) },
    ];
    const result = await pruneWorktrees(rows);

    expect(result.deleted).toHaveLength(0);
    expect(result.failed).toHaveLength(0); // skipped outright, not attempted-and-failed
    expect(existsSync(main.path)).toBe(true);
    await fx.cleanup();
  });

  test("refuses the CURRENT worktree even when handed a safe row", async () => {
    const fx = await makeRepo();
    const wt = await fx.addWorktree({ name: "alpha" });
    // cwd inside the linked worktree makes it isCurrent without making it isMain.
    const wts = await listWorktrees(fx.root, wt);
    const current = wts.find((w) => w.isCurrent)!;
    expect(current.isMain).toBe(false);

    const rows: Row[] = [
      {
        worktree: current,
        verdict: { safety: "safe", reasons: [] },
        sizes: await measure(current.path),
      },
    ];
    const result = await pruneWorktrees(rows);

    expect(result.deleted).toHaveLength(0);
    expect(result.failed).toHaveLength(0);
    expect(existsSync(wt)).toBe(true);
    await fx.cleanup();
  });

  test("refuses a worktree directory swapped for a symlink after plan time (TOCTOU)", async () => {
    const fx = await makeRepo();
    const wt = await fx.addWorktree({ name: "done", merge: "squash", ageSeconds: 30 * DAY });
    const rows = await rowsFor(fx, "safe");

    // assertInsideWorktree alone can't catch this: `worktrees` always
    // includes this very row, so its containment check degenerates to
    // realpath(path) === realpath(path), true no matter what's there now.
    const victim = join(dirname(fx.root), "victim");
    await mkdir(victim, { recursive: true });
    await writeFile(join(victim, "precious.txt"), "do not delete\n");
    await rm(wt, { recursive: true, force: true });
    await symlink(victim, wt);

    const result = await pruneWorktrees(rows);
    expect(result.deleted).toHaveLength(0);
    expect(result.failed).toHaveLength(1);
    // Must be swarfkit's own guard refusing, not `git worktree remove`'s
    // internal validation — assert on the message so a future change to
    // git's own behaviour can't make this pass for the wrong reason.
    expect(result.failed[0]?.error).toMatch(/not a real directory|symlink/i);
    expect(existsSync(join(victim, "precious.txt"))).toBe(true);
    await fx.cleanup();
  });
});
