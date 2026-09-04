/**
 * `POST /api/glyph/sanitize` — R5d (STA-184), over real HTTP against a real server.
 *
 * R5c (STA-183) put the SVG sanitiser in `src/core/svg-sanitize.ts` and made the store
 * accept an `svg` kind appearance ONLY when the value is that function's own canonical
 * output. The glyph picker is a browser, and core is Node-only code it cannot import —
 * so without this route the settings page could offer emoji and a catalog and nothing
 * else. It is the ONE route R5d adds, and it is deliberately the smallest thing that
 * closes that gap: the sanitiser, over the wire, writing nothing.
 *
 * Four things are worth pinning, and they are the four ways this goes wrong:
 *
 *   1. IT IS A POST AND IT IS GATED LIKE ONE. It writes nothing, which is precisely the
 *      argument for making it a GET — and precisely why it must not be. The body is
 *      markup somebody pasted and the answer reflects it back; a route that does that
 *      and is reachable from another origin's page is a reflection gadget on a server
 *      holding the whole tracker. `test/contract-http.test.ts` pins it into the route
 *      list and `src/ui/server.ts` pins POST as its only method.
 *   2. THE ANSWER IS THE CANONICAL DOCUMENT, AND IT IS A FIXED POINT. Sanitising the
 *      answer again returns it unchanged — that is what lets the store's validator
 *      accept only canonical values and still be cheap, and what lets the browser's own
 *      `isCanonicalSvg` gate recognise the picker's choice without a parser.
 *   3. A REFUSAL IS THE SANITISER'S OWN SENTENCE. "must be an SVG without <script>
 *      elements" is the product; it reaches the page as a 409 with `validation`, the way
 *      every other refusal on this server does, re-worded by nobody.
 *   4. IT TOUCHES NO WORKSPACE. No handle is resolved, no event is logged, nothing in
 *      the database moves — the settings POST is still the only thing that stores a
 *      glyph, and it is still the store that decides whether it may.
 */
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isCanonicalSvg, sanitizeSvg, SVG_MAX_BYTES } from "../src/core/svg-sanitize.js";
import { initWorkspace, openWorkspace } from "../src/core/workspace.js";
import { startUiServer, type UiHandle } from "../src/ui/server.js";

let home: string;
let ui: UiHandle;
let origin: string;
let token: string;
let dbPath: string;

interface Answer {
  status: number;
  body: Record<string, unknown>;
}

/** POST the route the way the picker does: same-origin, JSON, token header. */
async function post(
  body: unknown,
  init: { origin?: string | null; method?: string; token?: string | null } = {},
): Promise<Answer> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const sendToken = init.token === undefined ? token : init.token;
  if (sendToken) headers["x-staple-token"] = sendToken;
  const sendOrigin = init.origin === undefined ? origin : init.origin;
  if (sendOrigin) headers.origin = sendOrigin;
  const res = await fetch(`${origin}/api/glyph/sanitize`, {
    method: init.method ?? "POST",
    headers,
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const SIMPLE = '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="4" fill="#f00"/></svg>';

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "staple-glyph-sanitize-"));
  process.env.STAPLE_HOME = home;
  process.env.NODE_NO_WARNINGS = "1";

  const ws = initWorkspace({ global: true, slug: "glyphs" });
  dbPath = ws.dbPath;
  ws.store.createIssue({ title: "something for the workspace to hold" });
  ws.store.db.close();

  ui = startUiServer({ port: 0, hub: false, db: dbPath });
  await once(ui.server, "listening");
  token = ui.token;
  origin = `http://127.0.0.1:${(ui.server.address() as AddressInfo).port}`;
});

afterAll(() => {
  ui?.close();
  rmSync(home, { recursive: true, force: true });
});

describe("the route is gated exactly like every other POST on this server", () => {
  it("refuses an unauthenticated caller before it decides anything else", async () => {
    const res = await post({ svg: SIMPLE }, { token: null });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("unauthorized");
  });

  it("refuses a cross-origin POST — the body is markup and the answer reflects it", async () => {
    const res = await post({ svg: SIMPLE }, { origin: "http://evil.example" });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("forbidden");
  });

  it("refuses GET", async () => {
    const res = await fetch(`${origin}/api/glyph/sanitize`, { headers: { "x-staple-token": token } });
    expect(res.status).toBe(405);
  });
});

