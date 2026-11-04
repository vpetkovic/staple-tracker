/**
 * `cn` merges the design system's type scale as FONT SIZES. Without the registration in
 * lib/utils.ts, tailwind-merge reads `text-body` as a colour: a primitive's `text-primary-foreground`
 * would be dropped by a caller's `text-body` (a black button with black words), and a row's
 * `text-body` by its own `text-muted-foreground`.
 */
import { describe, expect, it } from "vitest";
import { cn } from "./utils";

describe("cn and the type scale", () => {
  it("keeps a size and a colour side by side", () => {
    for (const size of ["text-caption", "text-label", "text-body", "text-reading", "text-title", "text-heading", "text-display"]) {
      expect(cn("text-primary-foreground", size)).toBe(`text-primary-foreground ${size}`);
      expect(cn(size, "text-muted-foreground")).toBe(`${size} text-muted-foreground`);
    }
  });

  it("lets a later size replace an earlier one, the scale's and Tailwind's alike", () => {
    expect(cn("text-sm", "text-body")).toBe("text-body");
    expect(cn("text-body", "max-md:text-[15px]", "text-label")).toBe("max-md:text-[15px] text-label");
  });

  it("merges the shell's spacing and width names as spacing and widths", () => {
    expect(cn("h-8", "h-control-md")).toBe("h-control-md");
    expect(cn("size-7", "size-control-md")).toBe("size-control-md");
    expect(cn("max-w-lg", "max-w-readable")).toBe("max-w-readable");
    expect(cn("px-4", "px-page")).toBe("px-page");
  });
});
