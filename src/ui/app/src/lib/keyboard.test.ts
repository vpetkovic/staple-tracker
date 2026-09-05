/**
 * One typing guard for every shortcut. `isTyping` cannot be exercised here — there is
 * no DOM and it answers false where `HTMLElement` is undefined — so what is pinned is
 * the thing that CAN drift: that each surface with a keyboard shortcut reads its
 * answer from lib/keyboard.ts and keeps no copy of the tag-name test of its own. A copy
 * is how the detail panel once decided a SELECT was not a field while the create
 * shortcut decided it was.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = (relative: string) =>
  readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

const SURFACES = ["components/AppShell.tsx", "components/CreateIssueMount.tsx", "detail/IssueDetailMount.tsx"];

describe("the typing guard", () => {
  for (const relative of SURFACES) {
    it(`${relative} reads isTyping from lib/keyboard and keeps no copy`, () => {
      const text = source(relative);
      expect(text).toMatch(/import \{[^}]*\bisTyping\b[^}]*\} from "@\/lib\/keyboard"/);
      expect(text).not.toMatch(/tagName === "INPUT"/);
      expect(text).not.toMatch(/isContentEditable/);
    });
  }
});
