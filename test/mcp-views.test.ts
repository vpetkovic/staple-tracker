/**
 * The server side of staple's MCP Apps views, without a server: how a tool is linked to its
 * view (`linkToolView`, which the registerTool wrapper in src/mcp.ts applies to every tool),
 * and where the built view files are read from. The views rendering in a host is
 * test/mcp-views-host.test.ts.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { linkToolView, readViewHtml, resolveViewsDir, viewToolMeta } from "../src/mcp-views.js";
import { StapleError } from "../src/core/types.js";

const URI = "ui://staple/about";
const answer = { content: [{ type: "text", text: "staple 0.1.0" }], structuredContent: { ok: true } };

describe("linkToolView", () => {
  it("leaves a tool without a view exactly as it was", () => {
    const config = { annotations: { readOnlyHint: true } };
    const cb = () => answer;
    const [linked, linkedCb] = linkToolView("inbox", config, cb);
    expect(linked).toBe(config);
    expect(linkedCb).toBe(cb);
  });

  it("declares both spellings of the view and stamps a synchronous result", () => {
    const [linked, cb] = linkToolView("show_about", { _meta: viewToolMeta("about") }, () => answer);
    expect(linked._meta).toEqual({ ui: { resourceUri: URI }, "ui/resourceUri": URI });
    expect(cb()).toEqual({ ...answer, _meta: { ui: { resourceUri: URI } } });
  });

  it("accepts the legacy flat key alone and normalizes it", () => {
    const [linked] = linkToolView("show_about", { _meta: { "ui/resourceUri": URI } }, () => answer);
    expect(linked._meta).toEqual({ ui: { resourceUri: URI }, "ui/resourceUri": URI });
  });

  it("stamps an asynchronous result, and an error result", async () => {
    const failure = { content: [{ type: "text", text: "ERROR(not_found): no" }], isError: true };
    const [, asyncCb] = linkToolView("show_about", { _meta: viewToolMeta("about") }, async () => answer);
    await expect(asyncCb()).resolves.toEqual({ ...answer, _meta: { ui: { resourceUri: URI } } });
    const [, errorCb] = linkToolView("show_about", { _meta: viewToolMeta("about") }, () => failure);
    expect(errorCb()).toEqual({ ...failure, _meta: { ui: { resourceUri: URI } } });
  });

  it("keeps what the result already carries under _meta and _meta.ui", () => {
    const own = { ...answer, _meta: { trace: "t1", ui: { visibility: ["model"] } } };
    const [, cb] = linkToolView("show_about", { _meta: viewToolMeta("about") }, () => own);
    expect(cb()).toEqual({ ...answer, _meta: { trace: "t1", ui: { visibility: ["model"], resourceUri: URI } } });
  });

  it("refuses a view staple does not serve, at registration", () => {
    expect(() => linkToolView("show_nothing", { _meta: { ui: { resourceUri: "ui://staple/nothing" } } }, () => answer)).toThrow(
      /ui:\/\/staple\/nothing, which is not a view staple serves/,
    );
    expect(() => viewToolMeta("nothing")).toThrow(/no view named "nothing"/);
  });
});

describe("where the view files are read from", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("prefers the packaged views/ beside the bundle, and falls back to the source build", () => {
    dir = mkdtempSync(join(tmpdir(), "staple-views-dir-"));
    expect(resolveViewsDir(dir)).toBe(join(dir, "views", "dist"));
    mkdirSync(join(dir, "views"));
    writeFileSync(join(dir, "views", "about.html"), "<!doctype html><p>packaged</p>");
    expect(resolveViewsDir(dir)).toBe(join(dir, "views"));
    expect(readViewHtml("about", join(dir, "views"))).toContain("packaged");
  });

  it("answers a missing build with not_found and the command that builds it", () => {
    dir = mkdtempSync(join(tmpdir(), "staple-views-dir-"));
    let error: unknown;
    try {
      readViewHtml("about", dir);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(StapleError);
    expect((error as StapleError).code).toBe("not_found");
    expect((error as StapleError).message).toContain("npm run build:views");
  });
});
