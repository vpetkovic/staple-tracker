import type { WorkspaceStore } from "./store.js";
import { StapleError, WORKLOG_KEY } from "./types.js";

/** A handoff must describe this tenure, rather than reusing a previous worker's notes. */
export function checkpointedSince(store: WorkspaceStore, issueId: string, since: string): boolean {
  let document: ReturnType<WorkspaceStore["getDocument"]>;
  try {
    document = store.getDocument(issueId, WORKLOG_KEY);
  } catch (error) {
    if (error instanceof StapleError && error.code === "not_found") return false;
    throw error;
  }
  if (!(Date.parse(document.createdAt) >= Date.parse(since))) return false;
  // Check the required handoff sections, without trying to judge the agent's prose.
  const sections = new Map<string, string[]>();
  let current: string[] | undefined;
  for (const line of document.body.split(/\r?\n/)) {
    const heading = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      current = [];
      sections.set(heading[1]!.trim().toLowerCase(), current);
    } else {
      current?.push(line);
    }
  }
  return ["done", "next", "files touched"].every((key) => sections.get(key)?.join("\n").trim());
}

export function worklogReminder(ref: string): string {
  return `Write a current worklog with Done, Next, and Files touched sections, each with content (say "none" when appropriate): staple checkpoint ${ref} --done "..." --next "..." --files "..." --json (or staple doc ${ref} worklog --put <file>). Update it at every milestone and before handoff; comments alone are not a checkpoint.`;
}
