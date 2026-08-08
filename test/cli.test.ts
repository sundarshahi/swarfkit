import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeRepo } from "./fixtures";
import { parseArgs, parseDuration, run } from "../src/cli";

const DAY = 86_400;

function io(cwd: string, answer = true) {
  const out: string[] = [];
  const err: string[] = [];
  const asked: string[] = [];
  return {
    io: {
      cwd,
      out: (s: string) => out.push(s),
      err: (s: string) => err.push(s),
      confirm: async (question: string) => {
        asked.push(question);
        return answer;
      },
    },
    out,
    err,
    asked,
  };
}

/** The formatted byte figure in a line, e.g. "52.0 MB" — or "" if absent. */
const SIZE = /(\d+(?:\.\d+)? (?:B|KB|MB|GB|TB))/;
function size(text: string): string {
  return SIZE.exec(text)?.[1] ?? "";
}

describe("parseDuration", () => {
  test("parses day, hour and week suffixes", () => {
    expect(parseDuration("7d")).toBe(7 * DAY);
    expect(parseDuration("12h")).toBe(12 * 3600);
    expect(parseDuration("2w")).toBe(14 * DAY);
  });

  test("rejects unparseable input", () => {
    expect(parseDuration("soon")).toBeNull();
    expect(parseDuration("7")).toBeNull();
    expect(parseDuration("-3d")).toBeNull();
  });
});

describe("parseArgs", () => {
  test("defaults to the report command", () => {
    const parsed = parseArgs([]);
    expect("command" in parsed && parsed.command).toBe("report");
  });

  test("accepts repeated --root", () => {
    const parsed = parseArgs(["--root", "/a", "--root", "/b"]);
    expect("roots" in parsed && parsed.roots).toEqual(["/a", "/b"]);
  });

  test("rejects an unknown flag", () => {
    const parsed = parseArgs(["--wat"]);
    expect("error" in parsed).toBe(true);
  });

  test("rejects a delete flag on the bare command", () => {
    const parsed = parseArgs(["--yes"]);
    expect("error" in parsed).toBe(true);
  });

  test("-h/--help short-circuits without a usage error", () => {
    const short = parseArgs(["-h"]);
    const long = parseArgs(["--help"]);
    expect("help" in short && short.help).toBe(true);
    expect("error" in short).toBe(false);
    expect("help" in long && long.help).toBe(true);
    expect("error" in long).toBe(false);
  });
});

