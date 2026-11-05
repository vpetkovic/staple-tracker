/**
 * Did the agent use a memory it was shown? The Stop hook answers from the agent's last
 * reply: an explicit `[brain:<name>]` citation, or the record's name or short id in the text.
 * A bare name counts only when it is distinctive (hyphenated, 8+ characters), so an
 * ordinary word in a reply is not mistaken for a citation.
 */
import { readFileSync } from "node:fs";
import type { BrainRecord } from "./types.js";

export function citedIn(text: string, candidates: readonly BrainRecord[]): string[] {
  const out: string[] = [];
  for (const r of candidates) {
    const name = r.name ?? "";
    const explicit = name !== "" && text.includes(`[brain:${name}]`);
    const named = name.length >= 8 && name.includes("-") && new RegExp(`(^|[^a-z0-9-])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9-]|$)`, "i").test(text);
    const byId = text.includes(r.id.slice(0, 8));
    if (explicit || named || byId) out.push(r.id);
  }
  return out;
}

/**
 * The assistant's text since the last user message, from a transcript file: Claude Code's
 * (`{type:"assistant", message:{content:[{type:"text", text}]}}`) or Codex's rollout
 * (`{type:"response_item", payload:{type:"message", role:"assistant", content:[{type:"output_text", text}]}}`).
 */
export function lastAssistantText(path: string | null): string | null {
  if (!path) return null;
  let lines: string[];
  try {
    lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  } catch {
    return null;
  }
  const texts: string[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    let row: Record<string, any>;
    try {
      row = JSON.parse(lines[i]!) as Record<string, any>;
    } catch {
      continue;
    }
    const claudeRole = row.type === "assistant" || row.type === "user" ? row.type : null;
    const codex = row.type === "response_item" && row.payload?.type === "message" ? row.payload : null;
    const role = claudeRole ?? codex?.role ?? null;
    if (role === "user") {
      // A tool result arrives as a user row in Claude transcripts; only a real prompt ends the turn.
      const content = claudeRole ? row.message?.content : codex?.content;
      const isToolResult = Array.isArray(content) && content.every((c: any) => c?.type === "tool_result");
      if (!isToolResult && texts.length) break;
      continue;
    }
    if (role !== "assistant") continue;
    const content = claudeRole ? row.message?.content : codex?.content;
    if (typeof content === "string") texts.unshift(content);
    else if (Array.isArray(content)) {
      for (const c of content) if (typeof c?.text === "string" && (c.type === "text" || c.type === "output_text")) texts.unshift(c.text);
    }
  }
  return texts.length ? texts.join("\n") : null;
}
