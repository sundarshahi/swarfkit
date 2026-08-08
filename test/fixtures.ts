import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../src/git";

export type WorktreeOpts = {
  name: string;
  /** How the branch relates to trunk. */
  merge?: "none" | "squash" | "ff";
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
  await git(cwd, [
    ...AUTHOR,
    "-c", `author.date=${when}`,
    "-c", `committer.date=${when}`,
    "commit", "-q", "--allow-empty", "-m", message,
  ]);
}

export async function makeRepo(): Promise<Fixture> {
  const base = await mkdtemp(join(tmpdir(), "swarf-fx-"));
  const remote = join(base, "remote.git");
  const root = join(base, "repo");

  await git(base, ["init", "--bare", "-q", "-b", "trunk", remote]);
  await git(base, ["clone", "-q", remote, root]);
  await git(root, [...AUTHOR, "symbolic-ref", "HEAD", "refs/heads/trunk"]);
  await writeFile(join(root, "README.md"), "# fixture\n");
  await git(root, ["add", "-A"]);
  await commit(root, "initial");
  await git(root, ["push", "-q", "-u", "origin", "trunk"]);
  await git(root, ["remote", "set-head", "origin", "trunk"]);

  const addWorktree = async (opts: WorktreeOpts): Promise<string> => {
    const {
      name,
      merge = "none",
      dirty = false,
      noUpstream = false,
      extraCommit = false,
      ageSeconds = 0,
    } = opts;
    const wtPath = join(base, `wt-${name}`);

    await git(root, ["worktree", "add", "-q", "-b", name, wtPath, "trunk"]);
    await writeFile(join(wtPath, `${name}.txt`), `work for ${name}\n`);
    await git(wtPath, ["add", "-A"]);
    await commit(wtPath, `work on ${name}`, ageSeconds);

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
