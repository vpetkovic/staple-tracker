/**
 * Vitest setupFiles: apply the run's isolated home in every worker, before any test file
 * loads (see `test/setup/isolated-home.ts`). A worker that did not inherit the
 * environment globalSetup changed still cannot resolve the operator's real home.
 */
import { join } from "node:path";
import { inject } from "vitest";

const { home, stapleHome } = inject("isolatedHome");
process.env.HOME = home;
process.env.STAPLE_HOME = stapleHome;
process.env.XDG_CONFIG_HOME = join(home, ".config");
process.env.APPDATA = join(home, "AppData", "Roaming");
