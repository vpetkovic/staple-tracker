/**
 * What a hub-wide connect shows a human BEFORE it asks, and before it has spoken
 * to anything.
 *
 * Contract: STA-275 — *"One connect covers every registered workspace without
 * connecting each by hand"*. And `docs/sync.md`, "Three consents" — *"**Connect
 * shows before it asks.** It prints the endpoint, the `repositoryId` and the
 * account it is about to bind, and performs **no remote mutation** before the
 * answer."*
 *
 * ## Why this is a separate file from `hub-connect.ts`
 *
 * For exactly the reason `preview.ts` is a separate file from `connect.ts`, and
 * the reason is worth restating rather than inherited by assumption.
 *
 * The way to keep a consent mechanism from quietly acquiring a network call is
 * not to remember not to add one — it is to build it somewhere a network call
 * cannot be written. `preview.ts` does not import `client.ts`, so a single
 * preview's silence is a property of the import graph. A fan-out preview that
 * lived beside `performHubConnect` would sit in a module that reaches
 * `connect.ts` and therefore `client.ts`, and the property would be gone: not
 * because anything had called out, but because nothing structural would stop the
 * next person from adding a "let us check which of these endpoints is
 * reachable" convenience to the preview. That convenience is exactly the
 * violation — `docs/sync.md` counts *attempted* calls, so a reachability probe
 * across twelve endpoints on a screen nobody has agreed to yet is twelve
 * violations.
 *
 * So this module imports `preview.ts`, `connection.ts`, `credential-store.ts`,
 * `endpoint.ts` and `hub-scope.ts`, and **nothing that reaches `client.ts`**.
 * `test/cloud-hub-connect.test.ts` walks the graph transitively and asserts it,
 * the same walk `test/cloud-auto-sync.test.ts` uses for the automatic-sync gate.
 *
 * ## A fan-out preview shows every workspace, not a count
 *
 * `willConnect: 9` is a number to agree to, and agreeing to a number is not
 * consent. Every registered workspace appears in {@link HubConnectPreview.entries}
 * — including every one that will be skipped, and why — so the question a person
 * asks immediately afterwards ("why is my other repository not in this list?") is
 * answered before they ask it.
 *
 * ## Idempotent and additive by default
 *
 * An already-connected workspace is SKIPPED, not re-minted. That is what makes
 * *"a newly registered workspace appears without reconnecting"* true in the
 * strong sense: after `staple init` in a new directory, `staple cloud connect
 * --all` connects that one workspace and leaves the other eleven credentials,
 * device registrations and consents exactly as they were. `reconnect: true` opts
 * into replacing credentials, and the preview says `RECONNECT` in capitals for
 * every row it would do that to, because it is destructive.
 */
import { readConnection, type CloudConnection } from "./connection.js";
import { selectCredentialStore, type SelectOptions } from "./credential-store.js";
import { parseEndpoint } from "./endpoint.js";
import {
  describeSkip,
  listHubWorkspaces,
  skipReasonFor,
  type HubSkipReason,
  type HubWorkspace,
} from "./hub-scope.js";
import { buildConnectPreview, type ConnectPreview } from "./preview.js";

/** What a fan-out would do to one workspace. */
export type HubConnectAction =
  /** Not connected here yet; a credential will be minted. */
  | "connect"
  /** Already connected; the credential will be REPLACED. Only with `reconnect`. */
  | "reconnect"
  /** Nothing will happen to it, and `reason` says why. */
  | "skip";

export interface HubConnectEntry {
  slug: string;
  prefix: string;
  path: string;
  kind: string;
  available: boolean;
  repositoryId: string | null;
  action: HubConnectAction;
  /** Always present, for every action. A sentence, not a code. */
  reason: string;
  /**
   * Why this row is not actionable at all, or null.
   *
   * Distinct from `action: "skip"`, which is the broader category: a workspace
   * that is skipped only because it is ALREADY CONNECTED is perfectly
   * actionable and carries `skip: null`. Collapsing the two would make "not
   * connected because something is wrong" and "not connected because nothing
   * needs doing" indistinguishable, and they have opposite remedies.
   */
  skip: HubSkipReason | null;
  /**
   * The per-workspace preview this fan-out would act on. Null for a skipped row
   * — there is nothing to show about a workspace nothing will happen to, and a
   * placeholder preview would describe an action that is not going to be taken.
   */
  preview: ConnectPreview | null;
}

export interface HubConnectPreview {
  /** The normalized origin every entry would be connected to. */
  readonly endpoint: string;
  readonly entries: readonly HubConnectEntry[];
  readonly willConnect: number;
  readonly willReconnect: number;
  readonly willSkip: number;
  /**
   * Always false, for every workspace, and present as a field for the same
   * reason `ConnectPreview.autoAfterConnect` is: the JSON a script reads must
   * carry the same promise the human preview prints. A hub-wide connect is not a
   * hub-wide automatic-sync consent, and there is no argument on this path that
   * could make it one.
   */
  readonly autoAfterConnect: false;
}

export interface BuildHubPreviewArgs {
  home: string;
  endpoint: string;
  label?: string;
  credential?: SelectOptions;
  /** Re-mint credentials for workspaces that are already connected. */
  reconnect?: boolean;
  /** Injected in tests. Replaces the hub enumeration. */
  workspaces?: readonly HubWorkspace[];
}

