/**
 * Typed file attachments: the bytes are sniffed, capped, stored, and returned
 * identical, and a listing never carries them.
 */
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ATTACH_MAX_BYTES, sha256Hex, sniffMediaType } from "../src/core/attachments.js";
import { openDb } from "../src/core/db.js";
import { migrateWorkspace } from "../src/core/schema.js";
import { WorkspaceStore } from "../src/core/store.js";
import { StapleError } from "../src/core/types.js";
import { runCliAt, tempDir } from "./fixtures/characterize-support.js";
import { startMcpClient, toolPayload, type McpHarness } from "./fixtures/contract-support.js";

function memStore(): WorkspaceStore {
  const db = openDb(":memory:");
  migrateWorkspace(db);
  return new WorkspaceStore(db, "test", "TST");
}

const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
const pdf = Uint8Array.from(Buffer.from("%PDF-1.4\n"));
const mp4 = Uint8Array.from(Buffer.from("\0\0\0\0ftypisom"));
const text = Uint8Array.from(Buffer.from("build log\n"));

describe("sniffing", () => {
  it("reads the bytes and ignores the name", () => {
    expect(sniffMediaType(png)).toBe("image/png");
    expect(sniffMediaType(pdf)).toBe("application/pdf");
    expect(sniffMediaType(mp4)).toBe("video/mp4");
    expect(sniffMediaType(text)).toBe("text/plain");
    expect(sniffMediaType(Uint8Array.from(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'></svg>")))).toBe("image/svg+xml");
    expect(sniffMediaType(Uint8Array.from(Buffer.from("<!DOCTYPE html><html></html>")))).toBe("text/html");
    expect(sniffMediaType(Uint8Array.from([0, 1, 2, 3, 4]))).toBe("application/octet-stream");
    expect(sniffMediaType(new Uint8Array())).toBe("application/octet-stream");
  });
});

describe("the store", () => {
  it("keeps the bytes identical, shares one copy, and lists metadata only", () => {
    const store = memStore();
    const issue = store.createIssue({ title: "Evidence" });
    const first = store.attachFile(issue.identifier, { filename: "shot.txt", bytes: png, caption: "before", author: "ada" });
    const second = store.attachFile(issue.identifier, { filename: "again.png", bytes: png, author: "ada" });
    expect(first.mediaType).toBe("image/png");
    expect(first.sha256).toBe(sha256Hex(png));
    expect(first.byteSync).toBe("inline");
    expect(store.readFile(first.id).bytes.equals(Buffer.from(png))).toBe(true);

    const blobs = store.db.prepare("SELECT COUNT(*) AS n FROM attachment_bytes").get() as { n: number };
    expect(blobs.n).toBe(1);
    store.removeFile(first.id, "ada");
    expect((store.db.prepare("SELECT COUNT(*) AS n FROM attachment_bytes").get() as { n: number }).n).toBe(1);
    store.removeFile(second.id, "ada");
    expect((store.db.prepare("SELECT COUNT(*) AS n FROM attachment_bytes").get() as { n: number }).n).toBe(0);

    const again = store.attachFile(issue.identifier, { filename: "notes.txt", bytes: text, author: "ada" });
    const listed = store.context(issue.identifier).attachments;
    expect(listed.map((file) => file.id)).toEqual([again.id]);
    expect(JSON.stringify(listed)).not.toMatch(/"bytes"/);

    expect(() => store.attachFile(issue.identifier, { filename: "big.bin", bytes: Buffer.alloc(ATTACH_MAX_BYTES + 1) })).toThrow(StapleError);
    expect(store.listFiles(issue.identifier).map((file) => file.id)).toEqual([again.id]);
    store.db.close();
  });
});

describe("the CLI and MCP", () => {
  const dirs: string[] = [];
  const harnesses: McpHarness[] = [];
  afterEach(async () => {
    for (const harness of harnesses) await harness.close();
    harnesses.length = 0;
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  function workspace(): { home: string; repo: string; env: Record<string, string> } {
    const home = tempDir("file-home");
    const repo = tempDir("file-repo");
    dirs.push(home, repo);
    const env = { STAPLE_HOME: home, STAPLE_AGENT: "ada" };
    expect(runCliAt(repo, ["init"], env).status).toBe(0);
    return { home, repo, env };
  }

  it("attaches, lists, exports and removes, and refuses an oversized file with exit 16", () => {
    const { repo, env } = workspace();
    const created = runCliAt(repo, ["new", "Evidence", "--json"], env);
    expect(created.status, created.stderr).toBe(0);
    const ref = (JSON.parse(created.stdout) as { identifier: string }).identifier;
    const source = join(repo, "shot.txt");
    writeFileSync(source, png);

    const attached = runCliAt(repo, ["file", "attach", ref, source, "--filename", "shot.txt", "--json"], env);
    expect(attached.status, attached.stderr).toBe(0);
    const meta = JSON.parse(attached.stdout) as { id: string; mediaType: string; sha256: string };
    expect(meta.mediaType).toBe("image/png");
    expect(meta.sha256).toBe(sha256Hex(png));

    const shown = runCliAt(repo, ["show", ref, "--json"], env);
    expect(shown.status, shown.stderr).toBe(0);
    const detail = JSON.parse(shown.stdout) as { attachments: Array<Record<string, unknown>> };
    expect(detail.attachments).toHaveLength(1);
    expect(detail.attachments[0]).not.toHaveProperty("bytes");

    const out = join(repo, "out.png");
    const got = runCliAt(repo, ["file", "get", meta.id, "--out", out, "--json"], env);
    expect(got.status, got.stderr).toBe(0);
    expect(readFileSync(out).equals(Buffer.from(png))).toBe(true);
    expect(JSON.parse(got.stdout)).not.toHaveProperty("bytes");

    expect(runCliAt(repo, ["file", "rm", meta.id], env).status).toBe(0);
    expect(runCliAt(repo, ["file", "ls", ref], env).stdout).toContain("(no files)");

    const big = join(repo, "big.bin");
    writeFileSync(big, Buffer.alloc(ATTACH_MAX_BYTES + 1));
    const refused = runCliAt(repo, ["file", "attach", ref, big], env);
    expect(refused.status).toBe(16);
    expect(runCliAt(repo, ["file", "ls", ref], env).stdout).toContain("(no files)");
  }, 60_000);

  it("attaches from MCP by path and by base64, and get_task omits the bytes", async () => {
    const { home, repo } = workspace();
    const harness = await startMcpClient({ home, cwd: repo, agent: "ada" });
    harnesses.push(harness);
    const created = toolPayload(await harness.call("create_task", { title: "Evidence", actor: "ada" })) as { identifier: string };
    const source = join(repo, "log.txt");
    writeFileSync(source, text);

    const fromPath = toolPayload(
      await harness.call("attach_file", { ref: created.identifier, path: source, actor: "ada" }),
    ) as { id: string; mediaType: string; sha256: string };
    expect(fromPath.mediaType).toBe("text/plain");

    const fromBytes = toolPayload(
      await harness.call("attach_file", {
        ref: created.identifier,
        bytes_base64: Buffer.from(pdf).toString("base64"),
        filename: "spec.pdf",
        actor: "ada",
      }),
    ) as { id: string; mediaType: string };
    expect(fromBytes.mediaType).toBe("application/pdf");

    const listed = toolPayload(await harness.call("list_files", { ref: created.identifier })) as { files: Array<{ id: string }> };
    expect(listed.files.map((file) => file.id)).toEqual([fromPath.id, fromBytes.id]);

    const task = toolPayload(await harness.call("get_task", { ref: created.identifier })) as { attachments: Array<Record<string, unknown>> };
    expect(task.attachments).toHaveLength(2);
    expect(JSON.stringify(task.attachments)).not.toMatch(/"bytes"/);

    const out = join(repo, "spec.pdf");
    const exported = toolPayload(await harness.call("export_file", { id: fromBytes.id, out })) as { sha256: string };
    expect(readFileSync(out).equals(Buffer.from(pdf))).toBe(true);
    expect(exported.sha256).toBe(sha256Hex(pdf));

    await harness.call("remove_file", { id: fromPath.id, actor: "ada" });
    const removed = await harness.call("remove_file", { id: fromPath.id, actor: "ada" });
    expect(removed.isError).toBe(true);
  }, 60_000);
});
