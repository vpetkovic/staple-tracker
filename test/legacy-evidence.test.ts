/**
 * Evidence an agent wrote as a base64 document before typed files existed.
 * AII-2's `evidence-before-png` is the shape: a heading, a
 * `Media type:` line, a `SHA-256:` line, and the bytes as a data URI.
 *
 * Detection must prove the bytes match what the document claims before it
 * shows or converts anything. Conversion keeps that revision and points the
 * current document at the file. A second run does nothing.
 */
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sha256Hex } from "../src/core/attachments.js";
import { openDb } from "../src/core/db.js";
import { evidenceFilename, parseEvidenceDocument } from "../src/core/legacy-evidence.js";
import { migrateWorkspace } from "../src/core/schema.js";
import { WorkspaceStore } from "../src/core/store.js";
import { StapleError } from "../src/core/types.js";
import { initWorkspace } from "../src/core/workspace.js";
import { startUiServer, type UiHandle } from "../src/ui/server.js";
import { runCliAt, tempDir } from "./fixtures/characterize-support.js";

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const png = Buffer.from(PNG_B64, "base64");
const PNG_SHA = sha256Hex(png);

/** The AII-2 shape, byte for byte in its header lines. */
function aiiShape(opts: { sha?: string; mediaType?: string; b64?: string } = {}): string {
  return [
    "# AII-2 BEFORE screenshot",
    "",
    `Media type: ${opts.mediaType ?? "image/png"}`,
    `SHA-256: ${opts.sha ?? PNG_SHA}`,
    "Encoding: base64 data URI",
    "",
    `![AII-2 BEFORE](data:${opts.mediaType ?? "image/png"};base64,${opts.b64 ?? PNG_B64})`,
    "",
  ].join("\n");
}

function memStore(): WorkspaceStore {
  const db = openDb(":memory:");
  migrateWorkspace(db);
  return new WorkspaceStore(db, "test", "TST");
}

describe("parseEvidenceDocument", () => {
  it("verifies the AII-2 shape", () => {
    const parsed = parseEvidenceDocument(aiiShape());
    expect(parsed).not.toBeNull();
    expect(parsed!.status).toBe("verified");
    expect(parsed!.mediaType).toBe("image/png");
    expect(parsed!.sha256).toBe(PNG_SHA);
    expect(parsed!.size).toBe(png.byteLength);
    expect(parsed!.bytes!.equals(png)).toBe(true);
  });

  it("reads a fenced block of base64 lines and a bold, backticked header", () => {
    const wrapped = PNG_B64.match(/.{1,40}/g)!.join("\n");
    const body = `# Log\n\n**Media type:** \`image/png\`\n**SHA-256:** \`${PNG_SHA.toUpperCase()}\`\n\n\`\`\`\n${wrapped}\n\`\`\`\n`;
    const parsed = parseEvidenceDocument(body);
    expect(parsed?.status).toBe("verified");
    expect(parsed?.bytes?.equals(png)).toBe(true);
  });

  it("flags bytes that do not hash to the claimed SHA-256", () => {
    const parsed = parseEvidenceDocument(aiiShape({ sha: "0".repeat(64) }));
    expect(parsed?.status).toBe("sha256_mismatch");
    expect(parsed?.sha256).toBe(PNG_SHA);
    expect(parsed?.problem).toContain(PNG_SHA);
  });

  it("flags one changed byte of the payload", () => {
    const tampered = Buffer.from(png);
    tampered[tampered.length - 1]! ^= 0xff;
    const parsed = parseEvidenceDocument(aiiShape({ b64: tampered.toString("base64") }));
    expect(parsed?.status).toBe("sha256_mismatch");
  });

  it("flags bytes that are not the claimed media type", () => {
    expect(parseEvidenceDocument(aiiShape({ mediaType: "image/jpeg" }))?.status).toBe("type_mismatch");
  });

  it("flags base64 that does not decode", () => {
    const parsed = parseEvidenceDocument(aiiShape({ b64: `${PNG_B64.slice(0, -2)}A` }));
    expect(parsed?.status).toBe("undecodable");
    expect(parsed?.bytes).toBeNull();
  });

  it("leaves ordinary documents alone", () => {
    expect(parseEvidenceDocument("# Plan\n\n1. Do it\n")).toBeNull();
    // Mentions both labels, carries no payload.
    expect(parseEvidenceDocument(`Media type: image/png\nSHA-256: ${PNG_SHA}\nThe screenshot is attached.\n`)).toBeNull();
    expect(parseEvidenceDocument(`We record the SHA-256 and the media type of each file.\n`)).toBeNull();
  });

  it("names the download after the key and the real type", () => {
    expect(evidenceFilename("evidence-before-png", "image/png")).toBe("evidence-before.png");
    expect(evidenceFilename("screenshot", "image/jpeg")).toBe("screenshot.jpg");
    expect(evidenceFilename("blob", "application/octet-stream")).toBe("blob");
  });
});

