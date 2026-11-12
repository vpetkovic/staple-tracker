import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
it("the published planning contract states the person trust model and current enable/upgrade path", () => {
  for (const path of ["design/plan.md", "design/configuration.md"]) {
    const text = readFileSync(path, "utf8");
    expect(text).toMatch(/UI is the person/); expect(text).toMatch(/token is the person's/); expect(text).toMatch(/trusted not to impersonate/);
  }
  const cli = readFileSync("docs/cli.md", "utf8");
  expect(cli).toContain("staple plan enable --person"); expect(cli).not.toContain("Now, Next and Later");
  expect(readFileSync("design/plan.md", "utf8")).not.toContain("**Upgrade.** On workspace open");
});
