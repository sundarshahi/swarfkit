import { describe, expect, test } from "bun:test";
import {
  artifactBytes, formatBytes, renderTable, renderJson, reclaimableBytes, treeBytes,
  suggestNextStep,
} from "../src/render";
import type { Row } from "../src/types";

function row(over: Partial<Row> = {}): Row {
  return {
    worktree: {
      path: "/tmp/wt-a", branch: "feature-a", head: "abc",
      repoRoot: "/tmp/repo", isMain: false, isCurrent: false, locked: false,
    },
    verdict: { safety: "safe", reasons: [] },
    sizes: { total: 2_000_000, artifacts: [{ path: "/tmp/wt-a/node_modules", bytes: 1_500_000 }] },
    ...over,
  };
}

describe("formatBytes", () => {
  test("uses binary units with one decimal above kilobytes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1024 ** 3 * 43)).toBe("43.0 GB");
  });

  test("renders unknown sizes as a dash", () => {
    expect(formatBytes(-1)).toBe("—");
  });
});

describe("reclaimableBytes", () => {
  test("counts the whole tree for a safe row", () => {
    expect(reclaimableBytes(row())).toBe(2_000_000);
  });

  test("counts only artifacts for a blocked row", () => {
    const r = row({ verdict: { safety: "blocked", reasons: ["has uncommitted changes"] } });
    expect(reclaimableBytes(r)).toBe(1_500_000);
  });

  test("treats unknown total as zero rather than negative", () => {
    const r = row({ sizes: { total: -1, artifacts: [] } });
    expect(reclaimableBytes(r)).toBe(0);
  });

  test("falls back to measured artifacts when a safe row's total is unknown", () => {
    // total: -1 means the walk could not read the tree, not that it is empty.
    // Reporting 0 while holding measured artifacts is simply wrong.
    const r = row({ sizes: { total: -1, artifacts: [{ path: "/tmp/wt-a/dist", bytes: 900 }] } });
    expect(reclaimableBytes(r)).toBe(900);
    expect(treeBytes(r)).toBe(900);
  });
});

describe("artifactBytes and treeBytes", () => {
  test("split what clean deletes from what prune deletes", () => {
    // The confirmation prompt picks one per command; a single shared number was
    // wrong in both directions.
    expect(artifactBytes(row())).toBe(1_500_000);
    expect(treeBytes(row())).toBe(2_000_000);

    const caution = row({ verdict: { safety: "caution", reasons: ["younger than 7d"] } });
    expect(artifactBytes(caution)).toBe(1_500_000);
    expect(treeBytes(caution)).toBe(2_000_000); // prune takes the whole tree
  });

  test("ignore negative artifact sizes", () => {
    const r = row({ sizes: { total: 10, artifacts: [{ path: "/tmp/wt-a/dist", bytes: -1 }] } });
    expect(artifactBytes(r)).toBe(0);
  });
});

