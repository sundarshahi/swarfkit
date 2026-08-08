import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../src/git";

export type WorktreeOpts = {
  name: string;
  /** How the branch relates to trunk. */
  merge?: "none" | "squash" | "ff";
  /**
   * How many commits the branch carries before any merge. Defaults to 1.
   * `git cherry` compares patch ids per commit, so a squash of N > 1 commits
   * behaves differently from a squash of exactly one — the single-commit-only
   * fixture is what let that hole ship.
   */
  commits?: number;
  /** Leave an uncommitted change in the worktree. */
  dirty?: boolean;
  /** Create the branch without pushing it to origin. */
  noUpstream?: boolean;
  /** Add a commit after merging, so work exists that trunk does not have. */
  extraCommit?: boolean;
  /** Seconds to subtract from the commit date, to age the branch. */
  ageSeconds?: number;
};

export type Fixture = {
  root: string;
  remote: string;
  cleanup(): Promise<void>;
  addWorktree(opts: WorktreeOpts): Promise<string>;
  /** Write a directory of junk inside a worktree, returning its byte size. */
  addArtifacts(worktreePath: string, dirName: string, bytes: number): Promise<void>;
};

const AUTHOR = [
  "-c", "user.email=test@example.com",
  "-c", "user.name=Test",
  "-c", "commit.gpgsign=false",
];

async function commit(cwd: string, message: string, ageSeconds = 0) {
  const when = new Date(Date.now() - ageSeconds * 1000).toISOString();
  await git(
    cwd,
    [...AUTHOR, "commit", "-q", "--allow-empty", "-m", message],
    { GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when },
  );
}

export async function makeRepo(): Promise<Fixture> {
  const base = await mkdtemp(join(tmpdir(), "swarf-fx-"));
  const remote = join(base, "remote.git");
  const root = join(base, "repo");

  await git(base, ["init", "--bare", "-q", "-b", "trunk", remote]);
  await git(base, ["clone", "-q", remote, root]);
  await git(root, [...AUTHOR, "symbolic-ref", "HEAD", "refs/heads/trunk"]);
  await writeFile(join(root, "README.md"), "# fixture\n");
  // Real repos ignore their build output. Without this, `addArtifacts` leaves
  // untracked files and every worktree it touches reads as dirty — which would
  // quietly make it impossible to test `prune` against a worktree that has
  // artifacts in it.
  await writeFile(
    join(root, ".gitignore"),
    // `logs/` is deliberately NOT one of swarfkit's artifact directories: it
    // gives tests a way to add bulk that counts toward a worktree's total but
    // not toward its artifacts, so the two figures are far enough apart that
    // rounding to one decimal cannot make a wrong one look right.
    "node_modules/\n.next/\ndist/\nbuild/\n.turbo/\nlogs/\n",
  );
  await git(root, ["add", "-A"]);
  await commit(root, "initial");
  await git(root, ["push", "-q", "-u", "origin", "trunk"]);
  await git(root, ["remote", "set-head", "origin", "trunk"]);

  const addWorktree = async (opts: WorktreeOpts): Promise<string> => {
    const {
      name,
      merge = "none",
      commits = 1,
      dirty = false,
      noUpstream = false,
      extraCommit = false,
      ageSeconds = 0,
    } = opts;
    const wtPath = join(base, `wt-${name}`);

    await git(root, ["worktree", "add", "-q", "-b", name, wtPath, "trunk"]);
    for (let i = 1; i <= commits; i++) {
      // The first file keeps the bare `<name>.txt` form other tests assert on.
      const file = i === 1 ? `${name}.txt` : `${name}-${i}.txt`;
      await writeFile(join(wtPath, file), `work ${i} for ${name}\n`);
      await git(wtPath, ["add", "-A"]);
      await commit(wtPath, `work on ${name} (${i}/${commits})`, ageSeconds);
    }

    if (!noUpstream) {
      await git(wtPath, ["push", "-q", "-u", "origin", name]);
    }

    if (merge === "squash") {
      await git(root, ["merge", "--squash", name]);
      await git(root, [...AUTHOR, "commit", "-q", "-m", `squash: ${name}`]);
      await git(root, ["push", "-q", "origin", "trunk"]);
    } else if (merge === "ff") {
      await git(root, ["merge", "-q", "--no-ff", name, "-m", `merge: ${name}`]);
      await git(root, ["push", "-q", "origin", "trunk"]);
    }

    if (extraCommit) {
      await writeFile(join(wtPath, `${name}-extra.txt`), "unshipped\n");
      await git(wtPath, ["add", "-A"]);
      await commit(wtPath, `extra on ${name}`, ageSeconds);
      if (!noUpstream) await git(wtPath, ["push", "-q", "origin", name]);
    }

    if (dirty) {
      await writeFile(join(wtPath, "dirty.txt"), "uncommitted\n");
    }

    return wtPath;
  };

  const addArtifacts = async (worktreePath: string, dirName: string, bytes: number) => {
    const dir = join(worktreePath, dirName);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "blob.bin"), Buffer.alloc(bytes, 1));
  };

  return {
    root,
    remote,
    addWorktree,
    addArtifacts,
    cleanup: () => rm(base, { recursive: true, force: true }),
  };
}
