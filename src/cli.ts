import { DEFAULT_MIN_AGE_SECONDS } from "./classify";
import { gitOut, GitMissingError } from "./git";
import { cleanArtifacts, pruneWorktrees } from "./reclaim";
import { formatBytes, renderJson, renderTable, reclaimableBytes } from "./render";
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
};

const HELP = `swarf — reclaim the disk space left behind by agent-driven development

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
    const rows = await scan(scanOpts);

    if (parsed.command === "report") {
      io.out(parsed.json ? renderJson(rows) : renderTable(rows));
      return 0;
    }

    // Show what would happen, then confirm, then RE-SCAN before touching disk.
    io.out(renderTable(rows));

    const candidates =
      parsed.command === "clean"
        ? rows.filter((r) => r.sizes.artifacts.length > 0)
        : selectForPrune(rows, parsed.includeCaution);

    if (candidates.length === 0) {
      io.out("\nNothing to reclaim.");
      return 0;
    }

    const bytes = candidates.reduce((sum, r) => sum + reclaimableBytes(r), 0);
    const noun = parsed.command === "clean" ? "artifact directories in" : "worktrees";
    const question = `\nReclaim ${formatBytes(bytes)} from ${candidates.length} ${noun}? [y/N] `;

    if (!parsed.yes && !(await io.confirm(question))) {
      io.out("Nothing deleted.");
      return 0;
    }

    const fresh = await scan(scanOpts);
    const targets =
      parsed.command === "clean"
        ? fresh.filter((r) => r.sizes.artifacts.length > 0)
        : selectForPrune(fresh, parsed.includeCaution);

    const result =
      parsed.command === "clean"
        ? await cleanArtifacts(targets)
        : await pruneWorktrees(targets);

    io.out(`Reclaimed ${formatBytes(result.bytes)} from ${result.deleted.length} paths.`);
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
