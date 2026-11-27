/**
 * The Return lens and a role page against REAL server answers.
 *
 * As `views/budget/budget-e2e.test.tsx`: the real HTTP server (`src/ui/server.ts`, in this
 * process, hub mode) serves two workspaces whose tickets and attempts were written through the
 * real store, and the real components are rendered from what came off the wire with
 * `react-dom/server`. The cost model is changed only by posting the writes `cost-edits.ts`
 * builds, so the server's validator accepts every one of them. No figure the assertions name is
 * hand-written: each is read from the response.
 *
 * The cases run in order, each building on the model the one before saved: Just me on the
 * defaults, one workspace, A company with nothing entered, A company with seats per role, a
 * role page with chips and other rules, removing a role, a refusal, and nothing spent.
 */
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { formatMoney, formatMultiple, formatPercent } from "@/components/analytics/format";
import type { CostModelResponse, CostModelWrite, RoiResponse, RoiTicketsResponse } from "@/lib/analytics-api";
import { setClock } from "../../../../../core/types.ts";
import { initWorkspace } from "../../../../../core/workspace.ts";
import { startUiServer, type UiHandle } from "../../../../server.ts";
import { costEdits, refusalSentence, withHome, type CostEdit } from "./cost-edits";
import { homeWords, saveWords } from "./CostSetupDialog";
import { AmountField, type CostApi } from "./return-parts";
import { returnView } from "./return-model";
import { ReturnPage } from "./ReturnPage";
import { RolePageView } from "./RolePage";

const T0 = Date.parse("2026-09-01T09:00:00.000Z");
const QUERY = "from=2026-09-01&to=2026-09-07&tz=UTC";
const query = { from: "2026-09-01", to: "2026-09-07", tz: "UTC" };

let home: string;
let ui: UiHandle;
let origin: string;
const previousHome = process.env.STAPLE_HOME;

