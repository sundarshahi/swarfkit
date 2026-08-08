/** A single git worktree as reported by `git worktree list --porcelain`. */
export type Worktree = {
  path: string;
  /** Short branch name, or null when HEAD is detached. */
  branch: string | null;
  head: string;
  repoRoot: string;
  isMain: boolean;
  isCurrent: boolean;
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
