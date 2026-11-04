/**
 * The ticket card's reads, without a server: the branch pointer read off comments, the web
 * UI base the deep link starts from, and a milestone's criterion marks. The card rendering
 * in a host is test/mcp-views-ticket.test.ts.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { updateConfig } from "../src/config/file.js";
import { initWorkspace } from "../src/core/workspace.js";
import type { IssueComment } from "../src/core/types.js";
import { branchPointer, formatDuration, stapleUiBase, ticketCard, ticketUrl } from "../src/mcp-ticket-card.js";

function comment(body: string, at = "2026-11-04T10:00:00.000Z", author = "pat"): IssueComment {
  return { id: at, issueId: "i", author, authorType: "agent", body, idempotencyKey: null, deletedAt: null, createdAt: at };
}

describe("branchPointer", () => {
  it("reads the claim-time convention", () => {
    expect(branchPointer([comment("Branch pointer: branch feat/reset-lockout, base 7d1e2f3.")])).toEqual({
      name: "feat/reset-lockout",
      base: "7d1e2f3",
      author: "pat",
      at: "2026-11-04T10:00:00.000Z",
    });
  });

  it("reads the short form, with a base branch and sha", () => {
    expect(branchPointer([comment("working on branch fix/retry (off main 3f2a1bc)")])).toMatchObject({
      name: "fix/retry",
      base: "main 3f2a1bc",
    });
  });

  it("takes the newest pointer and ignores comments that only mention a branch", () => {
    const comments = [
      comment("Branch pointer: branch feat/one, base aaaaaaa.", "2026-11-04T10:00:00.000Z"),
      comment("Branch pointer: branch feat/two.", "2026-11-04T11:00:00.000Z"),
      comment("Rebased the branch feat/three onto main.", "2026-11-04T12:00:00.000Z"),
    ];
    expect(branchPointer(comments)).toMatchObject({ name: "feat/two", base: null, at: "2026-11-04T11:00:00.000Z" });
  });

  it("stops the base at the end of its sentence, and reads a pointer without the word branch", () => {
    expect(branchPointer([comment("Branch pointer: branch feat/x, base 3f2a1bc. Plan stored.")])).toMatchObject({
      name: "feat/x",
      base: "3f2a1bc",
    });
    expect(branchPointer([comment("Branch pointer: `feat/x` off main")])).toMatchObject({ name: "feat/x", base: "main" });
  });

  it("is null when no comment is a pointer", () => {
    expect(branchPointer([comment("Looks good."), comment("Branch pointer: none yet")])).toBeNull();
    expect(branchPointer([])).toBeNull();
  });
});

describe("stapleUiBase and ticketUrl", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "staple-card-base-"));
    process.env.STAPLE_HOME = join(home, ".staple");
  });
  afterEach(() => {
    delete process.env.STAPLE_HOME;
    rmSync(home, { recursive: true, force: true });
  });

  it("uses STAPLE_UI_URL, and never keeps a token in it", () => {
    expect(stapleUiBase({ STAPLE_UI_URL: "https://staple.example.test/ui/" })).toBe("https://staple.example.test/ui/");
    expect(stapleUiBase({ STAPLE_UI_URL: "http://127.0.0.1:4410/?token=secret#x" })).toBe("http://127.0.0.1:4410/");
    expect(stapleUiBase({ STAPLE_UI_URL: "https://user:pass@staple.example.test/?Token=a&TOKEN=b&view=tasks" })).toBe(
      "https://staple.example.test/?view=tasks",
    );
  });

  it("leaves the link out when STAPLE_UI_URL says off or is not an http address", () => {
    for (const value of ["off", "none", "OFF", "false", "0", "ftp://host/", "not a url"]) {
      expect(stapleUiBase({ STAPLE_UI_URL: value }), value).toBeNull();
    }
  });

  it("defaults to the loopback address on the configured UI port", () => {
    expect(stapleUiBase({})).toBe("http://127.0.0.1:4400/");
    updateConfig(join(home, ".staple"), { port: 4567 });
    expect(stapleUiBase({})).toBe("http://127.0.0.1:4567/");
  });

  it("adds the workspace and the ticket to the base, keeping what the base already says", () => {
    expect(ticketUrl("http://127.0.0.1:4400/", "shop", "SHO-12")).toBe("http://127.0.0.1:4400/?ws=shop&issue=SHO-12");
    expect(ticketUrl("https://staple.example.test/ui/?view=tasks", "shop", "SHO-12")).toBe(
      "https://staple.example.test/ui/?view=tasks&ws=shop&issue=SHO-12",
    );
  });
});

describe("ticketCard", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "staple-card-store-"));
    process.env.STAPLE_HOME = join(home, ".staple");
  });
  afterEach(() => {
    delete process.env.STAPLE_HOME;
    rmSync(home, { recursive: true, force: true });
  });

  it("marks a milestone's criteria with its goal check", () => {
    const { store } = initWorkspace({ global: true, slug: "goals" });
    try {
      store.addKind({ id: "milestone", label: "Milestone" }, "pat");
      const milestones = store.milestones();
      const created = milestones.create({ title: "Launch", acceptanceCriteria: ["Docs written", "Tests pass", "Announced"] }, "pat");
      if (created.preview) throw new Error("create returned a preview");
      const ref = created.milestone.identifier;
      milestones.markCriterion(ref, 1, { verdict: "met", evidence: ["the guide is published"] }, "pat");
      milestones.markCriterion(ref, 2, { verdict: "unmet", note: "two suites fail" }, "pat");
      const card = ticketCard(store, ref, null);
      expect(card.criteria).toEqual([
        { text: "Docs written", mark: "met" },
        { text: "Tests pass", mark: "unmet" },
        { text: "Announced", mark: "open" },
      ]);
      expect(card.kind.id).toBe("milestone");
      expect(card.url).toBeNull();
      expect(card.attempt).toBeNull();
      expect(card.branch).toBeNull();
    } finally {
      store.db.close();
    }
  });
});

describe("ticketCard's branch pointer", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "staple-card-pointer-"));
    process.env.STAPLE_HOME = join(home, ".staple");
  });
  afterEach(() => {
    delete process.env.STAPLE_HOME;
    rmSync(home, { recursive: true, force: true });
  });

  it("is the newest pointer, however many comments came before it", () => {
    const { store } = initWorkspace({ global: true, slug: "pointers" });
    try {
      const { identifier } = store.createIssue({ title: "Long thread" });
      store.addComment(identifier, "Branch pointer: branch feat/first, base aaaaaaa.", "pat", "agent");
      for (let i = 0; i < 250; i++) store.addComment(identifier, `note ${i}`, "pat", "agent");
      store.addComment(identifier, "Branch pointer: branch feat/second, base bbbbbbb.", "pat", "agent");
      expect(ticketCard(store, identifier, null).branch).toMatchObject({ name: "feat/second", base: "bbbbbbb" });
    } finally {
      store.db.close();
    }
  });
});

describe("formatDuration", () => {
  it("says how long for a person", () => {
    expect([0, 59, 60, 3599, 3600, 3660, 3 * 3600 + 5 * 60, 48 * 3600].map(formatDuration)).toEqual([
      "0s",
      "59s",
      "1m",
      "59m",
      "1h",
      "1h 01m",
      "3h 05m",
      "48h",
    ]);
  });
});
