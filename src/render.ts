import { ESC, paint } from "./color";
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

/**
 * Verdict word color, keyed to the same literal words as `MARK`. Color is an
 * enhancement layered on a TTY, never the signal itself — `safe`/`caution`/
 * `blocked` must stay readable with color stripped entirely.
 */
const VERDICT_COLOR: Record<Row["verdict"]["safety"], string> = {
  safe: ESC.green,
  caution: ESC.yellow,
  blocked: ESC.red,
};

/**
 * Longest branch name shown before truncating with a visible ellipsis. One
 * absurd branch name (a bot-generated slug, say) must not stretch the column
 * and misalign every other row's numbers.
 */
const MAX_BRANCH_WIDTH = 40;

function truncateBranch(name: string): string {
  return name.length > MAX_BRANCH_WIDTH ? `${name.slice(0, MAX_BRANCH_WIDTH - 1)}…` : name;
}

export type RenderOptions = {
  /** Emit ANSI color. Only ever true for a TTY stdout with color permitted; never for --json. */
  color?: boolean;
};

/**
 * The one concrete command that would act on what this report found, quoting
 * the exact bytes THAT command would reclaim — same command-specific split
 * `reclaimableBytes` warns callers about, so the number here matches what
 * `clean` or `prune` actually reports afterward, never the generic report
 * figure. Returns null when neither command has anything to do.
 */
export function suggestNextStep(rows: Row[]): string | null {
  const cleanTargets = rows.filter((r) => r.sizes.artifacts.length > 0);
  const cleanBytes = cleanTargets.reduce((sum, r) => sum + artifactBytes(r), 0);
  const cleanCount = cleanTargets.reduce((sum, r) => sum + r.sizes.artifacts.length, 0);

  const pruneTargets = rows.filter((r) => r.verdict.safety === "safe");
  const pruneBytes = pruneTargets.reduce((sum, r) => sum + treeBytes(r), 0);

  if (pruneBytes === 0 && cleanBytes === 0) return null;

  // Whichever command reclaims more is the more useful suggestion; prune wins
  // ties since it also removes the worktree, not just its build output.
  if (pruneBytes >= cleanBytes) {
    const noun = pruneTargets.length === 1 ? "worktree" : "worktrees";
    return `Run \`swarf prune\` to reclaim ${formatBytes(pruneBytes)} across ${pruneTargets.length} ${noun}.`;
  }
  const noun = cleanCount === 1 ? "build directory" : "build directories";
  return `Run \`swarf clean\` to reclaim ${formatBytes(cleanBytes)} across ${cleanCount} ${noun}.`;
}

export function renderTable(rows: Row[], opts: RenderOptions = {}): string {
  const color = opts.color ?? false;

  // Case 1: nothing was found under the given roots at all — scan() only
  // ever returns zero rows when findRepos() found zero repositories, since
  // every discovered repo contributes at least its main worktree.
  if (rows.length === 0) {
    return [
      "No worktrees found — no git repository was located under the given roots.",
      "Check --root, or run swarf from inside a repository.",
    ].join("\n");
  }

  // Case 2: repositories exist, but none has a linked worktree — the main
  // checkout is the only row. Nothing for this tool to do; not an error.
  const linked = rows.filter((r) => !r.worktree.isMain);
  if (linked.length === 0) {
    const noun = rows.length === 1 ? "repository" : "repositories";
    return [
      `No linked worktrees to report — found ${rows.length} ${noun} with nothing but the main checkout.`,
      "Nothing for swarf to do here.",
    ].join("\n");
  }

  const sorted = [...rows].sort(byReclaimableDesc);
  const total = sorted.reduce((sum, r) => sum + reclaimableBytes(r), 0);

  // Case 3: worktrees exist, but none of them are reclaimable.
  if (total === 0) {
    return `${sorted.length} worktrees found, but nothing reclaimable — no build artifacts and nothing prunable.`;
  }

  const cells = sorted.map((r) => ({
    branch: truncateBranch(r.worktree.branch ?? "(detached)"),
    safety: r.verdict.safety,
    verdict: MARK[r.verdict.safety],
    size: formatBytes(reclaimableBytes(r)),
    reason: r.verdict.reasons[0] ?? "",
  }));

  const width = (pick: (c: (typeof cells)[number]) => string, header: string) =>
    Math.max(header.length, ...cells.map((c) => pick(c).length));

  const wBranch = width((c) => c.branch, "BRANCH");
  const wVerdict = width((c) => c.verdict, "VERDICT");
  const wSize = width((c) => c.size, "RECLAIM");

  // Padding is always computed on plain text above, then the fully-padded
  // field is wrapped in color below. Coloring first and padding after would
  // count invisible escape bytes as visible characters and misalign every
  // column that follows.
  const header = [
    paint(ESC.dim, "BRANCH".padEnd(wBranch), color),
    paint(ESC.dim, "VERDICT".padEnd(wVerdict), color),
    paint(ESC.dim, "RECLAIM".padStart(wSize), color),
    paint(ESC.dim, "REASON", color),
  ].join("  ");

  const lines = [header];
  for (const c of cells) {
    lines.push(
      [
        // Branch and reclaim size are the primary data: normal intensity.
        c.branch.padEnd(wBranch),
        paint(VERDICT_COLOR[c.safety], c.verdict.padEnd(wVerdict), color),
        c.size.padStart(wSize),
        // The reason is secondary — why, not what — so it's dimmed rather
        // than making the primary columns bold to compete with it. Safe rows
        // have no reason at all; skip painting so an empty cell doesn't carry
        // a pointless empty escape sequence.
        c.reason ? paint(ESC.dim, c.reason, color) : "",
      ].join("  "),
    );
  }

  const safeCount = sorted.filter((r) => r.verdict.safety === "safe").length;
  lines.push("");
  lines.push(`${sorted.length} worktrees · ${safeCount} safe · ${formatBytes(total)} reclaimable`);

  const suggestion = suggestNextStep(rows);
  if (suggestion) {
    lines.push("");
    lines.push(suggestion);
  }

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
