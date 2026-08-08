import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
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

  test("refuses to remove a row that is not safe", async () => {
    const fx = await makeRepo();
    const wt = await fx.addWorktree({ name: "open" });
    const rows = await rowsFor(fx, "blocked");
    const result = await pruneWorktrees(rows);
    expect(result.deleted).toHaveLength(0);
    expect(existsSync(wt)).toBe(true);
    await fx.cleanup();
  });
});