/**
 * Build the fan-out preview. Local only, and structurally incapable of anything
 * else.
 *
 * The credential store is selected ONCE and handed to every per-workspace
 * preview through {@link buildConnectPreview}'s `selection` argument. The probe
 * is a real round trip through the OS keychain — a sentinel written, read back
 * and deleted — and twelve workspaces would otherwise mean thirty-six
 * `security(1)` subprocesses to answer one question that cannot have twelve
 * different answers at one instant.
 */
export function buildHubConnectPreview(args: BuildHubPreviewArgs): HubConnectPreview {
  const endpoint = parseEndpoint(args.endpoint);
  const workspaces = args.workspaces ?? listHubWorkspaces();
  const selection = selectCredentialStore(args.home, args.credential ?? {});

  const entries = workspaces.map((workspace): HubConnectEntry => {
    const base = {
      slug: workspace.slug,
      prefix: workspace.prefix,
      path: workspace.path,
      kind: workspace.kind,
      available: workspace.available,
      repositoryId: workspace.repositoryId,
    };

    const skip = skipReasonFor(workspace);
    if (skip !== null) {
      return { ...base, action: "skip", reason: describeSkip(workspace, skip), skip, preview: null };
    }

    // `skipReasonFor` returning null establishes this. The assertion is for the
    // type checker, not for the reader.
    const repositoryId = workspace.repositoryId as string;

    let existing: CloudConnection | null;
    try {
      existing = readConnection(args.home, repositoryId);
    } catch (error) {
      /**
       * A connection record that is present and unreadable. Skipped rather than
       * connected over: `connection.ts` refuses to replace one rather than
       * overwriting it, because overwriting would mint a second device for a
       * machine that already had one — and a fan-out is exactly the context in
       * which nobody would notice a twelfth line of output.
       */
      return {
        ...base,
        action: "skip",
        reason:
          `This workspace's connection record could not be read: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        skip: "problem",
        preview: null,
      };
    }

    if (existing && args.reconnect !== true) {
      return {
        ...base,
        action: "skip",
        reason:
          `Already connected to ${existing.endpoint}. Left exactly as it is — its credential, ` +
          `its device registration and its consents are untouched. Pass --reconnect to replace ` +
          `the credential.`,
        skip: null,
        preview: null,
      };
    }

    const preview = buildConnectPreview({
      home: args.home,
      repositoryId,
      endpoint: endpoint.origin,
      label: args.label,
      credential: args.credential,
      selection,
    });

    return existing
      ? {
          ...base,
          action: "reconnect",
          reason:
            `Already connected to ${existing.endpoint}. Its credential will be REPLACED and a ` +
            `new one minted. Automatic sync and backup are reset to off, as on any connect.`,
          skip: null,
          preview,
        }
      : {
          ...base,
          action: "connect",
          reason: "Not connected on this machine. A credential will be minted and stored here.",
          skip: null,
          preview,
        };
  });

  return {
    endpoint: endpoint.origin,
    entries,
    willConnect: entries.filter((entry) => entry.action === "connect").length,
    willReconnect: entries.filter((entry) => entry.action === "reconnect").length,
    willSkip: entries.filter((entry) => entry.action === "skip").length,
    autoAfterConnect: false,
  };
}

/**
 * The fan-out preview as a human reads it.
 *
 * Written as a table with a sentence under each row rather than as a bare list,
 * because the rows are not homogeneous: three of them may be about to have a
 * credential replaced and nine about to get their first, and a person consenting
 * to the gesture needs to see which is which without counting.
 */
export function renderHubConnectPreview(preview: HubConnectPreview): string {
  const lines: string[] = [];
  lines.push(`Connect every registered workspace to ${preview.endpoint}`);
  lines.push("");

  if (preview.entries.length === 0) {
    lines.push("  No workspaces are registered on this machine. There is nothing to connect.");
    return lines.join("\n");
  }

  const width = Math.max(...preview.entries.map((entry) => entry.slug.length), 9);
  for (const entry of preview.entries) {
    const verb =
      entry.action === "connect" ? "connect" : entry.action === "reconnect" ? "RECONNECT" : "skip";
    lines.push(`  ${verb.padEnd(10)} ${entry.slug.padEnd(width)}  ${entry.path}`);
    lines.push(`             ${entry.reason}`);
  }

  lines.push("");
  lines.push(
    `  ${preview.willConnect} to connect, ${preview.willReconnect} to re-connect, ` +
      `${preview.willSkip} skipped.`,
  );
  lines.push("");
  lines.push("What happens if you say yes:");
  lines.push("  - each workspace above marked `connect` is registered separately with that service");
  lines.push("    and gets ITS OWN credential. One gesture, one credential per workspace, so");
  lines.push("    revoking one workspace does not disconnect the others.");
  lines.push("  - this machine is one device in every one of them, under one device id and label.");
  lines.push("  - the enrollment secret you supply is offered to each workspace in turn. A");
  lines.push("    workspace whose service does not accept it is REPORTED AND SKIPPED; the rest");
  lines.push("    still connect.");
  lines.push("  - AUTOMATIC SYNC STAYS OFF FOR EVERY ONE OF THEM. Nothing is uploaded until you");
  lines.push("    run `staple cloud sync`. Turning it on is a separate, per-workspace decision.");
  lines.push("  - the hub itself is not sent anywhere. This is a fan-out over workspaces this");
  lines.push("    machine knows about; the service never learns that they sit together.");
  lines.push("  - issue titles, descriptions, comments and documents are stored in PLAINTEXT on");
  lines.push("    that service. There is no end-to-end encryption.");
  lines.push("");
  lines.push(
    "Nothing has been sent yet. Declining leaves no credential, no setting and no remote record.",
  );
  return lines.join("\n");
}
