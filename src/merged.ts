import { git } from "./git";

/**
 * Is every commit on `branch` already represented in `defaultBranch`?
 *
 * `git cherry <upstream> <head>` prints one line per commit on head:
 *   `- <sha>`  an equivalent patch exists upstream
 *   `+ <sha>`  no equivalent upstream — unshipped work
 *
 * Patch equivalence, unlike ancestry, survives squash and rebase merges. Empty
 * output means the branch has no commits beyond upstream, which is merged.
 *
 * Known limit: a squash merge that was later amended upstream changes the
 * patch id and reads as `+`. That direction blocks a branch that was in fact
 * merged — it costs disk, not work. The opposite error is unacceptable, so any
 * failure or ambiguity returns false.
 */
export async function isMergedEquivalent(
  repoRoot: string,
  defaultBranch: string,
  branch: string,
): Promise<boolean> {
  const res = await git(repoRoot, ["cherry", "-v", defaultBranch, branch]);
  if (res.code !== 0) return false; // unknown branch or bad ref: never assume merged

  const lines = res.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return true;
  return lines.every((line) => line.startsWith("-"));
}
