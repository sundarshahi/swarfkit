import { classify } from "./classify";
import { resolveDefaultBranch } from "./default-branch";
import { findRepos, listWorktrees } from "./discover";
import { measure } from "./measure";
import type { Row } from "./types";

export type ScanOpts = {
  roots: string[];
  cwd: string;
  minAgeSeconds: number;
  now?: number;
};

/**
 * Full read-only pass: find repos, enumerate worktrees, then classify and
 * measure each. `classify` and `measure` are independent, so they run
 * concurrently per worktree.
 *
 * Callers re-run this immediately before any deletion — that re-run, not a
 * stored plan, is what prevents acting on stale state.
 */
export async function scan(opts: ScanOpts): Promise<Row[]> {
  const repos = await findRepos(opts.roots);
  const rows: Row[] = [];

  for (const repoRoot of repos) {
    const defaultBranch = await resolveDefaultBranch(repoRoot);
    const worktrees = await listWorktrees(repoRoot, opts.cwd);

    const built = await Promise.all(
      worktrees.map(async (worktree) => {
        const [verdict, sizes] = await Promise.all([
          classify(worktree, {
            defaultBranch,
            minAgeSeconds: opts.minAgeSeconds,
            now: opts.now,
          }),
          measure(worktree.path),
        ]);
        return { worktree, verdict, sizes } satisfies Row;
      }),
    );

    rows.push(...built);
  }

  return rows;
}
