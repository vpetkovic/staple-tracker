/**
 * Build the publishable `staple-cli` payload.
 *
 * Produces dist-package/, a directory that is itself a complete npm package: run
 * `npm pack` inside it and the tarball installs and runs anywhere with Node >= 22.5
 * and nothing else. No TypeScript, no tsx, no node_modules, no repository checkout.
 *
 *   dist-package/
 *     package.json            generated — name staple-cli, bin staple, no dependencies
 *     staple.mjs              esbuild bundle: CLI + MCP server + every non-builtin dep
 *     assets/index.html       the Vite UI bundle, copied beside staple.mjs
 *     assets/assets/*         its hashed js/css
 *     README.md
 *     LICENSE
 *     THIRD-PARTY-NOTICES.md  the repository's notices + the bundled dependency graph
 *
 * The layout is flat on purpose: STA-24 §6 has the installer stage a packed runtime
 * into `<home>/runtime/versions/<version>/` as `staple.mjs` beside `assets/`, so the
 * tarball contents can be copied into a version directory verbatim.
 *
 * Why the source package.json is not the published one: it stays `private: true` so a
 * stray `npm publish` at the repository root cannot ship the source tree. The artifact
 * metadata is generated here, taking `version` from the source package.json so there
 * is still exactly one place to bump.
 *
 * The payload is assembled and verified in a temporary sibling of the target, then
 * renamed into place (see `promote`). The target is never deleted up front and never
 * written piece by piece, so it is never half-built, and a build that fails leaves the
 * previous payload where it was. It is not atomic: another process can find the
 * target missing for the instant between the two renames that swap it. No test and no
 * deploy step reads it while a build runs (the test suite builds its own payload).
 */
import { build } from "esbuild";
import { randomBytes } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { WORKSPACE_LATEST_VERSION } from "../src/core/migrations/workspace/index.js";
import { HUB_LATEST_VERSION } from "../src/core/migrations/hub/index.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultOutDir = join(repoRoot, "dist-package");
const uiDist = join(repoRoot, "src", "ui", "app", "dist");

const sourcePkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
  version: string;
  description: string;
  license: string;
  engines: Record<string, string>;
  dependencies?: Record<string, string>;
};

/**
 * Everything except Node's own built-ins is bundled. `node:sqlite` is the load-bearing
 * one — it is a builtin, so it must stay external, and esbuild's node platform already
 * externalises the `node:` scheme. Nothing else may survive as an import: the published
 * runtime has no node_modules to resolve from. verifyNoExternalImports enforces that.
 */
async function bundle(dir: string): Promise<{ bundledPackages: string[]; externals: string[] }> {
  const result = await build({
    entryPoints: [join(repoRoot, "src", "package", "staple.ts")],
    outfile: join(dir, "staple.mjs"),
    bundle: true,
    // No splitting: the dynamic imports in the entrypoint stay inlined and lazy, so one
    // file holds both surfaces and only the dispatched one evaluates.
    splitting: false,
    format: "esm",
    platform: "node",
    target: "node22.5",
    // No shebang banner: esbuild hoists the `#!/usr/bin/env node` that src/package/
    // staple.ts already carries. Adding one here emits it twice, and the second copy
    // is a syntax error only Node catches — at the user's first run, not at build.
    define: { __STAPLE_VERSION__: JSON.stringify(sourcePkg.version) },
    legalComments: "none",
    metafile: true,
    logLevel: "warning",
  });

  // Every non-builtin package whose files ended up inside the bundle, for the notices.
  const packages = new Set<string>();
  for (const input of Object.keys(result.metafile.inputs)) {
    const name = /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(input)?.[1];
    if (name) packages.add(name);
  }

  // What esbuild actually left as an import of the output file. This is the honest
  // question — the bundle text also contains bare specifiers inside comments and inside
  // Ajv's standalone-codegen string templates, and neither is an import.
  const output = Object.values(result.metafile.outputs).find((o) => o.entryPoint);
  const externals = (output?.imports ?? [])
    .filter((imported) => imported.external)
    .map((imported) => imported.path);

  return { bundledPackages: [...packages].sort(), externals: [...new Set(externals)].sort() };
}

/**
 * The published bundle must not reach for node_modules at runtime: it is installed with
 * no dependencies and may run from a versioned runtime directory with no node_modules
 * anywhere above it. Only Node's own built-ins may remain external.
 * STA-24 §6: "Any unresolved non-built-in import fails A2."
 */
function verifyNoExternalImports(externals: string[]): void {
  const offenders = externals.filter((specifier) => !specifier.startsWith("node:"));
  if (offenders.length > 0) {
    throw new Error(
      `bundle has unresolved non-builtin imports, so it cannot run without node_modules: ${offenders.join(", ")}`,
    );
  }
}

/**
 * The bin must start with exactly one shebang and be executable.
 *
 * Both halves are easy to get wrong in a way nothing catches until a user runs the
 * installed command: esbuild hoists the entrypoint's own `#!` line, so a `banner`
 * shebang on top of it produces a second one that is a syntax error, and npm's bin
 * shim on POSIX execs the file directly.
 */
