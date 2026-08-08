import { describe, expect, test } from "bun:test";
import { makeRepo } from "./fixtures";
import { git } from "../src/git";
import { resolveDefaultBranch } from "../src/default-branch";

describe("resolveDefaultBranch", () => {
  test("prefers origin/HEAD over any conventional name", async () => {
    const fx = await makeRepo();
    expect(await resolveDefaultBranch(fx.root)).toBe("trunk");
    await fx.cleanup();
  });

  test("falls back to main when origin/HEAD is absent", async () => {
    const fx = await makeRepo();
    await git(fx.root, ["branch", "main", "trunk"]);
    await git(fx.root, ["symbolic-ref", "--delete", "refs/remotes/origin/HEAD"]);
    expect(await resolveDefaultBranch(fx.root)).toBe("main");
    await fx.cleanup();
  });

  test("falls back to master when neither origin/HEAD nor main exists", async () => {
    const fx = await makeRepo();
    await git(fx.root, ["branch", "master", "trunk"]);
    await git(fx.root, ["symbolic-ref", "--delete", "refs/remotes/origin/HEAD"]);
    expect(await resolveDefaultBranch(fx.root)).toBe("master");
    await fx.cleanup();
  });

  test("returns null rather than guessing when nothing resolves", async () => {
    const fx = await makeRepo();
    await git(fx.root, ["symbolic-ref", "--delete", "refs/remotes/origin/HEAD"]);
    expect(await resolveDefaultBranch(fx.root)).toBeNull();
    await fx.cleanup();
  });
});
