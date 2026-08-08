# swarfkit

Agent-driven development spins up a git worktree per task, sometimes several
per day. Each one gets its own `node_modules`, its own build output, often its
own Docker layer cache. Nothing removes any of it when the branch merges. Left
alone this accumulates fast: one machine's own worktrees held 43 GB of build
artifacts across 77 worktrees, plus another 31 GB of dead Docker build cache
and images — roughly 78 GB reclaimed once someone went looking.

`swarf` finds this mess, tells you which of it is safe to reclaim, and only
then offers to delete it.

```bash
npx swarfkit --root ~/dev/acme
```

## What it does

The bare `swarf` command never deletes anything, under any flag or
condition. It only prints a report. Deletion requires an explicit verb.

| Command | Deletes |
| --- | --- |
| `swarf` | nothing, ever |
| `swarf clean` | build artifacts inside worktrees — `node_modules`, `.next`, `dist`, `build`, `.turbo` |
| `swarf prune` | worktrees whose branch is merged, clean, pushed, and older than `--min-age` |

Both `clean` and `prune` print the same report first, ask for confirmation
(unless `--yes` is given), then re-scan immediately before touching disk so a
worktree that changed state during the prompt is re-evaluated rather than
deleted on stale information.

## Why not `git worktree prune`

`git worktree prune` only removes a worktree's *registration* — the entry in
`.git/worktrees` — and only once the worktree's directory is already gone. It
never looks at whether the work shipped, never measures anything, and never
reclaims a single byte on its own. Something else still has to notice the
worktree is safe to remove, delete the directory, and only then does
`git worktree prune` have anything to clean up after. `swarf` does the part
that actually frees disk: it measures what each worktree costs and decides
whether the work it holds has already shipped.

## How it decides

A worktree's verdict is `safe` only if all five rules hold. If every rule
holds except the age rule, the verdict is `caution` instead of `blocked` —
young but otherwise provably safe. If any other rule fails, or a rule
couldn't be evaluated at all, the verdict is `blocked` and `swarf` never
touches it.

1. **Not the main or current worktree.** The worktree you're standing in, and
   the repository's primary checkout, are never candidates.
2. **No uncommitted changes.** `git status --porcelain` must be empty.
3. **Pushed.** An upstream must exist, and there must be nothing in
   `HEAD` that isn't already on it.
4. **Merged into the default branch, squash merges included.**
5. **Old enough.** The last commit must be older than `--min-age` (default
   `7d`).

Rule 4 is the one worth explaining. The obvious approach, `git branch
--merged`, tests whether a branch's commits are an *ancestor* of the target
branch. That works for a fast-forward or a regular merge commit, but a squash
merge rewrites the branch's commits into one new commit on the default
branch — the original commits are never an ancestor of anything. Since squash
merging is the default merge strategy on most hosted git platforms, ancestry
-based detection would classify almost every genuinely-merged branch as
unmerged, which is exactly backwards. `swarf` instead uses `git cherry`,
which compares *patch content* rather than commit identity — the same diff
under a different commit hash still matches. That survives squash merges and
most rebase-and-merge workflows.

When a rule can't be evaluated at all — no default branch could be resolved,
`git status` failed, the working tree is detached — the verdict is `blocked`,
never `safe`. `swarf` fails toward keeping disk, not toward losing work.

### `--include-caution`

By default, `prune` only removes `safe` worktrees. Pass `--include-caution`
to also remove `caution` worktrees — those that passed every rule except the
age check. This does not loosen any of the other four rules; a worktree that
is dirty, unpushed, unmerged, or unresolvable is still `blocked` and is never
offered, `--include-caution` or not.

## Options

```
swarf — reclaim the disk space left behind by agent-driven development

Usage:
  swarf [--root <dir>]...            report only; never deletes
  swarf clean [--root <dir>]...      delete build artifacts inside worktrees
  swarf prune [--root <dir>]...      remove merged, clean, pushed worktrees

Options:
  --root <dir>        scan this directory (repeatable; defaults to the current repo)
  --json              machine-readable output
  --min-age <dur>     age rule for prune, e.g. 7d, 12h, 2w (default 7d)
  --include-caution   also offer worktrees younger than --min-age
  --yes               skip the confirmation prompt
  -h, --help          show this help

Exit codes: 0 success · 1 a deletion failed · 2 usage error or git not found
```

## Exit codes

`0` success · `1` a deletion failed · `2` usage error or `git` not found
