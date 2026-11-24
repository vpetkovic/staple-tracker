import { describe, expect, it } from "vitest";
import type { ConnectionHealthSnapshot, DetectedConnection } from "../../../../../core/integrations/contracts";
import type { ConnectionView } from "@/integrations/connection-status";
import {
  chipLabel,
  commandIn,
  connectionMeta,
  needsAttention,
  offeredDetections,
  orderWorkspaces,
  pickerSections,
  unmappedSentence,
  type MappedTarget,
  type PickerItem,
} from "./integrations-model";

const health = (state: ConnectionHealthSnapshot["state"], over: Partial<ConnectionHealthSnapshot> = {}): ConnectionHealthSnapshot => ({
  connectionId: "c1",
  state,
  message: state === "ready" ? null : "Something is wrong.",
  action: null,
  identity: null,
  checkedAt: "2026-11-24T12:00:00Z",
  retryAfterSeconds: null,
  ...over,
});
const github = (over: Partial<ConnectionView> = {}): ConnectionView =>
  ({ id: "9f0c2a7e-1111-4111-8111-111111111111", providerId: "github", mode: "cli", host: "github.com", account: "octo", health: null, ...over }) as ConnectionView;
const linear = (over: Partial<ConnectionView> = {}): ConnectionView =>
  ({
    id: "lin-1", providerId: "linear", mode: "api", host: "linear.app",
    account: "11111111-1111-4111-8111-111111111111", scopeId: "22222222-2222-4222-8222-222222222222",
    credentialEnv: "STAPLE_LINEAR_API_KEY", health: null, ...over,
  }) as ConnectionView;
const target = (over: Partial<MappedTarget> = {}): MappedTarget => ({
  key: "github.com/123456", providerId: "github", host: "github.com", scopeId: "host", kind: "repository",
  containerId: "123456", name: "octo/app", url: null, connectionId: "c1", ...over,
});

describe("commandIn", () => {
  it("takes the command after Run, up to the full stop", () => {
    expect(commandIn("Run gh auth login -h github.com.")).toBe("gh auth login -h github.com");
    expect(commandIn("Run gh auth status")).toBe("gh auth status");
  });
  it("stops where the server's sentences go back to prose", () => {
    expect(commandIn("Run gh auth login --hostname github.com on the computer running Staple.")).toBe("gh auth login --hostname github.com");
    expect(commandIn("Run gh auth switch --hostname github.com --user octo, or reconnect Staple as other.")).toBe("gh auth switch --hostname github.com --user octo");
  });
  it("returns null for prose and for nothing", () => {
    expect(commandIn("Wait for the GitHub rate limit to reset, then check again.")).toBeNull();
    expect(commandIn("Set STAPLE_LINEAR_API_KEY to a valid Linear personal API key.")).toBeNull();
    expect(commandIn(null)).toBeNull();
  });
});

describe("connectionMeta", () => {
  it("names a GitHub account through the CLI and drops github.com", () => {
    expect(connectionMeta(github())).toBe("octo · through GitHub CLI");
    expect(connectionMeta(github({ host: "ghe.acme.io" }))).toBe("octo · ghe.acme.io · through GitHub CLI");
  });
  it("names a Linear account by its login, never by its UUID", () => {
    expect(connectionMeta(linear())).toBe("Linear account · API key in STAPLE_LINEAR_API_KEY");
    expect(connectionMeta(linear({ health: health("ready", { identity: { login: "Ada" } }) }))).toBe("Ada · API key in STAPLE_LINEAR_API_KEY");
    expect(connectionMeta(linear())).not.toMatch(/[0-9a-f]{8}-/);
  });
});

describe("offeredDetections", () => {
  it("offers only sign-ins no connection covers", () => {
    const detected: DetectedConnection[] = [
      { providerId: "github", host: "github.com", login: "octo", configuredConnectionId: null },
      { providerId: "github", host: "github.com", login: "taken", configuredConnectionId: "c1" },
    ];
    expect(offeredDetections(detected).map((d) => d.login)).toEqual(["octo"]);
  });
});

describe("needsAttention", () => {
  it("is true for a non-ready snapshot and false for ready or unknown", () => {
    expect(needsAttention([github({ health: health("unauthenticated") })])).toBe(true);
    expect(needsAttention([github({ health: health("ready") })])).toBe(false);
    expect(needsAttention([github({ health: null })])).toBe(false);
    expect(needsAttention([])).toBe(false);
  });
});

describe("workspace rows", () => {
  const rows = [
    { workspace: "zeta", targets: [] },
    { workspace: "alpha", targets: [target()] },
    { workspace: "mid", targets: [] },
  ];
  it("puts the current workspace first and the rest alphabetically", () => {
    expect(orderWorkspaces(rows, "mid").map((r) => r.workspace)).toEqual(["mid", "alpha", "zeta"]);
    expect(orderWorkspaces(rows, "").map((r) => r.workspace)).toEqual(["alpha", "mid", "zeta"]);
    expect(orderWorkspaces(rows, "gone").map((r) => r.workspace)).toEqual(["alpha", "mid", "zeta"]);
  });
  it("says what an unmapped workspace searches", () => {
    expect(unmappedSentence(rows, "zeta")).toBe("Searches everything chosen here");
    expect(unmappedSentence([{ workspace: "zeta", targets: [] }, { workspace: "mid", targets: [] }], "zeta")).toBe("Nothing to search yet");
  });
});

describe("chipLabel", () => {
  it("uses the stored name", () => {
    expect(chipLabel(target())).toEqual({ text: "octo/app", title: "octo/app" });
  });
  it("falls back to a short key segment and says why", () => {
    const nameless = target({ name: null, key: "linear.app/22222222-2222-4222-8222-222222222222/33333333-3333-4333-8333-333333333333" });
    expect(chipLabel(nameless)).toEqual({ text: "33333333", title: "Name unavailable until this source is read again" });
  });
});

describe("pickerSections", () => {
  const item = (over: Partial<PickerItem>): PickerItem => ({ id: "1", name: "x", url: "", kind: "repository", scopeId: "host", key: "github.com/1", ...over });
  it("marks items already mapped to the workspace by key", () => {
    const [section] = pickerSections("github", { repository: { items: [item({ key: "github.com/123456" }), item({ id: "2", key: "github.com/2" })], nextCursor: null } }, [target()]);
    expect(section!.items.map((i) => i.mapped)).toEqual([true, false]);
    expect(section!.label).toBeNull();
  });
  it("splits a Linear connection into Teams and Projects", () => {
    const sections = pickerSections(
      "linear",
      {
        team: { items: [item({ kind: "team", key: "t" })], nextCursor: "more" },
        project: { items: [item({ kind: "project", key: "p" })], nextCursor: null },
      },
      [],
    );
    expect(sections.map((s) => [s.label, s.kind, s.nextCursor])).toEqual([
      ["Teams", "team", "more"],
      ["Projects", "project", null],
    ]);
  });
});
