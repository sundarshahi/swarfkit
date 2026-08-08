import { describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { makeRepo } from "./fixtures";
import { findRepos, listWorktrees } from "../src/discover";

describe("listWorktrees", () => {
  test("returns the main worktree plus each added worktree", async () => {
    const fx = await makeRepo();
    const a = await fx.addWorktree({ name: "alpha" });
    const wts = await listWorktrees(fx.root, fx.root);

    expect(wts.length).toBe(2);
    const main = wts.find((w) => w.isMain);
    expect(main?.branch).toBe("trunk");
    const alpha = wts.find((w) => w.branch === "alpha");
    expect(alpha?.path).toBe(a);
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
    expect(wts.find((w) => w.path === a)?.branch).toBeNull();
    await fx.cleanup();
  });
});

describe("findRepos", () => {
  test("finds a repo and does not descend into it", async () => {
    const fx = await makeRepo();
    await mkdir(join(fx.root, "packages", "inner"), { recursive: true });
    const repos = await findRepos([fx.root]);
    expect(repos).toContain(fx.root);
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
});
