import { describe, expect, test } from "bun:test";
import { symlink, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeRepo } from "./fixtures";
import { measure, ARTIFACT_DIRS } from "../src/measure";

describe("measure", () => {
  test("reports artifact directories separately from the total", async () => {
    const fx = await makeRepo();
    const wt = await fx.addWorktree({ name: "alpha" });
    await fx.addArtifacts(wt, "node_modules", 4096);
    await fx.addArtifacts(wt, ".next", 8192);

    const sizes = await measure(wt);
    const names = sizes.artifacts.map((a) => a.path.split("/").pop());
    expect(names.sort()).toEqual([".next", "node_modules"]);

    const nm = sizes.artifacts.find((a) => a.path.endsWith("node_modules"));
    expect(nm!.bytes).toBeGreaterThanOrEqual(4096);
    expect(sizes.total).toBeGreaterThanOrEqual(12288);
    await fx.cleanup();
  });

  test("does not follow symlinks out of the worktree", async () => {
    const fx = await makeRepo();
    const wt = await fx.addWorktree({ name: "alpha" });
    const outside = join(fx.root, "outside");
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "big.bin"), Buffer.alloc(1024 * 1024, 7));
    await symlink(outside, join(wt, "link"));

    const sizes = await measure(wt);
    expect(sizes.total).toBeLessThan(1024 * 1024);
    await fx.cleanup();
  });

  test("returns zero artifacts for a clean worktree", async () => {
    const fx = await makeRepo();
    const wt = await fx.addWorktree({ name: "alpha" });
    const sizes = await measure(wt);
    expect(sizes.artifacts).toHaveLength(0);
    await fx.cleanup();
  });

  test("exposes the fixed artifact directory list", () => {
    expect([...ARTIFACT_DIRS].sort()).toEqual(
      [...([".next", ".turbo", "build", "dist", "node_modules"] as const)].sort(),
    );
  });
});
