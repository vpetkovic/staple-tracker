import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/core/db.js";
import { migrateWorkspace } from "../src/core/schema.js";
import { WorkspaceStore } from "../src/core/store.js";

/**
 * The words written ON a ticket find it: `listIssues({ q })`, which is what `staple ls -q`,
 * the MCP list tool and the toolbar search (`/api/search`) all ask.
 *
 * Each case puts a word in exactly one place on one ticket, beside a decoy ticket that does
 * not carry it, so a match can only come from the place under test.
 */

function memStore(): WorkspaceStore {
  const db = openDb(":memory:");
  migrateWorkspace(db);
  return new WorkspaceStore(db, "test", "TST");
}

let store: WorkspaceStore;
beforeEach(() => {
  store = memStore();
  store.createIssue({ title: "Decoy with nothing to find" });
});

const found = (q: string) => store.listIssues({ q, includeResolved: true }).map((issue) => issue.title);

describe("text search over what is written on a ticket", () => {
  it("finds a word that appears only in the title", () => {
    store.createIssue({ title: "Rotate the zephyrine keys" });
    expect(found("zephyrine")).toEqual(["Rotate the zephyrine keys"]);
  });

  it("finds a word that appears only in an acceptance criterion", () => {
    store.createIssue({ title: "Criterion holder", acceptanceCriteria: ["First", "The quokkas are counted"] });
    expect(found("quokkas")).toEqual(["Criterion holder"]);
  });

  it("finds a word that appears only in a comment", () => {
    const issue = store.createIssue({ title: "Comment holder" });
    store.addComment(issue.identifier, "tried the marmoset approach, it failed");
    expect(found("marmoset")).toEqual(["Comment holder"]);
  });

  it("finds a word that appears only in a plan document", () => {
    const issue = store.createIssue({ title: "Plan holder" });
    store.putDocument(issue.identifier, "plan", "1. migrate the axolotl table");
    expect(found("axolotl")).toEqual(["Plan holder"]);
  });

  it("finds a word that appears only in a worklog document", () => {
    const issue = store.createIssue({ title: "Worklog holder" });
    store.putDocument(issue.identifier, "worklog", "## Done\nbisected to the pangolin commit");
    expect(found("pangolin")).toEqual(["Worklog holder"]);
  });

  it("matches the CURRENT document revision, not a word an edit removed", () => {
    const issue = store.createIssue({ title: "Edited plan" });
    const first = store.putDocument(issue.identifier, "plan", "use the wombat cache");
    store.putDocument(issue.identifier, "plan", "use the plain cache", { baseRevision: first.revision });
    expect(found("wombat")).toEqual([]);
    expect(found("plain cache")).toEqual(["Edited plan"]);
  });

  it("matches a label and an assignee, as the toolbar always has", () => {
    store.createIssue({ title: "Labelled", labels: ["narwhal-label"] });
    store.createIssue({ title: "Assigned", assignee: "okapi-agent" });
    expect(found("narwhal")).toEqual(["Labelled"]);
    expect(found("okapi")).toEqual(["Assigned"]);
  });

  it("is case-insensitive and lists a ticket once however many places match", () => {
    const issue = store.createIssue({ title: "Ibis everywhere", acceptanceCriteria: ["ibis"] });
    store.addComment(issue.identifier, "IBIS");
    store.addComment(issue.identifier, "ibis again");
    store.putDocument(issue.identifier, "plan", "Ibis");
    expect(found("iBiS")).toEqual(["Ibis everywhere"]);
  });

  it("treats % and _ as literal characters, not wildcards", () => {
    const issue = store.createIssue({ title: "Literal holder" });
    store.addComment(issue.identifier, "coverage is at 100% for a_b");
    store.addComment(store.createIssue({ title: "Wildcard bait" }).identifier, "1000 runs of axb");
    expect(found("100%")).toEqual(["Literal holder"]);
    expect(found("a_b")).toEqual(["Literal holder"]);
  });

  it("ignores surrounding whitespace, as the toolbar does", () => {
    const issue = store.createIssue({ title: "Spaced holder" });
    store.putDocument(issue.identifier, "plan", "ocelot");
    expect(found("  ocelot ")).toEqual(["Spaced holder"]);
  });

  it("still finds nothing for a word written nowhere", () => {
    expect(found("unwritten-word")).toEqual([]);
  });
});
