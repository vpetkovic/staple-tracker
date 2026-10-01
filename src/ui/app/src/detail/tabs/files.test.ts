import { describe, expect, it } from "vitest";
import { evidenceLabel, fileGroupId, formatFileSize, groupFiles } from "./files";

describe("file groups", () => {
  it("keeps images, video, pdf and text apart, and sends svg and html to Other", () => {
    expect(fileGroupId("image/png")).toBe("images");
    expect(fileGroupId("image/jpeg")).toBe("images");
    expect(fileGroupId("image/svg+xml")).toBe("other");
    expect(fileGroupId("video/mp4")).toBe("videos");
    expect(fileGroupId("application/pdf")).toBe("pdfs");
    expect(fileGroupId("text/plain")).toBe("text");
    expect(fileGroupId("text/html")).toBe("other");
    expect(fileGroupId("application/octet-stream")).toBe("other");
  });

  it("omits empty groups and keeps the fixed order", () => {
    const groups = groupFiles([
      { mediaType: "application/octet-stream", filename: "blob.bin" },
      { mediaType: "image/png", filename: "b.png" },
      { mediaType: "text/plain", filename: "log.txt" },
      { mediaType: "image/webp", filename: "a.webp" },
    ]);
    expect(groups.map((group) => group.label)).toEqual(["Images", "Text", "Other"]);
    expect(groups[0]!.files.map((file) => file.filename)).toEqual(["b.png", "a.webp"]);
    expect(groups.map((group) => group.files.length)).toEqual([2, 1, 1]);
  });

  it("reads before and after from the caption or the filename", () => {
    expect(evidenceLabel({ filename: "shot.png", caption: "before" })).toBe("before");
    expect(evidenceLabel({ filename: "after.png", caption: null })).toBe("after");
    expect(evidenceLabel({ filename: "notes.txt", caption: "the build" })).toBeNull();
    expect(evidenceLabel({ filename: "before-after.png", caption: null })).toBe("before");
  });

  it("prints a size a person can read", () => {
    expect(formatFileSize(1)).toBe("1 byte");
    expect(formatFileSize(512)).toBe("512 bytes");
    expect(formatFileSize(1536)).toBe("1.5 KiB");
    expect(formatFileSize(1024 * 1024)).toBe("1.0 MiB");
  });
});
