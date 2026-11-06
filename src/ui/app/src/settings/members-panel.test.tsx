/**
 * Settings → Members, the approval toast and the join flow.
 *
 * Rendered to a string, as every settings test here is (no DOM, no testing library). The
 * properties that matter are what each person is OFFERED and what the page is allowed to
 * ask the service on its own, and both are visible in the markup and the pure model.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { CloudJoinRequest, CloudMemberList, CloudSurfaceReport } from "@/lib/types";
import { IDLE_MEMBERS, MembersPanel, defaultDraft, draftReady, type MembersActions, type MembersState } from "./MembersSection";
import {
  approveChoices,
  countdown,
  joinPollDelay,
  mayPollJoinRequests,
  mayRemoveDevice,
  mayRemoveMember,
  mayRename,
  memberInitials,
  relativeTime,
  removeConfirmMatches,
} from "./members-settings";
import { JoinDialogView, joinTitle, requestJoin, type JoinDialogActions, type JoinStage } from "@/components/join/JoinDialog";
import { JoinOfferView, offersJoin } from "@/components/join/JoinOffer";
import { JoinRequestToastView, toastRequest, watchJoinRequests } from "@/components/join/JoinRequestToast";

const NOW = 1_800_000_000_000;
const NOOP = () => {};
const ACTIONS: MembersActions = {
  onDraft: NOOP,
  onApprove: NOOP,
  onDeny: NOOP,
  onRenameStart: NOOP,
  onRenameDraft: NOOP,
  onRenameSave: NOOP,
  onRenameCancel: NOOP,
  onRemoveAsk: NOOP,
  onRemoveTyped: NOOP,
  onRemoveConfirm: NOOP,
  onRemoveCancel: NOOP,
  onRemoveDevice: NOOP,
  onReload: NOOP,
};

/** VP owns the workspace with two devices; marko has one. `self` decides who is looking. */
function list(self: "vp" | "marko"): CloudMemberList {
  return {
    version: 1,
    repositoryId: "60fff10e-0000-4000-8000-000000000000",
    fetchedAt: new Date(NOW).toISOString(),
    self: self === "vp" ? { memberId: "m-vp", deviceId: "d-mbp" } : { memberId: "m-marko", deviceId: "d-thinkpad" },
    members: [
      {
        memberId: "m-vp",
        name: "VP",
        isOwner: true,
        removed: false,
        devices: [
          { deviceId: "d-mbp", label: "mbp-16", lastSeenAt: NOW - 5_000, revoked: false },
          { deviceId: "d-studio", label: "mac-studio", lastSeenAt: NOW - 2 * 3600_000, revoked: false },
        ],
      },
      {
        memberId: "m-marko",
        name: "marko",
        isOwner: false,
        removed: false,
        devices: [{ deviceId: "d-thinkpad", label: "thinkpad", lastSeenAt: NOW - 5 * 60_000, revoked: false }],
      },
    ],
  };
}

const REQUEST: CloudJoinRequest = {
  requestId: "jr-1",
  code: "K7QX-29MB",
  label: "thinkpad-2",
  createdAt: NOW - 40_000,
  expiresAt: NOW + 560_000,
};

function render(state: Partial<MembersState>, slug = "AII"): string {
  return renderToStaticMarkup(<MembersPanel state={{ ...IDLE_MEMBERS, loading: false, ...state }} actions={ACTIONS} slug={slug} now={NOW} />);
}

describe("a pending request, as the owner and as a member sees it", () => {
  it("the owner may admit a new person or add the device to anyone", () => {
    const owner = list("vp");
    const html = render({ list: owner, requests: [REQUEST] });
    expect(html).toContain("K7QX-29MB");
    expect(html).toContain("Check that this matches the code on their screen");
    expect(html).toContain('aria-label="New member&#x27;s name"');
    expect(html).not.toContain("owner only");
    expect(html).toContain("Add to existing:");
    expect(html).toContain("VP (you)");
    expect(html).toContain(">marko<");
    expect(html).not.toContain("Approve as mine");
    expect(approveChoices(owner).canAdmitNew).toBe(true);
    expect(defaultDraft(owner)).toMatchObject({ mode: "new" });
    // A new member needs a name before Approve is pressable.
    expect(draftReady(defaultDraft(owner))).toBe(false);
  });

  it("a member sees New member disabled as owner only, and may add the device only to themselves", () => {
    const member = list("marko");
    const html = render({ list: member, requests: [REQUEST] });
    expect(html).toMatch(/data-approve-new="true" data-disabled=""/);
    expect(html).toContain("owner only");
    expect(html).not.toContain("New member&#x27;s name");
    expect(html).toContain("Add to: marko (you)");
    expect(html).not.toContain("VP (you)");
    expect(html).toContain("Only VP can admit new people.");
    expect(html).toContain("Approve as mine");
    expect(approveChoices(member).existing.map((m) => m.name)).toEqual(["marko"]);
    expect(defaultDraft(member)).toEqual({ mode: "existing", name: "", memberId: "m-marko" });
    expect(draftReady(defaultDraft(member))).toBe(true);
  });
});

