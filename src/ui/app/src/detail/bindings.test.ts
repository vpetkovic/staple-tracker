/**
 * THE JSX BINDINGS, pinned by reading the source (the suite has no DOM, by design; the repo
 * pins effect behaviour with source scans the same way).
 *
 * Every list the detail renders is a `.map((x) => …)`, and every handler inside it must act
 * on `x` itself: `onSelect={x.select}`, `onClick={x.click}`, or a closure that names `x`. A
 * handler that indexes into the list (`entries[0].select`) or names a different variable
 * is the "tap item k, get item 0" bug, and it fails here. The handlers' own behaviour (item k
 * sends exactly item k's request) is pinned in action-controller.test.ts.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const FILES = ["IssueActions.tsx", "IssueDetailPanel.tsx", "GateReview.tsx", "InlineProperties.tsx", "tabs/OverviewTab.tsx"];
const HANDLER = /\bon(?:Select|Click|Change|CheckedChange)=\{/g;

/** The `.map((name) => …)` blocks in a file: the variable and the text up to the block's end. */
function mapBlocks(source: string): Array<{ variable: string; body: string; at: number }> {
  const blocks: Array<{ variable: string; body: string; at: number }> = [];
  const opener = /\.map\(\(\s*(\w+)[^)]*\)\s*=>\s*/g;
  for (let match = opener.exec(source); match; match = opener.exec(source)) {
    // Walk to the paren that closes `.map(`.
    let depth = 1;
    let i = source.indexOf("(", match.index) + 1;
    for (; i < source.length && depth > 0; i++) {
      if (source[i] === "(") depth++;
      else if (source[i] === ")") depth--;
    }
    blocks.push({ variable: match[1]!, body: source.slice(match.index, i), at: match.index });
  }
  return blocks;
}

/** Each handler expression inside `body`, balanced on braces. */
function handlers(body: string): string[] {
  const found: string[] = [];
  for (let match = HANDLER.exec(body); match; match = HANDLER.exec(body)) {
    let depth = 1;
    let i = match.index + match[0].length;
    const start = i;
    for (; i < body.length && depth > 0; i++) {
      if (body[i] === "{") depth++;
      else if (body[i] === "}") depth--;
    }
    found.push(body.slice(start, i - 1).trim());
  }
  HANDLER.lastIndex = 0;
  return found;
}

describe("every handler inside a rendered list acts on its own item", () => {
  let checked = 0;
  for (const file of FILES) {
    it(file, () => {
      const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
      const blocks = mapBlocks(source);
      for (const block of blocks) {
        // Handlers of a nested .map are judged against that nested block's own variable.
        const nested = blocks.filter((other) => other.at > block.at && other.at < block.at + block.body.length);
        let own = block.body;
        for (const inner of nested) own = own.replace(inner.body, "");
        for (const expression of handlers(own)) {
          checked++;
          const where = `${file}: .map((${block.variable}) …) → {${expression}}`;
          expect(expression, `${where} indexes into a list`).not.toMatch(/\w\s*\[\s*\d+\s*\]|\]\s*!?\s*\./);
          expect(new RegExp(`\\b${block.variable}\\b`).test(expression) || /^\(\w*\)\s*=>\s*set\w+\(\w+\.target\.value\)$/.test(expression), `${where} does not act on ${block.variable}`).toBe(true);
        }
      }
    });
  }

  it("actually found the list handlers it judges (not a vacuous scan)", () => {
    // Status menu, ⋯ menu, the gate checklist and the label chips.
    expect(checked).toBeGreaterThanOrEqual(4);
  });

  it("the menus bind each item's own handler, by name", () => {
    const source = readFileSync(new URL("./IssueActions.tsx", import.meta.url), "utf8");
    expect(source.match(/onSelect=\{item\.select\}/g)?.length).toBe(2);
    expect(source).toMatch(/onClick=\{item\.click\}/);
    expect(source).toMatch(/statusEntries\(statusItems\(ctx\), controller\.run\)/);
    expect(source).toMatch(/overflowEntries\(overflowItems\(contextOf\(detail, controller\)\), controller\.run,/);
  });
});
