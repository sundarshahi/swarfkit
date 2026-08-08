import { describe, expect, test } from "bun:test";
import { ESC, paint, shouldColor } from "../src/color";

describe("shouldColor", () => {
  test("follows the TTY when no env override is present", () => {
    expect(shouldColor({}, true)).toBe(true);
    expect(shouldColor({}, false)).toBe(false);
  });

  test("NO_COLOR (any value, even empty string) always wins", () => {
    expect(shouldColor({ NO_COLOR: "1" }, true)).toBe(false);
    expect(shouldColor({ NO_COLOR: "" }, true)).toBe(false);
    expect(shouldColor({ NO_COLOR: "0" }, true)).toBe(false); // presence, not truthiness
    expect(shouldColor({ NO_COLOR: "1", FORCE_COLOR: "1" }, true)).toBe(false);
  });

  test("FORCE_COLOR forces on, even without a TTY or with TERM=dumb", () => {
    expect(shouldColor({ FORCE_COLOR: "1" }, false)).toBe(true);
    expect(shouldColor({ FORCE_COLOR: "1", TERM: "dumb" }, false)).toBe(true);
  });

  test("TERM=dumb forces off absent an explicit override", () => {
    expect(shouldColor({ TERM: "dumb" }, true)).toBe(false);
  });
});

describe("paint", () => {
  test("wraps text in the code and a trailing reset when enabled", () => {
    expect(paint(ESC.dim, "x", true)).toBe(`${ESC.dim}x${ESC.reset}`);
  });

  test("returns the text unchanged when disabled", () => {
    expect(paint(ESC.dim, "x", false)).toBe("x");
  });
});
