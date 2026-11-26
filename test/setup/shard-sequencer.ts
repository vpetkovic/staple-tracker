/**
 * Splits the suite into `--shard=i/N` slices of about equal running time.
 *
 * CI runs the unit tests as four parallel jobs, one shard each, and the run is as slow
 * as its slowest shard. Vitest 3's own split sorts the files by a hash of their path
 * and cuts the list into equal counts, which ignores how long a file takes. Here a
 * handful of files take one to two and a half minutes and most take a second or two,
 * so equal counts are not equal time: on the suite as it stood, the default split
 * gave one shard 990 s of test time and another 390 s. Vitest 3 has no
 * duration-aware split, so this sequencer supplies one.
 *
 * Every shard computes the same assignment from the same inputs, so every file runs
 * in exactly one shard: files are ordered by weight, heaviest first, then by the
 * same path hash vitest uses, and each goes to the shard with the least weight so
 * far. The weights are only a balance hint. A file missing from the table counts as
 * DEFAULT_SECONDS, a stale entry costs balance and nothing else, and correctness does
 * not depend on any of the numbers.
 *
 * Only sharding changes. Without `--shard` vitest never calls `shard()`, and the
 * order files run in within a shard is still vitest's own (`BaseSequencer.sort`).
 */
import { createHash } from "node:crypto";
import { relative, sep } from "node:path";
import { BaseSequencer, type TestSpecification } from "vitest/node";

/**
 * Seconds each file took in a passing CI run (ubuntu-latest, two workers), for every
 * file over 20 s. Refresh from a CI log when the heavy files change; the per-file
 * lines (`✓ test/x.test.ts (N tests) 12345ms`) carry the numbers.
 */
const SECONDS: Record<string, number> = {
  "test/run-hook.test.ts": 157,
  "test/ui-phone-back.test.ts": 133,
  "test/plan-lifecycle-surfaces.test.ts": 93,
  "test/run-drive.test.ts": 89,
  "test/characterize-cli-surface.test.ts": 70,
  "test/command-help.test.ts": 66,
  "test/run-surfaces.test.ts": 59,
  "test/path-migration-crash.test.ts": 59,
  "test/path-migration.test.ts": 56,
  "test/ui-issue-link.test.ts": 54,
  "test/cli-settings.test.ts": 49,
  "test/network-silence.test.ts": 42,
  "test/gates-surfaces.test.ts": 42,
  "test/hub-unregister-surfaces.test.ts": 38,
  "test/contract-estimate-surfaces.test.ts": 37,
  "test/contract-stale-claim.test.ts": 35,
  "test/doctor.test.ts": 34,
  "test/ui-lifecycle.test.ts": 30,
  "test/mcp-views-progress.test.ts": 29,
  "test/discovery.test.ts": 27,
  "test/queue-surfaces.test.ts": 25,
  "test/cloud-lease-heartbeat-signal.test.ts": 25,
  "test/attempts-surfaces.test.ts": 25,
  "test/cloud-renumber-holders.test.ts": 24,
  "test/cli-config.test.ts": 24,
  "test/ui-milestones-page.test.ts": 22,
  "test/cloud-hub-registry-cli.test.ts": 22,
  "test/cloud-error-codes.test.ts": 21,
  "test/cloud-cli.test.ts": 21,
  "test/run-attachment-lock.test.ts": 20,
};

/** About the mean of every file not in the table. */
const DEFAULT_SECONDS = 2;

export class BalancedShardSequencer extends BaseSequencer {
  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const { root, shard } = this.ctx.config;
    if (!shard) return files;
    const weighed = files.map((spec) => {
      const path = relative(root, spec.moduleId).split(sep).join("/");
      return {
        spec,
        weight: SECONDS[path] ?? DEFAULT_SECONDS,
        hash: createHash("sha1").update(path).digest("hex"),
      };
    });
    weighed.sort((a, b) => b.weight - a.weight || (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));

    const load: number[] = new Array(shard.count).fill(0);
    const mine: TestSpecification[] = [];
    for (const file of weighed) {
      const lightest = load.indexOf(Math.min(...load));
      load[lightest] = Math.min(...load) + file.weight;
      if (lightest === shard.index - 1) mine.push(file.spec);
    }
    return mine;
  }
}
