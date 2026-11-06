/**
 * A standalone entry for `staple brain`, bundled to `dist-brain/brain.mjs` by
 * `scripts/build-brain.ts`. The hooks run on every session start and every prompt, so they
 * must not pay for the whole CLI's module graph or for `tsx`: this entry loads only the brain.
 */
import { runBrainCommand } from "../commands/brain.js";
import { errorEnvelope } from "../core/types.js";

try {
  runBrainCommand(process.argv.slice(2));
} catch (error) {
  const envelope = errorEnvelope(error);
  process.stderr.write(`error(${envelope.code}): ${envelope.message}\n`);
  process.exitCode = 1;
}
