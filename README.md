# swarfkit

Find and delete the disk space left behind by old git worktrees.

If you use git worktrees a lot — especially with AI coding agents, which tend to
make one per task — you end up with a lot of them. Each worktree is a full copy
of your project. Each gets its own `node_modules` and its own build output.
Nothing deletes any of it when the branch is merged.

It adds up. On one machine: 43 GB of build files across 77 worktrees, plus
31 GB of old Docker cache and images. About 78 GB in total.

`swarf` shows you what is there, tells you what is safe to delete, and asks
before deleting anything.

## Install

Run it without installing:

```bash
npx swarfkit --root ~/dev
```

Or install it:

```bash
npm install -g swarfkit
swarf --root ~/dev
```

You need Node 22 or newer and `git` on your PATH. That is all. Node 22 is what
it is built and tested on, and what `engines.node` requires.

## Usage

Running `swarf` on its own only prints a report. It never deletes anything, no
matter what flags you give it. To delete, you have to type a second word:

| Command | What it deletes |
| --- | --- |
| `swarf` | nothing |
| `swarf clean` | build folders inside worktrees: `node_modules`, `.next`, `dist`, `build`, `.turbo` |
| `swarf prune` | whole worktrees, but only ones it judges safe |

`clean` is the safer of the two. Build folders can always be rebuilt, so it
will remove them even from a worktree you are still working on.

`prune` deletes the worktree itself, so it is much more careful. See the rules
below.

Both commands show you the report, ask you to confirm, and then check
everything again before deleting. If a worktree changed while you were reading
the prompt, it gets re-checked and may be skipped.

### Example

```
$ swarf --root ~/dev

BRANCH               VERDICT  RECLAIM  REASON
add-billing          safe      1.2 GB
fix-login            safe    847.0 MB
redesign-dashboard   caution 612.0 MB  younger than 7d
wip-search           blocked 498.0 MB  has uncommitted changes
main                 blocked   2.1 GB  is the main worktree

5 worktrees · 2 safe · 5.2 GB reclaimable
```

## When is a worktree safe to delete?

All five of these must be true. If any one fails, `swarf` will not delete it.

1. **It is not your main worktree, not the one you are currently in, and not
   locked.**
2. **It has no uncommitted changes.**
3. **Everything is pushed.** It must have an upstream branch, and nothing on it
   that has not been pushed.
4. **Its branch is already merged** into the default branch. This includes
   squash merges.
5. **It is old enough** — the last commit is older than `--min-age`, which
   defaults to 7 days.

If the only rule that fails is the age rule, the verdict is `caution` instead
of `blocked`. Those are skipped by default. Use `--include-caution` to delete
them too. That flag only affects the age rule — a worktree that is dirty,
unpushed, or unmerged stays blocked either way.

If `swarf` cannot check a rule — say it cannot work out your default branch —
it marks the worktree `blocked`. When it is unsure, it keeps your files.

### Why squash merges matter

The obvious way to check if a branch is merged is `git branch --merged`. It
does not work here.

`git branch --merged` checks whether your branch's commits are part of the
history of the main branch. A squash merge does not keep those commits — it
combines everything into one new commit. So after a squash merge, your branch
looks unmerged even though all of its work has shipped.

Most git hosting platforms use squash merge by default. So this method would
mark almost every merged branch as unmerged, and `swarf` would never delete
anything.

Instead `swarf` uses `git cherry`, which compares the actual changes rather
than the commit IDs. The same change under a different commit ID still counts
as merged. This works with rebase merges and with single-commit squash merges.

`git cherry` compares one commit at a time, though, and a squash merge of a
three-commit branch produces one upstream commit that matches none of the
three. So when `git cherry` says no, `swarf` asks a second question: it builds
the commit the squash *would* have made — the branch's own tree, on top of the
merge base — and compares that single commit instead. That is what catches a
normal multi-commit pull request.

The second check has to prove the branch shipped, not just fail to disprove it:
it accepts exactly one answer, "this patch is already upstream". Anything else
— including a branch that was squash-merged and then had another commit added —
leaves the worktree alone.

(That check asks git to write one small commit object into your repository. It
is unreferenced and unreachable, so `git gc` cleans it up like any other
dangling object.)

## Why not just use `git worktree prune`?

`git worktree prune` does something different. It only removes the leftover
*record* of a worktree, and only after you have already deleted the folder
yourself. It does not check whether your work is merged, does not measure
anything, and does not free any disk space on its own.

`swarf` does the part that actually frees space.

## Options

```
swarf — reclaim the disk space left behind by agent-driven development

Usage:
  swarf [--root <dir>]...            report only; never deletes
  swarf clean [--root <dir>]...      delete build artifacts inside worktrees
  swarf prune [--root <dir>]...      remove merged, clean, pushed worktrees

Options:
  --root <dir>        scan this directory (repeatable; defaults to the current repo)
  --json              machine-readable output (for clean/prune: what was deleted)
  --min-age <dur>     age rule for prune, e.g. 7d, 12h, 2w (default 7d)
  --include-caution   also offer worktrees younger than --min-age
  --yes               skip the confirmation prompt
  -h, --help          show this help

Exit codes: 0 success · 1 a deletion failed · 2 usage error or git not found
```

Use `--json` if you want to script it. It works for all three commands: on
`clean` and `prune` it replaces the table with a single object listing what was
deleted, what failed, and how many bytes came back. Use `--yes` to skip the
prompt in CI.

## Exit codes

- `0` — worked
- `1` — something could not be deleted
- `2` — bad arguments, or `git` was not found

## License

MIT
