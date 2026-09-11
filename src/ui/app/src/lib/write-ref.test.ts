import { describe, expect, it } from "vitest";
import { EMPTY_CREATE_FORM, buildCreatePayload } from "../components/createIssueForm";
import type { IssueRow } from "./types";
import { idsOf, pinnedRef } from "./write-ref";

const row = (workspace: string, id: string, identifier: string): IssueRow =>
  ({ workspace, issue: { id, identifier } }) as unknown as IssueRow;

const rows = [row("tracker", "id-2", "TRA-2"), row("tracker", "id-5", "TRA-5"), row("other", "id-9", "OTH-9")];

describe("a write from the page names its issue by id", () => {
  it("a number the page shows, as the id of the row showing it; another workspace's as <slug>:<id>", () => {
    expect(pinnedRef(rows, "tracker", "tra-5")).toBe("id-5");
    expect(pinnedRef(rows, "tracker", "OTH-9")).toBe("other:id-9");
    expect(pinnedRef(rows, "tracker", "id-2")).toBe("id-2");
    // Nothing on the page names it: left for the store to answer, in its own words.
    expect(pinnedRef(rows, "tracker", "TRA-77")).toBe("TRA-77");
  });

  it("an order or a row the reader acted on, as the ids of the rows that showed it", () => {
    const entries = [
      { identifier: "TRA-2", id: "id-2" },
      { identifier: "TRA-5", id: "id-5" },
    ];
    expect(idsOf(entries, ["TRA-5", "TRA-2"])).toEqual(["id-5", "id-2"]);
  });

  it("the create dialog's parent and relations, pinned", () => {
    const form = { ...EMPTY_CREATE_FORM, title: "New", parent: "TRA-2", blockedBy: ["TRA-5"], blocking: ["OTH-9"] };
    const payload = buildCreatePayload(form, (ref) => pinnedRef(rows, "tracker", ref));
    expect(payload).toEqual(expect.objectContaining({ parent: "id-2", blockedBy: ["id-5"], blocking: ["other:id-9"] }));
  });
});
