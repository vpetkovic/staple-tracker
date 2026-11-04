/**
 * Vitest setupFiles: apply the run's isolated home in every worker, before any test file
 * loads (see `test/setup/isolated-home.ts`). A worker that did not inherit the
 * environment globalSetup changed still cannot resolve the operator's real home, or reach
 * the machine's launchd.
 */
import { join } from "node:path";
import { inject } from "vitest";

const { home, stapleHome, fakeBin } = inject("isolatedHome");
process.env.HOME = home;
process.env.STAPLE_HOME = stapleHome;
process.env.XDG_CONFIG_HOME = join(home, ".config");
process.env.APPDATA = join(home, "AppData", "Roaming");
// The fake `launchctl` first on PATH, here and in every child: see isolated-home.ts.
if (!(process.env.PATH ?? "").split(":").includes(fakeBin)) process.env.PATH = `${fakeBin}:${process.env.PATH ?? ""}`;
process.env.STAPLE_TEST_LAUNCHCTL = join(fakeBin, "launchctl");
