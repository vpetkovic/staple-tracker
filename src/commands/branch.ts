/**
 * `staple branch` — the branch a ticket is worked on, and the pull requests opened for it.
 *
 *   branch <ref>                               the branch, its base and every linked pull request
 *   branch <ref> <name> [--base <commit>]      record the branch (and the commit it was cut from)
 *   branch <ref> --clear                       forget the branch field
 *   branch <ref> ... --discover                then look for its pull requests through the local gh
 *
 * Reading and recording never reach the network. `--discover` runs the same read-only lookup
 * the web UI's poll runs (`integrations discover`), for this ticket only.
 */
import { parseArgs } from "node:util";
import { acknowledgeRenumbers } from "../core/identifier-moves.js";
import { IntegrationOperations } from "../core/integrations/operations.js";
import type { LinkedPullRequest } from "../core/integrations/link-store.js";
import type { DiscoveryReport } from "../core/integrations/pr-discovery.js";
import { hubWorkspaces } from "../core/integrations/mapping.js";
import type { WorkspaceStore } from "../core/store.js";
import { setTicketBranch, ticketBranch, type TicketBranch } from "../core/ticket-branch.js";
import { StapleError } from "../core/types.js";
import { resolveWorkspace } from "../core/workspace.js";

const HELP = `staple branch <ref> [<name>] [--base <commit>] [--clear] [--discover] [--json]
  The branch a ticket is worked on, and every pull request linked to it.
  <name>        record the branch, as git names it (feat/sta-42); a changed branch
                drops the old base unless --base comes with it
  --base <c>    the commit the branch was cut from (git rev-parse --short HEAD)
  --clear       forget the branch field; a branch-pointer comment then answers again
  --discover    look for the branch's pull requests in the GitHub repositories mapped
                to this workspace, through the local gh, and link what it finds.
                Read-only at GitHub; it never changes the ticket's status
  With no branch field, an existing "Branch pointer: ... branch <name>, base <sha>"
  comment is the answer (shown as "from a comment").`;

export interface BranchAnswer {
  ref: string;
  branch: TicketBranch | null;
  changed: boolean;
  pullRequests: LinkedPullRequest[];
  /** Set when --discover ran. */
  discovery: Pick<DiscoveryReport, "linked" | "refreshed" | "failures" | "note"> | null;
}

export async function runBranchCommand(rest: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      db: { type: "string" },
      ws: { type: "string" },
      json: { type: "boolean" },
      "ack-renumber": { type: "boolean" },
      agent: { type: "string" },
      base: { type: "string" },
      clear: { type: "boolean" },
      discover: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) return console.log(HELP);
  const [ref, name, ...extra] = positionals;
  if (!ref?.trim()) throw new StapleError("validation", "staple branch needs an issue reference.");
  if (extra.length) throw new StapleError("validation", `staple branch takes one branch name; got ${[name, ...extra].join(" ")}.`);
  if (values.clear && (name !== undefined || values.base !== undefined)) throw new StapleError("validation", "--clear forgets the branch and its base; pass it alone.");
  if (values.base !== undefined && name === undefined) throw new StapleError("validation", "--base needs the branch it belongs to: staple branch <ref> <name> --base <commit>.");
  if (values["ack-renumber"]) acknowledgeRenumbers();
  const { store } = resolveWorkspace({ ws: values.ws, db: values.db });
  const actor = values.agent ?? process.env.STAPLE_AGENT ?? process.env.USER ?? "user";
  let changed = false;
  if (name !== undefined || values.clear) {
    changed = setTicketBranch(store, ref, { branch: values.clear ? null : name!, ...(values.base !== undefined ? { base: values.base } : {}) }, actor).changed;
  }
  let discovery: BranchAnswer["discovery"] = null;
  if (values.discover) {
    const opened = new Map<string, WorkspaceStore>();
    const workspaces = () => {
      try {
        return hubWorkspaces((slug) => opened.get(slug) ?? opened.set(slug, slug === store.slug ? store : resolveWorkspace({ ws: slug }).store).get(slug)!);
      } catch {
        return [{ slug: store.slug, store }];
      }
    };
    const { linked, refreshed, failures, note } = await new IntegrationOperations(store, { workspaces }).discover({ ref, actor });
    discovery = { linked, refreshed, failures, note };
  }
  const issue = store.getIssue(ref);
  const answer: BranchAnswer = {
    ref: issue.identifier,
    branch: ticketBranch(store, issue.id),
    changed,
    pullRequests: store.externalLinks().pullRequests().get(issue.id) ?? [],
    discovery,
  };
  if (values.json) return console.log(JSON.stringify(answer));
  console.log(branchText(answer, store.categoryOf(issue.status)));
}

/** The answer as the terminal prints it. */
export function branchText(answer: BranchAnswer, category: string | null): string {
  const lines: string[] = [];
  const { branch } = answer;
  if (!branch) lines.push(`${answer.ref}  no branch recorded. staple branch ${answer.ref} <name> --base <commit>`);
  else {
    const from = branch.source === "comment" ? " (from a comment)" : "";
    lines.push(`${answer.ref}  branch ${branch.name}${branch.base ? ` · base ${branch.base}` : ""}${from}`);
  }
  if (answer.pullRequests.length === 0) lines.push("  no pull requests linked");
  for (const pr of answer.pullRequests) {
    const checks = pr.checks ? ` · checks ${pr.checks.state}${pr.checks.failing.length ? ` (${pr.checks.failing.join(", ")})` : ""}` : "";
    lines.push(`  ${(pr.state ?? "unknown").padEnd(7)} ${pr.key}${pr.title ? `  ${pr.title}` : ""}${checks}`);
    lines.push(`          ${pr.url}`);
  }
  const finished = category === "done" || category === "cancelled";
  if (!finished && answer.pullRequests.some((pr) => pr.state === "merged")) {
    lines.push(`  A pull request is merged. If the work is finished: staple done ${answer.ref}`);
  }
  const discovery = answer.discovery;
  if (discovery) {
    lines.push(discovery.linked.length ? `  linked ${discovery.linked.map((l) => l.key).join(", ")}` : "  no new pull requests found");
    if (discovery.note) lines.push(`  ${discovery.note}`);
    for (const failure of discovery.failures) lines.push(`  ${failure.message}${failure.action ? ` ${failure.action}` : ""}`);
  }
  return lines.join("\n");
}
