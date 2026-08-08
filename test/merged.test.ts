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
