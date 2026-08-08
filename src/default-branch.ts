import { gitOut } from "./git";

const FALLBACKS = ["main", "master"] as const;

/**
 * Resolve a repository's default branch.
 *
 * `origin/HEAD` is authoritative when present — real repositories do not all
 * use `main`. Only when that symbolic ref is missing do we try conventional
 * names, and only if they actually exist. Returns null when nothing resolves;
 * callers must treat that as `blocked`, never as a licence to guess.
 */
export async function resolveDefaultBranch(repoRoot: string): Promise<string | null> {
  const head = await gitOut(repoRoot, [
    "symbolic-ref", "--quiet", "refs/remotes/origin/HEAD",
  ]);
  if (head) {
    const name = head.replace(/^refs\/remotes\/origin\//, "");
    if (name) return name;
  }

  for (const candidate of FALLBACKS) {
    const exists = await gitOut(repoRoot, [
      "rev-parse", "--verify", "--quiet", `refs/heads/${candidate}`,
    ]);
    if (exists) return candidate;
  }

  return null;
}
