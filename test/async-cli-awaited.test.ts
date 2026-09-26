/**
 * Every call to the async CLI helpers is awaited.
 *
 * The files that serve HTTP in-process run the CLI with `spawnAsync`,
 * `runCliAsync` or `runCliAtAsync` (see `test/fixtures/spawn-async.ts`), usually
 * through a local wrapper such as `cli(...)`. A call written in the old synchronous
 * style, `const view = cli(...)`, still typechecks wherever the result is read as
 * `unknown`, and then asserts against a pending Promise. That happened once, in a
 * test merged while these files were being converted.
 *
 * This walks each such file's syntax tree, collects the functions declared `async`
 * in it plus the three helpers, and fails on a call to any of them that is not
 * directly awaited, returned, the body of an arrow function, or explicitly `void`ed.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const TEST_DIR = join(process.cwd(), "test");
const HELPERS = ["spawnAsync", "runCliAsync", "runCliAtAsync"];

function filesUsingAsyncCli(): string[] {
  return readdirSync(TEST_DIR)
    .filter((name) => name.endsWith(".test.ts"))
    .filter((name) => {
      const text = readFileSync(join(TEST_DIR, name), "utf8");
      return HELPERS.some((helper) => new RegExp(`import[^;]*\\b${helper}\\b[^;]*from`).test(text));
    })
    .sort();
}

function functionName(node: ts.Node): string | undefined {
  if (ts.isFunctionDeclaration(node) && node.name) return node.name.text;
  if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) {
    return node.parent.name.text;
  }
  return undefined;
}

function unawaitedCalls(fileName: string, text: string): string[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const asyncNames = new Set(HELPERS);
  const collect = (node: ts.Node): void => {
    const isAsync = ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
    const name = isAsync ? functionName(node) : undefined;
    if (name) asyncNames.add(name);
    ts.forEachChild(node, collect);
  };
  collect(source);

  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && asyncNames.has(node.expression.text)) {
      let parent = node.parent;
      while (ts.isParenthesizedExpression(parent)) parent = parent.parent;
      const handled =
        ts.isAwaitExpression(parent) ||
        ts.isReturnStatement(parent) ||
        ts.isVoidExpression(parent) ||
        (ts.isArrowFunction(parent) && parent.body !== undefined);
      if (!handled) {
        const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        found.push(`${fileName}:${line} ${node.expression.text}(...) is not awaited`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe("async CLI calls in the files that serve HTTP in-process", () => {
  it("finds the files, so an empty result below means something", () => {
    expect(filesUsingAsyncCli().length).toBeGreaterThanOrEqual(20);
  });

  it("are all awaited", () => {
    const found = filesUsingAsyncCli().flatMap((name) => unawaitedCalls(name, readFileSync(join(TEST_DIR, name), "utf8")));
    expect(found).toEqual([]);
  });

  it("the check catches the shapes it is for", () => {
    const sample = [
      "async function cli() { return runCliAsync([], {}); }",
      "async function t() {",
      "  const view = cli();",
      "  cli();",
      "  const status = cli().status;",
      "  const fine = await cli();",
      "  const alsoFine = (await cli()).status;",
      "  expect(cli()).toBeDefined();",
      "  let late; late = cli();",
      "  void cli();",
      "  const wrapped = () => cli();",
      "}",
    ].join("\n");
    expect(unawaitedCalls("sample.ts", sample)).toEqual([
      "sample.ts:3 cli(...) is not awaited",
      "sample.ts:4 cli(...) is not awaited",
      "sample.ts:5 cli(...) is not awaited",
      "sample.ts:8 cli(...) is not awaited",
      "sample.ts:9 cli(...) is not awaited",
    ]);
  });
});
