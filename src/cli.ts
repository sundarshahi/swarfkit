import { DEFAULT_MIN_AGE_SECONDS } from "./classify";
import { gitOut, GitMissingError } from "./git";
import { cleanArtifacts, pruneWorktrees, type ReclaimResult } from "./reclaim";
import { artifactBytes, formatBytes, renderJson, renderTable, treeBytes } from "./render";
import { scan } from "./scan";
import type { Row } from "./types";

export type Command = "report" | "clean" | "prune";

export type ParsedArgs = {
  command: Command;
  roots: string[];
  json: boolean;
  yes: boolean;
  includeCaution: boolean;
  minAgeSeconds: number;
  /** Set when -h/--help was requested; run() prints help and exits 0. */
  help: boolean;
};

export type ParseError = { error: string };

export type Io = {
  cwd: string;
  out(s: string): void;
  err(s: string): void;
  confirm(question: string): Promise<boolean>;
  /** Emit ANSI color in report output. Omit or set false for plain output. */
  color?: boolean;
  /**
   * TTY-only progress indicator on stderr. Call with a label to show/update
   * it, `null` to clear it. Omit entirely when stderr is not a TTY — the
   * scan must stay silent rather than spam a log file.
   */
  progress?(s: string | null): void;
};

/** A scan taking this long or more gets a progress line; see `withProgress`. */
export const PROGRESS_DELAY_MS = 400;

/**
 * Runs `work`, and if it hasn't settled within `delayMs`, shows `label` via
 * `io.progress` until it does. A no-op when `io.progress` is absent (stderr
 * isn't a TTY) — printing nothing there is the correct behavior, not a
 * missing feature. No spinner, no animation: one line, shown once, cleared
 * once.
 */
export async function withProgress<T>(
  io: Io,
  work: Promise<T>,
  label = "scanning…",
  delayMs = PROGRESS_DELAY_MS,
): Promise<T> {
  if (!io.progress) return work;
  let shown = false;
  const timer = setTimeout(() => {
    shown = true;
    io.progress?.(label);
  }, delayMs);
  try {
    return await work;
  } finally {
    clearTimeout(timer);
    if (shown) io.progress?.(null);
  }
}

const HELP = `swarf — reclaim the disk space left behind by agent-driven development

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

Exit codes: 0 success · 1 a deletion failed · 2 usage error or git not found`;

const UNIT_SECONDS: Record<string, number> = { h: 3600, d: 86_400, w: 604_800 };

export function parseDuration(input: string): number | null {
  const match = /^(\d+)([hdw])$/.exec(input);
  if (!match) return null;
  const value = Number.parseInt(match[1]!, 10);
  const unit = UNIT_SECONDS[match[2]!];
  if (!Number.isFinite(value) || value <= 0 || unit === undefined) return null;
  return value * unit;
}

export function parseArgs(argv: string[]): ParsedArgs | ParseError {
  const args: ParsedArgs = {
    command: "report",
    roots: [],
    json: false,
    yes: false,
    includeCaution: false,
    minAgeSeconds: DEFAULT_MIN_AGE_SECONDS,
    help: false,
  };

  let index = 0;
  const first = argv[0];
  if (first === "clean" || first === "prune") {
    args.command = first;
    index = 1;
  }

  for (; index < argv.length; index++) {
    const arg = argv[index]!;
    switch (arg) {
      case "--root": {
        const value = argv[++index];
        if (!value) return { error: "--root requires a directory" };
        args.roots.push(value);
        break;
      }
      case "--min-age": {
        const value = argv[++index];
        if (!value) return { error: "--min-age requires a duration, e.g. 7d" };
        const seconds = parseDuration(value);
        if (seconds === null) return { error: `unrecognised duration: ${value}` };
        args.minAgeSeconds = seconds;
        break;
      }
      case "--json": args.json = true; break;
      case "--include-caution": args.includeCaution = true; break;
      case "--yes": args.yes = true; break;
      case "-h":
      case "--help":
        // Explicitly-requested help is not a usage error: short-circuit here
        // rather than routing through the error channel, so run() can print
        // it to stdout and exit 0 instead of stderr/exit 2.
        return { ...args, help: true };
      default: return { error: `unknown option: ${arg}` };
    }
  }

  // The bare command must be incapable of deleting, so flags that only make
  // sense for a deletion are rejected rather than silently ignored.
  if (args.command === "report" && (args.yes || args.includeCaution)) {
    return { error: "--yes and --include-caution require the clean or prune command" };
  }

  return args;
}

async function resolveRoots(args: ParsedArgs, io: Io): Promise<string[] | null> {
  if (args.roots.length > 0) return args.roots;
  const top = await gitOut(io.cwd, ["rev-parse", "--show-toplevel"]);
  if (top) return [top];
  return null;
}

