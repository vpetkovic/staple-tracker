/**
 * A2 acceptance: the packed `staple-cli` tarball works outside this repository.
 *
 * Everything else in the suite runs staple through `tsx src/…`, which silently supplies
 * the whole repository — TypeScript, node_modules, the UI bundle at its source path.
 * That proves the product and proves nothing about the artifact. This file builds the
 * real payload, packs it with `npm pack`, installs the tarball into a throwaway prefix
 * with no network, and then drives the installed `staple` binary from a directory that
 * is not inside this project and has no node_modules anywhere near it.
 *
 * What that arrangement is designed to catch:
 *   - an unbundled dependency (nothing is installed alongside, so it cannot resolve);
 *   - a runtime reach for src/, tsx, or the checkout (none of them exist there);
 *   - UI assets resolved relative to the repository rather than to the running bundle;
 *   - an MCP surface that only exists as an npm script rather than in the binary.
 *
 * It is deliberately slow and deliberately not skippable: `npm pack` and the install
 * both read from local files only, so there is no network condition to skip on.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildPackage } from "../scripts/build-package.js";
import { WORKSPACE_LATEST_VERSION } from "../src/core/migrations/workspace/index.js";
import { HUB_LATEST_VERSION } from "../src/core/migrations/hub/index.js";
import { bareEnv, freePort, removeDir, REPO_ROOT, tempDir } from "./fixtures/characterize-support.js";

/** Build + pack + install is a minute of work on a cold cache; do it once. */
const SETUP_TIMEOUT = 300_000;
/** Starting a real process and waiting on a socket does not fit the 5s default. */
const PROCESS_TIMEOUT = 60_000;

let staging: string;
/** Where the tarball is installed. Has node_modules. */
let prefix: string;
/** Where staple is *used*. Outside the repo, outside the prefix, no node_modules. */
let project: string;
let home: string;
let stapleBin: string;
let tarball: string;
let artifactVersion: string;
let tarballEntries: string[];

function env(extra: Record<string, string> = {}): Record<string, string> {
  // bareEnv already strips every STAPLE_* variable. NODE_PATH is cleared on top: a
  // module directory injected through the environment would hide an unbundled import,
  // which is exactly the failure this file exists to detect.
  const base = bareEnv({ STAPLE_HOME: home, ...extra });
  delete base.NODE_PATH;
  return base;
}

