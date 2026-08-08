import { classify } from "./classify";
import { resolveDefaultBranch } from "./default-branch";
import { findRepos, listWorktrees } from "./discover";
import { measure } from "./measure";
import { reclaimableBytes } from "./render";
import type { Row } from "./types";

/**
 * How many repositories are processed at once. Each repo's turn spawns its
 * own git processes (default-branch resolution, worktree listing) and a full
 * filesystem walk per worktree (see measure.ts) — letting every discovered
 * repo run at once on a root with hundreds of them would thrash disk I/O and
 * the process table harder than scanning them one at a time ever did, so the
 * pool is bounded rather than an unbounded `Promise.all`.
 */
const REPO_CONCURRENCY = 6;

/**
 * Runs `fn` over `items` with at most `limit` calls in flight at once,
 * returning results in the same order as `items` regardless of which one
 * settles first — a fixed-size worker pool, not `Promise.all`.
 */
async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (let i = next++; i < items.length; i = next++) {
      results[i] = await fn(items[i]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Progress events emitted by `scan` as it works; see `ScanOpts.onProgress`. */
export type ScanProgress =
  | { phase: "discovering"; repos: number }
  | { phase: "measuring"; completed: number; total: number; bytes: number };

export type ScanOpts = {
  roots: string[];
  cwd: string;
  minAgeSeconds: number;
  now?: number;
  /**
   * Optional live-progress hook, invoked as discovery and measurement
   * progress. Purely additive: omitting it changes nothing about `scan`'s
   * behavior or return value, so every existing caller keeps working as-is.
   */
  onProgress?: (progress: ScanProgress) => void;
};

/**
 * Full read-only pass: find repos, enumerate worktrees, then classify and
 * measure each. `classify` and `measure` are independent, so they run
 * concurrently per worktree; repositories themselves run concurrently too,
 * bounded by `REPO_CONCURRENCY`.
 *
 * Callers re-run this immediately before any deletion — that re-run, not a
 * stored plan, is what prevents acting on stale state.
 */
export async function scan(opts: ScanOpts): Promise<Row[]> {
  const repos = await findRepos(opts.roots, (repos) =>
    opts.onProgress?.({ phase: "discovering", repos }),
  );

  // `total` grows as each repo's (cheap) worktree listing resolves, ahead of
  // that repo's (expensive) measuring — it only ever grows, so the progress
  // line never appears to go backwards.
  let total = 0;
  let completed = 0;
  let bytes = 0;

  const perRepo = await mapPool(repos, REPO_CONCURRENCY, async (repoRoot) => {
    const defaultBranch = await resolveDefaultBranch(repoRoot);
    const worktrees = await listWorktrees(repoRoot, opts.cwd);
    total += worktrees.length;

    return Promise.all(
      worktrees.map(async (worktree) => {
        const [verdict, sizes] = await Promise.all([
          classify(worktree, {
            defaultBranch,
            minAgeSeconds: opts.minAgeSeconds,
            now: opts.now,
          }),
          measure(worktree.path),
        ]);
        const row = { worktree, verdict, sizes } satisfies Row;
        completed += 1;
        bytes += reclaimableBytes(row);
        opts.onProgress?.({ phase: "measuring", completed, total, bytes });
        return row;
      }),
    );
  });

  // Reassembled in the original per-repo, per-worktree order — mapPool keeps
  // each repo's slot fixed by index, and Promise.all preserves the order of
  // its own array — so output is deterministic no matter which repo or
  // worktree actually finished first.
  return perRepo.flat();
}
