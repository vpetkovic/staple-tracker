/**
 * GET /join/{repoId}: the page a share link opens. Static, the same bytes for every
 * repository and every query, no database read, every name written by the page's own
 * script as text, and a CSP that admits only that script and that stylesheet.
 */
import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index.js";
import { LANDING_PAGE_BODY, LOCAL_APP_ORIGIN } from "../src/landing.js";
import { ORIGIN, REPO, call, jsonOf, seedRepo } from "./helpers.js";

const PAGE = `${ORIGIN}/join/${REPO}`;

async function sha256Base64(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  let binary = "";
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** A D1 binding that fails the test on ANY use. */
const noDatabase = new Proxy({} as D1Database, {
  get(_target, property) {
    throw new Error(`the landing page touched D1 (${String(property)})`);
  },
});

/** Run the page's own script against a stub DOM, as a browser at `href` would. */
function render(href: string, rawSearch?: string): { title: string; sub: string; open: string; command: string } {
  const script = /<script>([\s\S]*)<\/script>/.exec(LANDING_PAGE_BODY)![1]!;
  const url = new URL(href);
  const nodes: Record<string, { textContent: string; href: string; setAttribute: (k: string, v: string) => void; addEventListener: () => void }> = {};
  const node = (id: string) =>
    (nodes[id] ??= {
      textContent: "",
      href: "",
      setAttribute(k, v) {
        if (k === "href") this.href = v;
      },
      addEventListener() {},
    });
  const document = { getElementById: node };
  const location = { origin: url.origin, pathname: url.pathname, search: rawSearch ?? url.search };
  new Function("location", "document", "navigator", script)(location, document, {});
  return { title: node("title").textContent, sub: node("sub").textContent, open: node("open").href, command: node("command").textContent };
}

describe("GET /join/{repoId}", () => {
  it("serves the page with a strict CSP that pins its one script and one stylesheet", async () => {
    const response = await SELF.fetch(`${PAGE}?n=ai-inbox&p=AII&by=VP&as=marko`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const csp = response.headers.get("content-security-policy")!;
    const body = await response.text();
    const script = /<script>([\s\S]*)<\/script>/.exec(body)![1]!;
    const style = /<style>([\s\S]*)<\/style>/.exec(body)![1]!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain(`script-src 'sha256-${await sha256Base64(script)}'`);
    expect(csp).toContain(`style-src 'sha256-${await sha256Base64(style)}'`);
    for (const part of ["img-src 'none'", "connect-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'"]) {
      expect(csp).toContain(part);
    }
    expect(csp).not.toContain("unsafe-inline");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    // Nothing the CSP would block: no style or event-handler attribute, which a hash
    // cannot admit (a real browser found the first version's two `style=` attributes).
    expect(body).not.toMatch(/\sstyle=|\son[a-z]+=/i);
    // No external asset of any kind.
    expect(body).not.toMatch(/<(link|img|iframe)\b/);
    expect(body).not.toMatch(/src=["']?https?:/);
  });

  it("reads no database: it answers with D1 itself unusable", async () => {
    const response = await worker.fetch(new Request(`${PAGE}?n=ai-inbox`), { ...env, DB: noDatabase } as never);
    expect(response.status).toBe(200);
  });

  it("never reflects the query: a hostile name gets the same bytes, and the script writes it as text", async () => {
    const hostile = `${PAGE}?n=${encodeURIComponent("<script>alert(1)</script>")}&by=${encodeURIComponent('"><img src=x onerror=alert(2)>')}`;
    const plain = await (await SELF.fetch(PAGE)).text();
    const attacked = await (await SELF.fetch(hostile)).text();
    expect(attacked).toBe(plain);
    expect(attacked).not.toContain("alert(");
    expect(attacked).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);

    // In the browser: a name that is not a name is not shown, never interpreted.
    const shown = render(hostile);
    expect(shown.title).toBe("You are invited to join a shared workspace");
    expect(`${shown.title}${shown.sub}`).not.toContain("<");
  });

  it("says who invited whom to what, and offers the app link and the command", () => {
    const href = `${PAGE}?n=ai-inbox&p=AII&by=VP&as=marko`;
    const shown = render(href);
    expect(shown.title).toBe("VP invited you to join ai-inbox");
    expect(shown.sub).toContain("AII");
    expect(shown.sub).toContain("You were invited as marko.");
    expect(shown.open).toBe(`${LOCAL_APP_ORIGIN}/?join=${encodeURIComponent(href)}`);
    expect(shown.command).toBe(`staple cloud join '${href}'`);
    expect(LANDING_PAGE_BODY).toContain("npm install -g staple-cli");
    // A quote in the link is escaped for a POSIX shell, as `shareJoinCommand` does. (A
    // browser percent-encodes one in a query; this feeds the raw character to be sure.)
    expect(render(PAGE, "?n=it's").command).toBe(`staple cloud join '${PAGE}?n=it'\\''s'`);
  });

  it("checks the id's shape and nothing else", async () => {
    expect((await SELF.fetch(`${ORIGIN}/join/not-a-uuid`)).status).toBe(404);
    expect((await SELF.fetch(`${ORIGIN}/join/${REPO.toUpperCase()}`)).status).toBe(200);
    expect((await SELF.fetch(PAGE, { method: "POST" })).status).toBe(400);
    // A repository that exists and one that does not get the same page.
    await seedRepo();
    const known = await (await SELF.fetch(PAGE)).text();
    const unknown = await (await SELF.fetch(`${ORIGIN}/join/99999999-9999-4999-8999-999999999999`)).text();
    expect(known).toBe(unknown);
  });
});

describe("join requests carry invitedAs", () => {
  async function workspaceWithOwner(): Promise<string> {
    await seedRepo(REPO, "seed-device");
    const response = await call(`/v1/repos/${REPO}/connect`, {
      method: "POST",
      token: `enroll_${REPO}`,
      body: { deviceId: "owner-laptop" },
      device: null,
    });
    return (await jsonOf(response)).token as string;
  }

  const create = (body: Record<string, unknown>) =>
    call(`/v1/repos/${REPO}/join-requests`, {
      method: "POST",
      body: { deviceId: "marko-laptop", requestSecretSha256: "ab".repeat(32), ...body },
      device: null,
      headers: { "CF-Connecting-IP": "192.0.2.7" },
    });

  it("stores the name the link meant, and lists it to members", async () => {
    const owner = await workspaceWithOwner();
    expect((await create({ invitedAs: "marko" })).status).toBe(200);
    expect((await create({ deviceId: "anon-laptop", requestSecretSha256: "cd".repeat(32) })).status).toBe(200);
    const listed = await jsonOf(await call(`/v1/repos/${REPO}/join-requests`, { token: owner, device: null }));
    expect(listed.map((r: any) => [r.label ?? null, r.invitedAs])).toEqual(
      expect.arrayContaining([[null, "marko"], [null, null]]),
    );
  });

  it("holds invitedAs to the member name rules", async () => {
    await workspaceWithOwner();
    for (const bad of ["", "   ", "a".repeat(65), "bad\u0000name", 42]) {
      expect((await create({ invitedAs: bad })).status, String(bad)).toBe(400);
    }
  });
});
