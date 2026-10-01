/**
 * GET /api/file — the bytes, with a type the browser can show, and not a type
 * it can execute.
 *
 * SVG and HTML are stored as what the bytes are. The response is a download
 * (`application/octet-stream`, nosniff, a sandbox policy) so opening the file
 * in this app cannot run their script. A missing blob is the sync gap, said
 * in the error, not an empty body.
 */
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initWorkspace } from "../src/core/workspace.js";
import { startUiServer, type UiHandle } from "../src/ui/server.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const html = Buffer.from("<!DOCTYPE html><html><body><script>parent.STAPLE_PWNED=1</script></body></html>");
const svg = Buffer.from("<svg xmlns='http://www.w3.org/2000/svg' onload='parent.STAPLE_PWNED=1'></svg>");
const text = Buffer.from("build log\nline two\n");
const pdf = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");

let home: string;
let ui: UiHandle;
let origin: string;
let token: string;
const id: Record<string, string> = {};

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "staple-file-"));
  process.env.STAPLE_HOME = home;
  process.env.NODE_NO_WARNINGS = "1";
  const ws = initWorkspace({ global: true, slug: "files" });
  const issue = ws.store.createIssue({ title: "Evidence" });
  const attached = {
    png: ws.store.attachFile(issue.identifier, { filename: "before.png", bytes: png, caption: "before", author: "ada" }),
    html: ws.store.attachFile(issue.identifier, { filename: "page.html", bytes: html, author: "ada" }),
    svg: ws.store.attachFile(issue.identifier, { filename: "mark.svg", bytes: svg, author: "ada" }),
    text: ws.store.attachFile(issue.identifier, { filename: "build.log", bytes: text, author: "ada" }),
    pdf: ws.store.attachFile(issue.identifier, { filename: "notes.pdf", bytes: pdf, author: "ada" }),
    // Different bytes from the png, so deleting this blob leaves the image intact.
    gap: ws.store.attachFile(issue.identifier, { filename: "remote.bin", bytes: Buffer.from("bytes that stayed on the other device"), author: "ada" }),
  };
  for (const [key, meta] of Object.entries(attached)) id[key] = meta.id;
  ws.store.db.prepare("DELETE FROM attachment_bytes WHERE sha256 = ?").run(attached.gap.sha256);
  ws.store.db.close();

  ui = startUiServer({ port: 0, hub: false, db: ws.dbPath });
  await once(ui.server, "listening");
  token = ui.token;
  origin = `http://127.0.0.1:${(ui.server.address() as AddressInfo).port}`;
});

afterAll(() => {
  ui?.close();
  if (home) rmSync(home, { recursive: true, force: true });
});

function get(path: string, auth = true): Promise<Response> {
  return fetch(`${origin}${path}`, { headers: auth ? { "x-staple-token": token } : {} });
}

describe("GET /api/file", () => {
  it("refuses a caller with no token", async () => {
    const res = await get(`/api/file?id=${id.png}`, false);
    expect(res.status).toBe(401);
  });

  it("refuses a request with no id", async () => {
    const res = await get("/api/file");
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("validation");
  });

  it("serves a png as an image, byte for byte, and will not be sniffed", async () => {
    const res = await get(`/api/file?id=${id.png}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-disposition")).toContain("inline");
    expect(res.headers.get("content-disposition")).toContain("before.png");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    expect(Buffer.from(await res.arrayBuffer()).equals(png)).toBe(true);
  });

  it("serves text as text and a pdf as a pdf", async () => {
    const log = await get(`/api/file?id=${id.text}`);
    expect(log.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await log.text()).toBe(text.toString("utf8"));
    const notes = await get(`/api/file?id=${id.pdf}`);
    expect(notes.headers.get("content-type")).toBe("application/pdf");
    expect(notes.headers.get("content-disposition")).toContain("inline");
  });

  it("does not serve html or svg as a document of this origin", async () => {
    for (const key of ["html", "svg"] as const) {
      const res = await get(`/api/file?id=${id[key]}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/octet-stream");
      expect(res.headers.get("content-type")).not.toMatch(/html|svg/);
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("content-disposition")).toContain("attachment");
      expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
      const body = Buffer.from(await res.arrayBuffer());
      expect(body.equals(key === "html" ? html : svg)).toBe(true);
    }
  });

  it("says when the bytes never arrived, and does not send an empty file", async () => {
    const res = await get(`/api/file?id=${id.gap}`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe("not_found");
    expect(body.message).toMatch(/did not travel/);
  });
});
