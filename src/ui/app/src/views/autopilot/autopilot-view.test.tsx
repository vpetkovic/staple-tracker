/**
 * The Autopilot view's wiring: the selected run is the address's, choosing a run goes through
 * `session.openRun`, and a linked run the list does not hold is shown beside the listed ones.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { buildRunsState, RunsContext } from "@/lib/runs";
import { SessionContext } from "@/lib/session";
import { fakeSession } from "@/views/fake-session";
import { failedEntry, workingEntry } from "./fixtures";

const linked = failedEntry({ title: "An older run" });
vi.mock("@/lib/runs", async (original) => ({
  ...(await original<typeof import("@/lib/runs")>()),
  useRunEntry: (runId: string | null) => ({ entry: runId === linked.run.id ? linked : null, error: undefined, loading: false }),
}));
vi.mock("@/detail/parts", async (original) => ({ ...(await original<typeof import("@/detail/parts")>()), useNow: () => new Date("2026-11-26T12:08:00.000Z") }));

const { AutopilotView } = await import("./AutopilotView");

function render(run: string | null): string {
  const listed = workingEntry();
  return renderToStaticMarkup(
    <SessionContext value={fakeSession({ view: "autopilot", run })}>
      <RunsContext value={buildRunsState([listed], () => {}, "2026-11-26T12:08:00.000Z")}>
        <AutopilotView onAuthError={() => {}} />
      </RunsContext>
    </SessionContext>,
  );
}

describe("the Autopilot view", () => {
  it("shows the run the address names", () => {
    const listed = workingEntry();
    expect(render(listed.run.id)).toContain(`data-autopilot-panes="run"`);
    expect(render(null)).toContain(`data-autopilot-panes="list"`);
  });

  it("lists a linked run the page's read does not hold, and shows it", () => {
    const html = render(linked.run.id);
    expect(html).toContain(`data-run-item="${linked.run.id}"`);
    expect(html).toContain(`data-run-detail="${linked.run.id}"`);
    expect(html).not.toContain("data-run-unknown");
  });
});