describe("renderTable", () => {
  test("sorts by reclaimable bytes descending", () => {
    const small = row({ worktree: { ...row().worktree, path: "/tmp/small", branch: "small" },
      sizes: { total: 10, artifacts: [] } });
    const out = renderTable([small, row()]);
    expect(out.indexOf("feature-a")).toBeLessThan(out.indexOf("small"));
  });

  test("prints the reason for a non-safe row", () => {
    const r = row({ verdict: { safety: "blocked", reasons: ["has uncommitted changes"] } });
    expect(renderTable([r])).toContain("has uncommitted changes");
  });

  test("reports an empty result set explicitly", () => {
    expect(renderTable([])).toContain("No worktrees found");
  });

  test("case 2: repos found but none has a linked worktree — not an error", () => {
    const mainOnly = row({
      worktree: { ...row().worktree, isMain: true },
      verdict: { safety: "blocked", reasons: ["is the main worktree"] },
    });
    const out = renderTable([mainOnly]);
    expect(out).toContain("No linked worktrees");
    expect(out).not.toContain("No worktrees found");
  });

  test("case 3: worktrees found, but nothing is reclaimable", () => {
    const nothing = row({
      verdict: { safety: "blocked", reasons: ["has uncommitted changes"] },
      sizes: { total: 0, artifacts: [] },
    });
    const out = renderTable([nothing]);
    expect(out).toContain("nothing reclaimable");
  });

  test("the four empty/near-empty report states each render distinct copy", () => {
    const noRepo = renderTable([]);
    const mainOnly = renderTable([
      row({
        worktree: { ...row().worktree, isMain: true },
        verdict: { safety: "blocked", reasons: ["is the main worktree"] },
      }),
    ]);
    const nothingReclaimable = renderTable([
      row({ verdict: { safety: "blocked", reasons: ["x"] }, sizes: { total: 0, artifacts: [] } }),
    ]);
    const hasData = renderTable([row()]);
    expect(new Set([noRepo, mainOnly, nothingReclaimable, hasData]).size).toBe(4);
  });

  test("truncates an absurdly long branch name with a visible ellipsis, keeping columns aligned", () => {
    const longName = `feature/${"x".repeat(80)}`;
    const long = row({ worktree: { ...row().worktree, branch: longName } });
    const short = row({
      worktree: { ...row().worktree, path: "/tmp/wt-b", branch: "short" },
      sizes: { total: 10, artifacts: [] },
    });
    const out = renderTable([long, short]);

    expect(out).not.toContain(longName);
    expect(out).toContain("…");

    const dataLines = out
      .split("\n")
      .filter((l) => l.includes("safe") && !l.includes("reclaimable") && !l.startsWith("Run "));
    expect(dataLines.length).toBe(2);
    const offsets = dataLines.map((l) => l.indexOf("safe"));
    expect(new Set(offsets).size).toBe(1); // both VERDICT columns start at the same offset
  });

  test("--json keeps the untruncated branch name even when the table would truncate it", () => {
    const longName = `feature/${"x".repeat(80)}`;
    const long = row({ worktree: { ...row().worktree, branch: longName } });
    const parsed = JSON.parse(renderJson([long]));
    expect(parsed.worktrees[0].branch).toBe(longName);
  });

  describe("color", () => {
    test("emits ANSI escapes when explicitly enabled", () => {
      expect(renderTable([row()], { color: true })).toContain("\x1b[");
    });

    test("emits no ANSI escapes by default", () => {
      expect(renderTable([row()])).not.toContain("\x1b");
    });

    test("emits no ANSI escapes when explicitly disabled", () => {
      expect(renderTable([row()], { color: false })).not.toContain("\x1b");
    });

    test("the literal verdict words survive with color stripped", () => {
      // Color is an enhancement, never the only signal — the word must be
      // there in plain monochrome output too.
      const blocked = row({ verdict: { safety: "blocked", reasons: ["has uncommitted changes"] } });
      expect(renderTable([blocked])).toContain("blocked");
      expect(renderTable([blocked], { color: true })).toContain("blocked");
    });
  });

  describe("renderJson never decorates", () => {
    test("no ANSI escapes appear in JSON output, ever", () => {
      expect(renderJson([row()])).not.toContain("\x1b");
    });
  });
});

describe("suggestNextStep", () => {
  test("suggests prune and quotes prune's own reclaim figure when a safe worktree exists", () => {
    const safe = row(); // safe, treeBytes 2_000_000
    const suggestion = suggestNextStep([safe]);
    expect(suggestion).toContain("swarf prune");
    expect(suggestion).toContain(formatBytes(treeBytes(safe)));
  });

  test("suggests clean and quotes clean's own reclaim figure when nothing is prunable", () => {
    const blocked = row({ verdict: { safety: "blocked", reasons: ["has uncommitted changes"] } });
    const suggestion = suggestNextStep([blocked]);
    expect(suggestion).toContain("swarf clean");
    expect(suggestion).toContain(formatBytes(artifactBytes(blocked)));
  });

  test("returns null when neither command has anything to do", () => {
    const nothing = row({
      verdict: { safety: "blocked", reasons: ["x"] },
      sizes: { total: 0, artifacts: [] },
    });
    expect(suggestNextStep([nothing])).toBeNull();
  });

  test("renderTable appends the suggestion after the summary line", () => {
    expect(renderTable([row()])).toContain("Run `swarf prune`");
  });
});

describe("renderJson", () => {
  test("emits parseable JSON carrying verdict and bytes", () => {
    const parsed = JSON.parse(renderJson([row()]));
    expect(parsed.worktrees[0].branch).toBe("feature-a");
    expect(parsed.worktrees[0].safety).toBe("safe");
    expect(parsed.worktrees[0].reclaimableBytes).toBe(2_000_000);
    expect(parsed.totals.reclaimableBytes).toBe(2_000_000);
  });
});