function runStaple(args: string[], cwd = project) {
  const result = spawnSync(stapleBin, args, {
    cwd,
    env: env(),
    encoding: "utf8",
    timeout: 60_000,
  });
  return { status: result.status ?? 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

beforeAll(async () => {
  staging = tempDir("pkg-staging");
  prefix = tempDir("pkg-prefix");
  project = tempDir("pkg-project");
  home = tempDir("pkg-home");

  // The packaged payload embeds the Vite bundle, so the bundle has to exist. Building
  // it here rather than skipping keeps this file unconditional: `npm test` alone proves
  // the artifact, whether or not someone remembered to run `npm run build:ui` first.
  if (!existsSync(join(REPO_ROOT, "src", "ui", "app", "dist", "index.html"))) {
    const uiBuild = spawnSync("npm", ["run", "build:ui"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 180_000,
    });
    expect(uiBuild.status, `npm run build:ui failed: ${uiBuild.stderr}`).toBe(0);
  }

  const built = await buildPackage();
  artifactVersion = built.version;

  // `npm pack <dir>` produces exactly what `npm publish` would upload.
  const packed = spawnSync("npm", ["pack", built.outDir, "--pack-destination", staging, "--json"], {
    encoding: "utf8",
    timeout: 120_000,
  });
  expect(packed.status, `npm pack failed: ${packed.stderr}`).toBe(0);
  const [manifest] = JSON.parse(packed.stdout) as [
    { filename: string; files: Array<{ path: string }> },
  ];
  tarball = join(staging, manifest.filename);
  tarballEntries = manifest.files.map((file) => file.path).sort();

  // A prefix npm will treat as a project root, so node_modules lands where we expect.
  writeFileSync(
    join(prefix, "package.json"),
    JSON.stringify({ name: "staple-tarball-host", version: "0.0.0", private: true }),
  );

  // --offline is the assertion, not an optimisation: the artifact declares no
  // dependencies, so a correct tarball installs with the network unavailable. If this
  // ever needs the registry, something crept back into `dependencies`.
  const installed = spawnSync(
    "npm",
    ["install", tarball, "--offline", "--no-audit", "--no-fund", "--ignore-scripts"],
    { cwd: prefix, encoding: "utf8", timeout: 180_000 },
  );
  expect(installed.status, `npm install failed: ${installed.stderr}`).toBe(0);

  stapleBin = join(prefix, "node_modules", ".bin", "staple");
}, SETUP_TIMEOUT);

afterAll(() => {
  for (const dir of [staging, prefix, project, home]) removeDir(dir);
});

describe("the packed artifact", () => {
  it("publishes as staple-cli with one bin named staple", () => {
    const pkg = JSON.parse(
      readFileSync(join(prefix, "node_modules", "staple-cli", "package.json"), "utf8"),
    ) as { name: string; bin: Record<string, string>; engines: Record<string, string> };

    expect(pkg.name).toBe("staple-cli");
    expect(pkg.bin).toEqual({ staple: "staple.mjs" });
    expect(pkg.engines.node).toBe(">=22.5.0");
  });

  it("declares the workspace schema its bundle understands, from the same migration list", () => {
    const pkg = JSON.parse(
      readFileSync(join(prefix, "node_modules", "staple-cli", "package.json"), "utf8"),
    ) as { staple: { workspaceSchema: number; hubSchema: number } };

    // The installer reads this so `staple install status` and `doctor` can say
    // which workspace a runtime opens without executing it. It has to be the
    // number compiled into the bundle, so it is derived, never typed.
    expect(pkg.staple).toEqual({ workspaceSchema: WORKSPACE_LATEST_VERSION, hubSchema: HUB_LATEST_VERSION });
  });

  it("declares no dependencies, so nothing else is installed beside it", () => {
    const pkg = JSON.parse(
      readFileSync(join(prefix, "node_modules", "staple-cli", "package.json"), "utf8"),
    ) as { dependencies: Record<string, string> };
    expect(pkg.dependencies).toEqual({});

    // The whole install is staple-cli, its bin shims, and npm's own bookkeeping.
    const installedPackages = JSON.parse(
      spawnSync("npm", ["ls", "--json", "--depth", "0"], {
        cwd: prefix,
        encoding: "utf8",
      }).stdout,
    ) as { dependencies?: Record<string, unknown> };
    expect(Object.keys(installedPackages.dependencies ?? {})).toEqual(["staple-cli"]);
  });

  it("ships runtime output only — no sources, no tests, no lockfile", () => {
    // Vite's asset filenames carry a content hash that moves whenever anyone touches
    // src/ui/app, so they are matched by shape. Everything else is pinned exactly:
    // adding a file to the published payload has to change this list.
    const hashed = tarballEntries.filter((entry) => entry.startsWith("assets/assets/"));
    expect(tarballEntries.filter((entry) => !hashed.includes(entry))).toEqual([
      "LICENSE",
      "README.md",
      "THIRD-PARTY-NOTICES.md",
      "assets/index.html",
      "package.json",
      "staple.mjs",
    ]);
    expect(hashed.length).toBeGreaterThan(0);
    // Three shapes, and only three. The bundle pair (index-<hash>.js/css); the
    // two Geist variable fonts vendored by the design layer (STA-86) — which are
    // emitted by Vite as content-hashed assets exactly like the bundle is; and
    // `icon-previews.generated-<hash>.js`, the LAZY chunk R5d (STA-184) split the
    // Lucide components into so the glyph picker can preview the whole catalog
    // without the main view carrying ~140 kB gzipped of icons it never draws
    // (docs/web-ui.md, "Glyph picker"). It ships because the picker fetches it at
    // runtime; a build that folded it back into the bundle is the regression.
    // Anything else appearing under assets/ is a payload regression, which is the
    // whole point of matching by shape instead of counting files.
    for (const entry of hashed) {
      expect(entry).toMatch(
        /^assets\/assets\/(index-[\w-]+\.(js|css)|icon-previews\.generated-[\w-]+\.js|Geist(Mono)?-Variable-[\w-]+\.woff2)$/,
      );
    }
    // The lazy chunk is exactly one file, and it is separate from the bundle.
    expect(hashed.filter((entry) => entry.includes("icon-previews.generated-"))).toHaveLength(1);
    // Named explicitly so a font silently failing to bundle — which degrades the
    // whole app to a fallback typeface without breaking anything — fails here.
    expect(hashed.filter((entry) => entry.endsWith(".woff2"))).toHaveLength(2);
  });

  it("carries no TypeScript, no tsx and no node_modules", () => {
    expect(tarballEntries.some((entry) => entry.endsWith(".ts"))).toBe(false);
    expect(tarballEntries.some((entry) => entry.includes("node_modules"))).toBe(false);
    expect(tarballEntries.some((entry) => entry.startsWith("src/"))).toBe(false);
    expect(tarballEntries.some((entry) => entry.startsWith("test/"))).toBe(false);
  });

  it("leaves only Node built-ins as imports of the bundle", () => {
    const bundle = readFileSync(join(prefix, "node_modules", "staple-cli", "staple.mjs"), "utf8");
    // Top-level import statements are the only place an unresolved specifier can hide;
    // esbuild emits them all in a block at the head of the file.
    const specifiers = [...bundle.matchAll(/^import\s[^;]*?from\s*"([^"]+)";$/gm)].map((m) => m[1]);
    expect(specifiers.length).toBeGreaterThan(0);
    expect(specifiers.filter((s) => !s!.startsWith("node:"))).toEqual([]);
  });
});

describe("the installed binary, run from outside this repository", () => {
  it("is not standing in a directory that could supply modules", () => {
    // If this ever fails the rest of the file proves much less than it claims to.
    expect(existsSync(join(project, "node_modules"))).toBe(false);
    expect(project.startsWith(prefix)).toBe(false);
  });

  it("reports its version", () => {
    const result = runStaple(["--version"]);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(artifactVersion);
  });

  it("prints usage for --help", () => {
    const result = runStaple(["--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("staple");
    expect(result.stdout).toContain("init");
  });

  it("initializes a workspace in a plain directory", () => {
    const result = runStaple(["init"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Created workspace");
    expect(existsSync(join(project, ".staple", "staple.db"))).toBe(true);
  });

  it("creates an issue and lists it back as JSON", () => {
    const created = runStaple(["new", "packaged runtime works", "-p", "high"]);
    expect(created.status, created.stderr).toBe(0);

    const listed = runStaple(["ls", "--json"]);
    expect(listed.status, listed.stderr).toBe(0);
    const issues = JSON.parse(listed.stdout) as Array<{ title: string; priority: string }>;
    expect(issues.map((issue) => issue.title)).toContain("packaged runtime works");
    expect(issues.find((issue) => issue.title === "packaged runtime works")?.priority).toBe("high");
  });

  it("serves the bundled UI assets, not the repository's", async () => {
    const port = await freePort();
    const child = spawn(stapleBin, ["ui", "--port", String(port), "--no-open"], {
      cwd: project,
      env: env(),
      detached: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));

    try {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline && !stdout.includes(`http://localhost:${port}/`)) {
        await new Promise((r) => setTimeout(r, 50));
      }
      // The startup line is the contract a wrapper script greps for.
      expect(stdout, stderr).toContain(`staple ui — `);
      expect(stdout).toContain(`http://localhost:${port}/`);
      // The build hint means asset resolution fell back to a repository path that is
      // not there — the precise regression this ticket's server.ts seam prevents.
      expect(stderr).not.toContain("npm run build:ui");

      const page = await fetch(`http://127.0.0.1:${port}/`);
      expect(page.status).toBe(200);
      const html = await page.text();
      // The real Vite bundle, not the "UI not built" placeholder.
      expect(html).toContain("/assets/index-");
      expect(html).not.toContain("the UI bundle has not been built");

      // …and the hashed asset it points at is actually served from the package. Vite
      // emits the reference relative (`./assets/…`), so it is resolved against the page.
      const assetPath = /src="(\.?\/assets\/[^"]+\.js)"/.exec(html)?.[1];
      expect(assetPath, html.slice(0, 400)).toBeDefined();
      const asset = await fetch(new URL(assetPath!, `http://127.0.0.1:${port}/`));
      expect(asset.status).toBe(200);
      expect(asset.headers.get("content-type")).toContain("javascript");
    } finally {
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
    }
  }, PROCESS_TIMEOUT);

  it("answers an MCP handshake on the same binary via `staple mcp`", async () => {
    const child = spawn(stapleBin, ["mcp"], {
      cwd: project,
      env: env({ STAPLE_AGENT: "tarball-test" }),
      stdio: ["pipe", "pipe", "pipe"],
    });

    let buffer = "";
    let banner = "";
    const pending = new Map<number, (message: Record<string, unknown>) => void>();
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let index: number;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        const message = JSON.parse(line) as { id?: number };
        if (message.id !== undefined && pending.has(message.id)) {
          pending.get(message.id)!(message as Record<string, unknown>);
          pending.delete(message.id);
        }
      }
    });
    child.stderr.on("data", (chunk: Buffer) => (banner += chunk.toString("utf8")));

    let nextId = 1;
    const rpc = (method: string, params: unknown): Promise<Record<string, unknown>> => {
      const id = nextId++;
      return new Promise((resolvePromise, reject) => {
        const timer = setTimeout(() => reject(new Error(`${method} timed out. stderr: ${banner}`)), 30_000);
        pending.set(id, (message) => {
          clearTimeout(timer);
          resolvePromise(message);
        });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    };

    try {
      const initialized = (await rpc("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "a2-tarball-test", version: "0" },
      })) as { result?: { serverInfo?: { name?: string } } };
      expect(initialized.result?.serverInfo?.name).toBeTruthy();
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

      const listed = (await rpc("tools/list", {})) as { result?: { tools?: Array<{ name: string }> } };
      const tools = listed.result?.tools ?? [];
      // The same tools scripts/smoke-mcp.ts exercises against the source tree.
      // STA-71 added one, cloud_status, taking this from 40 to 41.
      expect(tools).toHaveLength(41);
      expect(tools.map((tool) => tool.name)).toContain("list_tasks");

      // A real call, so this proves the workspace path too, not just the handshake.
      const called = (await rpc("tools/call", {
        name: "list_tasks",
        arguments: {},
      })) as { result?: { isError?: boolean; content?: Array<{ text?: string }> } };
      expect(called.result?.isError).toBeFalsy();
      expect(called.result?.content?.[0]?.text).toContain("packaged runtime works");

      expect(banner).toContain("staple mcp ready");
    } finally {
      child.kill("SIGKILL");
    }
  }, PROCESS_TIMEOUT);
});
