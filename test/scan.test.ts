import { describe, expect, test } from "bun:test";
import { realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeRepo } from "./fixtures";
import { scan } from "../src/scan";
import { DEFAULT_MIN_AGE_SECONDS } from "../src/classify";
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