async function http<T>(path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const response = await fetch(`${origin}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "x-staple-token": ui.token, origin, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify({ actor: "ui", ...(body as object) }) }),
  });
  return { status: response.status, body: (await response.json()) as T };
}
async function get<T>(path: string): Promise<T> {
  const answer = await http<T>(path);
  expect(answer.status, path).toBe(200);
  return answer.body;
}
const roiOf = (scope = "hub") => get<RoiResponse>(`/api/analytics/roi?scope=${scope}&${QUERY}`);
const modelOf = () => get<CostModelResponse>("/api/analytics/cost-model?scope=hub");
/** Save one edit as the lens does: the edit's write, with the first save sent to the suggested workspace. */
async function save(change: CostEdit | CostModelWrite | null): Promise<CostModelResponse> {
  expect(change).not.toBeNull();
  const now = await modelOf();
  const write = "next" in change! && "write" in change! ? (change as CostEdit).write : (change as CostModelWrite);
  const answer = await http<CostModelResponse>("/api/analytics/cost-model?scope=hub", withHome(write, now.home));
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
  return answer.body;
}

const costApi = (response: CostModelResponse): CostApi => ({ model: response.model, response, save: { state: "idle" }, apply: () => {}, problem: () => undefined, workspaces: [{ slug: "alpha", prefix: "ALP" }, { slug: "beta", prefix: "BET" }] });
const page = (roi: RoiResponse | undefined, response: CostModelResponse | null, error?: Error) =>
  renderToStaticMarkup(<ReturnPage roi={roi} cost={response ? costApi(response) : null} error={error} onRetry={() => {}} query={query} onAuthError={() => {}} onOpenTicket={() => {}} />);

/** The markup of the element carrying `attribute`, up to its matching close tag. */
function section(html: string, attribute: string): string {
  const start = html.indexOf(attribute);
  expect(start, attribute).toBeGreaterThan(-1);
  const open = html.lastIndexOf("<", start);
  const tag = /^<(\w+)/.exec(html.slice(open))![1]!;
  let depth = 0;
  const pattern = new RegExp(`<${tag}[\\s>]|</${tag}>`, "g");
  pattern.lastIndex = open;
  for (let match = pattern.exec(html); match; match = pattern.exec(html)) {
    depth += match[0].startsWith("</") ? -1 : 1;
    if (depth === 0) return html.slice(open, pattern.lastIndex);
  }
  throw new Error(`unclosed ${attribute}`);
}
const text = (html: string): string =>
  html
    .replace(/<[^>]+>/g, "")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"');
const money = (value: number) => formatMoney(value, "$");

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "staple-return-ui-e2e-"));
  process.env.STAPLE_HOME = home;
  process.env.NODE_NO_WARNINGS = "1";
  let clock = T0;
  setClock(() => clock);
  const at = (minutes: number): void => void (clock = T0 + minutes * 60_000);
  const tickets: Record<string, { title: string; hours?: number; labels?: string[]; work: number }[]> = {
    alpha: [
      { title: "Build the importer", hours: 2, work: 60 },
      { title: "Build the exporter", hours: 3, work: 90 },
      { title: "Settings page", hours: 4, labels: ["design"], work: 60 },
      { title: "Wire CI", labels: ["ci"], work: 30 },
    ],
    beta: [{ title: "Docs for the API", hours: 2, work: 45 }],
  };
  for (const [slug, list] of Object.entries(tickets)) {
    const store = initWorkspace({ global: true, slug }).store;
    for (const [n, ticket] of list.entries()) {
      at(n * 240);
      const id = store.createIssue({ title: ticket.title, ...(ticket.hours ? { estimatedSeconds: ticket.hours * 3600 } : {}), ...(ticket.labels ? { labels: ticket.labels } : {}) }).id;
      store.checkoutIssue(id, `${slug}-worker`, undefined, { attempt: { harness: "claude_code", model: "claude-opus-5-5" } });
      at(n * 240 + ticket.work);
      store.updateIssue(id, { status: "done" }, `${slug}-worker`);
    }
    store.db.close();
  }
  setClock(null);
  ui = startUiServer({ port: 0, hub: true });
  await once(ui.server, "listening");
  origin = `http://127.0.0.1:${(ui.server.address() as AddressInfo).port}`;
}, 60_000);

