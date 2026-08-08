import { git, gitOut } from "./git";

/**
 * Pinned so the probe commit below hashes identically on every run: git's
 * default committer identity and *current timestamp* would mint a brand new
 * object each scan. With these fixed, re-scanning the same branch reuses the
 * same object instead of accumulating one per invocation.
 */
const PROBE_ENV = {
  GIT_AUTHOR_NAME: "swarfkit",
  GIT_AUTHOR_EMAIL: "swarfkit@invalid",
  GIT_COMMITTER_NAME: "swarfkit",
  GIT_COMMITTER_EMAIL: "swarfkit@invalid",
  GIT_AUTHOR_DATE: "@0 +0000",
  GIT_COMMITTER_DATE: "@0 +0000",
};

/**
 * `git cherry` prints one line per commit on head:
 *   `- <sha>`  an equivalent patch exists upstream
 *   `+ <sha>`  no equivalent upstream — unshipped work
 * Empty output means no commits beyond upstream, which is merged.
 */
function allEquivalent(stdout: string): boolean {
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .every((line) => line.startsWith("-"));
}

/**
 * Second chance for a squash merge of MORE THAN ONE commit.
 *
 * `git cherry` matches patch ids per commit, and a squash collapses N commits
 * into a single upstream commit whose patch id matches none of them. Measured:
 * a squash-merged branch reads as merged at 1 commit and unmerged at 2 and 3 —
 * i.e. for every normal multi-commit PR.
 *
 * So synthesise the commit the squash *would* have produced — the branch's own
 * tree, parented on the merge base — and ask `cherry` about that one commit
 * instead. Its patch is exactly the squashed diff, so it matches the real
 * squash commit upstream.
 *
 * The asymmetry does not weaken: this requires positive evidence, exactly one
 * line marked `-`. Empty output (an empty diff), a `+`, a failed merge-base, a
 * failed commit-tree, or any other shape all return false.
 *
 * `git commit-tree` writes one small commit object into the repository. That
 * is acceptable: it is unreferenced and unreachable, so `git gc`/`git prune`
 * collects it exactly like any other dangling object, and PROBE_ENV pins its
 * hash so a given branch contributes one object total rather than one per run.
 */
async function isSquashMerged(
  repoRoot: string,
  upstream: string,
  head: string,
): Promise<boolean> {
  const base = await gitOut(repoRoot, ["merge-base", upstream, head]);
  if (!base) return false;

  const synthetic = await git(
    repoRoot,
    ["commit-tree", `${head}^{tree}`, "-p", base, "-m", "swarfkit squash probe"],
    PROBE_ENV,
  );
  if (synthetic.code !== 0) return false;
  const sha = synthetic.stdout.trim();
  if (!/^[0-9a-f]{7,64}$/.test(sha)) return false;

  const res = await git(repoRoot, ["cherry", upstream, sha]);
  if (res.code !== 0) return false;

  const lines = res.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.length === 1 && lines[0]!.startsWith("-");
}

/**
 * Is every change on `branch` already represented in `defaultBranch`?
 *
 * Patch equivalence, unlike ancestry, survives squash and rebase merges. Any
 * failure or ambiguity returns false — blocking a branch that was in fact
 * merged costs disk; the opposite error costs work, and is unacceptable.
 *
 * Known limit: a squash merge that was later amended upstream, or one taken
 * while the default branch had moved on, changes the patch id and reads as
 * unmerged. That is the safe direction.
 */
export async function isMergedEquivalent(
  repoRoot: string,
  defaultBranch: string,
  branch: string,
): Promise<boolean> {
  // Both refs are FULLY QUALIFIED. Git resolves a bare name as refs/tags/<name>
  // BEFORE refs/heads/<name>, so a tag sharing a branch's name (`git tag v1.2.0`
  // alongside a branch `v1.2.0`) silently shadows the branch: `cherry` then
  // compares the wrong object, returns empty, and an unmerged branch reads as
  // merged. Verified in both positions — a tag can shadow the default branch
  // just as easily. Qualifying costs nothing: `branch` provably comes from a
  // `branch refs/heads/…` porcelain line, and `defaultBranch` from origin/HEAD
  // or a `refs/heads/` existence check.
  const upstream = `refs/heads/${defaultBranch}`;
  const head = `refs/heads/${branch}`;

  const res = await git(repoRoot, ["cherry", "-v", upstream, head]);
  if (res.code !== 0) return false; // unknown branch or bad ref: never assume merged
  if (allEquivalent(res.stdout)) return true;

  return isSquashMerged(repoRoot, upstream, head);
}