function verifyExecutableBin(bundlePath: string): void {
  const [first, second] = readFileSync(bundlePath, "utf8").split("\n", 2);
  if (first !== "#!/usr/bin/env node") {
    throw new Error(`bin does not start with a node shebang: ${JSON.stringify(first)}`);
  }
  if (second?.startsWith("#!")) {
    throw new Error("bin has two shebangs; the second one is a syntax error at runtime");
  }
  if ((statSync(bundlePath).mode & 0o111) === 0) {
    throw new Error("bin is not executable");
  }
}

/** The UI bundle, copied beside staple.mjs as assets/ — the layout resolveUiDistDir probes for. */
function copyUiAssets(dir: string): void {
  if (!existsSync(join(uiDist, "index.html"))) {
    throw new Error(
      `the UI bundle is missing at ${uiDist}. Run \`npm run build:ui\` before building the package.`,
    );
  }
  cpSync(uiDist, join(dir, "assets"), { recursive: true });
}

function writeArtifactManifest(dir: string, bundledPackages: string[]): void {
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify(
      {
        name: "staple-cli",
        version: sourcePkg.version,
        description: sourcePkg.description,
        license: sourcePkg.license,
        type: "module",
        // One executable, one entrypoint. `npx -y staple-cli` and an installed `staple`
        // both land here, per STA-24's key decision.
        bin: { staple: "staple.mjs" },
        engines: sourcePkg.engines,
        // The schema versions compiled into this bundle, read from the same migration
        // lists the bundle carries. The installer records them so `staple install
        // status` and `doctor` can say which workspace a runtime understands without
        // executing it; a workspace stamped higher is refused by that runtime.
        staple: { workspaceSchema: WORKSPACE_LATEST_VERSION, hubSchema: HUB_LATEST_VERSION },
        // Nothing is left to install: the bundle carries its dependencies inside it.
        dependencies: {},
        files: ["staple.mjs", "assets/", "README.md", "LICENSE", "THIRD-PARTY-NOTICES.md"],
      },
      null,
      2,
    )}\n`,
  );

  // The artifact's notices are the repository's hand-maintained notices (the vendored
  // source whose licenses require a preserved copyright, which the UI bundle ships)
  // plus the generated list of packages esbuild compiled into staple.mjs. Both halves
  // ride in the tarball, so one file has to carry both.
  const vendoredNotices = readFileSync(join(repoRoot, "THIRD-PARTY-NOTICES.md"), "utf8").trimEnd();
  const notices = [
    vendoredNotices,
    "",
    "## Bundled npm packages",
    "",
    "`staple.mjs` is a single bundle. The following packages are compiled into it;",
    "their own licenses continue to apply to their code.",
    "",
    ...bundledPackages.map((name) => `- ${name}`),
    "",
    // The fonts are not bundled INTO staple.mjs — they are separate assets served
    // by the UI — so they are not in `bundledPackages` and would otherwise ship
    // with no attribution at all. The OFL requires the notice to travel with the
    // font, and the tarball is where it travels.
    "## Fonts",
    "",
    "The web UI ships Geist Sans and Geist Mono as `assets/assets/Geist*-Variable-*.woff2`.",
    "",
    "> Geist — Copyright (c) 2023 Vercel, in collaboration with basement.studio.",
    "> Licensed under the SIL Open Font License, Version 1.1.",
    "> The full license text is in the source tree at",
    "> `src/ui/app/src/assets/fonts/GEIST-OFL-LICENSE.txt`.",
    "",
  ].join("\n");
  writeFileSync(join(dir, "THIRD-PARTY-NOTICES.md"), notices);

  cpSync(join(repoRoot, "README.md"), join(dir, "README.md"));
  cpSync(join(repoRoot, "LICENSE"), join(dir, "LICENSE"));
}

/**
 * The published tree must contain runtime output and metadata only — no sources, no
 * tests, no lockfile, nothing private. Checked here rather than trusted to `files`,
 * because dist-package/ is built fresh and an accidental stray copy would ship.
 */
function verifyNoSourceLeaks(dir: string): void {
  const allowed = new Set([
    "package.json",
    "staple.mjs",
    "assets",
    "README.md",
    "LICENSE",
    "THIRD-PARTY-NOTICES.md",
  ]);
  const unexpected = readdirSync(dir).filter((name) => !allowed.has(name));
  if (unexpected.length > 0) {
    throw new Error(`unexpected files in the publishable payload: ${unexpected.join(", ")}`);
  }
}

/**
 * Move a verified payload from its staging directory to `target`.
 *
 * rename(2) replaces a file in one step, but it will not replace a directory that
 * has anything in it. So an existing payload is renamed aside, the new one is
 * renamed in, and only then is the old one deleted. The two renames run back to
 * back and synchronously, so no JavaScript runs between them. Another process can
 * find the target missing in the instant between those two system calls (this is
 * not an atomic swap), but never finds it half-built. If the second rename fails,
 * the previous payload is put back.
 *
 * A truly atomic swap needs either an exchange-rename (renameat2 / renamex_np, not
 * reachable from Node) or a `dist-package` symlink swapped over its target. The
 * symlink would change what `cpSync` and `npm pack` see at `dist-package/`: a copy
 * of the path copies the link itself unless every reader resolves it first.
 *
 * Exported for its test.
 */
export function promote(staging: string, target: string): void {
  const aside = `${staging}.previous`;
  let hadPrevious = false;
  try {
    renameSync(target, aside);
    hadPrevious = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    renameSync(staging, target);
  } catch (error) {
    if (hadPrevious) renameSync(aside, target);
    throw error;
  }
  if (hadPrevious) rmSync(aside, { recursive: true, force: true });
}

/** True while `pid` names a running process (one this user may not signal counts too). */
function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Remove every `<parent>/<prefix><pid>-…` entry whose `<pid>` is no longer running,
 * and return the names removed.
 *
 * Scratch directories carry the pid of the process that made them. A process
 * stopped by a signal leaves its scratch behind, and gitignored scratch is never
 * removed by `git reset --hard`, so the next run sweeps it. A directory whose
 * owner is still running is left alone: that is a build or a test run in
 * progress, not debris.
 */
export function removeStaleScratch(parent: string, prefix: string): string[] {
  const stale = staleScratch(parent, prefix);
  for (const name of stale) rmSync(join(parent, name), { recursive: true, force: true });
  return stale;
}

/** The `<prefix><pid>-…` entries in `parent` whose `<pid>` is no longer running. */
function staleScratch(parent: string, prefix: string): string[] {
  let names: string[];
  try {
    names = readdirSync(parent);
  } catch {
    return [];
  }
  return names.filter((name) => {
    if (!name.startsWith(prefix)) return false;
    const pid = Number(/^(\d+)-/.exec(name.slice(prefix.length))?.[1]);
    return Number.isSafeInteger(pid) && pid > 0 && !isRunning(pid);
  });
}

/**
 * Put back a payload that a killed build had renamed aside.
 *
 * A build killed between `promote`'s two renames leaves no target, and the
 * previous payload only as `.<name>.building-<pid>-<random>.previous`. That is
 * the last good tree, not debris: sweeping it and then failing this build would
 * leave nothing at all. So when the target is missing, the newest such tree
 * from a dead build is renamed back first, and only then is the rest swept.
 */
function restoreInterruptedSwap(parent: string, prefix: string, target: string): void {
  if (existsSync(target)) return;
  const [newest] = staleScratch(parent, prefix)
    .filter((name) => name.endsWith(".previous"))
    .map((name) => ({ name, mtime: statSync(join(parent, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (newest) renameSync(join(parent, newest.name), target);
}

/**
 * Build the payload into `outDir` (default: the repository's `dist-package/`).
 *
 * The work happens in a hidden sibling, `.<name>.building-<pid>-<random>`, on the
 * same filesystem as the target so the final move is a rename. Every verification
 * runs against the staged tree before it is promoted, and the staging directory is
 * removed whether the build succeeds or fails. A build killed by a signal cannot
 * clean up after itself, so each build first puts back a previous payload that a
 * killed build had renamed aside (when the target is missing), and then removes
 * staging directories whose process is gone. Each call works only on its own
 * directories, so builds into different targets can run at the same time.
 */
export async function buildPackage(options: { outDir?: string } = {}): Promise<{
  outDir: string;
  version: string;
  bundledPackages: string[];
  externals: string[];
}> {
  const target = resolve(options.outDir ?? defaultOutDir);
  mkdirSync(dirname(target), { recursive: true });
  const stagingPrefix = `.${basename(target)}.building-`;
  restoreInterruptedSwap(dirname(target), stagingPrefix, target);
  removeStaleScratch(dirname(target), stagingPrefix);
  const staging = join(dirname(target), `${stagingPrefix}${process.pid}-${randomBytes(4).toString("hex")}`);
  mkdirSync(staging);

  try {
    const { bundledPackages, externals } = await bundle(staging);
    verifyNoExternalImports(externals);
    verifyExecutableBin(join(staging, "staple.mjs"));
    copyUiAssets(staging);
    writeArtifactManifest(staging, bundledPackages);
    verifyNoSourceLeaks(staging);
    promote(staging, target);
    return { outDir: target, version: sourcePkg.version, bundledPackages, externals };
  } finally {
    // A no-op after a successful promote; after a failure it removes the half-built tree.
    rmSync(staging, { recursive: true, force: true });
  }
}

// Only when run directly, so the tests can import buildPackage() instead of shelling
// out to a second tsx process. `--out <dir>` builds somewhere other than
// dist-package/; the interrupted-build test uses it to stop a real build midway.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { out: { type: "string" } } });
  const { outDir, bundledPackages, externals } = await buildPackage(
    values.out === undefined ? {} : { outDir: values.out },
  );
  console.log(`built ${relative(repoRoot, outDir)}/ — staple-cli ${sourcePkg.version}`);
  console.log(`bundled ${bundledPackages.length} packages: ${bundledPackages.join(", ")}`);
  console.log(`external (built-ins only): ${externals.join(", ")}`);
}
