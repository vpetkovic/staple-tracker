/**
 * The about view: a placeholder that proves the MCP Apps loop end to end. It renders the
 * `show_about` result, follows the host theme, reports its size, and its Refresh button calls
 * `show_about` again through the host.
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import "../shared/base.css";
import "./about.css";
import { h, resultText, startView, type ViewHost } from "../shared/runtime.js";

interface About {
  server: { name: string; version: string };
  workspace: {
    slug: string;
    prefix: string;
    total: number;
    statuses: Array<{ id: string; label: string; category: string; count: number }>;
  } | null;
  views: Array<{ name: string; uri: string; title: string }>;
}

function read(result: CallToolResult): About | null {
  const data = result.structuredContent as Partial<About> | undefined;
  return data?.server && Array.isArray(data.views) && data.workspace !== undefined ? (data as About) : null;
}

const root = document.getElementById("view")!;
let refreshes = 0;
let refreshNote = "";

function hostLine(host: ViewHost): string {
  const context = host.context;
  const dimensions = context?.containerDimensions as { width?: number; maxWidth?: number } | undefined;
  const width = dimensions?.width ?? dimensions?.maxWidth ?? Math.round(document.documentElement.clientWidth);
  return [host.hostName ?? "unknown host", context?.theme ?? document.documentElement.dataset.theme, `${width}px`]
    .filter(Boolean)
    .join(" · ");
}

function render(about: About, host: ViewHost): void {
  const workspace = about.workspace;
  const statusPills = workspace
    ? workspace.statuses
        .filter((status) => status.count > 0)
        .map((status) => h("span", { class: "view-pill", "data-status": status.id }, `${status.label} ${status.count}`))
    : [];
  const refresh = h("button", { class: "view-button", type: "button", "data-action": "refresh" }, "Refresh");
  const note = h("p", { class: "about-status view-muted", role: "status", "data-refresh-note": "" }, refreshNote);
  refresh.addEventListener("click", async () => {
    refresh.disabled = true;
    note.textContent = "Calling show_about through the host…";
    try {
      const result = await host.callTool("show_about", host.toolArguments);
      if (result.isError || read(result) === null) {
        note.textContent = `Refresh failed: ${resultText(result) || "no result"}`;
        refresh.disabled = false;
        return;
      }
      refreshes += 1;
      refreshNote = `Refreshed through the host (${refreshes} tool call${refreshes === 1 ? "" : "s"}).`;
      host.show(result);
    } catch (error) {
      note.textContent = `Refresh failed: ${error instanceof Error ? error.message : String(error)}`;
      refresh.disabled = false;
    }
  });

  root.replaceChildren(
    h(
      "section",
      { class: "view-card", "data-view": "about", "aria-label": "About this staple server" },
      h(
        "div",
        { class: "about-head" },
        h("h1", { class: "about-title" }, "staple"),
        h("span", { class: "view-pill view-mono", "data-version": "" }, `v${about.server.version}`),
      ),
      h(
        "dl",
        { class: "about-facts" },
        h("dt", {}, "Workspace"),
        h(
          "dd",
          { "data-workspace": workspace?.slug ?? "" },
          workspace ? `${workspace.slug} · ${workspace.prefix}` : "none resolves here",
        ),
        h("dt", {}, "Tickets"),
        h(
          "dd",
          {},
          workspace ? String(workspace.total) : "–",
          statusPills.length > 0 ? h("div", { class: "about-statuses" }, ...statusPills) : null,
        ),
        h("dt", {}, "Views"),
        h("dd", { class: "view-mono" }, about.views.map((view) => view.uri).join(", ")),
        h("dt", {}, "Host"),
        h("dd", { "data-host": "" }, hostLine(host)),
      ),
      h("div", { class: "about-actions" }, refresh, note),
    ),
  );
}

startView({ name: "about", root, read, render });
