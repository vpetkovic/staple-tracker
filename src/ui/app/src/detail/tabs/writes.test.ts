/**
 * Who a comment and a document restore are signed with: the person's own name when they
 * have given one, otherwise nothing, so the server's "ui" applies.
 */
import { describe, expect, it } from "vitest";
import { personActor } from "../parts";
import { commentWrite, restoreWrite } from "./writes";

const store = (entries: Record<string, string>) => ({
  getItem: (key: string) => entries[key] ?? null,
  setItem: () => {},
  removeItem: () => {},
});

describe("tab writes", () => {
  it("signs a comment with the person's name when they have given one", () => {
    expect(commentWrite("staple", "id-1", "looks good", "VP")).toEqual({
      target: { ws: "staple", ref: "id-1", actor: "VP" },
      payload: { type: "comment", body: "looks good" },
    });
  });

  it("sends no actor without a name, so the server signs it ui", () => {
    const write = commentWrite("staple", "id-1", "looks good", undefined);
    expect(write.target).toEqual({ ws: "staple", ref: "id-1" });
    expect("actor" in write.target).toBe(false);
    expect(commentWrite("staple", "id-1", "x", "").target).not.toHaveProperty("actor");
  });

  it("signs a restore the same way, and keeps the revision it restores and the base it read", () => {
    expect(restoreWrite("staple", "id-1", "plan", 2, 5, "VP")).toEqual({
      target: { ws: "staple", ref: "id-1", actor: "VP" },
      payload: { type: "doc_restore", key: "plan", revision: 2, baseRevision: 5 },
    });
    expect(restoreWrite("staple", "id-1", "plan", 2, 5, null).target).not.toHaveProperty("actor");
  });

  it("takes the person's own name, never the working name", () => {
    // `staple:actor` is the last Start work name (maybe an agent's); it must not sign a comment.
    expect(personActor(store({ "staple:actor": "codex-1" }))).toBeUndefined();
    expect(commentWrite("staple", "id-1", "x", personActor(store({ "staple:actor": "codex-1" }))).target).not.toHaveProperty("actor");
    expect(commentWrite("staple", "id-1", "x", personActor(store({ "staple:me": "VP", "staple:actor": "codex-1" }))).target.actor).toBe("VP");
  });
});
