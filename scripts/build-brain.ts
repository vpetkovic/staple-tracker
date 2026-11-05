/**
 * Bundle `staple brain` into one file for the agent hooks: `dist-brain/brain.mjs`.
 *
 *   npx tsx scripts/build-brain.ts
 *
 * The hooks then run `node dist-brain/brain.mjs context|turn|stop --hook`, which starts in a
 * fraction of what `tsx src/cli.ts` costs.
 */
import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
await build({
  entryPoints: [join(root, "src", "brain", "main.ts")],
  outfile: join(root, "dist-brain", "brain.mjs"),
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22.5",
  define: { __STAPLE_VERSION__: JSON.stringify("brain-poc") },
  legalComments: "none",
  logLevel: "warning",
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
console.log(`built ${join(root, "dist-brain", "brain.mjs")}`);
