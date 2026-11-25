import { describe, expect, it } from "vitest";
import type { ConnectionHealthSnapshot, DetectedConnection } from "../../../../../core/integrations/contracts";
import type { ConnectionView } from "@/integrations/connection-status";
import {
  chipLabel,
  CONNECTION_CHOICES,
  linearIdProblem,
  clickupIdProblem,
  commandIn,
  connectionMeta,
  needsAttention,
  offeredDetections,
  orderWorkspaces,
  pickerPlaceholder,
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
    expect(connectionMeta(linear({ health: health("ready", { identity: { login: "Ada", organization: "Acme" } }) }))).toBe("Ada · Acme · API key in STAPLE_LINEAR_API_KEY");
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
  it("names the kind when no name is stored, never a piece of an id", () => {
    const nameless = target({ name: null, kind: "team", key: "linear.app/22222222-2222-4222-8222-222222222222/33333333-3333-4333-8333-333333333333" });
    expect(chipLabel(nameless)).toEqual({ text: "Unnamed team", title: "Name unavailable until this source is read again" });
    expect(chipLabel(target({ name: null })).text).toBe("Unnamed repository");
    expect(chipLabel(target({ name: null, kind: "project" })).text).toBe("Unnamed project");
  });
});

describe("linearIdProblem", () => {
  const id = "22222222-2222-4222-8222-222222222222";
  it("accepts two ids in Linear's format and stays quiet while a field is still empty", () => {
    expect(linearIdProblem(id, id)).toBeNull();
    expect(linearIdProblem("", "")).toBeNull();
    expect(linearIdProblem(` ${id} `, "")).toBeNull();
  });
  it("says which field is not an id, in words a person can act on", () => {
    expect(linearIdProblem("acme", id)).toBe("Organization ID should be the 36-character id Linear shows, like 123e4567-e89b-12d3-a456-426614174000.");
    expect(linearIdProblem(id, "me@example.com")).toBe("Your user ID should be the 36-character id Linear shows, like 123e4567-e89b-12d3-a456-426614174000.");
  });
});

describe("clickupIdProblem", () => {
  it("accepts the workspace number from a ClickUp address and stays quiet while empty", () => {
    expect(clickupIdProblem("9012345")).toBeNull();
    expect(clickupIdProblem(" 9012345 ")).toBeNull();
    expect(clickupIdProblem("")).toBeNull();
  });
  it("says where the number is when given anything else", () => {
    expect(clickupIdProblem("https://app.clickup.com/9012345/home")).toBe("Workspace ID is the number after app.clickup.com/ in any ClickUp page's address, like 9012345.");
    expect(clickupIdProblem("acme")).not.toBeNull();
  });
});

describe("a ClickUp connection row", () => {
  const clickup = (h: ConnectionHealthSnapshot | null) =>
    ({ id: "cu", providerId: "clickup", mode: "api", host: "app.clickup.com", scopeId: "9012345", credentialEnv: "STAPLE_CLICKUP_API_TOKEN", health: h }) as ConnectionView;
  it("names the user and workspace once checked, and the workspace number and token variable before", () => {
    expect(connectionMeta(clickup(null))).toBe("Workspace 9012345 · API token in STAPLE_CLICKUP_API_TOKEN");
    expect(connectionMeta(clickup(health("ready", { identity: { login: "ada", organization: "Acme" } })))).toBe("ada · Acme · API token in STAPLE_CLICKUP_API_TOKEN");
    expect(connectionMeta(clickup(health("ready", { identity: { login: "Ada", organization: "Ada" } })))).toBe("Ada · API token in STAPLE_CLICKUP_API_TOKEN");
  });
});

describe("pickerPlaceholder", () => {
  it("names only what the readable connections list", () => {
    expect(pickerPlaceholder(["github", "linear"])).toBe("Find a repository, team or project");
    expect(pickerPlaceholder([])).toBe("Find a repository, team or project");
    expect(pickerPlaceholder(["github"])).toBe("Find a repository");
    expect(pickerPlaceholder(["clickup"])).toBe("Find a space or list");
    expect(pickerPlaceholder(["github", "clickup"])).toBe("Find a repository, space or list");
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
  it("splits a ClickUp connection into Spaces and Lists", () => {
    const sections = pickerSections(
      "clickup",
      {
        space: { items: [item({ kind: "space", key: "app.clickup.com/1/space/2" })], nextCursor: null },
        list: { items: [item({ kind: "list", key: "app.clickup.com/1/list/3" })], nextCursor: "next space" },
      },
      [target({ key: "app.clickup.com/1/list/3", providerId: "clickup", kind: "list" })],
    );
    expect(sections.map((s) => [s.label, s.kind, s.nextCursor, s.items.map((i) => i.mapped)])).toEqual([
      ["Spaces", "space", null, [false]],
      ["Lists", "list", "next space", [true]],
    ]);
  });
});

describe("what Add connection offers", () => {
  it("lists every provider, each one available", () => {
    expect(CONNECTION_CHOICES.map((c) => [c.providerId, c.label, c.available])).toEqual([
      ["github", "GitHub account or Enterprise host", true],
      ["linear", "Linear workspace", true],
      ["azure_devops", "Azure DevOps organization", true],
      ["clickup", "ClickUp workspace", true],
    ]);
  });
});
