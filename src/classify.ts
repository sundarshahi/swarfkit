import { gitOut } from "./git";
import { isMergedEquivalent } from "./merged";
import type { Verdict, Worktree } from "./types";

export const DEFAULT_MIN_AGE_SECONDS = 7 * 24 * 60 * 60;

export type ClassifyOpts = {
  /** Resolved default branch, or null when it could not be determined. */
  defaultBranch: string | null;
  minAgeSeconds: number;
  /** Epoch milliseconds; injectable so age checks are deterministic in tests. */
  now?: number;
};

/**
 * Evaluate the five safety rules. All five must pass for `safe`. Rules 1-4
 * passing with only the age rule failing yields `caution`. Anything that
 * cannot be evaluated yields `blocked` — never `safe` by default.
 */
export async function classify(wt: Worktree, opts: ClassifyOpts): Promise<Verdict> {
  const reasons: string[] = [];
  const now = opts.now ?? Date.now();

  // Rule 1 — never the main or current worktree.
  if (wt.isMain) reasons.push("is the main worktree");
  if (wt.isCurrent) reasons.push("is the current worktree");

  // `git worktree remove` refuses a locked worktree, so calling one `safe`
  // buys nothing but a failed prune and exit 1.
  if (wt.locked) reasons.push("is locked (git worktree unlock to release it)");

  // A detached worktree has no branch, so rules 3 and 4 cannot be evaluated.
  if (wt.branch === null) {
    reasons.push("HEAD is detached");
    return { safety: "blocked", reasons };
  }

  // Rule 2 — no uncommitted changes.
  const status = await gitOut(wt.path, ["status", "--porcelain"]);
  if (status === null) reasons.push("could not read working tree status");
  else if (status !== "") reasons.push("has uncommitted changes");

  // Rule 3 — an upstream exists and nothing is unpushed.
  const upstream = await gitOut(wt.path, [
    "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}",
  ]);
  if (upstream === null) {
    reasons.push("has no upstream tracking branch");
  } else {
    const unpushed = await gitOut(wt.path, ["log", "--oneline", "@{u}..HEAD"]);
    if (unpushed === null) reasons.push("could not compare against upstream");
    else if (unpushed !== "") reasons.push("has unpushed commits");
  }

  // Rule 4 — merged into the default branch, squash merges included.
  if (opts.defaultBranch === null) {
    reasons.push("could not resolve the default branch");
  } else if (wt.branch === opts.defaultBranch) {
    reasons.push("is the default branch");
  } else {
    const merged = await isMergedEquivalent(wt.repoRoot, opts.defaultBranch, wt.branch);
    if (!merged) reasons.push(`not merged into ${opts.defaultBranch}`);
  }

  // Rule 5 — old enough. Evaluated last so its verdict can be softened to
  // `caution` only when it is the sole failure.
  const committedAt = await gitOut(wt.path, ["log", "-1", "--format=%ct", "HEAD"]);
  const epoch = committedAt ? Number.parseInt(committedAt, 10) : Number.NaN;
  if (!Number.isFinite(epoch)) {
    reasons.push("could not read the last commit date");
    return { safety: "blocked", reasons };
  }

  const ageSeconds = Math.floor(now / 1000) - epoch;
  const tooYoung = ageSeconds < opts.minAgeSeconds;

  if (reasons.length > 0) return { safety: "blocked", reasons };
  if (tooYoung) {
    const days = Math.round(opts.minAgeSeconds / 86_400);
    return { safety: "caution", reasons: [`younger than ${days}d`] };
  }
  return { safety: "safe", reasons: [] };
}
