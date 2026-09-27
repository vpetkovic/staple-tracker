/**
 * The detail as a full-screen sheet on a phone — drawer.ts's `presentationFor`, the panel's
 * sheet chrome, and the stylesheet that makes it a sheet (dvh, safe-area insets, momentum
 * scroll). The desktop's drawer and page are pinned unchanged beside it.
 *
 * The overlay itself portals through Radix, which a static render does not draw, so the
 * panel is rendered directly with the presentation the mount would hand it.
 */
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SessionContext } from "@/lib/session";
import { fakeSession } from "@/views/fake-session";
import { panelClass, presentationFor, SHEET_BELOW, type DetailPresentation } from "./drawer";
import { IssueDetailPanel } from "./IssueDetailPanel";

const noop = () => {};

function panel(presentation: DetailPresentation | undefined, mode: "drawer" | "full" = "drawer"): string {
  return renderToStaticMarkup(
    <SessionContext.Provider value={fakeSession()}>
      <IssueDetailPanel
        selection={{ workspace: "staple", ref: "STA-60" }}
        mode={mode}
        presentation={presentation}
        onToggleMode={noop}
        nav={{ prev: null, next: null, index: -1, total: 0 }}
        onNavigate={noop}
        onClose={noop}
        onAuthError={noop}
      />
    </SessionContext.Provider>,
  );
}

describe("presentationFor — a sheet below 768px, the reader's own mode above", () => {
  it("is a sheet on every phone width, whatever the stored mode", () => {
    for (const width of [320, 360, 390, 430, 767]) {
      expect(presentationFor(width, "drawer"), `${width}`).toBe("sheet");
      expect(presentationFor(width, "full"), `${width}`).toBe("sheet");
    }
  });

  it("keeps the drawer or the page from 768px up — the desktop is unchanged", () => {
    expect(SHEET_BELOW).toBe(768);
    expect(presentationFor(768, "drawer")).toBe("drawer");
    expect(presentationFor(1440, "full")).toBe("full");
    expect(panelClass("drawer")).toBe("inset-y-0 right-0 w-[min(46rem,94vw)] border-l");
    expect(panelClass("full")).toBe("inset-0");
  });

  it("pins the sheet to the viewport edges, not to a drawer width", () => {
    expect(panelClass("sheet")).toBe("inset-x-0 top-0");
    expect(panelClass("sheet")).not.toContain("w-[");
  });
});

describe("the sheet's chrome", () => {
  it("leads with a Back control and drops the expand toggle and the X", () => {
    const sheet = panel("sheet");
    expect(sheet).toContain("data-detail-back");
    expect(sheet).toContain('aria-label="Back to the list"');
    expect(sheet).toContain(">Back<");
    expect(sheet).not.toContain("Expand to full screen");
    expect(sheet).not.toContain('aria-label="Close detail"');
    expect(sheet).toContain('data-detail-bar="sheet"');
  });

  it("leaves the drawer's controls exactly as they were", () => {
    for (const markup of [panel(undefined), panel("drawer")]) {
      expect(markup).not.toContain("data-detail-back");
      expect(markup).toContain('aria-label="Expand to full screen"');
      expect(markup).toContain('aria-label="Close detail"');
    }
    expect(panel("full", "full")).toContain('aria-label="Collapse to drawer"');
  });

  it("scrolls in one marked container the sheet rules can reach", () => {
    expect(panel("sheet")).toContain("staple-detail-scroll");
  });
});

describe("the sheet's stylesheet — dvh, safe areas, momentum scroll", () => {
  const CSS = readFileSync(new URL("./detail.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const rule = (selector: string) =>
    new RegExp(`${selector.replace(/[[\]().="]/g, (c) => `\\${c}`)}\\s*{([^}]*)}`).exec(CSS)?.[1] ?? "";

  it("takes the dynamic viewport height, with 100vh only as the fallback before it", () => {
    const sheet = rule('.staple-detail-panel[data-mode="sheet"]');
    expect(sheet).toMatch(/height:\s*100vh;\s*height:\s*100dvh/);
  });

  it("pads for the notch and the home indicator on all four sides", () => {
    const sheet = rule('.staple-detail-panel[data-mode="sheet"]');
    for (const side of ["top", "right", "bottom", "left"]) {
      expect(sheet).toContain(`padding-${side}: env(safe-area-inset-${side}`);
    }
  });

  it("scrolls with momentum and keeps the scroll inside the sheet", () => {
    const scroller = rule('.staple-detail-panel[data-mode="sheet"] .staple-detail-scroll');
    expect(scroller).toMatch(/-webkit-overflow-scrolling:\s*touch/);
    expect(scroller).toMatch(/overscroll-behavior:\s*contain/);
  });

  it("scrolls the tab strip inside itself so the sheet never scrolls sideways", () => {
    expect(rule('.staple-detail-panel[data-mode="sheet"] .staple-detail-tabstrip')).toMatch(/overflow-x:\s*auto/);
  });
});
