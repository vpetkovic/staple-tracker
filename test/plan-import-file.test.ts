/**
 * Ideas from files (design/plan.md, "Ideas from files"): a .md, .html or .jsx file becomes an idea
 * with its original attached under Files; Markdown maps to its sections; with no maturity chosen the
 * idea waits to be classified, a plan step for an agent to read the file, fill the plan and set or
 * propose its stage. The same on the device that imported it, on one that received it by sync and
 * on a freshly hydrated one.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/core/db.js";
import type { PlanStore } from "../src/core/plan-store.js";
import { htmlTitle, importFormatOf } from "../src/core/plan-import.js";
import { migrateWorkspace } from "../src/core/schema.js";
import { WorkspaceStore } from "../src/core/store.js";
import { StapleError } from "../src/core/types.js";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";
import { Fleet, type Machine } from "./fixtures/sync-machines.js";
import { READY_PLAN } from "./fixtures/plan-ready.js";

const PERSON = { person: { via: "plan_view" } } as const;
const REPO = "5eed0000-0000-4000-8000-000000000590";

const MARKDOWN = `# Gift cards

Sell gift cards at checkout.

## Goal

Customers buy and redeem gift cards.

## Task breakdown

| # | Task | Est. |
|---|---|---|
| 1 | Card model | 2h |
| 2 | Redeem at checkout | 3h |

## Acceptance criteria

- A card is bought and redeemed

## Open questions

- [ ] Do cards expire?
`;

const HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Passkeys &amp; SSO &#8212; chat</title></head><body><h1>Ignored</h1><p>We talked about passkeys.</p></body></html>`;
const JSX = `export function CheckoutMock() {\n  return <div className="checkout">Pay</div>;\n}\n`;

function refused(fn: () => unknown): StapleError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(StapleError);
    return error as StapleError;
  }
  throw new Error("expected a refusal");
}

describe("importing a file as an idea", () => {
  let store: WorkspaceStore;
  let plan: PlanStore;
  beforeEach(() => {
    const db = openDb(":memory:");
    migrateWorkspace(db);
    store = new WorkspaceStore(db, "test", "TST");
    plan = store.plan();
    plan.clock = () => new Date("2026-11-27T12:00:00.000Z");
    plan.enable("vp", { person: { via: "settings" } });
  });

  const ideaCount = () => (store.db.prepare("SELECT COUNT(*) AS n FROM issues WHERE plan_maturity IS NOT NULL").get() as { n: number }).n;
  const fileCount = () => (store.db.prepare("SELECT COUNT(*) AS n FROM attachments").get() as { n: number }).n;

  it("maps a Markdown plan to its sections and keeps the original, byte for byte, under Files", () => {
    const result = plan.importPlan({ name: "gift-cards.md", content: MARKDOWN }, {}, "agent");
    const detail = result.idea;
    expect(detail.idea).toMatchObject({ title: "Gift cards", maturity: "raw", state: "raw" });
    expect(detail.brief).toBe("Sell gift cards at checkout.");
    expect(detail.plan.goal).toBe("Customers buy and redeem gift cards.");
    expect(detail.plan.breakdown.map((row) => row.title)).toEqual(["Card model", "Redeem at checkout"]);
    expect(detail.plan.acceptance).toEqual(["A card is bought and redeemed"]);
    expect(detail.plan.sources).toEqual(["gift-cards.md (attached)"]);
    expect(detail.questions.map((q) => q.text)).toEqual(["Do cards expire?"]);
    expect(result.rows).toBe(2);
    const [file] = store.listFiles(detail.idea.id);
    expect(file).toMatchObject({ filename: "gift-cards.md", mediaType: "text/plain", caption: "The file this idea was imported from", author: "agent" });
    expect(Buffer.from(store.readFile(file!.id).bytes).toString("utf8")).toBe(MARKDOWN);
    // Files, not Documents: no document holds the file.
    expect(store.listDocuments(detail.idea.id).map((doc) => doc.key)).not.toContain("gift-cards.md");
  });

  it("takes an HTML page's title, and a JSX file's name, and attaches each as it was given", () => {
    const html = plan.importPlan({ name: "passkeys-chat.html", content: new TextEncoder().encode(HTML) }, {}, "agent").idea;
    expect(html.idea.title).toBe("Passkeys & SSO — chat");
    expect(html.plan.goal).toBeNull();
    expect(store.listFiles(html.idea.id)).toMatchObject([{ filename: "passkeys-chat.html", mediaType: "text/html" }]);
    const jsx = plan.importPlan({ name: "checkout-mock.jsx", content: JSX }, {}, "agent").idea;
    expect(jsx.idea.title).toBe("checkout-mock");
    expect(store.listFiles(jsx.idea.id)).toMatchObject([{ filename: "checkout-mock.jsx", size: Buffer.byteLength(JSX) }]);
    expect(Buffer.from(store.readFile(store.listFiles(jsx.idea.id)[0]!.id).bytes).toString("utf8")).toBe(JSX);
  });

  it("reads an HTML title from <title>, else the first <h1>, else the file name", () => {
    expect(htmlTitle("<h1>Plan <em>B</em></h1>")).toBe("Plan B");
    expect(htmlTitle("<title>  </title><h1>Fallback</h1>")).toBe("Fallback");
    expect(htmlTitle("<p>none</p>")).toBeNull();
    expect(plan.importPlan({ name: "untitled-export.htm", content: "<html><body><p>hi</p></body></html>" }, {}, "agent").idea.idea.title).toBe("untitled-export");
    expect(["a.md", "a.MARKDOWN", "a.html", "a.HTM", "a.jsx", "a.tsx", "a.pdf", "md"].map(importFormatOf)).toEqual(["markdown", "markdown", "html", "html", "jsx", null, null, null]);
  });

  it("refuses any other file type, a file that is not text, an empty one and one with no name, writing nothing", () => {
    const before = { ideas: ideaCount(), files: fileCount() };
    expect(refused(() => plan.importPlan({ name: "plan.pdf", content: "%PDF-1.4" }, {}, "agent")).message).toContain(".md, .html or .jsx");
    expect(refused(() => plan.importPlan({ name: "plan.tsx", content: JSX }, {}, "agent")).code).toBe("validation");
    expect(refused(() => plan.importPlan({ name: "plan.md", content: new Uint8Array([0xff, 0xfe, 0x00, 0x41]) }, {}, "agent")).message).toContain("not UTF-8 text");
    expect(refused(() => plan.importPlan({ name: "plan.md", content: "  \n" }, {}, "agent")).message).toContain("empty");
    expect(refused(() => plan.importPlan({ name: "", content: MARKDOWN }, {}, "agent")).code).toBe("validation");
    expect({ ideas: ideaCount(), files: fileCount() }).toEqual(before);
  });

  it("is refused with planning off, and its idea hides with planning off and is back, step and file, when it is on again", () => {
    const id = plan.importPlan({ name: "gift-cards.md", content: MARKDOWN }, {}, "agent").idea.idea.id;
    store.setSetting("features.planning", false, "vp", PERSON.person);
    expect(refused(() => plan.importPlan({ name: "x.md", content: MARKDOWN }, {}, "agent")).code).toBe("validation");
    plan.enable("vp", PERSON);
    expect(plan.ideaView(id).nextStep?.need).toBe("classify");
    expect(store.listFiles(id)).toHaveLength(1);
  });

  describe("with no maturity chosen, a classify step", () => {
    const imported = (name = "gift-cards.md", content: string = MARKDOWN) => plan.importPlan({ name, content }, {}, "agent").idea.idea;

    it("asks an agent to read the file, fill the plan and set or propose its stage, with no horizon carrying it", () => {
      const idea = imported("passkeys-chat.html", HTML);
      expect(idea.nextStep).toMatchObject({ ideaId: idea.id, need: "classify", who: "agent", horizonId: null, state: "raw" });
      expect(idea.nextStep!.instruction).toContain("passkeys-chat.html");
      expect(idea.nextStep!.instruction).toContain(`staple idea plan ${idea.number}`);
      expect(idea.nextStep!.instruction).toContain(`staple idea propose ${idea.number}`);
      expect(idea.nextStep!.instruction).toContain(`staple idea set ${idea.number} --classified`);
      // An agent's step, never the person's Needs you.
      expect(plan.view().ideas.find((view) => view.id === idea.id)!.nextStep?.who).toBe("agent");
    });

    it("is none when the person chose a maturity, raw included", () => {
      for (const maturity of ["raw", "exploring"]) {
        const idea = plan.importPlan({ name: `${maturity}.md`, content: MARKDOWN }, { maturity }, "vp", PERSON).idea.idea;
        expect(idea.maturity).toBe(maturity);
        expect(idea.nextStep).toBeNull();
      }
      const shaped = plan.importPlan({ name: "shaped.md", content: MARKDOWN.replace("- [ ] Do cards expire?", "- [x] Do cards expire?") }, { maturity: "shaped" }, "vp", PERSON).idea.idea;
      expect(shaped.maturity).toBe("shaped");
      expect(shaped.nextStep).toBeNull();
    });

    it("is settled by filling the plan, which moves it to exploring", () => {
      const idea = imported();
      plan.update(idea.id, { plan: { risks: "Fraud on stolen cards." } }, "agent");
      const view = plan.ideaView(idea.id);
      expect(view.state).toBe("exploring");
      expect(view.nextStep).toBeNull();
    });

    it("is settled by proposing it shaped, and a dismissed proposal does not bring it back", () => {
      const idea = imported("gift-cards.md", MARKDOWN.replace("- [ ] Do cards expire?", "- [x] Do cards expire?"));
      plan.update(idea.id, { proposeShaped: { note: "The file settles it." } }, "agent");
      expect(plan.ideaView(idea.id).nextStep?.need).not.toBe("classify");
      plan.update(idea.id, { dismissProposal: true }, "vp", PERSON);
      expect(plan.ideaView(idea.id)).toMatchObject({ state: "raw", nextStep: null });
    });

    it("is settled by leaving it raw on purpose, anyone's once, and refused where nothing waits", () => {
      const idea = imported();
      plan.update(idea.id, { classified: true }, "agent");
      expect(plan.ideaView(idea.id)).toMatchObject({ state: "raw", maturity: "raw", nextStep: null });
      expect(refused(() => plan.update(idea.id, { classified: true }, "agent")).message).toContain("Nothing waits to be classified");
      const captured = plan.capture({ title: "Typed in" }, "agent").id;
      expect(refused(() => plan.update(captured, { classified: true }, "agent")).message).toContain("Nothing waits to be classified");
      const chosen = plan.importPlan({ name: "chosen.md", content: MARKDOWN }, { maturity: "raw" }, "vp", PERSON).idea.idea.id;
      expect(refused(() => plan.update(chosen, { classified: true }, "agent")).code).toBe("validation");
    });

    it("is settled when the person moves its maturity, and returns only while it is raw and unclassified", () => {
      const idea = imported();
      plan.update(idea.id, { maturity: "dropped" }, "vp", PERSON);
      expect(plan.ideaView(idea.id).nextStep).toBeNull();
      plan.update(idea.id, { maturity: "exploring" }, "vp", PERSON);
      expect(plan.ideaView(idea.id)).toMatchObject({ state: "exploring", nextStep: null });
    });

    it("cannot be written or cleared as a raw document", () => {
      const idea = imported();
      expect(refused(() => store.putDocument(idea.id, "classify", "", { author: "agent" })).message).toContain("classify request");
      const other = plan.capture({ title: "Other" }, "agent").id;
      expect(refused(() => store.putDocument(other, "classify", "x.md", { author: "agent" })).code).toBe("validation");
      expect(plan.ideaView(idea.id).nextStep?.need).toBe("classify");
    });

    it("is the horizon's step, in place of brainstorm, for a sub-idea the horizon carries", () => {
      const horizon = plan.createHorizon({ name: "Gift season" }, "vp", PERSON);
      const parent = plan.capture({ title: "Checkout", maturity: "shaped", plan: READY_PLAN, horizon: horizon.id }, "vp", PERSON).id;
      const sub = plan.importPlan({ name: "gift-cards.md", content: MARKDOWN }, { parent }, "agent").idea.idea;
      expect(sub.nextStep).toMatchObject({ need: "classify", who: "agent", horizonId: horizon.id, parentId: parent });
      const steps = plan.planStepsOf(horizon.id);
      expect(steps.find((step) => step.ideaId === sub.id)).toMatchObject({ need: "classify", horizonId: horizon.id });
      plan.update(sub.id, { classified: true }, "agent");
      expect(plan.ideaView(sub.id).nextStep?.need).toBe("brainstorm");
    });

    it("reads every waiting import in one statement, however many there are", () => {
      for (let n = 0; n < 6; n += 1) imported(`plan-${n}.md`);
      // Every read that names the classify key, by its bound values.
      const reads: unknown[][] = [];
      const prepare = store.db.prepare.bind(store.db);
      // The store keeps its one-document read prepared: let it be prepared again, where it is watched.
      (plan as unknown as { headBody?: unknown }).headBody = undefined;
      store.db.prepare = ((sql: string) => {
        const statement = prepare(sql);
        for (const verb of ["get", "all"] as const) {
          const run = statement[verb].bind(statement) as (...args: unknown[]) => unknown;
          (statement as unknown as Record<string, unknown>)[verb] = (...args: unknown[]) => {
            if (args.includes("classify")) reads.push(args);
            return run(...args);
          };
        }
        return statement;
      }) as typeof store.db.prepare;
      try {
        // A write first: the plan's facts are derived afresh for the state it leaves.
        plan.capture({ title: "Typed in" }, "agent");
        expect(plan.view().ideas.filter((view) => view.nextStep?.need === "classify")).toHaveLength(6);
      } finally {
        store.db.prepare = prepare;
      }
      expect(reads).toHaveLength(1);
    });
  });
});

describe("an imported idea over sync", () => {
  let fleet: Fleet | null = null;
  afterEach(() => {
    fleet?.close();
    fleet = null;
  });

  function reading(machine: Machine, idea: string) {
    const plan = machine.store.plan();
    plan.clock = () => new Date("2026-11-27T12:00:00.000Z");
    const view = plan.ideaView(idea);
    return { title: view.title, maturity: view.maturity, state: view.state, step: view.nextStep?.need ?? null, files: machine.store.listFiles(idea).map((file) => file.filename) };
  }
  const conflicts = (machine: Machine): unknown[] => machine.db.prepare("SELECT field FROM sync_conflicts WHERE resolved_at IS NULL").all();

  async function both(a: Machine, b: Machine, rounds = 2): Promise<void> {
    for (let round = 0; round < rounds; round += 1) {
      for (const machine of [a, b]) {
        machine.use();
        await machine.sync();
      }
    }
  }

  async function pair(fold: "service" | "tail"): Promise<{ a: Machine; b: Machine; idea: string }> {
    const server = new FakeSyncServer({ repositoryId: REPO, ...(fold === "tail" ? { maxSnapshotFoldOps: 3 } : {}) });
    fleet = new Fleet(server, REPO);
    const a = fleet.machine("a");
    a.store.plan().enable("vp", { person: { via: "settings" } });
    const idea = a.store.plan().importPlan({ name: "passkeys-chat.html", content: HTML }, {}, "agent").idea.idea.id;
    await a.sync();
    const b = fleet.machine("b");
    await b.sync();
    return { a, b, idea };
  }

  for (const fold of ["service", "tail"] as const) {
    it(`reads the same classify step and file on a device that received it and on a fresh one (${fold} fold)`, async () => {
      const { a, b, idea } = await pair(fold);
      expect(reading(a, idea)).toEqual({ title: "Passkeys & SSO — chat", maturity: "raw", state: "raw", step: "classify", files: ["passkeys-chat.html"] });
      expect(reading(b, idea)).toEqual(reading(a, idea));
      const fresh = fleet!.machine("fresh");
      await fresh.sync();
      expect(reading(fresh, idea)).toEqual(reading(a, idea));
    });

    it(`one device leaving it raw while another fills its plan converges on exploring, with no conflict (${fold} fold)`, async () => {
      const { a, b, idea } = await pair(fold);
      a.use();
      a.store.plan().update(idea, { classified: true }, "agent-a");
      b.use();
      b.store.plan().update(idea, { plan: { goal: "Sign in without a password." } }, "agent-b");
      await both(a, b);
      expect(reading(a, idea)).toMatchObject({ state: "exploring", step: null });
      expect(reading(b, idea)).toEqual(reading(a, idea));
      expect(conflicts(a)).toEqual([]);
      expect(conflicts(b)).toEqual([]);
      const fresh = fleet!.machine("fresh");
      await fresh.sync();
      expect(reading(fresh, idea)).toEqual(reading(a, idea));
    });

    it(`two devices both leaving it raw converge with the step settled, with no conflict (${fold} fold)`, async () => {
      const { a, b, idea } = await pair(fold);
      a.use();
      a.store.plan().update(idea, { classified: true }, "agent-a");
      b.use();
      b.store.plan().update(idea, { classified: true }, "agent-b");
      await both(a, b);
      expect(reading(a, idea)).toMatchObject({ state: "raw", step: null });
      expect(reading(b, idea)).toEqual(reading(a, idea));
      expect(conflicts(a)).toEqual([]);
      expect(conflicts(b)).toEqual([]);
    });
  }
});
