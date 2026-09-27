/**
 * ONE phone/desk breakpoint. Every file that switches shape at it imports it from
 * lib/use-media.ts; a second hard-coded 768px query anywhere in the app is how the shell and
 * the rows end up switching at different widths (the 720-767px band that showed desk rows
 * inside the phone shell).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DESK_MIN_WIDTH, DESK_QUERY, PHONE_QUERY, isDeskWidth } from "./use-media";

const SRC = fileURLToPath(new URL("..", import.meta.url));
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "dist" ? [] : files(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe("the one breakpoint", () => {
  it("is 768px, with the phone below it and the desk from it", () => {
    expect(DESK_MIN_WIDTH).toBe(768);
    expect(DESK_QUERY).toBe("(min-width: 768px)");
    expect(PHONE_QUERY).toBe("(max-width: 767px)");
    expect(isDeskWidth(767)).toBe(false);
    expect(isDeskWidth(768)).toBe(true);
  });

  it("is written nowhere else in the app", () => {
    const offenders = files(SRC).filter((path) => {
      if (path.endsWith(join("lib", "use-media.ts"))) return false;
      return /\((?:min|max)-width:\s*76[78]px\)/.test(readFileSync(path, "utf8"));
    });
    expect(offenders).toEqual([]);
  });
});
