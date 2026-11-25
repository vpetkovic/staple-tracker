/**
 * `staple attention` — the work waiting on a person (core/attention.ts).
 *
 *   attention [--hub] [--json]
 *   attention dismiss <ref|run-id|key> [--json]
 *
 * The same rows the web view's Attention page and the `attention` MCP tool show: every
 * surface calls `attentionList`. Printed grouped by kind, gates and person-owned blockers
 * first, the longest waiting first within a kind; each row names its workspace, its age and
 * the one command that acts on it.
 */
import { parseArgs } from "node:util";
import { attentionKindLabel, attentionList, attentionText, dismissAttention, type AttentionList } from "../core/attention.js";
import { hubWorkspaces } from "../core/integrations/mapping.js";
import { hideDraftIdentifiers } from "../core/plan.js";
import type { WorkspaceStore } from "../core/store.js";
import { StapleError } from "../core/types.js";
import { resolveWorkspace } from "../core/workspace.js";

const HELP = `staple attention [--hub] [--json]
  The work waiting on a person, one row each: pending and resubmitted gates, blockers
  whose owner is a person, tickets in review, tickets made ready because their blockers
  in other workspaces closed, stopped autopilot runs, claims silent past
  queue.silentClaimMinutes, and sync conflicts. Gates and person-owned blockers come
  first; within a kind the longest waiting comes first. A ready ticket is never listed
  just because it is in the pickup queue: the queue is the plan (staple queue).
  A silent claim is shown, never taken over from here.
  --hub   every workspace this machine's hub knows; each row names its workspace

staple attention dismiss <ref|run-id|key>
  Take a row off the list without acting on it. Only a ticket made ready by its
  cross-workspace blockers and a stopped run can be dismissed; a gate, a review, a
  blocker, a silent claim and a conflict leave the list when someone acts on them.`;

export function runAttentionCommand(rest: string[]): void {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      db: { type: "string" },
      ws: { type: "string" },
      json: { type: "boolean" },
      hub: { type: "boolean" },
      agent: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [sub, target] = positionals;
  if (values.help === true || sub === "help") return console.log(HELP);
  const out = (payload: unknown) => console.log(JSON.stringify(payload, hideDraftIdentifiers));

  if (sub === "dismiss") {
    if (!target?.trim()) throw new StapleError("validation", "staple attention dismiss needs a ticket, a run id or a row key.");
    const { store } = resolveWorkspace({ db: values.db, ws: values.ws });
    const actor = values.agent ?? process.env.STAPLE_AGENT ?? process.env.USER ?? "user";
    const row = dismissAttention(store, target, actor);
    if (values.json) return out({ dismissed: row });
    return console.log(`dismissed ${row.ref ?? row.runId ?? row.key} (${attentionKindLabel(row.kind).toLowerCase()})`);
  }
  if (sub !== undefined) throw new StapleError("validation", `Unknown attention subcommand "${sub}". Use: staple attention [--hub] | staple attention dismiss <ref>`);
  if (values.hub && (values.ws || values.db)) throw new StapleError("validation", "--hub reads every workspace; it does not combine with --ws or --db.");

  let list: AttentionList;
  if (values.hub) {
    const opened = new Map<string, WorkspaceStore>();
    try {
      list = attentionList(
        hubWorkspaces((slug) => {
          const store = resolveWorkspace({ ws: slug }).store;
          opened.set(slug, store);
          return store;
        }),
      );
    } finally {
      for (const store of opened.values()) if (store.db.isOpen) store.db.close();
    }
  } else {
    const { store } = resolveWorkspace({ db: values.db, ws: values.ws });
    list = attentionList([{ slug: store.slug, store }]);
  }
  if (values.json) return out(list);
  console.log(attentionText(list));
}
