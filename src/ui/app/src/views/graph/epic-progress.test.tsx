/** The epic's graph progress: a bar on the desk, the phone's "3/4 done" exactly as it shipped. */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EpicProgress, EpicProgressEdge } from "./EpicProgress";

describe("EpicProgress", () => {
  it("keeps the phone's '3/4 done' and draws no bar there", () => {
    const html = renderToStaticMarkup(<EpicProgress resolved={3} total={4} desk={false} />);
    expect(html).toContain(">3/4 done</span>");
    expect(html).not.toContain("data-epic-progress-bar");
    expect(renderToStaticMarkup(<EpicProgressEdge resolved={1} total={4} desk={false} />)).toBe("");
  });

  it("draws the bar on the desk, filled to the share done, and keeps the sentence", () => {
    const html = renderToStaticMarkup(<EpicProgress resolved={3} total={4} />);
    expect(html).toContain("data-epic-progress-bar");
    expect(html).toContain("width:75%");
    expect(html).toContain("3 of 4 tickets on this canvas are done");
    expect(renderToStaticMarkup(<EpicProgressEdge resolved={1} total={4} />)).toContain("width:25%");
  });
});
