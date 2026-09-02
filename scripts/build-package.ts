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
 */
import { build } from "esbuild";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(repoRoot, "dist-package");
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
async function bundle(): Promise<{ bundledPackages: string[]; externals: string[] }> {
  const result = await build({
    entryPoints: [join(repoRoot, "src", "package", "staple.ts")],
    outfile: join(outDir, "staple.mjs"),
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
function copyUiAssets(): void {
  if (!existsSync(join(uiDist, "index.html"))) {
    throw new Error(
      `the UI bundle is missing at ${uiDist}. Run \`npm run build:ui\` before building the package.`,
    );
  }
  cpSync(uiDist, join(outDir, "assets"), { recursive: true });
}

function writeArtifactManifest(bundledPackages: string[]): void {
  writeFileSync(
    join(outDir, "package.json"),
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
  writeFileSync(join(outDir, "THIRD-PARTY-NOTICES.md"), notices);

  cpSync(join(repoRoot, "README.md"), join(outDir, "README.md"));
  cpSync(join(repoRoot, "LICENSE"), join(outDir, "LICENSE"));
}

/**
 * The published tree must contain runtime output and metadata only — no sources, no
 * tests, no lockfile, nothing private. Checked here rather than trusted to `files`,
 * because dist-package/ is built fresh and an accidental stray copy would ship.
 */
function verifyNoSourceLeaks(): void {
  const allowed = new Set([
    "package.json",
    "staple.mjs",
    "assets",
    "README.md",
    "LICENSE",
    "THIRD-PARTY-NOTICES.md",
  ]);
  const unexpected = readdirSync(outDir).filter((name) => !allowed.has(name));
  if (unexpected.length > 0) {
    throw new Error(`unexpected files in the publishable payload: ${unexpected.join(", ")}`);
  }
}

export async function buildPackage(): Promise<{
  outDir: string;
  version: string;
  bundledPackages: string[];
  externals: string[];
}> {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const { bundledPackages, externals } = await bundle();
  verifyNoExternalImports(externals);
  verifyExecutableBin(join(outDir, "staple.mjs"));
  copyUiAssets();
  writeArtifactManifest(bundledPackages);
  verifyNoSourceLeaks();

  return { outDir, version: sourcePkg.version, bundledPackages, externals };
}

// Only when run directly, so the tarball test can import buildPackage() instead of
// shelling out to a second tsx process.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { bundledPackages, externals } = await buildPackage();
  console.log(`built ${relative(repoRoot, outDir)}/ — staple-cli ${sourcePkg.version}`);
  console.log(`bundled ${bundledPackages.length} packages: ${bundledPackages.join(", ")}`);
  console.log(`external (built-ins only): ${externals.join(", ")}`);
}
