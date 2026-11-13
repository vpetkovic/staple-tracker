/**
 * The CLI as one file, for tests that run it hundreds of times.
 *
 * `runCliAsync` starts the CLI through tsx, which loads and transforms the whole TypeScript
 * module graph on every run: about a quarter of a second of CPU before the command starts. A walk
 * that runs the CLI for every cell of a table spends most of its time there. This builds the same
 * source into one ES module once per test process (esbuild, packages left to node_modules), and
 * runs that with plain node. Each module keeps its own `import.meta.url`, so a path a module
 * resolves next to itself resolves as it does from source. The bundle lives under `.cache/` in
 * the repository, so bare imports resolve from its node_modules, and is removed when the
 * process exits.
 */
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build, type Plugin } from "esbuild";
import { CLI_ENTRY, REPO_ROOT, cleanEnv, type CliResult } from "./contract-support.js";
import { spawnAsync } from "./spawn-async.js";

let built: Promise<string> | null = null;

const ownMetaUrl: Plugin = {
  name: "own-import-meta-url",
  setup(on) {
    on.onLoad({ filter: /\/src\/.*\.ts$/ }, (args) => {
      const url = JSON.stringify(pathToFileURL(args.path).href);
      const source = readFileSync(args.path, "utf8");
      if (!source.includes("import.meta.")) return { contents: source, loader: "ts" };
      const contents = source
        .replace(/import\.meta\.url/g, url)
        .replace(/import\.meta\.dirname/g, `new URL(".", ${url}).pathname.replace(/\\/$/, "")`)
        .replace(/import\.meta\.filename/g, `new URL(${url}).pathname`);
      return { contents, loader: "ts" };
    });
  },
};

/** The bundled CLI's path, built on first use in this process. */
export function bundledCli(): Promise<string> {
  built ??= (async () => {
    const dir = join(REPO_ROOT, ".cache", "test-cli");
    mkdirSync(dir, { recursive: true });
    const out = join(dir, `cli-${process.pid}-${Date.now()}.mjs`);
    await build({
      entryPoints: [CLI_ENTRY],
      outfile: out,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      packages: "external",
      logLevel: "silent",
      plugins: [ownMetaUrl],
    });
    process.once("exit", () => rmSync(out, { force: true }));
    return out;
  })();
  return built;
}

/** `runCliAsync`, on the bundled CLI: the same arguments, environment and result. */
export async function runBundledCli(args: string[], env: Record<string, string>): Promise<CliResult> {
  const cli = await bundledCli();
  const result = await spawnAsync(process.execPath, [cli, ...args], {
    cwd: REPO_ROOT,
    env: cleanEnv(env),
    encoding: "utf8",
  });
  return { status: result.status ?? 0, stdout: result.stdout, stderr: result.stderr };
}

