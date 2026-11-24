/**
 * The suite renders to strings, where React does not run error boundaries, so the boundary's
 * two halves are exercised directly: the state it derives from an error and what it renders.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MountBoundary } from "./MountBoundary";

function boundary(placement: "overlay" | "inline") {
  const b = new MountBoundary({ label: "Link issue or PR", placement, children: <p>healthy child</p> });
  b.setState = ((update: (s: typeof b.state) => typeof b.state) => { b.state = { ...b.state, ...update(b.state) }; }) as typeof b.setState;
  return b;
}

describe("MountBoundary", () => {
  it("renders its children while nothing has failed", () => {
    expect(renderToStaticMarkup(boundary("overlay").render())).toContain("healthy child");
  });

  it("turns a render error into a dismissible alert instead of an empty page", () => {
    const b = boundary("overlay");
    b.state = { ...b.state, ...MountBoundary.getDerivedStateFromError(new TypeError("crypto.randomUUID is not a function")) };
    const html = renderToStaticMarkup(b.render());
    expect(html).toContain('role="alert"');
    expect(html).toContain("Link issue or PR stopped because of an error");
    expect(html).toContain("crypto.randomUUID is not a function");
    expect(html).toContain("Dismiss");
    expect(html).not.toContain("healthy child");
  });

  it("starts the failed part afresh when dismissed", () => {
    const b = boundary("inline");
    b.state = { ...b.state, ...MountBoundary.getDerivedStateFromError("not an Error") };
    expect(renderToStaticMarkup(b.render())).toContain("Try again");
    b.reset();
    expect(b.state).toEqual({ error: null, generation: 1 });
    expect(renderToStaticMarkup(b.render())).toContain("healthy child");
  });
});
