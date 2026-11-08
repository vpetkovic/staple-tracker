import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { openDb } from "../src/core/db.js";
import { migrateWorkspace } from "../src/core/schema.js";
import { WorkspaceStore } from "../src/core/store.js";
import { HorizonsBoard } from "../src/ui/app/src/views/plan/PlanBoards.js";

vi.mock("../src/ui/app/src/lib/use-media", () => ({ useIsDesk: () => false }));

it("uses server counts and late warnings in the phone's horizon switcher", () => {
  const db = openDb(":memory:");
  migrateWorkspace(db);
  const store = new WorkspaceStore(db, "test", "LAR");
  store.plan().enable("person");
  const plan = store.plan().view();
  Object.assign(plan.horizons[0], { ideaCount: 7, memberCount: 9, lateCount: 4 });
  const html = renderToStaticMarkup(<HorizonsBoard plan={plan} write={async () => true} onOpen={() => {}} selected={null} />);
  expect(html).toContain("7 ideas · 9 members");
  expect(html).toContain('aria-label="4 late"');
  db.close();
});

it("uses singular idea and member wording in the phone switcher", () => {
  const db = openDb(":memory:");
  migrateWorkspace(db);
  const store = new WorkspaceStore(db, "test", "LAR");
  store.plan().enable("person");
  const plan = store.plan().view();
  Object.assign(plan.horizons[0], { ideaCount: 1, memberCount: 1 });
  const html = renderToStaticMarkup(<HorizonsBoard plan={plan} write={async () => true} onOpen={() => {}} selected={null} />);
  expect(html).toContain("1 idea · 1 member");
  expect(html).not.toContain("1 ideas");
  db.close();
});
