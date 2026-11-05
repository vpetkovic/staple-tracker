/**
 * The MCP half of the brain: `recall`, `remember`, `verify` and `forget` call the same
 * `BrainStore` and `recall` as `staple brain …`, so the two surfaces answer one shape. Each
 * call opens the brain and closes it again, so a long-lived MCP server never holds a stale
 * handle on a file another process is writing, and each call is a row in the usage log under
 * the connected client's name.
 *
 * The descriptions and the server instructions are written for an agent with NO hooks
 * installed: they alone have to make it recall before it works and remember what it learns.
 *
 * Registered from `src/mcp.ts` with that file's own `run` wrapper.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { openBrain } from "./open.js";
import { recall } from "./recall.js";
import { projectKeysFor, projectScope } from "./scope.js";
import type { BrainStore } from "./store.js";
import { BRAIN_KINDS, GLOBAL_SCOPE } from "./types.js";
import { hashPrompt, withUsage, type UsageEvent } from "./usage.js";

type Run = (fn: () => unknown) => { content: Array<{ type: "text"; text: string }>; isError?: true };

/** Sent once at initialize: the brain's part of how to use this server. */
export const BRAIN_SERVER_INSTRUCTIONS = [
  "staple is a task tracker and a shared agent memory (the brain) that every agent on every synced machine reads and writes.",
  "Brain, in order:",
  "1. At the start of any task, call `recall` with what the task is about (the files, the command, the feature) before reading code or acting. Memories hold the user's corrections, preferences, gotchas and where things live; acting without them repeats mistakes that were already fixed once.",
  "2. Call `recall` again whenever the work reaches deploys, tests, credentials, releases, setup or anything the user decided before.",
  "3. When you learn something durable (a correction, a preference, a non-obvious command or requirement, where something lives), call `remember` once with kind, body and why. Pass `supersedes` to replace an outdated memory instead of adding a contradiction. Do not store what the code, git history or README already says.",
  "4. When you relied on a memory, cite it as [brain:<name>]; when you confirmed one is still true, call `verify`.",
].join("\n");

function withBrain<T>(db: string | undefined, fn: (brain: BrainStore, dbPath: string) => T): T {
  const opened = openBrain(db);
  try {
    return fn(opened.brain, opened.dbPath);
  } finally {
    opened.close();
  }
}

const dbSchema = z.string().optional().describe("Path of another brain database; default STAPLE_BRAIN_DB, then ~/.staple/workspaces/brain.db.");