describe("adoptDocumentFile", () => {
  it("makes a real file, keeps the document and its history, and is idempotent", () => {
    const store = memStore();
    const issue = store.createIssue({ title: "Evidence" });
    store.putDocument(issue.identifier, "evidence-before-png", "# draft\n", { author: "agent-a" });
    store.putDocument(issue.identifier, "evidence-before-png", aiiShape(), { author: "agent-a" });

    const first = store.adoptDocumentFile(issue.identifier, "evidence-before-png", { author: "agent-b" });
    expect(first.created).toBe(true);
    expect(first.document).toEqual({ key: "evidence-before-png", revision: 2 });
    expect(first.file).toMatchObject({ filename: "evidence-before.png", mediaType: "image/png", size: png.byteLength, sha256: PNG_SHA });
    expect(store.readFile(first.file.id).bytes.equals(png)).toBe(true);

    const second = store.adoptDocumentFile(issue.identifier, "evidence-before-png", { author: "agent-b" });
    expect(second.created).toBe(false);
    expect(second.file.id).toBe(first.file.id);
    expect(second.document.revision).toBe(3);
    expect(store.listFiles(issue.identifier)).toHaveLength(1);

    // The screenshot is a file. The document's current body says so, and the
    // revision that held the bytes is still there.
    expect(store.listDocumentRevisions(issue.identifier, "evidence-before-png").map((r) => r.revision).sort()).toEqual([1, 2, 3]);
    expect(store.getDocument(issue.identifier, "evidence-before-png", 2).body).toBe(aiiShape());
    expect(store.getDocument(issue.identifier, "evidence-before-png").body).toBe(
      `Moved to file evidence-before.png.\nsha256: ${PNG_SHA}\n`,
    );
  });

  it("refuses a mismatch and writes nothing", () => {
    const store = memStore();
    const issue = store.createIssue({ title: "Evidence" });
    store.putDocument(issue.identifier, "evidence-after-png", aiiShape({ sha: "f".repeat(64) }));
    expect(() => store.adoptDocumentFile(issue.identifier, "evidence-after-png")).toThrow(StapleError);
    expect(() => store.adoptDocumentFile(issue.identifier, "evidence-after-png")).toThrow(/not converted/);
    expect(store.listFiles(issue.identifier)).toHaveLength(0);
  });

  it("refuses a document that is not evidence", () => {
    const store = memStore();
    const issue = store.createIssue({ title: "Evidence" });
    store.putDocument(issue.identifier, "plan", "# Plan\n");
    expect(() => store.adoptDocumentFile(issue.identifier, "plan")).toThrow(/not base64 evidence/);
  });

  it("adopts an older revision when asked", () => {
    const store = memStore();
    const issue = store.createIssue({ title: "Evidence" });
    store.putDocument(issue.identifier, "shot", aiiShape());
    store.putDocument(issue.identifier, "shot", "# Replaced by a file\n");
    expect(() => store.adoptDocumentFile(issue.identifier, "shot")).toThrow(/not base64 evidence/);
    const adopted = store.adoptDocumentFile(issue.identifier, "shot", { revision: 1 });
    expect(adopted).toMatchObject({ created: true, document: { key: "shot", revision: 1 } });
  });
});

