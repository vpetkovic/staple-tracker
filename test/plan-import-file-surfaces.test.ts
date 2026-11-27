/**
 * Ideas from files on every surface (design/plan.md, "Ideas from files"): the Plan view's Import
 * (HTTP, as the person), `staple idea import` and an agent's `import_idea` take .md, .html and .jsx,
 * keep the original under Files, and answer the same idea; with no maturity chosen each leaves a
 * classify step an agent settles with `classified`. Maturity is the person's: the page and the CLI
 * with --person set it, an agent's import is always raw and waits to be classified.
 */
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startUiServer, type UiHandle } from "../src/ui/server.js";
import { CONTRACT_AGENT, runCliAsync, startMcpClient, toolPayload, type McpHarness } from "./fixtures/contract-support.js";

const WS = "importws";
let home: string;
let emptyDir: string;
let mcp: McpHarness;
let ui: UiHandle;
let origin: string;
let token: string;

async function http(path: string, body?: Record<string, unknown>) {
  const response = await fetch(`${origin}${path}`, {
    method: body ? "POST" : "GET",
    headers: { "x-staple-token": token, ...(body ? { "content-type": "application/json", origin } : {}) },
    body: body ? JSON.stringify({ ws: WS, actor: "VP", ...body }) : undefined,
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

const cli = (...args: string[]) => runCliAsync([...args, "--ws", WS], { STAPLE_HOME: home, STAPLE_AGENT: CONTRACT_AGENT });

const HTML = `<!doctype html><html><head><title>Passkeys chat</title></head><body><p>We talked.</p></body></html>`;
const MARKDOWN = `# Gift cards\n\nSell gift cards.\n\n## Goal\n\nCustomers redeem cards.\n\n## Task breakdown\n\n| # | Task | Est. |\n|---|---|---|\n| 1 | Card model | 2h |\n\n## Acceptance criteria\n\n- Redeemed at checkout\n`;
const JSX = `export const Mock = () => <div>Pay</div>;\n`;

interface ImportAnswer {
  idea: { idea: { id: string; title: string; maturity: string; state: string; nextStep: { need: string; who: string; horizonId: string | null } | null }; plan: { goal: string | null; breakdown: unknown[] } };
  rows: number;
  warnings: string[];
}

/** What every surface's answer says of the idea, without the ids and times that differ. */
const gist = (detail: ImportAnswer["idea"]) => ({
  title: detail.idea.title,
  maturity: detail.idea.maturity,
  state: detail.idea.state,
  step: detail.idea.nextStep === null ? null : { need: detail.idea.nextStep.need, who: detail.idea.nextStep.who, horizonId: detail.idea.nextStep.horizonId },
  goal: detail.plan.goal,
  rows: detail.plan.breakdown.length,
});

async function files(ref: string): Promise<Array<{ filename: string; mediaType: string }>> {
  return (toolPayload(await mcp.call("list_files", { ws: WS, ref })) as { files: Array<{ filename: string; mediaType: string }> }).files.map(({ filename, mediaType }) => ({ filename, mediaType }));
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "staple-import-home-"));
  emptyDir = mkdtempSync(join(tmpdir(), "staple-import-cwd-"));
  process.env.STAPLE_HOME = home;
  process.env.NODE_NO_WARNINGS = "1";
  expect((await runCliAsync(["init", "--global", WS], { STAPLE_HOME: home, STAPLE_AGENT: CONTRACT_AGENT })).status).toBe(0);
  expect((await runCliAsync(["config", "set", "humanName", "VP"], { STAPLE_HOME: home, STAPLE_AGENT: CONTRACT_AGENT })).status).toBe(0);
  mcp = await startMcpClient({ home, cwd: emptyDir, agent: CONTRACT_AGENT });
  ui = startUiServer({ port: 0, hub: true });
  await once(ui.server, "listening");
  token = ui.token;
  origin = `http://127.0.0.1:${(ui.server.address() as AddressInfo).port}`;
  expect((await http("/api/settings", { target: "settings", ops: [{ op: "set", key: "features.planning", value: true }] })).status).toBe(200);
}, 60_000);

