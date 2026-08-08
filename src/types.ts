/** A single git worktree as reported by `git worktree list --porcelain`. */
export type Worktree = {
  path: string;
  /** Short branch name, or null when HEAD is detached. */
  branch: string | null;
  head: string;
  repoRoot: string;
  isMain: boolean;
  isCurrent: boolean;
  /**
   * `git worktree lock` was used on it. `git worktree remove` refuses a locked
   * worktree outright, so reporting one as `safe` guarantees a failed prune
   * (exit 1). Classified `blocked` instead.
   */
  locked: boolean;
};

export type Safety = "safe" | "caution" | "blocked";

export type Verdict = {
  safety: Safety;
  /** Always non-empty when safety !== "safe". */
  reasons: string[];
};

export type ArtifactDir = { path: string; bytes: number };

export type Sizes = {
  /** Total bytes under the worktree. -1 when unknown (permission denied). */
  total: number;
  artifacts: ArtifactDir[];
};

/** One line of the report. */
export type Row = {
  worktree: Worktree;
  verdict: Verdict;
  sizes: Sizes;
};