describe("staple file adopt", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  it("adopts every verified document, reports a flagged one, and creates nothing on a second run", () => {
    const home = tempDir("adopt-home");
    const repo = tempDir("adopt-repo");
    dirs.push(home, repo);
    const env = { STAPLE_HOME: home, STAPLE_AGENT: "ada" };
    expect(runCliAt(repo, ["init"], env).status).toBe(0);
    const created = runCliAt(repo, ["new", "Evidence", "--json"], env);
    const ref = (JSON.parse(created.stdout) as { identifier: string }).identifier;
    const put = (key: string, body: string) => {
      const path = join(repo, `${key}.md`);
      writeFileSync(path, body);
      const result = runCliAt(repo, ["doc", ref, key, "--put", path], env);
      expect(result.status, result.stderr).toBe(0);
    };
    put("evidence-before-png", aiiShape());
    put("evidence-after-png", aiiShape({ sha: "a".repeat(64) }));
    put("plan", "# Plan\n");

    const first = runCliAt(repo, ["file", "adopt", ref, "--json"], env);
    expect(first.status, first.stderr).toBe(0);
    const out = JSON.parse(first.stdout) as {
      adopted: Array<{ created: boolean; file: { sha256: string } }>;
      flagged: Array<{ key: string; status: string }>;
    };
    expect(out.adopted).toHaveLength(1);
    expect(out.adopted[0]).toMatchObject({ created: true, file: { sha256: PNG_SHA } });
    expect(out.flagged).toEqual([expect.objectContaining({ key: "evidence-after-png", status: "sha256_mismatch" })]);

    const again = runCliAt(repo, ["file", "adopt", ref, "evidence-before-png"], env);
    expect(again.status, again.stderr).toBe(0);
    expect(again.stdout).toMatch(/^already {2}evidence-before-png@2 -> /);
    const listed = runCliAt(repo, ["file", "ls", ref, "--json"], env);
    expect(JSON.parse(listed.stdout)).toHaveLength(1);

    const refused = runCliAt(repo, ["file", "adopt", ref, "evidence-after-png"], env);
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain("not converted");
  });
});

describe("GET /api/document and /api/document-file", () => {
  let home: string;
  let ui: UiHandle;
  let origin: string;
  let token: string;
  let ref: string;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "staple-legacy-evidence-"));
    process.env.STAPLE_HOME = home;
    process.env.NODE_NO_WARNINGS = "1";
    const ws = initWorkspace({ global: true, slug: "legacy" });
    const issue = ws.store.createIssue({ title: "AII-2 shape" });
    ref = issue.identifier;
    ws.store.putDocument(ref, "evidence-before-png", aiiShape());
    ws.store.putDocument(ref, "evidence-after-png", aiiShape({ sha: "b".repeat(64) }));
    ws.store.putDocument(ref, "plan", "# Plan\n");
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

  const get = (path: string, auth = true) => fetch(`${origin}${path}`, { headers: auth ? { "x-staple-token": token } : {} });

  it("marks a verified document and leaves a plan unmarked", async () => {
    const doc = (await (await get(`/api/document?ref=${ref}&key=evidence-before-png`)).json()) as Record<string, unknown>;
    expect(doc.evidence).toMatchObject({ status: "verified", mediaType: "image/png", sha256: PNG_SHA, filename: "evidence-before.png" });
    expect(doc.evidence).not.toHaveProperty("bytes");
    const plan = (await (await get(`/api/document?ref=${ref}&key=plan`)).json()) as Record<string, unknown>;
    expect(plan).not.toHaveProperty("evidence");
  });

  it("serves the verified bytes as the image they are", async () => {
    const res = await get(`/api/document-file?ref=${ref}&key=evidence-before-png`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-disposition")).toContain('filename="evidence-before.png"');
    expect(Buffer.from(await res.arrayBuffer()).equals(png)).toBe(true);
  });

  it("flags a mismatch and refuses to serve it", async () => {
    const doc = (await (await get(`/api/document?ref=${ref}&key=evidence-after-png`)).json()) as { evidence: { status: string } };
    expect(doc.evidence.status).toBe("sha256_mismatch");
    const res = await get(`/api/document-file?ref=${ref}&key=evidence-after-png`);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("validation");
  });

  it("refuses a plan, and a caller with no token", async () => {
    expect((await get(`/api/document-file?ref=${ref}&key=plan`)).status).toBe(404);
    expect((await get(`/api/document-file?ref=${ref}&key=evidence-before-png`, false)).status).toBe(401);
  });
});