describe("run", () => {
  test("bare command reports and exits 0 without deleting", async () => {
    const fx = await makeRepo();
    const wt = await fx.addWorktree({ name: "done", merge: "squash", ageSeconds: 30 * DAY });
    await fx.addArtifacts(wt, "node_modules", 4096);

    const { io: i, out } = io(fx.root);
    const code = await run(["--root", fx.root], i);

    expect(code).toBe(0);
    expect(out.join("\n")).toContain("done");
    expect(existsSync(join(wt, "node_modules"))).toBe(true);
    await fx.cleanup();
  });

  test("--json emits parseable output", async () => {
    const fx = await makeRepo();
    await fx.addWorktree({ name: "done", merge: "squash", ageSeconds: 30 * DAY });
    const { io: i, out } = io(fx.root);
    const code = await run(["--root", fx.root, "--json"], i);
    expect(code).toBe(0);
    expect(() => JSON.parse(out.join("\n"))).not.toThrow();
    await fx.cleanup();
  });

  test("clean deletes artifacts after confirmation", async () => {
    const fx = await makeRepo();
    const wt = await fx.addWorktree({ name: "alpha" });
    await fx.addArtifacts(wt, "node_modules", 4096);
    const { io: i } = io(fx.root, true);
    const code = await run(["clean", "--root", fx.root], i);
    expect(code).toBe(0);
    expect(existsSync(join(wt, "node_modules"))).toBe(false);
    await fx.cleanup();
  });

  test("clean deletes nothing when the user declines", async () => {
    const fx = await makeRepo();
    const wt = await fx.addWorktree({ name: "alpha" });
    await fx.addArtifacts(wt, "node_modules", 4096);
    const { io: i } = io(fx.root, false);
    const code = await run(["clean", "--root", fx.root], i);
    expect(code).toBe(0);
    expect(existsSync(join(wt, "node_modules"))).toBe(true);
    await fx.cleanup();
  });

  test("prune removes only safe worktrees", async () => {
    const fx = await makeRepo();
    const safe = await fx.addWorktree({ name: "done", merge: "squash", ageSeconds: 30 * DAY });
    const open = await fx.addWorktree({ name: "open", merge: "none", ageSeconds: 30 * DAY });
    const { io: i } = io(fx.root, true);
    const code = await run(["prune", "--root", fx.root], i);
    expect(code).toBe(0);
    expect(existsSync(safe)).toBe(false);
    expect(existsSync(open)).toBe(true);
    await fx.cleanup();
  });

  test("prune --include-caution removes a merged-but-young caution worktree", async () => {
    const fx = await makeRepo();
    // merged, clean, pushed, but ageSeconds omitted (0) => younger than the
    // default 7d min-age => caution, not safe.
    const caution = await fx.addWorktree({ name: "young", merge: "squash" });
    const { io: i } = io(fx.root, true);
    const code = await run(["prune", "--include-caution", "--root", fx.root], i);
    expect(code).toBe(0);
    expect(existsSync(caution)).toBe(false);
    await fx.cleanup();
  });

  test("plain prune (no --include-caution) leaves a caution worktree behind", async () => {
    const fx = await makeRepo();
    const caution = await fx.addWorktree({ name: "young", merge: "squash" });
    const { io: i } = io(fx.root, true);
    const code = await run(["prune", "--root", fx.root], i);
    expect(code).toBe(0);
    expect(existsSync(caution)).toBe(true);
    await fx.cleanup();
  });

  test("prune --include-caution never removes a blocked worktree", async () => {
    const fx = await makeRepo();
    const blocked = await fx.addWorktree({ name: "open", merge: "none", ageSeconds: 30 * DAY });
    const { io: i } = io(fx.root, true);
    const code = await run(["prune", "--include-caution", "--root", fx.root], i);
    expect(code).toBe(0);
    expect(existsSync(blocked)).toBe(true);
    await fx.cleanup();
  });

  // The confirmation figure must describe exactly what THIS command deletes.
  // Measured before the fix: `clean` on a safe row promised 52.0 MB and freed
  // 2.0 MB (26x over); `prune --include-caution` on a caution row promised
  // 1.0 MB and freed 41.0 MB, taking the whole worktree with it (41x under).
  describe("the confirmation figure matches what is actually deleted", () => {
    test("clean promises only the artifact bytes, even on a safe row", async () => {
      const fx = await makeRepo();
      const wt = await fx.addWorktree({ name: "done", merge: "squash", ageSeconds: 30 * DAY });
      await fx.addArtifacts(wt, "node_modules", 2_000_000);
      await fx.addArtifacts(wt, "logs", 20_000_000); // bulk that clean must NOT count
      const { io: i, out, asked } = io(fx.root, true);

      expect(await run(["clean", "--root", fx.root], i)).toBe(0);
      const promised = size(asked.join("\n"));
      const actual = size(out.find((l) => l.startsWith("Reclaimed")) ?? "");
      expect(promised).not.toBe("");
      expect(promised).toBe(actual);
      await fx.cleanup();
    });

    test("prune promises the whole tree for a safe row", async () => {
      const fx = await makeRepo();
      const wt = await fx.addWorktree({ name: "done", merge: "squash", ageSeconds: 30 * DAY });
      await fx.addArtifacts(wt, "node_modules", 2_000_000);
      await fx.addArtifacts(wt, "logs", 20_000_000); // bulk that prune DOES take
      const { io: i, out, asked } = io(fx.root, true);

      expect(await run(["prune", "--root", fx.root], i)).toBe(0);
      const promised = size(asked.join("\n"));
      const actual = size(out.find((l) => l.startsWith("Reclaimed")) ?? "");
      expect(promised).not.toBe("");
      expect(promised).toBe(actual);
      await fx.cleanup();
    });

    test("prune --include-caution promises the whole tree for a caution row", async () => {
      const fx = await makeRepo();
      // merged and clean but young => caution, whose report figure is its
      // artifacts only, while prune takes the entire worktree.
      const wt = await fx.addWorktree({ name: "young", merge: "squash" });
      await fx.addArtifacts(wt, "node_modules", 2_000_000);
      await fx.addArtifacts(wt, "logs", 20_000_000); // bulk that prune DOES take
      const { io: i, out, asked } = io(fx.root, true);

      expect(await run(["prune", "--include-caution", "--root", fx.root], i)).toBe(0);
      const promised = size(asked.join("\n"));
      const actual = size(out.find((l) => l.startsWith("Reclaimed")) ?? "");
      expect(promised).not.toBe("");
      expect(promised).toBe(actual);
      expect(existsSync(wt)).toBe(false);
      await fx.cleanup();
    });

    test("the prompt counts the noun it names", async () => {
      const fx = await makeRepo();
      const wt = await fx.addWorktree({ name: "alpha" });
      await fx.addArtifacts(wt, "node_modules", 1024);
      await fx.addArtifacts(wt, "dist", 1024);
      const { io: i, asked } = io(fx.root, false);

      await run(["clean", "--root", fx.root], i);
      // Two artifact directories in one worktree: the count is of directories,
      // matching the noun, and the sentence does not dangle on "in".
      expect(asked[0]).toContain("Delete 2 build directories to reclaim");
      expect(asked[0]).not.toContain("in?");
      await fx.cleanup();
    });

    test("the prompt singularises a count of one", async () => {
      const fx = await makeRepo();
      await fx.addWorktree({ name: "done", merge: "squash", ageSeconds: 30 * DAY });
      const { io: i, asked } = io(fx.root, false);
      await run(["prune", "--root", fx.root], i);
      expect(asked[0]).toContain("Delete 1 worktree to reclaim");
      await fx.cleanup();
    });

    test("the clean prompt singularises a count of one build directory", async () => {
      const fx = await makeRepo();
      const wt = await fx.addWorktree({ name: "alpha" });
      await fx.addArtifacts(wt, "node_modules", 1024);
      const { io: i, asked } = io(fx.root, false);
      await run(["clean", "--root", fx.root], i);
      // Regression: naive "s$" stripping turned "build directories" into
      // "build directorie" — singular and plural are now spelled out explicitly.
      expect(asked[0]).toContain("Delete 1 build directory to reclaim");
      await fx.cleanup();
    });
  });

  describe("--json is honoured by clean and prune, not silently ignored", () => {
    test("prune --json --yes emits only parseable JSON naming what it deleted", async () => {
      const fx = await makeRepo();
      const wt = await fx.addWorktree({ name: "done", merge: "squash", ageSeconds: 30 * DAY });
      const { io: i, out } = io(fx.root, true);

      expect(await run(["prune", "--root", fx.root, "--json", "--yes"], i)).toBe(0);
      const parsed = JSON.parse(out.join("\n"));
      expect(parsed.command).toBe("prune");
      expect(parsed.deleted).toHaveLength(1);
      expect(parsed.failed).toEqual([]);
      expect(parsed.bytes).toBeGreaterThan(0);
      expect(existsSync(wt)).toBe(false);
      await fx.cleanup();
    });

    test("clean --json emits parseable JSON with no human table", async () => {
      const fx = await makeRepo();
      const wt = await fx.addWorktree({ name: "alpha" });
      await fx.addArtifacts(wt, "node_modules", 4096);
      const { io: i, out } = io(fx.root, true);

      expect(await run(["clean", "--root", fx.root, "--json"], i)).toBe(0);
      const parsed = JSON.parse(out.join("\n"));
      expect(parsed.command).toBe("clean");
      expect(parsed.deleted).toHaveLength(1);
      expect(existsSync(join(wt, "node_modules"))).toBe(false);
      await fx.cleanup();
    });

    test("--json stays parseable when the user declines and when there is nothing to do", async () => {
      const fx = await makeRepo();
      const wt = await fx.addWorktree({ name: "alpha" });
      await fx.addArtifacts(wt, "node_modules", 4096);

      const declined = io(fx.root, false);
      expect(await run(["clean", "--root", fx.root, "--json"], declined.io)).toBe(0);
      expect(JSON.parse(declined.out.join("\n")).deleted).toEqual([]);
      expect(existsSync(join(wt, "node_modules"))).toBe(true);

      const empty = io(fx.root, true);
      expect(await run(["prune", "--root", fx.root, "--json", "--yes"], empty.io)).toBe(0);
      expect(JSON.parse(empty.out.join("\n"))).toMatchObject({ deleted: [], bytes: 0 });
      await fx.cleanup();
    });
  });

  test("exits 2 on an unknown flag and writes to the err channel", async () => {
    const fx = await makeRepo();
    const { io: i, out, err } = io(fx.root);
    expect(await run(["--wat"], i)).toBe(2);
    expect(err.length).toBeGreaterThan(0);
    expect(out.length).toBe(0);
    await fx.cleanup();
  });

  test("--help exits 0 and writes to the out channel, not err", async () => {
    const fx = await makeRepo();
    const { io: i, out, err } = io(fx.root);
    const code = await run(["--help"], i);
    expect(code).toBe(0);
    expect(err.length).toBe(0);
    expect(out.join("\n")).toContain("Usage:");
    await fx.cleanup();
  });

  test("re-scans before deleting: a worktree that turns dirty during confirmation survives prune", async () => {
    const fx = await makeRepo();
    const wt = await fx.addWorktree({ name: "flip", merge: "squash", ageSeconds: 30 * DAY });

    // The worktree is `safe` at scan time. While the (async) confirmation is
    // pending, it picks up an uncommitted change — a real sequence an earlier
    // task proved happens (safe -> blocked between the two calls). Only a
    // fresh re-scan immediately before deletion can see this.
    const out: string[] = [];
    const err: string[] = [];
    const i = {
      cwd: fx.root,
      out: (s: string) => out.push(s),
      err: (s: string) => err.push(s),
      confirm: async () => {
        await writeFile(join(wt, "dirty.txt"), "uncommitted\n");
        return true;
      },
    };

    const code = await run(["prune", "--root", fx.root], i);
    expect(code).toBe(0);
    expect(existsSync(wt)).toBe(true);
    await fx.cleanup();
  });

  test("exits 2 outside a repository with no --root", async () => {
    const { io: i, err } = io("/");
    expect(await run([], i)).toBe(2);
    expect(err.join("\n")).toContain("--root");
  });
});
