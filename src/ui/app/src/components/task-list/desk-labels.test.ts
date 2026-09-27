import { describe, expect, it } from "vitest";
import { deskLabels } from "./TaskRowLine";

describe("desktop row labels", () => {
  it("leaves off a label that only restates the priority the row already draws", () => {
    expect(deskLabels(["p1", "cap:iam", "priority:high", "P0"], true)).toEqual(["cap:iam"]);
  });
  it("keeps every label where no priority is drawn", () => {
    expect(deskLabels(["p1", "cap:iam"], false)).toEqual(["p1", "cap:iam"]);
  });
});
