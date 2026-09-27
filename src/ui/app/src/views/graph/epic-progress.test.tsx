/** The epic's graph progress: a bar from 720px up, the phone's text exactly as it shipped. */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EpicProgress, EpicProgressEdge } from "./EpicProgress";

describe("EpicProgress", () => {
  it("keeps the phone's '3/4 done' and shows the bar only from 720px", () => {
    const html = renderToStaticMarkup(<EpicProgress resolved={3} total={4} />);
    expect(html).toMatch(/data-epic-progress-bar="" class="hidden [^"]*min-\[720px\]:block/);
    expect(html).toContain('3/4<span class="min-[720px]:hidden"> done</span>');
    expect(html).toContain("3 of 4 tickets on this canvas are done");
  });

  it("draws the collapsed node's edge bar hidden on a phone, filled to the share done", () => {
    const html = renderToStaticMarkup(<EpicProgressEdge resolved={1} total={4} />);
    expect(html).toMatch(/class="[^"]*\bhidden\b[^"]*min-\[720px\]:block/);
    expect(html).toContain("width:25%");
  });
});