describe("the member list", () => {
  it("lists people with their devices and when each was last seen", () => {
    const html = render({ list: list("vp"), requests: [] });
    expect(html).toContain("Members · 2");
    expect(html).toContain("mbp-16");
    expect(html).toContain("this device");
    expect(html).toContain("mac-studio");
    expect(html).toContain("2h ago");
    expect(html).toContain("2 devices");
    expect(html).toContain("No one is waiting to join");
  });

  it("owner-only controls are hidden from a member", () => {
    const asOwner = render({ list: list("vp") });
    const asMember = render({ list: list("marko") });
    expect(asOwner).toContain('data-remove-member="marko"');
    expect(asMember).not.toContain("data-remove-member");
    // A member renames themselves only; the owner anyone.
    expect(asMember).toContain('data-rename="marko"');
    expect(asMember).not.toContain('data-rename="VP"');
    expect(asOwner).toContain('data-rename="VP"');
    expect(asOwner).toContain('data-rename="marko"');
    // Your own other device can be removed; the one you are using cannot.
    expect(asOwner).toContain('data-remove-device="d-studio"');
    expect(asOwner).not.toContain('data-remove-device="d-mbp"');
    expect(asMember).not.toContain('data-remove-device="d-studio"');
  });

  it("the rules behind those controls", () => {
    const owner = list("vp");
    const member = list("marko");
    const [vp, marko] = owner.members;
    expect(mayRemoveMember(owner, marko!)).toBe(true);
    expect(mayRemoveMember(owner, vp!)).toBe(false);
    expect(mayRemoveMember(member, vp!)).toBe(false);
    expect(mayRename(member, vp!)).toBe(false);
    expect(mayRename(member, member.members[1]!)).toBe(true);
    expect(mayRemoveDevice(owner, vp!, "d-mbp")).toBe(false);
    expect(mayRemoveDevice(owner, marko!, "d-thinkpad")).toBe(true);
    expect(mayRemoveDevice(member, vp!, "d-studio")).toBe(false);
  });

  it("removing a member needs their name typed back", () => {
    expect(removeConfirmMatches("", "marko")).toBe(false);
    expect(removeConfirmMatches("mark", "marko")).toBe(false);
    expect(removeConfirmMatches("Marko ", "marko")).toBe(true);
    // The dialog's confirm is held disabled until it matches (MembersPanel passes it as `busy`).
    const source = readFileSync(fileURLToPath(new URL("./MembersSection.tsx", import.meta.url)), "utf8");
    expect(source).toMatch(/busy=\{state\.busy !== null \|\| removing === null \|\| !removeConfirmMatches\(/);
  });

  it("shows the not-connected sentence instead of an empty list", () => {
    const html = render({ list: null, loading: false, error: "This repository is not connected on this machine." });
    expect(html).toContain("not connected to a sync service on this computer");
    expect(html).toContain("Try again");
  });
});

describe("the toast polls only with automatic sync on and the tab visible", () => {
  const report = (mode: "disconnected" | "manual" | "automatic"): Pick<CloudSurfaceReport, "auto" | "mode"> => ({
    mode,
    auto: mode === "automatic",
  });

  it("asks nobody in manual mode, when disconnected, or with the tab hidden", () => {
    expect(mayPollJoinRequests(report("manual"), true)).toBe(false);
    expect(mayPollJoinRequests(report("disconnected"), true)).toBe(false);
    expect(mayPollJoinRequests(null, true)).toBe(false);
    expect(mayPollJoinRequests(report("automatic"), false)).toBe(false);
    expect(mayPollJoinRequests(report("automatic"), true)).toBe(true);
  });

  it("the watcher's only fetch sits behind that gate", () => {
    const source = readFileSync(fileURLToPath(new URL("../components/join/JoinRequestToast.tsx", import.meta.url)), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    expect(source.match(/fetchJoinRequests\(/g)).toHaveLength(1);
    expect(source).toMatch(/const allowed = slug !== "" && mayPollJoinRequests\(report, visible\);/);
    expect(source).toMatch(/if \(!allowed\) return;[\s\S]*watchJoinRequests\(/);
  });

  /** A clock the test turns by hand, and a record of every request the loop makes. */
  function harness(options: { members: boolean; refuse?: string }) {
    const asked: string[] = [];
    const timers = new Map<number, () => void>();
    let next = 0;
    const stopped: string[] = [];
    const seen: number[] = [];
    const stop = watchJoinRequests({
      every: 20_000,
      hasMembers: async () => {
        asked.push("members-cache");
        return options.members;
      },
      fetchRequests: async () => {
        asked.push("join-requests");
        if (options.refuse) {
          const error = Object.assign(new Error("refused"), { code: "forbidden", detail: { reason: options.refuse } });
          throw error;
        }
        return { requests: [REQUEST] };
      },
      onRequests: (requests) => seen.push(requests.length),
      onStop: (reason) => stopped.push(reason),
      setTimer: (fn) => {
        next += 1;
        timers.set(next, fn);
        return next;
      },
      clearTimer: (id) => void timers.delete(id as number),
    });
    const tick = async () => {
      for (const fn of [...timers.values()]) fn();
      await new Promise((resolve) => setTimeout(resolve, 0));
    };
    return { asked, timers, stopped, seen, stop, tick };
  }

  it("with no member list on this machine, makes no request to the service at all", async () => {
    const h = harness({ members: false });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await h.tick();
    await h.tick();
    expect(h.asked).toEqual(["members-cache"]);
    expect(h.timers.size).toBe(0);
    expect(h.stopped).toEqual(["no_members"]);
  });

  it("stops for good when the server refuses because automatic sync was turned off", async () => {
    const h = harness({ members: true, refuse: "auto_sync_off" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await h.tick();
    await h.tick();
    expect(h.asked.filter((call) => call === "join-requests")).toHaveLength(1);
    expect(h.timers.size).toBe(0);
    expect(h.stopped).toEqual(["auto_sync_off"]);
  });

  it("asks every 20 seconds while it is allowed, until stopped", async () => {
    const h = harness({ members: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await h.tick();
    expect(h.asked.filter((call) => call === "join-requests")).toHaveLength(2);
    expect(h.seen).toEqual([1, 1]);
    h.stop();
    await h.tick();
    expect(h.asked.filter((call) => call === "join-requests")).toHaveLength(2);
  });

  it("renders the newest request not put off, and nothing once all are", () => {
    const older = { ...REQUEST, code: "AAAA-BBBB", createdAt: NOW - 90_000 };
    expect(toastRequest([older, REQUEST], new Set())?.code).toBe("K7QX-29MB");
    expect(toastRequest([older, REQUEST], new Set(["K7QX-29MB"]))?.code).toBe("AAAA-BBBB");
    expect(toastRequest([REQUEST], new Set(["K7QX-29MB"]))).toBeNull();
    const html = renderToStaticMarkup(<JoinRequestToastView request={REQUEST} slug="AII" onLater={NOOP} onReview={NOOP} />);
    expect(html).toContain("thinkpad-2 wants to join AII");
    expect(html).toContain("K7QX-29MB");
    expect(html).toContain("Later");
    expect(html).toContain("Review");
  });
});

describe("the join flow", () => {
  const JOIN_ACTIONS: JoinDialogActions = { onRequest: NOOP, onLabel: NOOP, onCancel: NOOP, onRetry: NOOP, onClose: NOOP };
  const view = (state: JoinStage) =>
    renderToStaticMarkup(<JoinDialogView state={state} slug="AII" now={NOW} actions={JOIN_ACTIONS} />);

  const PREVIEW = {
    endpoint: "https://staple-tracker-sync.example.workers.dev",
    repositoryId: "60fff10e-0000-4000-8000-000000000000",
    deviceId: null,
    label: "Vojislavs-MacBook-Pro.local",
    credentialMechanism: "keychain" as const,
    credentialFallbackReason: null,
    alreadyConnected: false,
    existingEndpoint: null,
    autoAfterConnect: false as const,
    endpointSource: "manifest" as const,
  };
  const CONSENT = { id: "ticket-default", digest: "digest-default", expiresAt: "x" };

  it("the Device field is editable, starts from the default label, and needs a name", () => {
    const html = view({ stage: "preview", preview: PREVIEW, consent: CONSENT, label: PREVIEW.label });
    expect(html).toMatch(/<input[^>]*aria-label="Device name"[^>]*value="Vojislavs-MacBook-Pro.local"/);
    expect(html).toContain("shown to the member who approves you");
    // The field shows what was typed, not the preview's default.
    const edited = view({ stage: "preview", preview: PREVIEW, consent: CONSENT, label: "thinkpad" });
    expect(edited).toMatch(/<input[^>]*aria-label="Device name"[^>]*value="thinkpad"/);
    const blank = view({ stage: "preview", preview: PREVIEW, consent: CONSENT, label: "  " });
    expect(blank).toMatch(/<button[^>]*disabled=""[^>]*data-join-request-button/);
  });

  it("a changed label is previewed again locally before the request, and only the fresh ticket is sent", async () => {
    const calls: string[] = [];
    const fresh = { id: "ticket-thinkpad", digest: "digest-thinkpad", expiresAt: "x" };
    const api = {
      previewJoin: async (target: { slug: string; label?: string }) => {
        calls.push(`preview:${target.label}`);
        return { slug: target.slug, preview: { ...PREVIEW, label: target.label ?? PREVIEW.label }, consent: fresh };
      },
      startJoin: async (target: { slug: string; consent: { id: string } }) => {
        calls.push(`start:${target.consent.id}`);
        return { joinId: "j", code: "K7QX-29MB", expiresAt: NOW, label: "thinkpad", endpoint: PREVIEW.endpoint };
      },
    };
    await requestJoin({ slug: "AII", preview: PREVIEW, consent: CONSENT, label: " thinkpad " }, api);
    expect(calls).toEqual(["preview:thinkpad", "start:ticket-thinkpad"]);

    // Unchanged: the ticket on screen is the one sent, with no second preview.
    calls.length = 0;
    await requestJoin({ slug: "AII", preview: PREVIEW, consent: CONSENT, label: PREVIEW.label }, api);
    expect(calls).toEqual(["start:ticket-default"]);
  });

  it("a fresh preview that names another service or repository is shown, not joined", async () => {
    for (const changed of [
      { endpoint: "https://elsewhere.example.workers.dev" },
      { repositoryId: "11111111-0000-4000-8000-000000000000" },
      { alreadyConnected: true },
    ]) {
      const calls: string[] = [];
      const moved = { id: "ticket-moved", digest: "digest-moved", expiresAt: "x" };
      const outcome = await requestJoin(
        { slug: "AII", preview: PREVIEW, consent: CONSENT, label: "thinkpad" },
        {
          previewJoin: async (target) => {
            calls.push(`preview:${target.label}`);
            return { slug: "AII", preview: { ...PREVIEW, ...changed, label: "thinkpad" }, consent: moved };
          },
          startJoin: async () => {
            calls.push("start");
            throw new Error("must not start");
          },
        },
      );
      expect(calls).toEqual(["preview:thinkpad"]);
      expect(outcome).toMatchObject({ kind: "review", consent: moved, preview: { ...changed, label: "thinkpad" } });
    }
  });

  it("the preview names the service, the repository, the device and the encryption warning", () => {
    const html = view({
      stage: "preview",
      consent: { id: "c", digest: "d", expiresAt: "x" },
      label: "thinkpad",
      preview: {
        endpoint: "https://staple-tracker-sync.example.workers.dev",
        repositoryId: "60fff10e-0000-4000-8000-000000000000",
        deviceId: null,
        label: "thinkpad",
        credentialMechanism: "keychain",
        credentialFallbackReason: null,
        alreadyConnected: false,
        existingEndpoint: null,
        autoAfterConnect: false,
        endpointSource: "manifest",
      },
    });
    expect(html).toContain("staple-tracker-sync.example.workers.dev");
    expect(html).toContain("60fff10e");
    expect(html).toContain("thinkpad");
    expect(html).toContain("Not end-to-end encrypted");
    expect(html).toContain("Nothing is sent until you continue");
    expect(html).toContain("Request to join");
  });

  it("each later screen says what the storyboard says", () => {
    const waiting = view({
      stage: "waiting",
      started: { joinId: "j", code: "K7QX-29MB", expiresAt: NOW + 552_000, label: "thinkpad", endpoint: "https://x.example" },
    });
    expect(waiting).toContain("Read this code to a member of AII");
    expect(waiting).toContain("K7QX-29MB");
    expect(waiting).toContain("expires in 9:12");
    expect(waiting).toContain("Cancel request");
    expect(view({ stage: "joined", name: "marko", endpoint: "https://x.example" })).toContain("Automatic sync is on");
    expect(view({ stage: "expired", code: "K7QX-29MB" })).toContain("No one approved K7QX-29MB within 10 minutes");
    expect(view({ stage: "expired", code: "K7QX-29MB" })).toContain("Get a new code");
    expect(view({ stage: "denied", code: "K7QX-29MB" })).toContain("Nothing was sent to this device");
    expect(view({ stage: "too_many", cap: 5 })).toContain("AII already has 5 join requests waiting");
    expect(joinTitle({ stage: "waiting" } as JoinStage, "AII")).toBe("Waiting for approval");
  });

  it("the join card shows only when the manifest names a service and nothing is connected", () => {
    const offer = { slug: "AII", repositoryId: "r", endpoint: "https://staple-tracker-sync.example.workers.dev", connected: false, removedBy: null };
    expect(offersJoin(offer)).toBe(true);
    expect(offersJoin({ ...offer, endpoint: null })).toBe(false);
    expect(offersJoin({ ...offer, connected: true })).toBe(false);
    const html = renderToStaticMarkup(
      <JoinOfferView offer={offer} joined={null} onJoin={NOOP} onSync={NOOP} onAuto={NOOP} onDismiss={NOOP} />,
    );
    expect(html).toContain("This repository already has a shared tracker");
    expect(html).toContain("staple-tracker-sync");
    expect(html).toContain("Join the shared workspace");
    const banner = renderToStaticMarkup(
      <JoinOfferView offer={offer} joined={{ name: "marko", synced: "no", auto: "off" }} onJoin={NOOP} onSync={NOOP} onAuto={NOOP} onDismiss={NOOP} />,
    );
    expect(banner).toContain("Joined AII as");
    expect(banner).toContain("Automatic sync is off.");
    expect(banner).toContain("Turn on auto sync");
  });

  it("times read the way the storyboard prints them", () => {
    expect(countdown(NOW + 552_000, NOW)).toBe("9:12");
    expect(countdown(NOW - 1, NOW)).toBe("0:00");
    expect(relativeTime(NOW - 40_000, NOW)).toBe("40s ago");
    expect(relativeTime(NOW - 3_000, NOW)).toBe("just now");
    expect(relativeTime(null, NOW)).toBe("never");
    expect(memberInitials("marko")).toBe("MA");
    expect(memberInitials("Vlad Petkovic")).toBe("VP");
    expect([0, 1, 2, 3, 4, 9].map(joinPollDelay)).toEqual([2000, 3000, 4500, 6750, 10000, 10000]);
  });
});

describe("the join preview makes no request of its own", () => {
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

  it("previewJoin is one call to this computer's own server, and rendering the preview fetches nothing", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      seen.push(url);
      return { ok: true, status: 200, json: async () => ({}), clone: () => ({ json: async () => ({}) }) } as unknown as Response;
    });
    const api = await import("@/lib/api");
    await api.previewJoin({ slug: "AII" });
    expect(seen).toEqual(["/api/cloud/workspace/join/preview"]);

    seen.length = 0;
    renderToStaticMarkup(
      <JoinDialogView
        state={{ stage: "loading" }}
        slug="AII"
        now={NOW}
        actions={{ onRequest: NOOP, onLabel: NOOP, onCancel: NOOP, onRetry: NOOP, onClose: NOOP }}
      />,
    );
    expect(seen).toEqual([]);
  });
});
