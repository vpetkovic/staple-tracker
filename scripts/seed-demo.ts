/**
 * Seed a demo hub with staple's own build plan (dogfood) across two
 * workspaces, including a cross-workspace dependency.
 * Run with STAPLE_HOME pointing somewhere disposable:
 *   STAPLE_HOME=/tmp/staple-demo npx tsx scripts/seed-demo.ts
 */
import { initWorkspace } from "../src/core/workspace.js";
import { Hub } from "../src/core/hub.js";

if (!process.env.STAPLE_HOME) {
  console.error("Refusing to seed into your real ~/.staple — set STAPLE_HOME to a demo dir first.");
  process.exit(1);
}

const staple = initWorkspace({ global: true, slug: "staple" });
const workshop = initWorkspace({ global: true, slug: "workshop" });
const s = staple.store;
const w = workshop.store;

// --- M0/M1: core (done) ---
const core = s.createIssue({
  title: "M1: core store — schema, guards, claims, dependency graph",
  description:
    "SQLite workspace store: status guards, atomic checkout/release, blocks graph with cycle detection, level-triggered ready events, revisioned documents, idempotency + duplicate guards.",
  assignee: "claude",
  priority: "critical",
  status: "in_progress",
});
const coreKids = [
  ["Schema + migrations (issues, relations, comments, documents, events)", "done"],
  ["Status guards + stamps (in_progress needs assignee + clear blockers)", "done"],
  ["Atomic checkout/release with expectedStatuses", "done"],
  ["Cycle detection (BFS over blocks graph)", "done"],
  ["Level-triggered blockers_resolved + children_complete events", "done"],
  ["Keyed revisioned documents with baseRevision conflicts", "done"],
] as const;
for (const [title, status] of coreKids) {
  const child = s.createChild(core.id, { title, assignee: "claude", blockParentUntilDone: true });
  s.updateIssue(child.id, { status: status as never });
}
s.updateIssue(core.id, { status: "in_review", comment: "25/25 tests green — ready for review." });

const hubIssue = s.createIssue({
  title: "M1: hub federation — registry, prefixes, cross-workspace links",
  description:
    "hub.db with unique prefix allocation (GAR, GARA, ...), cross_links, graceful degradation when a workspace file is missing, unified inbox + graph.",
  assignee: "claude",
  priority: "high",
  status: "done",
});
s.addComment(hubIssue.id, "Prefix suffixing verified: garage→GAR, gargantua→GARA.", "claude", "agent");

const mcp = s.createIssue({
  title: "M1: MCP server — 15 tools over the store",
  description: "stdio MCP: inbox, create/get/list/update, checkout/release, comments, blocked-by, documents, events, cross_link, hub_overview.",
  assignee: "claude",
  priority: "high",
  status: "done",
});
const cli = s.createIssue({
  title: "M1: CLI — init/new/ls/show/start/done/board/inbox/doc/link/ui",
  assignee: "claude",
  priority: "medium",
  status: "done",
});

const ui = s.createIssue({
  title: "M1.5: staple ui — board, tree, graph, detail, hub mode",
  description:
    "Local web UI served by `staple ui`. Views: inbox (pickup order), kanban board, subtask tree, dependency graph, detail panel with documents + comments. Polls a change fingerprint — no daemon.",
  assignee: "claude",
  priority: "high",
  status: "in_progress",
  blockedBy: [mcp.id, cli.id],
  acceptanceCriteria: [
    "Board shows all 7 status columns",
    "Graph renders cross-workspace edges dashed",
    "Detail panel can claim, set status, comment",
    "Works in light and dark mode",
  ],
});
s.putDocument(
  ui.id,
  "plan",
  `# staple ui plan

## Views
- **inbox** — ready vs blocked, pickup order (in_progress → in_review → todo → backlog)
- **board** — 7 columns, click card → detail
- **tree** — subtask hierarchy with depth guides
- **graph** — layered DAG; cross-workspace edges dashed

## Non-goals (v1)
- drag & drop (click-to-set-status instead)
- websockets (fingerprint polling is enough locally)
`,
  { author: "claude", title: "UI plan" },
);
s.putDocument(ui.id, "plan", `# staple ui plan (v2)

## Views
- **inbox** — ready vs blocked, pickup order
- **board** — 7 columns, click card → detail
- **tree** — subtask hierarchy with depth guides
- **graph** — layered DAG; cross-workspace edges dashed; status stripe per node

## Decisions
- Poll /api/poll fingerprint every 1.5s; refresh on change
- Vanilla JS, zero build step — the page ships inside the CLI
`, { baseRevision: 1, author: "claude", changeSummary: "graph node status stripes + polling decision" });

const sync = s.createIssue({
  title: "M2: sync engine — TaskLink, field ownership, outbox",
  description: "Trimmed external-task-protocol: link state machine, per-field ownership, offline outbox, reconcile sweep.",
  priority: "high",
});
const github = s.createChild(sync.id, {
  title: "GitHub Issues adapter (sub-issues for trees, labels for status)",
  blockParentUntilDone: true,
});
const clickup = s.createChild(sync.id, {
  title: "ClickUp adapter (per-list status mapping, native dependencies)",
  blockParentUntilDone: true,
});
s.setBlockedBy(github.id, [ui.id]);
s.setBlockedBy(clickup.id, [github.id]);

const npmPublish = s.createIssue({
  title: "Publish standalone package",
  status: "blocked",
  unblockOwner: "vlad",
  unblockAction: "decide the final package name and whether it lives in its own repo",
  priority: "low",
});
s.addComment(npmPublish.id, "Name candidates: staple, staple-tasks, @vpetkovic/staple.", "claude", "agent");

// --- workshop workspace + cross-workspace dependency ---
const adopt = w.createIssue({
  title: "Adopt staple across workshop prototypes",
  description: "Wire the MCP server into .ai/tools once the prototype settles.",
  assignee: "vlad",
  priority: "medium",
  status: "todo",
});
const migrate = w.createIssue({
  title: "Migrate plan.md files into issue documents",
  priority: "low",
});
w.setBlockedBy(migrate.id, [adopt.id]);

const hub = Hub.open();
hub.addCrossLink(ui.identifier, adopt.identifier); // staple UI must land before workshop adopts
hub.close();

console.log(`Seeded:
  staple   (${s.prefix})  — ${s.listIssues({ includeResolved: true }).length} issues
  workshop (${w.prefix})  — ${w.listIssues({ includeResolved: true }).length} issues
  cross-link: ${ui.identifier} blocks ${adopt.identifier}
Hub home: ${process.env.STAPLE_HOME}`);

s.db.close();
w.db.close();
