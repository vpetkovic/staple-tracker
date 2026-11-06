/**
 * Sharing a workspace by link: the invite box and its copy buttons, joining from `?join=`,
 * the shared badge and the switcher's marker. Rendered to strings like every settings test.
 *
 * The two properties that matter most: nothing leaves this computer before "Request to
 * join", and a workspace with no member list (or one member) renders exactly what it did
 * before sharing existed.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { CloudLinkJoinPreview, CloudShareOffer, CloudSharedWorkspace } from "@/lib/types";
import { AUTO_SYNC_NOTE, IDLE_INVITE, InviteBoxView, copyText, textFor, type InviteActions } from "./InviteBox";
import { JoinDialogView, joinTitle, type JoinDialogActions } from "@/components/join/JoinDialog";
import { joinLinkFromSearch, openJoinedWorkspace, withoutJoin, workspaceHref } from "@/components/join/LinkJoinMount";
import { SharedBadgeView } from "@/components/SharedBadge";
import { readShellUrl } from "@/lib/session-url";
import { sharedBadgeText, sharedChips, sharedRow, syncDot } from "@/lib/shared-workspaces";

const NOOP = () => {};
const LINK =
  "https://staple-tracker-sync.example.workers.dev/join/60fff10e-0000-4000-8000-000000000000?n=ai-inbox-supabase&p=AII&by=VP&as=marko";

const OFFER: CloudShareOffer = {
  link: LINK,
  command: `staple cloud join '${LINK}'`,
  message: `VP invited you to the shared Staple workspace ai-inbox-supabase.\n\nOpen: ${LINK}`,
  name: "ai-inbox-supabase",
  prefix: "AII",
  invitedAs: "marko",
  autoSyncMandatory: true,
};

const INVITE_ACTIONS: InviteActions = { onName: NOOP, onGenerate: NOOP, onCopy: NOOP };

describe("the invite box", () => {
  it("before generating: the name field, the button, and the note that joining means automatic sync", () => {
    const html = renderToStaticMarkup(<InviteBoxView state={IDLE_INVITE} actions={INVITE_ACTIONS} slug="aii" />);
    expect(html).toContain("Invite someone");
    expect(html).toContain("Their name (optional)");
    expect(html).toContain("Generate link");
    expect(html).toContain(AUTO_SYNC_NOTE.slice(0, 40));
    expect(html).not.toContain("data-copy=");
  });

  it("after generating: the link, three copy buttons, and the copied state on the one pressed", () => {
    const html = renderToStaticMarkup(
      <InviteBoxView state={{ ...IDLE_INVITE, offer: OFFER, copied: "command" }} actions={INVITE_ACTIONS} slug="aii" />,
    );
    expect(html).toContain(`value="${LINK.replace(/&/g, "&amp;")}"`);
    expect(html).toContain("Copy link");
    expect(html).toContain("Copy message");
    expect(html).toMatch(/data-copy="command" data-copied="">[\s\S]*?Copied/);
    expect(html).not.toContain("Copy command");
    expect(html).toContain("The link suggests the name");
    expect(textFor(OFFER, "link")).toBe(LINK);
    expect(textFor(OFFER, "command")).toBe(OFFER.command);
    expect(textFor(OFFER, "message")).toBe(OFFER.message);
  });

  it("without a clipboard, shows the text selected in a read-only field", () => {
    const html = renderToStaticMarkup(
      <InviteBoxView state={{ ...IDLE_INVITE, offer: OFFER, fallback: "message" }} actions={INVITE_ACTIONS} slug="aii" />,
    );
    expect(html).toMatch(/<textarea[^>]*readOnly=""[^>]*data-copy-fallback=""/);
    expect(html).toContain("press ⌘C or Ctrl+C");
  });

  it("copyText: copied when the clipboard takes it, fallback otherwise", async () => {
    const taken: string[] = [];
    const board = { writeText: async (text: string) => void taken.push(text) };
    expect(await copyText("x", board)).toBe("copied");
    expect(taken).toEqual(["x"]);
    expect(await copyText("x", null)).toBe("fallback");
    expect(await copyText("x", undefined)).toBe("fallback");
    expect(await copyText("x", board, false)).toBe("fallback");
    expect(await copyText("x", { writeText: async () => Promise.reject(new Error("denied")) })).toBe("fallback");
  });
});

describe("joining from a link", () => {
  const PREVIEW: CloudLinkJoinPreview = {
    endpoint: "https://staple-tracker-sync.example.workers.dev",
    repositoryId: "60fff10e-0000-4000-8000-000000000000",
    deviceId: null,
    label: "thinkpad",
    credentialMechanism: "keychain",
    credentialFallbackReason: null,
    alreadyConnected: false,
    existingEndpoint: null,
    autoAfterConnect: false,
    endpointSource: "link",
    autoSync: "on (shared workspace)",
    link: {
      endpoint: "https://staple-tracker-sync.example.workers.dev",
      repositoryId: "60fff10e-0000-4000-8000-000000000000",
      name: "ai-inbox-supabase",
      prefix: "AII",
      sharedBy: "VP",
      invitedAs: "marko",
    },
  };
  const ACTIONS: JoinDialogActions = { onRequest: NOOP, onLabel: NOOP, onCancel: NOOP, onRetry: NOOP, onClose: NOOP };
  const STATE = {
    stage: "preview" as const,
    preview: PREVIEW,
    consent: { id: "c", digest: "d", expiresAt: "x" },
    label: "thinkpad",
    target: { name: "ai-inbox-supabase", created: true, fromCheckout: false },
  };

  it("reads the link out of the address, and refuses anything else", () => {
    const search = `?join=${encodeURIComponent(LINK)}&view=tasks`;
    expect(joinLinkFromSearch(search)).toEqual({ link: LINK, name: "ai-inbox-supabase" });
    expect(joinLinkFromSearch("?join=https%3A%2F%2Fevil.example%2Fsomething")).toBeNull();
    expect(joinLinkFromSearch("?join=not%20a%20url")).toBeNull();
    expect(joinLinkFromSearch("?view=tasks")).toBeNull();
    expect(withoutJoin(`http://localhost:4400/${search}`)).toBe("/?view=tasks");
    expect(workspaceHref("ai inbox")).toBe("/?ws=ai%20inbox&view=tasks");
    // The app reads an address only when it names a view, so a bare ?ws= would land on All workspaces.
    expect(readShellUrl(workspaceHref("ai inbox").slice(1))?.ws).toBe("ai inbox");
  });

  it("says who invited you to what, the service, the device, and that sync will be on", () => {
    const html = renderToStaticMarkup(<JoinDialogView state={STATE} slug="ai-inbox-supabase" now={0} actions={ACTIONS} />);
    expect(html).toContain("VP invited you to join ai-inbox-supabase");
    expect(html).toContain("staple-tracker-sync.example.workers.dev");
    expect(html).toMatch(/<input[^>]*aria-label="Device name"[^>]*value="thinkpad"/);
    expect(html).toContain("On (this is a shared workspace)");
    expect(html).toContain("A workspace named &quot;ai-inbox-supabase&quot; is made on this computer, after you continue.");
    expect(html).toContain("Not end-to-end encrypted");
    expect(joinTitle(STATE, "ai-inbox-supabase")).toBe("Join ai-inbox-supabase");
    // Said once, in the body, not repeated as the title.
    expect(html.match(/VP invited you to join ai-inbox-supabase/g)).toHaveLength(1);
  });

  it("opening the joined workspace syncs it first, so the board is not empty, and opens it even if that fails", async () => {
    const steps: string[] = [];
    await openJoinedWorkspace("ai-inbox-supabase", {
      sync: async (slug) => void steps.push(`sync:${slug}`),
      assign: (href) => void steps.push(`open:${href}`),
    });
    expect(steps).toEqual(["sync:ai-inbox-supabase", "open:/?ws=ai-inbox-supabase&view=tasks"]);
    steps.length = 0;
    await openJoinedWorkspace("ai-inbox-supabase", {
      sync: async () => Promise.reject(new Error("offline")),
      assign: (href) => void steps.push(`open:${href}`),
    });
    expect(steps).toEqual(["open:/?ws=ai-inbox-supabase&view=tasks"]);
  });

  it("shows the code with a copy button, then offers to open the workspace it joined", () => {
    const waiting = renderToStaticMarkup(
      <JoinDialogView
        state={{ stage: "waiting", started: { joinId: "j", code: "K7QX-29MB", expiresAt: 600_000, label: "thinkpad", endpoint: PREVIEW.endpoint, workspace: "ai-inbox-supabase" } }}
        slug="ai-inbox-supabase"
        now={0}
        actions={ACTIONS}
      />,
    );
    expect(waiting).toContain("K7QX-29MB");
    expect(waiting).toContain("Copy code");
    const joined = renderToStaticMarkup(
      <JoinDialogView
        state={{ stage: "joined", name: "marko", endpoint: PREVIEW.endpoint, workspace: "ai-inbox-supabase", auto: true }}
        slug="ai-inbox-supabase"
        now={0}
        actions={{ ...ACTIONS, onOpenWorkspace: NOOP }}
      />,
    );
    expect(joined).toContain("Open ai-inbox-supabase");
    expect(joined).toContain("Automatic sync is on");
  });
});

describe("no request before Request to join", () => {
  const TOKEN = "t0ken";
  beforeEach(() => {
    vi.resetModules();
    const store = new Map<string, string>([["staple:token", TOKEN]]);
    vi.stubGlobal("location", { search: "", pathname: "/", hash: "" });
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("previewing a link is one call to this computer's own server; only the request starts the join", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      seen.push(url);
      const body = url.endsWith("/preview")
        ? { preview: { label: "thinkpad" }, consent: { id: "c" }, target: { name: "ai-inbox-supabase", created: true, fromCheckout: false } }
        : { joinId: "j", code: "K7QX-29MB", expiresAt: 1, label: "thinkpad", endpoint: "x", workspace: "ai-inbox-supabase", created: true };
      return { ok: true, status: 200, json: async () => body, clone: () => ({ json: async () => body }) } as unknown as Response;
    });
    const { joinApi, requestJoin } = await import("@/components/join/JoinDialog");
    const api = joinApi("ai-inbox-supabase", LINK);
    const answer = await api.preview();
    expect(seen).toEqual(["/api/cloud/join-link/preview"]);
    expect(answer.target?.created).toBe(true);

    // Unchanged name: the ticket on screen is the one sent, and the start is the first egress.
    seen.length = 0;
    await requestJoin(
      { slug: "ai-inbox-supabase", preview: answer.preview, consent: answer.consent, label: answer.preview.label },
      api,
    );
    expect(seen).toEqual(["/api/cloud/join-link/start"]);
  });
});

describe("the shared badge and the switcher's marker", () => {
  const SHARED: CloudSharedWorkspace = {
    slug: "aii",
    shared: true,
    autoSyncLocked: true,
    members: [
      { memberId: "m-vp", name: "VP", isOwner: true, self: true },
      { memberId: "m-marko", name: "marko", isOwner: false, self: false },
    ],
  };
  const SOLO: CloudSharedWorkspace = { ...SHARED, shared: false, autoSyncLocked: false, members: [SHARED.members[0]!] };

  it("reads 'Shared · 2 members' with the members' chips and a live sync dot", () => {
    const html = renderToStaticMarkup(<SharedBadgeView row={SHARED} report={{ state: "automatic", mode: "automatic" }} />);
    expect(html).toContain("Shared · 2 members");
    expect(html).toContain('data-shared-badge="2"');
    expect(html).toContain('data-sync-dot="syncing"');
    expect(html).toContain('data-member-chip="m-marko"');
    expect(html).toContain('data-member-chip="m-vp"');
    expect(html).toContain("Shared with marko");
    expect(sharedBadgeText(SHARED)).toBe("Shared · 2 members");
    // Others first, yourself last.
    expect(sharedChips(SHARED).shown.map((m) => m.name)).toEqual(["marko", "VP"]);
  });

  it("renders nothing for a workspace that is not shared, or with no member list", () => {
    expect(renderToStaticMarkup(<SharedBadgeView row={null} report={{ state: "automatic", mode: "automatic" }} />)).toBe("");
    const rows = new Map([
      ["aii", SHARED],
      ["solo", SOLO],
    ]);
    expect(sharedRow(rows, "aii")).toBe(SHARED);
    expect(sharedRow(rows, "solo")).toBeNull();
    expect(sharedRow(rows, "unknown")).toBeNull();
    expect(sharedRow(new Map(), "aii")).toBeNull();
  });

  it("the dot says whether it is keeping up", () => {
    expect(syncDot({ state: "automatic", mode: "automatic" })).toBe("syncing");
    expect(syncDot({ state: "offline", mode: "automatic" })).toBe("attention");
    expect(syncDot({ state: "removed", mode: "automatic" })).toBe("stopped");
    expect(syncDot({ state: "manual", mode: "manual" })).toBe("idle");
    expect(syncDot(null)).toBe("idle");
  });

  it("the switcher marks a workspace only when the store says it is shared", () => {
    const source = readFileSync(fileURLToPath(new URL("../components/nav/WorkspaceSwitcher.tsx", import.meta.url)), "utf8");
    expect(source).toMatch(/\{sharedRow\(sharedRows, row\.value\) \? \([\s\S]{0,200}data-switcher-shared/);
  });
});
