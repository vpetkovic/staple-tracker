/**
 * All workspaces never means "the first workspace" — Queue, Milestones and Estimate
 * accuracy ask instead (workspace-scope.ts). The pure decision, then each page rendered in
 * the hub with nothing chosen, one chosen, and a hub of one.
 */
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SessionContext, type StapleSession } from "@/lib/session";
import { loadRememberedWorkspace } from "@/lib/session-workspace";
import type { WorkspaceRef } from "@/lib/types";
import { CalibrationView } from "./calibration/CalibrationView";
import { ChooseWorkspace } from "./ChooseWorkspace";
import { fakeSession } from "./fake-session";
import { MilestonesView } from "./milestones/MilestonesView";
import { QueueView } from "./queue/QueueView";
import { workspaceScope } from "./workspace-scope";

const THREE: WorkspaceRef[] = [
  { slug: "exercises-api", prefix: "EXE" },
  { slug: "staple", prefix: "STA" },
  { slug: "workshop", prefix: "WOR" },
];

describe("workspaceScope", () => {
  it("asks in the hub when nothing is chosen and there is more than one workspace", () => {
    expect(workspaceScope("hub", "", THREE)).toEqual({ kind: "choose", workspaces: THREE });
  });

  it("reads the chosen workspace — never the first — when one is chosen", () => {
    expect(workspaceScope("hub", "workshop", THREE)).toEqual({ kind: "one", slug: "workshop" });
  });

  it("has nothing to ask when there is only one workspace to read", () => {
    expect(workspaceScope("hub", "", [THREE[1]!])).toEqual({ kind: "one", slug: "staple" });
    expect(workspaceScope("workspace", "", [THREE[1]!])).toEqual({ kind: "one", slug: "staple" });
  });
});

/**
 * The pages that ASK in All workspaces. Milestones is not one of them any more: it lists every
 * workspace's milestones read-only (see its own block below), because reading them does not
 * need a workspace — only opening one does.
 */
const PAGES: Array<[string, () => ReactElement]> = [
  ["Queue", () => <QueueView onAuthError={() => {}} />],
  ["Estimates", () => <CalibrationView onAuthError={() => {}} />],
];

/**
 * Milestones reads `window.innerWidth` for its split layout while rendering, so each render
 * gets a desktop-sized window for its duration and leaves none behind.
 */
function render(page: () => ReactElement, over: Partial<StapleSession>): string {
  const globals = globalThis as { window?: unknown };
  globals.window = { innerWidth: 1440, addEventListener() {}, removeEventListener() {} };
  try {
    return renderToStaticMarkup(<SessionContext.Provider value={fakeSession(over)}>{page()}</SessionContext.Provider>);
  } finally {
    delete globals.window;
  }
}

describe("per-workspace pages in All workspaces", () => {
  for (const [name, page] of PAGES) {
    describe(name, () => {
      it("shows 'Choose a workspace' with every workspace one tap away, and names none as current", () => {
        const markup = render(page, { mode: "hub", ws: "", workspaces: THREE });
        expect(markup).toContain(`data-choose-workspace="${name}"`);
        expect(markup).toContain('aria-label="Choose a workspace"');
        for (const workspace of THREE) {
          expect(markup).toContain(`data-choose-workspace-option="${workspace.slug}"`);
        }
        // The old tell: a page that silently read the first workspace named it.
        expect(markup).not.toContain("showing exercises-api");
        expect(markup).not.toMatch(/in exercises-api/);
        // A plain sentence, not a field name.
        expect(markup).toMatch(/data-testid="choose-workspace-sentence">[A-Z][^<]*workspace[^<]*\.</);
      });

      it("goes straight to the page when a workspace is chosen", () => {
        const markup = render(page, { mode: "hub", ws: "workshop", workspaces: THREE });
        expect(markup).not.toContain("data-choose-workspace");
      });

      it("does not ask in a hub of one, or in a single workspace", () => {
        expect(render(page, { mode: "hub", ws: "", workspaces: [THREE[1]!] })).not.toContain("data-choose-workspace");
        expect(render(page, { mode: "workspace", ws: "", workspaces: [THREE[1]!] })).not.toContain("data-choose-workspace");
      });
    });
  }

  describe("Milestones", () => {
    const page = () => <MilestonesView onAuthError={() => {}} />;

    it("lists every workspace's milestones instead of asking, and names none as current", () => {
      const markup = render(page, { mode: "hub", ws: "", workspaces: THREE });
      expect(markup).toContain("data-all-milestones");
      expect(markup).not.toContain("data-choose-workspace");
      expect(markup).toContain("Milestones in every workspace");
      // The old tell: a page that silently read the first workspace named it.
      expect(markup).not.toMatch(/in exercises-api/);
    });

    it("goes straight to one workspace's page when a workspace is chosen, or there is only one", () => {
      for (const over of [
        { mode: "hub" as const, ws: "workshop", workspaces: THREE },
        { mode: "hub" as const, ws: "", workspaces: [THREE[1]!] },
        { mode: "workspace" as const, ws: "", workspaces: [THREE[1]!] },
      ]) {
        const markup = render(page, over);
        expect(markup).not.toContain("data-all-milestones");
        expect(markup).not.toContain("data-choose-workspace");
      }
    });
  });

  it("chooses by calling onChoose with the tapped workspace's slug", () => {
    // A static render carries no handlers, so the element tree is walked instead: every
    // option button's onClick must hand back its own slug, and nothing else.
    const chosen: string[] = [];
    const root = ChooseWorkspace({ page: "Queue", sentence: "S.", workspaces: THREE, onChoose: (slug) => chosen.push(slug) });
    const buttons: Array<{ slug: string; click: () => void }> = [];
    const walk = (node: unknown): void => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) return node.forEach(walk);
      const props = (node as { props?: Record<string, unknown> }).props;
      if (!props) return;
      const slug = props["data-choose-workspace-option"];
      if (typeof slug === "string") buttons.push({ slug, click: props.onClick as () => void });
      walk(props.children);
    };
    walk(root);
    expect(buttons.map((b) => b.slug)).toEqual(THREE.map((w) => w.slug));
    buttons[2]!.click();
    buttons[1]!.click();
    expect(chosen).toEqual(["workshop", "staple"]);
  });

  it("remembers the chosen workspace as the default that Create task and Settings offer", () => {
    const store = new Map<string, string>();
    const previous = globalThis.localStorage;
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) },
    });
    try {
      const root = ChooseWorkspace({ page: "Queue", sentence: "S.", workspaces: THREE, onChoose: () => {} });
      let click: (() => void) | undefined;
      const walk = (node: unknown): void => {
        if (!node || typeof node !== "object") return;
        if (Array.isArray(node)) return node.forEach(walk);
        const props = (node as { props?: Record<string, unknown> }).props;
        if (!props) return;
        if (props["data-choose-workspace-option"] === "staple") click = props.onClick as () => void;
        walk(props.children);
      };
      walk(root);
      click!();
      expect(loadRememberedWorkspace()).toBe("staple");
    } finally {
      Object.defineProperty(globalThis, "localStorage", { configurable: true, value: previous });
    }
  });
});
