#!/usr/bin/env node
/**
 * The published `staple` executable.
 *
 * STA-24's plan pins one npm package (`staple-cli`) exposing one binary (`staple`),
 * and requires that binary to serve both surfaces: the human CLI and the MCP stdio
 * server. In the repository those are two files with two top-level entrypoints —
 * src/cli.ts calls main() as it loads, src/mcp.ts awaits server.connect() as it loads
 * — so neither can be statically imported without running.
 *
 * Hence the dynamic imports below. esbuild inlines them into the single output bundle
 * without code splitting while keeping them lazily evaluated, so one staple.mjs holds
 * both surfaces and exactly one of them ever executes.
 *
 * This file is the only place the two surfaces are chosen between. It deliberately does
 * not parse anything else: every other flag belongs to the surface it is dispatched to.
 */

/** Replaced at build time by scripts/build-package.ts. Absent when run from source. */
declare const __STAPLE_VERSION__: string;

const version = typeof __STAPLE_VERSION__ === "string" ? __STAPLE_VERSION__ : "0.0.0-dev";

const argv = process.argv.slice(2);
const command = argv[0];

if (command === "--version" || command === "-v") {
  // The installer (STA-24 §6) keys its versioned runtime layout off this string, so it
  // is the bare version and nothing else — no banner, no name prefix.
  console.log(version);
} else if (command === "--help" || command === "-h") {
  // The plan's tarball acceptance runs `npx -y staple-cli --help`. The CLI itself
  // spells this as the `help` command; the flag spelling is an entrypoint concern.
  // Rewritten in place so argv[0] and argv[1] keep whatever Node put there.
  process.argv[2] = "help";
  await import("../cli.js");
} else if (command === "mcp") {
  // argv is passed through untouched: the MCP server reads its configuration from the
  // environment (STAPLE_DB, STAPLE_WS, STAPLE_AGENT), never from positional arguments.
  await import("../mcp.js");
} else {
  await import("../cli.js");
}