afterAll(async () => {
  await new Promise<void>((resolve) => (ui ? ui.server.close(() => resolve()) : resolve()));
  if (previousHome === undefined) delete process.env.STAPLE_HOME;
  else process.env.STAPLE_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

describe("Just me, on the shipped defaults, every workspace", () => {
  it("prints the server's return, roles, shared AI and directing time", async () => {
    const roi = await roiOf();
    const model = await modelOf();
    const html = page(roi, model);
    const low = roi.measured.returnOnTotalCost!;
    const high = roi.planned.returnOnTotalCost!;
    expect(text(section(html, "data-figure"))).toBe(`${formatMultiple(low).replace("×", "")}–${formatMultiple(high)}`);
    expect(text(section(html, "data-answer-sentence"))).toContain(`with AI it cost ${money(roi.measured.totalCost)}`);
    const table = section(html, 'data-role-layout="table"');
    for (const row of roi.measured.byRole.filter((item) => item.present)) {
      const cells = text(section(table, `data-role-row="${row.roleId}"`));
      expect(cells).toContain(row.title);
      expect(cells).toContain(`${row.tickets} tickets`);
      expect(cells).toContain(money(row.value));
    }
    const shared = text(section(table, 'data-role-row="shared"'));
    expect(shared).toContain(money(roi.measured.sharedAiCost));
    // The shipped plan, as the model the server answered with holds it: nothing here is typed in.
    const plan = model.model.solo.entries[0]!;
    expect(shared).toContain(`${plan.label} $${plan.monthlyAmount} × ${plan.quantity} a month`);
    expect(shared).not.toContain("of agent time");
    const person = text(section(table, 'data-role-row="person"'));
    expect(person).toContain(`Your time, directing the agents${roi.basis.activeDaysHub} days agents ran × ${model.model.solo.director.hoursPerActiveDay} h a day`);
    expect(person).toContain(money(roi.measured.director.cost));
    expect(text(section(table, 'data-role-row="total"'))).toContain(money(roi.measured.totalCost));
  });

  it("counts the assumed figures from the profile's list and says nothing is saved yet", async () => {
    const roi = await roiOf();
    const model = await modelOf();
    expect(roi.caveats).toContainEqual({ code: "default_cost_model", count: 5, of: 5 });
    const notice = text(section(page(roi, model), 'data-notice="assumed"'));
    expect(notice).toContain(`Cost setup is not saved yet. ${model.model.solo.assumed.length} figures are defaults, not yours yet: your hourly rate, your hours a day, AI spend, role rates.`);
    expect(page(roi, model)).not.toContain('data-notice="no_ai_spend"');
  });

  it("says where the first save will go", async () => {
    const model = await modelOf();
    expect(model.home.slug).toBeNull();
    expect(homeWords(model.home)).toBe(`Not saved yet. Your first change is saved with ${model.home.suggested}.`);
  });
});

describe("one workspace", () => {
  it("prints its share in the arithmetic of the shared AI and the directing time", async () => {
    const roi = await roiOf("alpha");
    const html = page(roi, await modelOf());
    expect(roi.basis.share).toBeGreaterThan(0);
    expect(roi.basis.share).toBeLessThan(1);
    const share = formatPercent(roi.basis.share);
    expect(text(section(html, 'data-role-row="person"'))).toContain(`× ${share} of agent time`);
    expect(text(section(html, 'data-role-row="shared"'))).toContain(`AI subscription $200 × 1 a month × ${share} of agent time`);
    expect(text(section(html, "data-method-share"))).toContain(`it carries ${share} of the shared AI spend`);
    expect(text(html)).toContain("Return on total cost · Sep 1");
    expect(text(html)).toContain("· alpha");
  });
});

describe("A company", () => {
  it("with nothing entered, says there is no AI spend and words the cost as an employee's", async () => {
    const saved = await save(costEdits.scenario((await modelOf()).model, "company"));
    expect(saved.home.slug).toBe(saved.home.suggested);
    const roi = await roiOf();
    expect(roi.caveats.map((caveat) => caveat.code)).toContain("no_ai_spend");
    const html = page(roi, await modelOf());
    expect(text(section(html, 'data-notice="no_ai_spend"'))).toContain("No AI spend is entered in this profile for this period, so the cost here is only an employee's time");
    expect(text(section(html, 'data-role-row="person"'))).toContain("Employee time, directing the agents");
    expect(html).not.toContain('data-role-row="shared"');
    expect(text(section(html, 'data-notice="assumed"'))).not.toContain("not saved yet");
  });

  it("with seats bought for a role and a shared API bill, prints each line and the server's cost", async () => {
    let model = (await modelOf()).model;
    model = (await save(costEdits.entryAdd(model, "design-engineer", "subscription", "seat-design"))).model;
    model = (await save(costEdits.entry(model, "seat-design", { monthlyAmount: 30 }))).model;
    model = (await save(costEdits.entry(model, "seat-design", { quantity: 2 }))).model;
    model = (await save(costEdits.entryAdd(model, null, "api", "shared-api"))).model;
    model = (await save(costEdits.entry(model, "shared-api", { monthlyAmount: 100 }))).model;
    const roi = await roiOf();
    const designer = roi.measured.byRole.find((row) => row.roleId === "design-engineer")!;
    expect(designer.aiEntries).toHaveLength(1);
    const html = page(roi, await modelOf());
    const row = text(section(html, 'data-role-row="design-engineer"'));
    expect(row).toContain("Subscription $30 × 2 a month");
    expect(row).toContain(money(designer.aiCost));
    expect(text(section(html, 'data-role-row="shared"'))).toContain("API bill $100 a month");
    expect(text(section(html, 'data-role-row="shared"'))).toContain(money(roi.measured.sharedAiCost));
    expect(html).not.toContain('data-notice="no_ai_spend"');
    // The narrow layout carries the same figures.
    expect(text(section(html, 'data-role-card="design-engineer"'))).toContain(money(designer.aiCost));
  });
});

describe("a role page", () => {
  it("lists the tickets the server priced at the role, each with what caught it, and how the role is recognized", async () => {
    let model = (await modelOf()).model;
    model = (await save(costEdits.chipAdd(model, "technical-writer", "label", "ci"))).model;
    // Rules the page does not edit as chips: one with two conditions, one that sets a kind of work.
    model = (
      await save({ roleMapping: { types: model.roleMapping.types, rules: [...model.roleMapping.rules, { label: "infra", agent: "alpha-*", roleId: "technical-writer" }, { title: "manual", type: "documentation" }], assumed: [] } })
    ).model;
    const roi = await roiOf();
    const tickets = await get<RoiTicketsResponse>(`/api/analytics/roi/tickets?scope=hub&roleId=technical-writer&${QUERY}`);
    const view = returnView(roi, model);
    const writer = view.all.find((role) => role.roleId === "technical-writer")!;
    const html = renderToStaticMarkup(<RolePageView role={writer} view={view} cost={costApi(await modelOf())} tickets={{ data: tickets, error: undefined, loading: false, reload: () => {} }} onBack={() => {}} onSetup={() => {}} onOpenTicket={() => {}} />);

    expect(tickets.tickets.map((ticket) => ticket.title).sort()).toEqual(["Docs for the API", "Wire CI"]);
    const list = section(html, "data-role-tickets");
    expect(text(list)).toContain(`Its tickets ${tickets.total}`);
    const ci = tickets.tickets.find((ticket) => ticket.title === "Wire CI")!;
    const docs = tickets.tickets.find((ticket) => ticket.title === "Docs for the API")!;
    expect(ci.reason).toEqual({ code: "rule", detail: "0" });
    expect(text(section(list, `data-ticket="${ci.identifier}"`))).toContain("rule 1");
    expect(docs.reason.code).toBe("title");
    expect(section(list, `data-ticket="${docs.identifier}"`)).toContain('data-caught-by="title"');

    const recognized = text(section(html, "data-role-recognized"));
    expect(recognized).toContain("documentation work");
    expect(recognized).toContain("label ci");
    expect(recognized).toContain("rule 2");
    expect(recognized).toContain("rule 3");
    expect(text(section(html, "data-role-rules-other"))).toContain('rule 2, tickets labelled infra and done by agents named alpha-*; rule 3, tickets titled with "manual" count as documentation work.');
    expect(text(section(html, "data-role-sentence"))).toContain(`${writer.tickets} finished tickets were this role's work`);
    // Not the role holding engineering: its kinds can be taken off.
    expect(html).toContain('aria-label="Remove documentation"');
  });

  it("says when it shows the first of more tickets than the route returns", async () => {
    const roi = await roiOf();
    const tickets = await get<RoiTicketsResponse>(`/api/analytics/roi/tickets?scope=hub&roleId=software-engineer&limit=1&${QUERY}`);
    expect(tickets.total).toBeGreaterThan(1);
    const model = await modelOf();
    const view = returnView(roi, model.model);
    const engineer = view.all.find((role) => role.roleId === "software-engineer")!;
    const html = renderToStaticMarkup(<RolePageView role={engineer} view={view} cost={costApi(model)} tickets={{ data: tickets, error: undefined, loading: false, reload: () => {} }} onBack={() => {}} onSetup={() => {}} onOpenTicket={() => {}} />);
    expect(text(section(html, "data-tickets-note"))).toContain(`the first 1 of ${tickets.total}`);
    // The role holding engineering takes everything else, and its kinds have nowhere to go.
    expect(text(section(html, "data-role-recognized"))).toContain("everything no other role matched");
    expect(html).not.toContain('aria-label="Remove engineering"');
  });
});

describe("removing a role", () => {
  it("moves its kinds of work to the engineering role and drops its rules in one save the server accepts", async () => {
    let model = (await modelOf()).model;
    model = (await save(costEdits.chipAdd(model, "design-engineer", "label", "ux"))).model;
    const saved = await save(costEdits.roleRemove(model, "design-engineer"));
    expect(saved.model.roles.roles.map((role) => role.id)).toEqual(["software-engineer", "technical-writer"]);
    expect(saved.model.roleMapping.types.design).toBe("software-engineer");
    expect(saved.model.roleMapping.rules.some((rule) => rule.roleId === "design-engineer")).toBe(false);
    const roi = await roiOf();
    expect(roi.fallbacks).toEqual([]);
    const html = page(roi, saved);
    expect(html).not.toContain('data-role-row="design-engineer"');
    // Its seat now counts as shared spend.
    expect(text(section(html, 'data-role-row="shared"'))).toContain("Subscription $30 × 2 a month");
  });
});

describe("a refusal", () => {
  it("brings the server's sentence to the field", async () => {
    const model = (await modelOf()).model;
    const refused = await http<{ code: string; message: string }>("/api/analytics/cost-model?scope=hub", { company: { ...model.company, savedAt: undefined, rates: { "software-engineer": -1 } } });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("validation");
    const sentence = refusalSentence(refused.body.message);
    expect(sentence).toBe("Rates.software-engineer must be a number from 0 to 100000.");
    const field = renderToStaticMarkup(<AmountField label="To hire, an hour" value={100} onCommit={() => {}} problem={sentence} />);
    expect(text(section(field, "data-field-problem"))).toBe(sentence);
    expect(field).toContain('aria-invalid="true"');
    expect(saveWords({ state: "failed", reason: "validation", message: sentence, field: "x" })).toBe(`Not saved: ${sentence}`);
    expect(saveWords({ state: "failed", reason: "conflict", message: "", field: "x" })).toContain("Settings, Cloud, Conflicts");
  });
});

describe("states", () => {
  it("draws the skeleton while loading, the problem with Try again on a failed read, and keeps the page on a failed refetch", async () => {
    const roi = await roiOf();
    const model = await modelOf();
    expect(page(undefined, null)).toContain("data-return-skeleton");
    const failed = page(undefined, null, new Error("The hub could not be read."));
    expect(text(failed)).toContain("The return could not be worked out");
    expect(text(failed)).toContain("Try again");
    const kept = page(roi, model, new Error("The hub could not be read."));
    expect(kept).toContain("data-return-answer");
    expect(kept).not.toContain("could not be worked out");
  });

  it("says nothing was spent when the period cost nothing", async () => {
    let model = (await modelOf()).model;
    model = (await save(costEdits.directorRate(model, 0))).model;
    for (const entry of model.company.entries) model = (await save(costEdits.entryRemove(model, entry.id))).model;
    const roi = await roiOf();
    expect(roi.measured.totalCost).toBe(0);
    expect(roi.measured.returnOnTotalCost).toBeNull();
    expect(text(section(page(roi, await modelOf()), "data-nothing-spent"))).toBe("Nothing was spent in this period, so there is no return to work out.");
  });
});

describe("where it is saved", () => {
  it("names the home workspace once a save made one, and says it stays on this computer when it does not sync", async () => {
    const model = await modelOf();
    expect(model.home.slug).not.toBeNull();
    expect(model.home.synced).toBe(false);
    expect(homeWords(model.home)).toBe(`Saved on this computer only, with ${model.home.slug}.`);
    expect(homeWords({ ...model.home, synced: true })).toBe(`Saved with ${model.home.slug}, and it follows you to your other devices.`);
    expect((await roiOf()).caveats).toContainEqual({ code: "home_not_synced", count: 1, of: null });
  });
});
