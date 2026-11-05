/**
 * The MCP half of the brain: `remember`, `recall` and `forget` call the same `BrainStore`
 * and `recall` as `staple brain remember|recall|forget`, so the two surfaces answer one
 * shape. Each call opens the brain and closes it again, so a long-lived MCP server never
 * holds a stale handle on a file another process is writing.
 *
 * Registered from `src/mcp.ts` with that file's own `run` wrapper.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { openBrain } from "./open.js";
import { recall } from "./recall.js";
import { projectKeysFor, projectScope } from "./scope.js";
import { BRAIN_KINDS, GLOBAL_SCOPE } from "./types.js";

type Run = (fn: () => unknown) => { content: Array<{ type: "text"; text: string }>; isError?: true };

function withBrain<T>(db: string | undefined, fn: (brain: ReturnType<typeof openBrain>["brain"]) => T): T {
  const opened = openBrain(db);
  try {
    return fn(opened.brain);
  } finally {
    opened.close();
  }
}

const dbSchema = z.string().optional().describe("Path of another brain database; default STAPLE_BRAIN_DB, then ~/.staple/workspaces/brain.db.");

export function registerBrainTools(server: McpServer, helpers: { run: Run }): void {
  const { run } = helpers;

  server.registerTool(
    "remember",
    {
      description:
        "Save one durable fact to the shared brain, the memory every agent (Claude Code, Codex, any MCP client) reads at session start on every synced machine. kind: user (who the user is), feedback (how they want the work done: corrections and confirmed approaches; always give why), project (state of ongoing work not derivable from code or git), reference (where something lives). One fact per record. scope: 'global', 'project' (the directory in cwd), or an explicit 'project:<slug>'. Pass supersedes to replace an outdated record instead of adding a contradiction. Do not save what the code, git history or CLAUDE.md already records.",
      inputSchema: {
        kind: z.enum(BRAIN_KINDS),
        body: z.string().describe("The fact, in full."),
        name: z.string().optional().describe("Short kebab-case handle."),
        description: z.string().optional().describe("One line: what this record is about. Shown in the session-start block."),
        why: z.string().optional().describe("Why this is true or why it matters; required in spirit for feedback."),
        scope: z.string().optional().describe("'global', 'project' (default) or 'project:<slug>'."),
        cwd: z.string().optional().describe("The directory 'project' scope refers to; default the server's cwd."),
        tags: z.array(z.string()).optional(),
        source: z.string().optional().describe("Who is writing: agent:<harness>/<session> or human:<name>."),
        provisional: z.boolean().optional().describe("True for an unconfirmed inference."),
        supersedes: z.string().optional().describe("Id of the record this one replaces."),
        db: dbSchema,
      },
      annotations: { title: "Remember", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    (args) =>
      run(() =>
        withBrain(args.db, (brain) => {
          const cwd = args.cwd ?? process.cwd();
          const scope = args.scope === "global" ? GLOBAL_SCOPE : !args.scope || args.scope === "project" ? projectScope(cwd) : args.scope;
          return brain.remember({
            kind: args.kind,
            body: args.body,
            name: args.name ?? null,
            description: args.description ?? null,
            why: args.why ?? null,
            scope,
            tags: args.tags ?? [],
            source: args.source ?? (process.env.STAPLE_AGENT ? `agent:${process.env.STAPLE_AGENT}` : "agent:mcp"),
            provisional: args.provisional ?? false,
            supersedes: args.supersedes ?? null,
          });
        }),
      ),
  );

  server.registerTool(
    "recall",
    {
      description:
        "Search the shared brain for memories relevant to a question (full-text, bm25; this project's records rank higher). Returns the full records. Use it before acting on anything the session-start brain block only summarizes, and whenever a past decision, preference or gotcha might apply.",
      inputSchema: {
        question: z.string(),
        limit: z.number().int().min(1).max(20).optional(),
        cwd: z.string().optional().describe("Directory whose project records get the boost; default the server's cwd."),
        db: dbSchema,
      },
      annotations: { title: "Recall", readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    (args) =>
      run(() =>
        withBrain(args.db, (brain) => ({
          hits: recall(brain.live(), args.question, { limit: args.limit ?? 3, keys: projectKeysFor(args.cwd ?? process.cwd()) }).map(
            (h) => ({ score: Number(h.score.toFixed(3)), ...h.record }),
          ),
        })),
      ),
  );

  server.registerTool(
    "forget",
    {
      description:
        "Delete one brain record everywhere the brain synchronizes. Use when a memory is wrong; when it is outdated, prefer remember with supersedes so the history stays.",
      inputSchema: { id: z.string().describe("Record id, an unambiguous prefix, or its name."), db: dbSchema },
      annotations: { title: "Forget", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    (args) => run(() => withBrain(args.db, (brain) => brain.forget(args.id, process.env.STAPLE_AGENT ?? null))),
  );
}
