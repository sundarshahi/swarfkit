import { describe, expect, test } from "bun:test";
import { formatBytes, renderTable, renderJson, reclaimableBytes } from "../src/render";
import type { Row } from "../src/types";

function row(over: Partial<Row> = {}): Row {
  return {
    worktree: {
      path: "/tmp/wt-a", branch: "feature-a", head: "abc",
      repoRoot: "/tmp/repo", isMain: false, isCurrent: false,
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
