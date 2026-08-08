import { describe, expect, test } from "bun:test";
import { makeRepo } from "./fixtures";
import { isMergedEquivalent } from "../src/merged";

describe("isMergedEquivalent", () => {
  test("true for a squash-merged branch that ancestry would call unmerged", async () => {
    const fx = await makeRepo();
    await fx.addWorktree({ name: "squashed", merge: "squash" });
    expect(await isMergedEquivalent(fx.root, "trunk", "squashed")).toBe(true);
    await fx.cleanup();
  });

  test("true for a conventionally merged branch", async () => {
    const fx = await makeRepo();
    await fx.addWorktree({ name: "merged", merge: "ff" });
    expect(await isMergedEquivalent(fx.root, "trunk", "merged")).toBe(true);
    await fx.cleanup();
  });

  test("false for a branch with no merge at all", async () => {
    const fx = await makeRepo();
    await fx.addWorktree({ name: "open", merge: "none" });
    expect(await isMergedEquivalent(fx.root, "trunk", "open")).toBe(false);
    await fx.cleanup();
  });

  test("false when a commit was added after the squash merge", async () => {
    const fx = await makeRepo();
    await fx.addWorktree({ name: "moved-on", merge: "squash", extraCommit: true });
    expect(await isMergedEquivalent(fx.root, "trunk", "moved-on")).toBe(false);
    await fx.cleanup();
  });

  test("true for a branch with no commits beyond the default branch", async () => {
    const fx = await makeRepo();
    const { git } = await import("../src/git");
    await git(fx.root, ["branch", "empty", "trunk"]);
    expect(await isMergedEquivalent(fx.root, "trunk", "empty")).toBe(true);
    await fx.cleanup();
  });

  // A squash collapses N commits into one, so `git cherry`'s per-commit patch
  // ids stop matching for N > 1. Measured before the fallback existed: 1 commit
  // true, 2 commits FALSE, 3 commits FALSE.
  for (const n of [1, 2, 3]) {
    test(`true for a ${n}-commit squash-merged branch`, async () => {
      const fx = await makeRepo();
      await fx.addWorktree({ name: `sq${n}`, merge: "squash", commits: n });
      expect(await isMergedEquivalent(fx.root, "trunk", `sq${n}`)).toBe(true);
      await fx.cleanup();
    });

    test(`false for a ${n}-commit squash-merged branch with an extra commit`, async () => {
      const fx = await makeRepo();
      await fx.addWorktree({
        name: `sq${n}x`, merge: "squash", commits: n, extraCommit: true,
      });
      expect(await isMergedEquivalent(fx.root, "trunk", `sq${n}x`)).toBe(false);
      await fx.cleanup();
    });

    test(`false for a ${n}-commit branch that was never merged`, async () => {
      const fx = await makeRepo();
      await fx.addWorktree({ name: `open${n}`, merge: "none", commits: n });
      expect(await isMergedEquivalent(fx.root, "trunk", `open${n}`)).toBe(false);
      await fx.cleanup();
    });
  }

  test("false for an unmerged branch shadowed by a tag of the same name", async () => {
    // Git resolves a bare ref as refs/tags/<name> before refs/heads/<name>, so
    // an unqualified `cherry trunk v1.2.0` reads the TAG, returns empty, and
    // calls unmerged work merged — destroying the only copy of that commit.
    const fx = await makeRepo();
    const { git } = await import("../src/git");
    await fx.addWorktree({ name: "v1.2.0", merge: "none" });
    await git(fx.root, ["tag", "v1.2.0", "trunk"]);
    expect(await isMergedEquivalent(fx.root, "trunk", "v1.2.0")).toBe(false);
    await fx.cleanup();
  });

  test("false when a tag shadows the DEFAULT branch name", async () => {
    // The same shadowing works in the upstream position: a tag `trunk` pointing
    // at the feature branch makes an unqualified comparison report merged.
    const fx = await makeRepo();
    const { git } = await import("../src/git");
    await fx.addWorktree({ name: "open", merge: "none" });
    await git(fx.root, ["tag", "trunk", "open"]);
    expect(await isMergedEquivalent(fx.root, "trunk", "open")).toBe(false);
    await fx.cleanup();
  });

  test("false when the branch does not exist", async () => {
    const fx = await makeRepo();
    expect(await isMergedEquivalent(fx.root, "trunk", "ghost")).toBe(false);
    await fx.cleanup();
  });

  test("false, not a thrown rejection, when repoRoot does not exist", async () => {
    await expect(
      isMergedEquivalent("/no/such/dir/swarf-missing", "trunk", "anything"),
    ).resolves.toBe(false);
  });
});
