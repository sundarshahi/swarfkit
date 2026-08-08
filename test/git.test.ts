import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../src/git";

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
});