describe("the answer is core's canonical document, and nothing else", () => {
  it("returns the sanitiser's own output, viewBox and accessible name", async () => {
    const res = await post({ svg: SIMPLE, label: "Bug" });
    expect(res.status).toBe(200);
    const expected = sanitizeSvg(SIMPLE, { label: "Bug" });
    expect(expected.ok).toBe(true);
    expect(res.body).toEqual({
      svg: expected.ok ? expected.svg : null,
      viewBox: "0 0 16 16",
      label: "Bug",
    });
  });

  it("what comes back is a fixed point, which is the only thing the store accepts", async () => {
    const res = await post({ svg: SIMPLE, label: "Bug" });
    const svg = res.body.svg as string;
    expect(isCanonicalSvg(svg)).toBe(true);
    // Sanitising the answer again is the answer: the picker can re-open a stored glyph
    // and the browser's own gate recognises it without a parser.
    const again = await post({ svg, label: "Bug" });
    expect(again.body.svg).toBe(svg);
  });

  it("normalises hue away, because a kind glyph is monochrome by design", async () => {
    const res = await post({ svg: SIMPLE, label: "Bug" });
    expect(res.body.svg).toContain('fill="currentColor"');
    expect(res.body.svg).not.toContain("#f00");
  });

  it("takes the document's own <title> as the name when it has one", async () => {
    const res = await post({ svg: '<svg viewBox="0 0 16 16"><title>Beetle</title><path d="M0 0 L4 4"/></svg>' });
    expect(res.status).toBe(200);
    expect(res.body.label).toBe("Beetle");
  });
});

describe("a refusal is the sanitiser's sentence, arriving as a refusal", () => {
  const cases: { name: string; svg: unknown; label?: string; contains: string }[] = [
    { name: "a script element", svg: '<svg viewBox="0 0 16 16"><script/></svg>', contains: "<script>" },
    {
      name: "an event handler",
      svg: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="4" onclick="x()"/></svg>',
      contains: "event handler",
    },
    {
      name: "a remote reference",
      svg: '<svg viewBox="0 0 16 16"><use href="http://evil.example/x.svg"/></svg>',
      contains: "local",
    },
    { name: "a DOCTYPE", svg: '<!DOCTYPE svg><svg viewBox="0 0 16 16"><path d="M0 0"/></svg>', contains: "DOCTYPE" },
    { name: "no viewBox to derive", svg: "<svg><path d=\"M0 0\"/></svg>", contains: "viewBox" },
    {
      name: "no accessible name anywhere",
      svg: '<svg viewBox="0 0 16 16"><path d="M0 0"/></svg>',
      contains: "accessible name",
    },
    { name: "something that is not a string", svg: 42, contains: "as a string" },
  ];

  for (const testCase of cases) {
    it(`refuses ${testCase.name}, in the sanitiser's own words`, async () => {
      const res = await post({ svg: testCase.svg, ...(testCase.label ? { label: testCase.label } : {}) });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe("validation");
      expect(res.body.message).toContain("Custom SVG must be ");
      expect(res.body.message).toContain(testCase.contains);
    });
  }

  it("refuses a document over the byte cap", async () => {
    const fat = `<svg viewBox="0 0 16 16"><title>Big</title><path d="${"M0 0 ".repeat(SVG_MAX_BYTES)}"/></svg>`;
    const res = await post({ svg: fat });
    expect(res.status).toBe(409);
    expect(res.body.message).toContain(`${SVG_MAX_BYTES} bytes`);
  });

  it("says the same sentence the CLI and MCP would — nothing here re-words core", async () => {
    const hostile = '<svg viewBox="0 0 16 16"><script/></svg>';
    const direct = sanitizeSvg(hostile);
    expect(direct.ok).toBe(false);
    const res = await post({ svg: hostile });
    expect(res.body.message).toBe(`Custom SVG must be ${direct.ok ? "" : direct.problem}`);
  });
});

describe("it writes nothing", () => {
  it("leaves the workspace exactly as it found it — no issue, no event, no setting", async () => {
    const before = openWorkspace(dbPath);
    const issuesBefore = before.store.listIssues({}).length;
    const eventsBefore = before.store.listEvents(0, 1000).length;
    before.store.db.close();

    await post({ svg: SIMPLE, label: "Bug" });
    await post({ svg: '<svg viewBox="0 0 16 16"><script/></svg>' });

    const after = openWorkspace(dbPath);
    expect(after.store.listIssues({}).length).toBe(issuesBefore);
    expect(after.store.listEvents(0, 1000).length).toBe(eventsBefore);
    // The route is not a way to store a glyph: the settings POST still is, and the
    // store still decides.
    expect(after.store.getSetting("kinds.appearance")).toEqual({});
    after.store.db.close();
  });
});
