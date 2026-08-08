import { describe, expect, test } from "bun:test";
import { realpath } from "node:fs/promises";
import { makeRepo } from "./fixtures";
import { listWorktrees } from "../src/discover";
import { classify, DEFAULT_MIN_AGE_SECONDS } from "../src/classify";
import { git } from "../src/git";
import type { Worktree } from "../src/types";

const DAY = 86_400;
const opts = { defaultBranch: "trunk", minAgeSeconds: DEFAULT_MIN_AGE_SECONDS };

// Resolve both sides canonically before comparing (handles /var vs /private/var
// on macOS, where git reports the realpath but the fixture returns the raw
// mkdtemp path) — same approach as test/discover.test.ts.
async function findByPath(wts: Worktree[], path: string): Promise<Worktree | undefined> {
  const target = await realpath(path);
  for (const w of wts) {
    const resolved = await realpath(w.path).catch(() => w.path);
    if (resolved === target) return w;
  }
  return undefined;
}

async function verdictFor(fx: Awaited<ReturnType<typeof makeRepo>>, path: string) {
  const wts = await listWorktrees(fx.root, fx.root);
  const wt = (await findByPath(wts, path))!;
  return classify(wt, opts);
}

describe("classify", () => {
  test("safe: merged, clean, pushed, old enough", async () => {
    const fx = await makeRepo();
    const wt = await fx.addWorktree({ name: "done", merge: "squash", ageSeconds: 30 * DAY });
    expect((await verdictFor(fx, wt)).safety).toBe("safe");
    await fx.cleanup();
  });

  test("blocked: the main worktree is never reclaimable", async () => {
    const fx = await makeRepo();
    const wts = await listWorktrees(fx.root, fx.root);
    const main = wts.find((w) => w.isMain)!;
    const v = await classify(main, opts);
    expect(v.safety).toBe("blocked");
    expect(v.reasons.join(" ")).toContain("main worktree");
    await fx.cleanup();
  });

  test("blocked: a locked worktree, which git would refuse to remove anyway", async () => {
    const fx = await makeRepo();
    // Otherwise perfectly safe: merged, clean, pushed, old.
    const wt = await fx.addWorktree({ name: "done", merge: "squash", ageSeconds: 30 * DAY });
    await git(fx.root, ["worktree", "lock", "--reason", "on a usb stick", wt]);
    const v = await verdictFor(fx, wt);
    expect(v.safety).toBe("blocked");
    expect(v.reasons.join(" ")).toContain("locked");
    await git(fx.root, ["worktree", "unlock", wt]);
    await fx.cleanup();
  });

  test("blocked: the current worktree is never reclaimable", async () => {
    const fx = await makeRepo();
    const wt = await fx.addWorktree({ name: "here", merge: "squash", ageSeconds: 30 * DAY });
    const wts = await listWorktrees(fx.root, wt);
    const current = (await findByPath(wts, wt))!;
    const v = await classify(current, opts);
    expect(v.safety).toBe("blocked");
    expect(v.reasons.join(" ")).toContain("current worktree");
    await fx.cleanup();
  });

  test("blocked: uncommitted changes", async () => {
    const fx = await makeRepo();
    const wt = await fx.addWorktree({
      name: "dirty", merge: "squash", dirty: true, ageSeconds: 30 * DAY,
    });
    const v = await verdictFor(fx, wt);
    expect(v.safety).toBe("blocked");
    expect(v.reasons.join(" ")).toContain("uncommitted");
    await fx.cleanup();
  });

  test("blocked: no upstream tracking branch", async () => {
    const fx = await makeRepo();
    const wt = await fx.addWorktree({
      name: "local", merge: "squash", noUpstream: true, ageSeconds: 30 * DAY,
    });
    const v = await verdictFor(fx, wt);
    expect(v.safety).toBe("blocked");
    expect(v.reasons.join(" ")).toContain("upstream");
    await fx.cleanup();
  });

  test("blocked: not merged", async () => {
    const fx = await makeRepo();
    const wt = await fx.addWorktree({ name: "open", merge: "none", ageSeconds: 30 * DAY });
    const v = await verdictFor(fx, wt);
    expect(v.safety).toBe("blocked");
    expect(v.reasons.join(" ")).toContain("not merged");
    await fx.cleanup();
  });

  test("blocked: detached HEAD", async () => {
    const fx = await makeRepo();
    const wt = await fx.addWorktree({ name: "loose", merge: "squash", ageSeconds: 30 * DAY });
    await git(wt, ["checkout", "-q", "--detach"]);
    const v = await verdictFor(fx, wt);
    expect(v.safety).toBe("blocked");
    expect(v.reasons.join(" ")).toContain("detached");
    await fx.cleanup();
  });

  test("blocked: default branch could not be resolved", async () => {
    const fx = await makeRepo();
    const wt = await fx.addWorktree({ name: "done", merge: "squash", ageSeconds: 30 * DAY });
    const wts = await listWorktrees(fx.root, fx.root);
    const target = (await findByPath(wts, wt))!;
    const v = await classify(target, { defaultBranch: null, minAgeSeconds: DEFAULT_MIN_AGE_SECONDS });
    expect(v.safety).toBe("blocked");
    expect(v.reasons.join(" ")).toContain("default branch");
    await fx.cleanup();
  });

  test("caution: passes rules 1-4 but is younger than min-age", async () => {
    const fx = await makeRepo();
    const wt = await fx.addWorktree({ name: "fresh", merge: "squash", ageSeconds: 60 });
    const v = await verdictFor(fx, wt);
    expect(v.safety).toBe("caution");
    expect(v.reasons.join(" ")).toContain("younger than");
    await fx.cleanup();
  });

  test("reasons are always populated when not safe", async () => {
    const fx = await makeRepo();
    const wt = await fx.addWorktree({ name: "open", merge: "none" });
    const v = await verdictFor(fx, wt);
    expect(v.reasons.length).toBeGreaterThan(0);
    await fx.cleanup();
  });
});
