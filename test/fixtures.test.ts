import { describe, expect, test } from "bun:test";
import { makeRepo } from "./fixtures";
import { gitOut } from "../src/git";

describe("makeRepo", () => {
  test("creates a repo whose origin/HEAD resolves to the default branch", async () => {
    const fx = await makeRepo();
    const head = await gitOut(fx.root, [
      "symbolic-ref", "--quiet", "refs/remotes/origin/HEAD",
    ]);
    expect(head).toBe("refs/remotes/origin/trunk");
    await fx.cleanup();
  });

  test("addWorktree creates a merged branch that is not an ancestor", async () => {
    const fx = await makeRepo();
    const wt = await fx.addWorktree({ name: "squashed", merge: "squash" });
    const merged = await gitOut(fx.root, ["branch", "--merged", "trunk"]);
    expect(merged).not.toContain("squashed");
    const cherry = await gitOut(fx.root, ["cherry", "-v", "trunk", "squashed"]);
    expect(cherry?.startsWith("-")).toBe(true);
    expect(wt.length).toBeGreaterThan(0);
    await fx.cleanup();
  });
});
