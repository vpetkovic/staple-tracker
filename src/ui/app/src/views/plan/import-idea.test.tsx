/**
 * Import on the Plan toolbar: on every lens, a picker of the three file types and the stage the
 * idea starts at, left to an agent unless the person picks one; and the body it sends.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Tabs } from "@/components/ui/tabs";
import type { PlanData } from "@/lib/plan-types";
import { fileBase64, IMPORT_ACCEPT, IMPORT_STAGES, ImportIdea, importBody } from "./ImportIdea";
import { PlanBar } from "./PlanView";
import { stepLabel } from "./plan-tree";
import type { Lens } from "./plan-model";

const PLAN = { enabled: true, today: "2026-11-27", horizons: [], ideas: [] } as unknown as PlanData;

const bar = (lens: Lens, onImport?: (body: Record<string, unknown>) => Promise<boolean>) =>
  renderToStaticMarkup(
    <Tabs value={lens}>
      <PlanBar lens={lens} plan={PLAN} focus="all" onFocus={() => {}} text="" onText={() => {}} onCapture={async () => true} onImport={onImport} onViewIdeas={() => {}} tools={null} />
    </Tabs>,
  );

describe("Import on the Plan toolbar", () => {
  it("is offered on every lens, labelled, beside the filter", () => {
    for (const lens of ["ideas", "horizons", "timeline"] as const) {
      const html = bar(lens, async () => true);
      expect(html).toContain("data-plan-import-open");
      expect(html).toContain('aria-label="Import an idea from a file"');
    }
    expect(bar("ideas")).not.toContain("data-plan-import-open");
  });

  it("picks only .md, .html and .jsx files, and offers the stage with an agent's classify first", () => {
    expect(IMPORT_ACCEPT.split(",")).toEqual([".md", ".markdown", ".html", ".htm", ".jsx"]);
    expect(IMPORT_STAGES.map((stage) => stage.id)).toEqual(["classify", "raw", "exploring", "shaped"]);
    expect(renderToStaticMarkup(<ImportIdea onImport={async () => true} onViewIdeas={() => {}} />)).toContain("Import");
  });

  it("sends the file's name and bytes, and a maturity only when the person picked one", async () => {
    const file = new File(["# Gift cards\n\nSell them. ✓"], "gift-cards.md", { type: "text/markdown" });
    const left = await importBody(file, "classify");
    expect(left).toEqual({ filename: "gift-cards.md", contentBase64: Buffer.from("# Gift cards\n\nSell them. ✓").toString("base64") });
    expect(await importBody(file, "exploring")).toMatchObject({ filename: "gift-cards.md", maturity: "exploring" });
    expect(await importBody(file, "raw")).toMatchObject({ maturity: "raw" });
  });

  it("encodes a file larger than one chunk byte for byte", async () => {
    const bytes = new Uint8Array(100_000).map((_, index) => index % 251);
    expect(await fileBase64(new Blob([bytes]))).toBe(Buffer.from(bytes).toString("base64"));
  });

  it("reads an import waiting for an agent as to classify, not the person's", () => {
    const step = { ideaId: "a", title: "", parentId: null, parentTitle: null, horizonId: null, state: "raw" as const, need: "classify" as const, who: "agent" as const, instruction: "" };
    expect(stepLabel(step)).toEqual({ label: "to classify", person: false });
  });
});
