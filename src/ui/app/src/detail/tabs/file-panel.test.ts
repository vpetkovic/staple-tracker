import { describe, expect, it } from "vitest";
import {
  FILE_PANEL_DEFAULT,
  FILE_PANEL_MIN,
  FILE_PANEL_WIDTH_KEY,
  clampFilePanelWidth,
  filePanelDock,
  loadFilePanelWidth,
  saveFilePanelWidth,
} from "./file-panel";

function fakeStorage(seed?: Record<string, string>, fail = false): Storage {
  const map = new Map(Object.entries(seed ?? {}));
  const boom = (): never => {
    throw new Error("SecurityError");
  };
  return {
    get length() {
      return map.size;
    },
    clear: () => (fail ? boom() : map.clear()),
    key: (index: number) => [...map.keys()][index] ?? null,
    getItem: (key: string) => (fail ? boom() : (map.get(key) ?? null)),
    setItem: (key: string, value: string) => (fail ? boom() : map.set(key, value)),
    removeItem: (key: string) => (fail ? boom() : map.delete(key)),
  };
}

describe("file panel dock", () => {
  it("sits against the ticket and leaves the drag the space to its left", () => {
    expect(filePanelDock(704, 1440)).toEqual({ right: 736, available: 696, sheet: false });
  });

  it("is the screen on a phone, with nothing to drag", () => {
    expect(filePanelDock(0, 390)).toEqual({ right: 0, available: 390, sheet: true });
  });

  it("sits on the right when the ticket is already edge to edge", () => {
    expect(filePanelDock(0, 1440)).toEqual({ right: 0, available: 1392, sheet: false });
  });

  it("clamps a drag between a readable minimum and the room beside the ticket", () => {
    expect(clampFilePanelWidth(200, 696)).toBe(FILE_PANEL_MIN);
    expect(clampFilePanelWidth(900, 696)).toBe(696);
    expect(clampFilePanelWidth(FILE_PANEL_DEFAULT, 696)).toBe(FILE_PANEL_DEFAULT);
    expect(clampFilePanelWidth(Number.NaN, 696)).toBe(FILE_PANEL_DEFAULT);
  });

  it("remembers a width, and a browser that refuses storage does not matter", () => {
    const storage = fakeStorage();
    expect(loadFilePanelWidth(storage)).toBe(FILE_PANEL_DEFAULT);
    saveFilePanelWidth(storage, 512.4);
    expect(storage.getItem(FILE_PANEL_WIDTH_KEY)).toBe("512");
    expect(loadFilePanelWidth(storage)).toBe(512);
    expect(loadFilePanelWidth(fakeStorage({ [FILE_PANEL_WIDTH_KEY]: "nope" }))).toBe(FILE_PANEL_DEFAULT);
    expect(loadFilePanelWidth(fakeStorage({}, true))).toBe(FILE_PANEL_DEFAULT);
    expect(() => saveFilePanelWidth(fakeStorage({}, true), 400)).not.toThrow();
    expect(loadFilePanelWidth(undefined)).toBe(FILE_PANEL_DEFAULT);
  });
});
