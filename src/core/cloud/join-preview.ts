/**
 * What `staple cloud join` shows a person BEFORE it asks, and before it has spoken to
 * anything — the join's half of `preview.ts`.
 *
 * Joining is a connect: it ends with a credential on this machine and a device row on
 * the service. So it keeps the same consent discipline, and the same mechanism for it.
 * This module does not import `client.ts`, so building and rendering the preview cannot
 * reach the network, and `test/network-silence.test.ts` asserts that against real spies.
 *
 * Everything else here is pure too: where the endpoint comes from, and what a code typed
 * by a person normalizes to. The web UI's join card uses the same three functions, so the
 * two surfaces show the same preview and accept the same codes.
 */
import { buildConnectPreview, type ConnectPreview } from "./preview.js";
import type { SelectOptions } from "./credential-store.js";
import { StapleError } from "../types.js";

/** Where the endpoint in a join preview came from. Shown, so a person knows who chose it. */
export type JoinEndpointSource = "flag" | "manifest";

export interface JoinPreview extends ConnectPreview {
  readonly endpointSource: JoinEndpointSource;
}

/**
 * The endpoint to join through: `--endpoint`, else the one a teammate published in
 * `.staple/repository.json` with `staple cloud share-endpoint`, else a refusal that
 * names both ways to supply one.
 */
export function resolveJoinEndpoint(
  flag: string | undefined,
  manifestEndpoint: string | undefined,
): { endpoint: string; source: JoinEndpointSource } {
  const given = flag?.trim();
  if (given) return { endpoint: given, source: "flag" };
  if (manifestEndpoint) return { endpoint: manifestEndpoint, source: "manifest" };
  throw new StapleError(
    "validation",
    "No sync service to join through. Pass --endpoint <url>, or ask someone already in the " +
      "workspace to run `staple cloud share-endpoint` and commit .staple/repository.json, then pull.",
  );
}

export interface BuildJoinPreviewArgs {
  home: string;
  repositoryId: string;
  endpoint: string;
  endpointSource: JoinEndpointSource;
  label?: string;
  credential?: SelectOptions;
}

/** Local only: parses a URL, reads two files, probes the local credential store. */
export function buildJoinPreview(args: BuildJoinPreviewArgs): JoinPreview {
  const base = buildConnectPreview({
    home: args.home,
    repositoryId: args.repositoryId,
    endpoint: args.endpoint,
    label: args.label,
    credential: args.credential,
  });
  return { ...base, endpointSource: args.endpointSource };
}

/** The join preview as a person reads it. Full sentences, because it asks for consent. */
export function renderJoinPreview(preview: JoinPreview): string {
  const lines: string[] = [];
  lines.push("Join this shared workspace");
  lines.push("");
  lines.push(
    `  service        ${preview.endpoint.origin}` +
      (preview.endpointSource === "manifest" ? "   (from .staple/repository.json)" : ""),
  );
  lines.push(`  repository     ${preview.repositoryId}`);
  lines.push(`  device         ${preview.deviceId ?? "a new device id will be minted for this machine"}`);
  lines.push(`  label          ${preview.label}   (sent to the server and shown to the approver; override with --label)`);
  lines.push(`  credential     ${describeMechanism(preview.credentialMechanism)}`);
  if (preview.credentialFallbackReason) {
    lines.push(`                 falling back because ${preview.credentialFallbackReason}`);
  }
  if (preview.alreadyConnected) {
    lines.push("");
    lines.push(
      `  This repository is already connected on this machine` +
        (preview.existingEndpoint ? ` to ${preview.existingEndpoint}` : "") +
        ". Joining replaces the stored credential once the request is approved.",
    );
  }
  lines.push("");
  lines.push("What happens if you say yes:");
  lines.push("  - a join request is sent to that service, and this terminal shows a short code");
  lines.push("  - someone already in the workspace approves it. Compare the code with them out loud");
  lines.push("    or on a call. The code only names your request; it is not a password, and no");
  lines.push("    secret has to travel over chat");
  lines.push("  - once approved, this device gets its own credential, stored on this machine only");
  lines.push("  - AUTOMATIC SYNC STAYS OFF. Nothing is uploaded until you run `staple cloud sync`.");
  lines.push("  - issue titles, descriptions, comments and documents are stored in PLAINTEXT on that");
  lines.push("    service. There is no end-to-end encryption. Whoever holds that Cloudflare account");
  lines.push("    can read them, and so can every member of the workspace.");
  lines.push("");
  lines.push("Nothing has been sent yet. Declining leaves no credential, no setting and no remote record.");
  return lines.join("\n");
}

function describeMechanism(mechanism: JoinPreview["credentialMechanism"]): string {
  switch (mechanism) {
    case "keychain":
      return "macOS keychain (service staple-sync)";
    case "secret-tool":
      return "the system secret service (libsecret)";
    case "file":
      return "a 0600 file in your staple home";
  }
}

/** Crockford base32, the alphabet the service draws codes from. */
const CROCKFORD = /^[0-9A-HJKMNP-TV-Z]{8}$/;

/**
 * A code as a person typed it, in the `XXXX-XXXX` form the service shows.
 *
 * Forgiving where a person reading a code aloud is likely to slip: case, spaces, the dash
 * or its absence, and the letters Crockford base32 folds (`O` reads as zero, `I` and `L`
 * as one). Strict about everything else, so a typo is refused here with a sentence rather
 * than sent as a request that matches nothing.
 */
export function normalizeJoinCode(input: string): string {
  const folded = input
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  if (!CROCKFORD.test(folded)) {
    throw new StapleError(
      "validation",
      `"${input}" is not a join code. A code is eight letters and digits, shown as XXXX-XXXX ` +
        "on the joining device. `staple cloud requests` lists the pending ones.",
    );
  }
  return `${folded.slice(0, 4)}-${folded.slice(4)}`;
}

/** The code, large, for the joining terminal: spaced so it reads aloud one character at a time. */
export function renderJoinCode(code: string): string {
  const spaced = code.split("").join(" ");
  const rule = "─".repeat(spaced.length + 8);
  return ["", `   ┌${rule}┐`, `   │    ${spaced}    │`, `   └${rule}┘`, ""].join("\n");
}
