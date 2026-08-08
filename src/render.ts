import type { Row } from "./types";

const UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

export function formatBytes(n: number): string {
  if (n < 0) return "—";
  if (n < 1024) return `${n} B`;
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${UNITS[unit]}`;
}

/** Exactly what `clean` deletes from this row: its build artifact directories. */
export function artifactBytes(row: Row): number {
  return row.sizes.artifacts.reduce((sum, a) => sum + Math.max(0, a.bytes), 0);
}

/**
 * Exactly what `prune` deletes from this row: the whole tree. Falls back to the
 * artifact sum when the total is unknown (-1, permission denied) — reporting 0
 * for a row that demonstrably holds measured artifacts is simply wrong.
 */
export function treeBytes(row: Row): number {
  return row.sizes.total >= 0 ? row.sizes.total : artifactBytes(row);
}

/**
 * What the *report* shows. A safe row is a prune candidate and can lose its
 * whole tree; anything else can still lose its build artifacts, which is tier 1
 * and always permitted. Command prompts must NOT use this — they use the
 * function matching the command, because `clean` on a safe row deletes only
 * artifacts and `prune --include-caution` on a caution row deletes everything.
 */
export function reclaimableBytes(row: Row): number {
  return row.verdict.safety === "safe" ? treeBytes(row) : artifactBytes(row);
}

function byReclaimableDesc(a: Row, b: Row): number {
  return reclaimableBytes(b) - reclaimableBytes(a);
}

const MARK: Record<Row["verdict"]["safety"], string> = {
  safe: "safe",
  caution: "caution",
  blocked: "blocked",
};

export function renderTable(rows: Row[]): string {
  if (rows.length === 0) return "No worktrees found.";

  const sorted = [...rows].sort(byReclaimableDesc);
  const cells = sorted.map((r) => ({
    branch: r.worktree.branch ?? "(detached)",
    verdict: MARK[r.verdict.safety],
    size: formatBytes(reclaimableBytes(r)),
    reason: r.verdict.reasons[0] ?? "",
    path: r.worktree.path,
  }));

  const width = (pick: (c: (typeof cells)[number]) => string, header: string) =>
    Math.max(header.length, ...cells.map((c) => pick(c).length));

  const wBranch = width((c) => c.branch, "BRANCH");
  const wVerdict = width((c) => c.verdict, "VERDICT");
  const wSize = width((c) => c.size, "RECLAIM");

  const lines = [
    `${"BRANCH".padEnd(wBranch)}  ${"VERDICT".padEnd(wVerdict)}  ${"RECLAIM".padStart(wSize)}  REASON`,
  ];
  for (const c of cells) {
    lines.push(
      `${c.branch.padEnd(wBranch)}  ${c.verdict.padEnd(wVerdict)}  ${c.size.padStart(wSize)}  ${c.reason}`,
    );
  }

  const total = sorted.reduce((sum, r) => sum + reclaimableBytes(r), 0);
  const safeCount = sorted.filter((r) => r.verdict.safety === "safe").length;
  lines.push("");
  lines.push(
    `${sorted.length} worktrees · ${safeCount} safe · ${formatBytes(total)} reclaimable`,
  );

  return lines.join("\n");
}

export function renderJson(rows: Row[]): string {
  const sorted = [...rows].sort(byReclaimableDesc);
  const payload = {
    worktrees: sorted.map((r) => ({
      path: r.worktree.path,
      branch: r.worktree.branch,
      repoRoot: r.worktree.repoRoot,
      safety: r.verdict.safety,
      reasons: r.verdict.reasons,
      totalBytes: r.sizes.total,
      artifacts: r.sizes.artifacts,
      reclaimableBytes: reclaimableBytes(r),
    })),
    totals: {
      worktrees: sorted.length,
      safe: sorted.filter((r) => r.verdict.safety === "safe").length,
      reclaimableBytes: sorted.reduce((sum, r) => sum + reclaimableBytes(r), 0),
    },
  };
  return JSON.stringify(payload, null, 2);
}