export function registerBrainTools(server: McpServer, helpers: { run: Run }): void {
  const { run } = helpers;
  const provider = () => server.server.getClientVersion()?.name ?? "mcp";
  const logUse = (dbPath: string, event: UsageEvent, recordIds: string[], extra: { promptHash?: string; latencyMs?: number; detail?: Record<string, unknown> } = {}) =>
    withUsage(dbPath, (log) => log.log({ event, provider: provider(), session: null, recordIds, ...extra }));

  server.registerTool(
    "recall",
    {
      description:
        "Search the shared brain (memory every agent shares across sessions and machines) and get the full memories that match. CALL THIS FIRST at the start of every task, with a question naming what the task touches (files, commands, the feature, deploys, tests), before reading code or acting: memories hold the user's corrections, preferences, gotchas and setup steps, and acting without them repeats fixed mistakes. Call it again whenever the work reaches something a past decision may govern. Full-text (bm25); this project's memories rank higher. Cite what you use as [brain:<name>].",
      inputSchema: {
        question: z.string().describe("What the task is about, in plain words: 'how do I run the tests here', 'release tag format', 'deploy steps for the worker'."),
        limit: z.number().int().min(1).max(20).optional(),
        cwd: z.string().optional().describe("Directory whose project memories get the boost; default the server's cwd."),
        db: dbSchema,
      },
      annotations: { title: "Recall", readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    (args) =>
      run(() =>
        withBrain(args.db, (brain, dbPath) => {
          const started = performance.now();
          const hits = recall(brain.live(), args.question, { limit: args.limit ?? 3, keys: projectKeysFor(args.cwd ?? process.cwd()) });
          logUse(dbPath, "recall", hits.map((h) => h.record.id), { promptHash: hashPrompt(args.question), latencyMs: Math.round((performance.now() - started) * 10) / 10 });
          return {
            hits: hits.map((h) => ({ score: Number(h.score.toFixed(3)), ...h.record })),
            ...(hits.length === 0 ? { note: "No memory matches. Try other words (recall matches words, not meaning), or proceed and remember what you learn." } : {}),
          };
        }),
      ),
  );

  server.registerTool(
    "remember",
    {
      description:
        "Save one durable fact to the shared brain so the next session (yours or another agent's, on any machine) starts knowing it. Call it as soon as you learn something that is not in the code, git history or README: a correction from the user, a preference, a non-obvious command or requirement, a gotcha, where something lives. kind: user (who the user is), feedback (how they want the work done; always give why), project (state of ongoing work), reference (where something lives). One fact per record. scope: 'project' (default: the directory in cwd) or 'global' for facts that hold everywhere. Pass supersedes with the old record's id to replace an outdated memory instead of adding a contradiction.",
      inputSchema: {
        kind: z.enum(BRAIN_KINDS),
        body: z.string().describe("The fact, in full, so a reader with no context can act on it."),
        name: z.string().optional().describe("Short kebab-case handle, used for citations: [brain:<name>]."),
        description: z.string().optional().describe("One line: what this record is about. Shown in the session-start block."),
        why: z.string().optional().describe("Why this is true or why it matters."),
        scope: z.string().optional().describe("'project' (default), 'global' or 'project:<slug>'."),
        cwd: z.string().optional().describe("The directory 'project' scope refers to; default the server's cwd."),
        tags: z.array(z.string()).optional(),
        source: z.string().optional().describe("Who is writing: agent:<harness>/<session> or human:<name>."),
        provisional: z.boolean().optional().describe("True for an unconfirmed inference."),
        supersedes: z.string().optional().describe("Id, prefix or name of the record this one replaces."),
        db: dbSchema,
      },
      annotations: { title: "Remember", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    (args) =>
      run(() =>
        withBrain(args.db, (brain, dbPath) => {
          const cwd = args.cwd ?? process.cwd();
          const scope = args.scope === "global" ? GLOBAL_SCOPE : !args.scope || args.scope === "project" ? projectScope(cwd) : args.scope;
          const record = brain.remember({
            kind: args.kind,
            body: args.body,
            name: args.name ?? null,
            description: args.description ?? null,
            why: args.why ?? null,
            scope,
            tags: args.tags ?? [],
            source: args.source ?? (process.env.STAPLE_AGENT ? `agent:${process.env.STAPLE_AGENT}` : `agent:${provider()}`),
            provisional: args.provisional ?? false,
            supersedes: args.supersedes ?? null,
          });
          logUse(dbPath, "remember", [record.id], { detail: { supersedes: args.supersedes ?? null } });
          return record;
        }),
      ),
  );

  server.registerTool(
    "verify",
    {
      description:
        "Mark a brain memory as confirmed still true (clears provisional, refreshes verified_at). Call it when you checked a memory against reality and it held; if it did not hold, call remember with supersedes instead.",
      inputSchema: { id: z.string().describe("Record id, an unambiguous prefix, or its name."), db: dbSchema },
      annotations: { title: "Verify memory", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    (args) =>
      run(() =>
        withBrain(args.db, (brain, dbPath) => {
          const record = brain.verify(args.id);
          logUse(dbPath, "verify", [record.id]);
          return record;
        }),
      ),
  );

  server.registerTool(
    "forget",
    {
      description:
        "Delete one brain memory everywhere the brain synchronizes. Only for a memory that is wrong; when it is merely outdated, prefer remember with supersedes so the history stays.",
      inputSchema: { id: z.string().describe("Record id, an unambiguous prefix, or its name."), db: dbSchema },
      annotations: { title: "Forget", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    (args) =>
      run(() =>
        withBrain(args.db, (brain, dbPath) => {
          const record = brain.forget(args.id, process.env.STAPLE_AGENT ?? null);
          logUse(dbPath, "forget", [record.id]);
          return record;
        }),
      ),
  );
}
