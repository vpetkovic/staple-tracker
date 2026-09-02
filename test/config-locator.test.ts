/**
 * A3 (STA-33) — the platform bootstrap locator.
 *
 * STA-24 plan §2 gives a three-row table and a v1 schema. The locator lives
 * OUTSIDE the movable home, so it is the one file that survives a home move and
 * the one file an installer (A8) must write correctly. `bootstrapLocatorPath`
 * takes an explicit platform/env/home so all three rows are proven on one OS.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  LOCATOR_SCHEMA_VERSION,
  bootstrapLocatorPath,
  readBootstrapLocator,
  writeBootstrapLocator,
} from "../src/config/locator.js";
import { StapleError } from "../src/core/types.js";
import { removeDir, tempDir } from "./fixtures/characterize-support.js";

let scratch: string;

beforeEach(() => {
  scratch = tempDir("cfg-locator");
});

afterEach(() => {
  removeDir(scratch);
});

describe("locator path per platform (plan §2 table)", () => {
  it("macOS: ~/Library/Application Support/Staple/bootstrap.json", () => {
    expect(bootstrapLocatorPath({ platform: "darwin", home: "/Users/dev", env: {} })).toBe(
      "/Users/dev/Library/Application Support/Staple/bootstrap.json",
    );
  });

  it("Linux: $XDG_CONFIG_HOME/staple/bootstrap.json when XDG_CONFIG_HOME is set", () => {
    expect(
      bootstrapLocatorPath({
        platform: "linux",
        home: "/home/dev",
        env: { XDG_CONFIG_HOME: "/home/dev/.xdg" },
      }),
    ).toBe("/home/dev/.xdg/staple/bootstrap.json");
  });

  it("Linux: ~/.config/staple/bootstrap.json when XDG_CONFIG_HOME is absent", () => {
    expect(bootstrapLocatorPath({ platform: "linux", home: "/home/dev", env: {} })).toBe(
      "/home/dev/.config/staple/bootstrap.json",
    );
  });

  it("Linux: an empty XDG_CONFIG_HOME is treated as unset, not as the root", () => {
    expect(
      bootstrapLocatorPath({ platform: "linux", home: "/home/dev", env: { XDG_CONFIG_HOME: "" } }),
    ).toBe("/home/dev/.config/staple/bootstrap.json");
  });

  it("Windows: %APPDATA%\\Staple\\bootstrap.json, with Windows separators", () => {
    expect(
      bootstrapLocatorPath({
        platform: "win32",
        home: "C:\\Users\\dev",
        env: { APPDATA: "C:\\Users\\dev\\AppData\\Roaming" },
      }),
    ).toBe("C:\\Users\\dev\\AppData\\Roaming\\Staple\\bootstrap.json");
  });

  it("Windows: falls back under the home when APPDATA is missing", () => {
    expect(bootstrapLocatorPath({ platform: "win32", home: "C:\\Users\\dev", env: {} })).toBe(
      "C:\\Users\\dev\\AppData\\Roaming\\Staple\\bootstrap.json",
    );
  });
});

describe("reading the locator", () => {
  const at = () => join(scratch, "bootstrap.json");

  it("an absent locator reads as null — absence is not an error", () => {
    expect(readBootstrapLocator(at())).toBeNull();
  });

  it("reads a valid v1 locator", () => {
    writeFileSync(at(), JSON.stringify({ schemaVersion: 1, home: join(scratch, "home") }));
    expect(readBootstrapLocator(at())).toEqual({
      schemaVersion: 1,
      home: join(scratch, "home"),
    });
  });

  it("rejects a relative home", () => {
    writeFileSync(at(), JSON.stringify({ schemaVersion: 1, home: "relative/home" }));
    expect(() => readBootstrapLocator(at())).toThrow(/absolute/i);
  });

  it("rejects a home that resolves to a filesystem root", () => {
    writeFileSync(at(), JSON.stringify({ schemaVersion: 1, home: "/" }));
    expect(() => readBootstrapLocator(at())).toThrow(/root/i);
  });

  it("rejects an unknown schema version rather than guessing", () => {
    writeFileSync(at(), JSON.stringify({ schemaVersion: 99, home: join(scratch, "home") }));
    expect(() => readBootstrapLocator(at())).toThrow(/schemaVersion/);
  });

  it("rejects malformed JSON, naming the file", () => {
    writeFileSync(at(), "{not json");
    const error = (() => {
      try {
        readBootstrapLocator(at());
        return null;
      } catch (caught) {
        return caught as StapleError;
      }
    })();
    expect(error).toBeInstanceOf(StapleError);
    expect(error?.code).toBe("validation");
    expect(error?.message).toContain(at());
  });

  it("rejects a missing home key", () => {
    writeFileSync(at(), JSON.stringify({ schemaVersion: 1 }));
    expect(() => readBootstrapLocator(at())).toThrow(StapleError);
  });
});

describe("writing the locator", () => {
  const at = () => join(scratch, "nested", "bootstrap.json");

  it("creates the directory and round-trips", () => {
    const home = join(scratch, "home");
    writeBootstrapLocator(at(), home);
    expect(readBootstrapLocator(at())).toEqual({ schemaVersion: LOCATOR_SCHEMA_VERSION, home });
  });

  it("writes exactly the v1 schema — no extra keys", () => {
    writeBootstrapLocator(at(), join(scratch, "home"));
    expect(Object.keys(JSON.parse(readFileSync(at(), "utf8")) as object).sort()).toEqual([
      "home",
      "schemaVersion",
    ]);
  });

  it.runIf(process.platform !== "win32")("creates the directory 0700 and the file 0600", () => {
    writeBootstrapLocator(at(), join(scratch, "home"));
    expect((statSync(join(scratch, "nested")).mode & 0o777).toString(8)).toBe("700");
    expect((statSync(at()).mode & 0o777).toString(8)).toBe("600");
  });

  it.runIf(process.platform !== "win32")("re-tightens the file mode when rewriting", () => {
    writeBootstrapLocator(at(), join(scratch, "one"));
    chmodSync(at(), 0o644);
    writeBootstrapLocator(at(), join(scratch, "two"));
    expect((statSync(at()).mode & 0o777).toString(8)).toBe("600");
  });

  it("refuses to write a relative home", () => {
    expect(() => writeBootstrapLocator(at(), "relative")).toThrow(/absolute/i);
  });

  it("refuses to write a filesystem root as the home", () => {
    expect(() => writeBootstrapLocator(at(), "/")).toThrow(/root/i);
  });

  it("leaves no temporary file behind", () => {
    mkdirSync(join(scratch, "nested"), { recursive: true });
    writeBootstrapLocator(at(), join(scratch, "home"));
    expect(readdirSync(join(scratch, "nested"))).toEqual(["bootstrap.json"]);
  });
});