afterAll(async () => {
  await mcp?.close();
  ui?.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(emptyDir, { recursive: true, force: true });
});

describe("importing a file on every surface", () => {
  it("answers the same idea, with the original under Files and a classify step, from the page, the CLI and an agent", async () => {
    const page = await http("/api/plan/import", { filename: "passkeys.html", contentBase64: Buffer.from(HTML).toString("base64") });
    expect(page.status, JSON.stringify(page.body)).toBe(200);
    const fromPage = page.body.idea as ImportAnswer["idea"];

    const path = join(home, "passkeys.html");
    writeFileSync(path, HTML);
    const terminal = await cli("idea", "import", path, "--json");
    expect(terminal.status, terminal.stderr).toBe(0);
    const fromCli = (JSON.parse(terminal.stdout) as ImportAnswer).idea;

    const agent = toolPayload(await mcp.call("import_idea", { ws: WS, content: HTML, filename: "passkeys.html" })) as ImportAnswer;
    const viaPath = toolPayload(await mcp.call("import_idea", { ws: WS, path })) as ImportAnswer;
    const viaBytes = toolPayload(await mcp.call("import_idea", { ws: WS, bytes_base64: Buffer.from(HTML).toString("base64"), filename: "passkeys.html" })) as ImportAnswer;

    const expected = { title: "Passkeys chat", maturity: "raw", state: "raw", step: { need: "classify", who: "agent", horizonId: null }, goal: null, rows: 0 };
    for (const detail of [fromPage, fromCli, agent.idea, viaPath.idea, viaBytes.idea]) {
      expect(gist(detail)).toEqual(expected);
      expect(await files(detail.idea.id)).toEqual([{ filename: "passkeys.html", mediaType: "text/html" }]);
    }
    // get_idea, idea show --json and /api/plan-idea read it the same.
    const id = agent.idea.idea.id;
    const read = toolPayload(await mcp.call("get_idea", { ws: WS, ref: id })) as ImportAnswer["idea"];
    const shown = JSON.parse((await cli("idea", "show", id, "--json")).stdout) as ImportAnswer["idea"];
    const onPage = (await http(`/api/plan-idea?ws=${WS}&ref=${id}`)).body as unknown as ImportAnswer["idea"];
    expect(gist(read)).toEqual(expected);
    expect(gist(shown)).toEqual(expected);
    expect(gist(onPage)).toEqual(expected);
  });

  it("maps Markdown to sections and takes JSX on every surface, and prints the classify step on the CLI", async () => {
    const md = join(home, "gift-cards.md");
    writeFileSync(md, MARKDOWN);
    const terminal = await cli("idea", "import", md);
    expect(terminal.status, terminal.stderr).toBe(0);
    expect(terminal.stdout).toContain("imported Gift cards");
    expect(terminal.stdout).toContain("to classify: no maturity was chosen");
    const agent = toolPayload(await mcp.call("import_idea", { ws: WS, content: MARKDOWN, filename: "gift-cards.md" })) as ImportAnswer;
    expect(gist(agent.idea)).toMatchObject({ title: "Gift cards", goal: "Customers redeem cards.", rows: 1, step: { need: "classify" } });
    const page = await http("/api/plan/import", { filename: "mock.jsx", contentBase64: Buffer.from(JSX).toString("base64") });
    expect(gist(page.body.idea as ImportAnswer["idea"])).toMatchObject({ title: "mock", step: { need: "classify" } });
  });

  it("lets the person choose the stage on the page and the CLI, which leaves no classify step, and keeps it from an agent", async () => {
    const page = await http("/api/plan/import", { filename: "chosen.md", contentBase64: Buffer.from(MARKDOWN).toString("base64"), maturity: "exploring" });
    expect(gist(page.body.idea as ImportAnswer["idea"])).toMatchObject({ maturity: "exploring", step: null });
    const md = join(home, "chosen.md");
    writeFileSync(md, MARKDOWN);
    const person = await cli("idea", "import", md, "--maturity", "exploring", "--person", "--json");
    expect(gist((JSON.parse(person.stdout) as ImportAnswer).idea)).toMatchObject({ maturity: "exploring", step: null });
    // Without --person the maturity is refused: it is the person's.
    const unattributed = await cli("idea", "import", md, "--maturity", "exploring");
    expect(unattributed.status).not.toBe(0);
    // import_idea takes no maturity: an agent's import is always raw and waits to be classified.
    const agent = await mcp.call("import_idea", { ws: WS, content: MARKDOWN, filename: "chosen.md", maturity: "shaped" });
    expect(gist((toolPayload(agent) as ImportAnswer).idea)).toMatchObject({ maturity: "raw", step: { need: "classify" } });
  });

  it("settles the classify step with classified on every surface", async () => {
    const make = async () => (toolPayload(await mcp.call("import_idea", { ws: WS, content: HTML, filename: "settle.html" })) as ImportAnswer).idea.idea.id;
    const [viaMcp, viaCli, viaPage] = [await make(), await make(), await make()];
    expect((toolPayload(await mcp.call("update_idea", { ws: WS, ref: viaMcp, classified: true })) as ImportAnswer["idea"]).idea.nextStep).toBeNull();
    const terminal = await cli("idea", "set", viaCli, "--classified", "--json");
    expect(terminal.status, terminal.stderr).toBe(0);
    expect((JSON.parse(terminal.stdout) as ImportAnswer["idea"]).idea.nextStep).toBeNull();
    const page = await http("/api/plan/update", { ref: viaPage, classified: true });
    expect((page.body.idea as ImportAnswer["idea"]).idea.nextStep).toBeNull();
    // Once settled, there is nothing to classify: refused on each.
    expect(JSON.stringify((await mcp.call("update_idea", { ws: WS, ref: viaMcp, classified: true })).content)).toContain("Nothing waits to be classified");
    expect((await cli("idea", "set", viaCli, "--classified")).stderr).toContain("Nothing waits to be classified");
    expect((await http("/api/plan/update", { ref: viaPage, classified: true })).status).toBe(409);
  });

  it("refuses a file type it does not take on every surface, and a raw write of the classify request", async () => {
    const page = await http("/api/plan/import", { filename: "notes.pdf", contentBase64: Buffer.from("%PDF-1.4").toString("base64") });
    expect(page.status).toBe(409);
    expect(JSON.stringify(page.body)).toContain(".md, .html or .jsx");
    const pdf = join(home, "notes.pdf");
    writeFileSync(pdf, "%PDF-1.4");
    expect((await cli("idea", "import", pdf)).stderr).toContain(".md, .html or .jsx");
    const agent = await mcp.call("import_idea", { ws: WS, content: "x", filename: "notes.txt" });
    expect(agent.isError).toBe(true);
    expect(JSON.stringify(agent.content)).toContain(".md, .html or .jsx");
    expect(JSON.stringify((await mcp.call("import_idea", { ws: WS, content: HTML })).content)).toContain("needs a filename");
    expect(JSON.stringify((await mcp.call("import_idea", { ws: WS, content: HTML, path: pdf, filename: "a.html" })).content)).toContain("one of path, content or bytes_base64");
    const id = (toolPayload(await mcp.call("import_idea", { ws: WS, content: HTML, filename: "raw-write.html" })) as ImportAnswer).idea.idea.id;
    const put = await mcp.call("put_document", { ws: WS, ref: id, key: "classify", body: "" });
    expect(JSON.stringify(put.content)).toContain("classify request");
  });
});
