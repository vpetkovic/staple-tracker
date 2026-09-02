/**
 * Loopback token injection — the "plain http://localhost:4400 just works" contract.
 *
 * The page served to a loopback Host carries an inline script seeding the token into
 * sessionStorage; any other Host gets the plain, tokenless page. The Host check is the
 * DNS-rebinding gate: a browser lured to evil.example (resolving to 127.0.0.1) sends
 * Host: evil.example and must not receive the credential.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initWorkspace } from "../src/core/workspace.js";
import { startUiServer, uiBundleExists } from "../src/ui/server.js";

let home: string;
let ui: ReturnType<typeof startUiServer>;
let origin: string;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "staple-inject-"));
  process.env.STAPLE_HOME = home;
  initWorkspace({ global: true, slug: "inject" });
  ui = startUiServer({ port: 0, hub: false });
  await once(ui.server, "listening");
  const address = ui.server.address();
  origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterAll(() => {
  ui.close();
  rmSync(home, { recursive: true, force: true });
});

async function page(): Promise<string> {
  const res = await fetch(`${origin}/`);
  expect(res.status).toBe(200);
  return res.text();
}

/** fetch (undici) refuses to override Host, so the rebinding cases go over raw http. */
function pageWithHost(host: string): Promise<string> {
  return new Promise((resolvePage, reject) => {
    const req = request(`${origin}/`, { headers: { host } }, (res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
      res.on("end", () => resolvePage(body));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("loopback token injection", () => {
  it.skipIf(!uiBundleExists())("seeds the token for a loopback Host", async () => {
    const body = await page();
    expect(body).toContain(`sessionStorage.setItem("staple:token", ${JSON.stringify(ui.token)})`);
  });

  it.skipIf(!uiBundleExists())("localhost counts as loopback", async () => {
    const body = await pageWithHost("localhost:4400");
    expect(body).toContain(ui.token);
  });

  it("never seeds the token for a foreign Host (DNS rebinding)", async () => {
    const body = await pageWithHost("evil.example:4400");
    expect(body).not.toContain(ui.token);
  });

  it("never seeds the token for a foreign IP-literal Host", async () => {
    // Node's client silently replaces an EMPTY Host with the connection host, so the
    // absent-Host branch can't be driven from here; a LAN IP covers the same gate.
    const body = await pageWithHost("10.0.0.5:4400");
    expect(body).not.toContain(ui.token);
  });
});
