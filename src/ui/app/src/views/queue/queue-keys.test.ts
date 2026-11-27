/**
 * The keys on a row nested under a plan entry (queue-keys.ts). The browser half — that Alt and
 * an arrow there leaves the plan alone — is test/ui-queue-reliability.test.ts.
 */
import { describe, expect, it } from "vitest";
import { nestedRowKey } from "./queue-keys";

const key = (k: string, mods: Partial<{ altKey: boolean; ctrlKey: boolean; metaKey: boolean }> = {}) => ({
  key: k,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  ...mods,
});

describe("a key on a nested queue row", () => {
  it("moves focus on a plain arrow", () => {
    expect(nestedRowKey(key("ArrowDown"), true)).toBe("next");
    expect(nestedRowKey(key("ArrowUp"), true)).toBe("previous");
  });

  it("stops Alt and an arrow at the row, so the plan entry above does not move", () => {
    expect(nestedRowKey(key("ArrowDown", { altKey: true }), true)).toBe("swallow");
    expect(nestedRowKey(key("ArrowUp", { altKey: true }), false)).toBe("swallow");
  });

  it("leaves Ctrl or Cmd and an arrow to the browser", () => {
    expect(nestedRowKey(key("ArrowDown", { ctrlKey: true }), true)).toBeNull();
    expect(nestedRowKey(key("ArrowUp", { metaKey: true }), true)).toBeNull();
  });

  it("opens on Enter or Space on the row itself, and leaves them to a control inside it", () => {
    expect(nestedRowKey(key("Enter"), true)).toBe("open");
    expect(nestedRowKey(key(" "), true)).toBe("open");
    expect(nestedRowKey(key("Enter"), false)).toBeNull();
    expect(nestedRowKey(key("Tab"), true)).toBeNull();
  });
});
