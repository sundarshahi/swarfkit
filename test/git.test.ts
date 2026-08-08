import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { git, GitMissingError } from "../src/git";

describe("git", () => {
  test("returns stdout and code 0 on success", async () => {
    const dir = await mkdtemp(join(tmpdir(), "swarf-git-"));
    await git(dir, ["init", "-q"]);
    const res = await git(dir, ["rev-parse", "--is-inside-work-tree"]);
    expect(res.code).toBe(0);
    expect(res.stdout.trim()).toBe("true");
  });

  test("returns non-zero code instead of throwing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "swarf-git-"));
    await git(dir, ["init", "-q"]);
    const res = await git(dir, ["rev-parse", "--abbrev-ref", "@{u}"]);
    expect(res.code).not.toBe(0);
    expect(res.stdout.trim()).toBe("");
  });

  test("passes arguments containing spaces without shell interpretation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "swarf git "));
    await git(dir, ["init", "-q"]);
    const res = await git(dir, ["rev-parse", "--show-toplevel"]);
    expect(res.code).toBe(0);
    expect(res.stdout.trim().length).toBeGreaterThan(0);
  });

  test("resolves with a non-zero code instead of throwing when cwd does not exist", async () => {
    const res = await git("/no/such/dir/swarf-missing", ["status"]);
    expect(res.code).not.toBe(0);
  });

  // Bun v1.0.29 resolved the executable using the real OS process environment
  // at spawn time, ignoring the `env` option passed to execFile entirely.
  // Later Bun releases honor a custom PATH for exec resolution in general
  // (verified on 1.3.14: an existing-but-wrong PATH correctly produces
  // ENOENT) — but an *empty string* PATH is still treated as unset rather
  // than "search nothing": `git(dir, args, { PATH: "" })` still silently
  // falls through to a default PATH and finds git (probed directly on
  // 1.3.14, still reproduces). Forcing a genuine "binary missing" still
  // requires a child process whose real environment has no git on PATH.
  test("throws GitMissingError when the git binary itself is absent", async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), "swarf-nogit-"));
    const scriptPath = join(scratchDir, "probe.mjs");
    const gitTsPath = join(import.meta.dir, "..", "src", "git.ts");
    await writeFile(
      scriptPath,
      [
        `import { git, GitMissingError } from ${JSON.stringify(gitTsPath)};`,
        `try {`,
        `  await git(process.cwd(), ["status"]);`,
        `  console.log("NO_THROW");`,
        `} catch (e) {`,
        `  console.log(e instanceof GitMissingError ? "GIT_MISSING_ERROR" : "OTHER:" + e);`,
        `}`,
      ].join("\n"),
    );

    // PATH = only the bun installation directory: enough to exec bun itself,
    // nothing to resolve "git" against.
    const bunDir = dirname(process.execPath);
    const out = execFileSync(process.execPath, [scriptPath], {
      env: { PATH: bunDir },
      encoding: "utf8",
    }).trim();

    expect(out).toBe("GIT_MISSING_ERROR");
  });
});