function selectForPrune(rows: Row[], includeCaution: boolean): Row[] {
  return rows.filter(
    (r) => r.verdict.safety === "safe" || (includeCaution && r.verdict.safety === "caution"),
  );
}

export async function run(argv: string[], io: Io): Promise<number> {
  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    io.err(parsed.error);
    return 2;
  }

  if (parsed.help) {
    io.out(HELP);
    return 0;
  }

  try {
    const roots = await resolveRoots(parsed, io);
    if (roots === null) {
      io.err("not inside a git repository — pass --root <dir> to choose what to scan");
      return 2;
    }

    const scanOpts = { roots, cwd: io.cwd, minAgeSeconds: parsed.minAgeSeconds };
    const rows = await withProgress(io, scan(scanOpts));

    if (parsed.command === "report") {
      io.out(parsed.json ? renderJson(rows) : renderTable(rows, { color: io.color }));
      return 0;
    }

    // With --json, stdout carries the result object and nothing else, so the
    // human plan table is suppressed rather than silently corrupting it.
    const emitJson = (result: ReclaimResult) =>
      io.out(JSON.stringify({
        command: parsed.command,
        bytes: result.bytes,
        deleted: result.deleted,
        failed: result.failed,
      }, null, 2));
    const NOTHING: ReclaimResult = { deleted: [], failed: [], bytes: 0 };

    // Show what would happen, then confirm, then RE-SCAN before touching disk.
    if (!parsed.json) io.out(renderTable(rows, { color: io.color }));

    const candidates =
      parsed.command === "clean"
        ? rows.filter((r) => r.sizes.artifacts.length > 0)
        : selectForPrune(rows, parsed.includeCaution);

    if (candidates.length === 0) {
      if (parsed.json) {
        emitJson(NOTHING);
        return 0;
      }
      // Case 4: the report had rows, but none of them qualify for THIS verb —
      // distinct from "nothing exists at all" (that's renderTable's job) and
      // distinct between the two verbs, since the fix differs: clean has no
      // build output to remove; prune's candidates got filtered by safety or
      // age.
      io.out(
        parsed.command === "clean"
          ? "\nNo build artifacts found to clean."
          : parsed.includeCaution
            ? "\nNo worktrees currently qualify for pruning."
            : "\nNo worktrees currently qualify for pruning (try --include-caution, or check --min-age).",
      );
      return 0;
    }

    // The figure must describe what THIS command deletes. `clean` removes only
    // the artifact directories even from a safe row; `prune` removes the whole
    // tree even from a caution row. One shared "reclaimable" number was wrong
    // in both directions — measured 26x over for clean, 41x under for prune.
    const [bytes, count, singular, plural] =
      parsed.command === "clean"
        ? [
            candidates.reduce((sum, r) => sum + artifactBytes(r), 0),
            candidates.reduce((sum, r) => sum + r.sizes.artifacts.length, 0),
            "build directory",
            "build directories",
          ]
        : [
            candidates.reduce((sum, r) => sum + treeBytes(r), 0),
            candidates.length,
            "worktree",
            "worktrees",
          ];
    const unit = count === 1 ? singular : plural;
    const question = `\nDelete ${count} ${unit} to reclaim ${formatBytes(bytes)}? [y/N] `;

    if (!parsed.yes && !(await io.confirm(question))) {
      if (parsed.json) emitJson(NOTHING);
      else io.out("Nothing deleted.");
      return 0;
    }

    const fresh = await withProgress(io, scan(scanOpts));
    const targets =
      parsed.command === "clean"
        ? fresh.filter((r) => r.sizes.artifacts.length > 0)
        : selectForPrune(fresh, parsed.includeCaution);

    const result =
      parsed.command === "clean"
        ? await cleanArtifacts(targets)
        : await pruneWorktrees(targets, { includeCaution: parsed.includeCaution });

    if (parsed.json) emitJson(result);
    else {
      // States what actually happened, not what was planned: `result.deleted`
      // reflects the fresh re-scan, which can differ from `count` above if a
      // row's safety changed between the plan and the confirmation.
      const actualUnit = result.deleted.length === 1 ? singular : plural;
      io.out(`Reclaimed ${formatBytes(result.bytes)} from ${result.deleted.length} ${actualUnit}.`);
    }
    // Failures go to stderr either way, so stdout stays parseable under --json.
    for (const failure of result.failed) {
      io.err(`failed: ${failure.path} — ${failure.error}`);
    }
    return result.failed.length > 0 ? 1 : 0;
  } catch (err) {
    if (err instanceof GitMissingError) {
      io.err("git not found on PATH");
      return 2;
    }
    io.err(err instanceof Error ? err.message : String(err));
    return 1;
  }
}
