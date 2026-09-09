/**
 * What `staple cloud connect` shows a human BEFORE it asks, and before it has
 * spoken to anything.
 *
 * Contract: `docs/sync.md`, "Three consents" — *"**Connect shows before it
 * asks.** It prints the endpoint, the `repositoryId` and the account it is about
 * to bind, and performs **no remote mutation** before the answer. A declined
 * connect leaves no credential, no config key and no server-side record."*
 *
 * ## This module does not import the client, and that is the mechanism
 *
 * The preview is the consent mechanism, not a courtesy. The way to keep a
 * consent mechanism from quietly acquiring a network call is not to remember not
 * to add one — it is to build it somewhere a network call cannot be written.
 * Nothing here imports `client.ts`, so the fact that computing a preview cannot
 * reach the network is a property of the import graph rather than of anybody's
 * diligence, and `test/network-silence.test.ts` asserts it against real spies as
 * well.
 *
 * The credential store is a deliberate exception to "no side effects": selecting
 * it writes and deletes a sentinel item in the OS keychain. That is a local
 * subprocess, not egress, and it happens here on purpose. Discovering that the
 * keychain is locked AFTER the server has minted a token would strand a
 * credential that only the server knows about — a device row this machine can
 * neither use nor recognise. Failing over to the `0600` file before the preview
 * means the preview can state, truthfully, where the credential is going to go.
 */
import { parseEndpoint, type CloudEndpoint } from "./endpoint.js";
import { defaultDeviceLabel, readDeviceId } from "./device.js";
import { selectCredentialStore, type CredentialMechanism, type SelectOptions } from "./credential-store.js";
import { readConnection } from "./connection.js";

export interface ConnectPreview {
  readonly endpoint: CloudEndpoint;
  readonly repositoryId: string;
  /** The device id that will be bound. Null when one has not been minted yet. */
  readonly deviceId: string | null;
  readonly label: string;
  readonly credentialMechanism: CredentialMechanism;
  /** Why the OS store was not chosen, when it was not. Shown, never swallowed. */
  readonly credentialFallbackReason: string | null;
  /** true when this repository is already connected here — a re-connect. */
  readonly alreadyConnected: boolean;
  /** The endpoint the existing connection names, when it differs from this one. */
  readonly existingEndpoint: string | null;
  /**
   * Always false. Present as a field rather than as prose so that the JSON
   * preview a script reads carries the same promise the human preview prints:
   * connecting does not enable automatic synchronization.
   */
  readonly autoAfterConnect: false;
}

export interface BuildPreviewArgs {
  home: string;
  repositoryId: string;
  endpoint: string;
  label?: string;
  credential?: SelectOptions;
}

/**
 * Build the preview. Local only: parses a URL, reads two files, probes the
 * local credential store. No DNS, no socket, no `fetch`.
 */
export function buildConnectPreview(args: BuildPreviewArgs): ConnectPreview {
  const endpoint = parseEndpoint(args.endpoint);
  const existing = readConnection(args.home, args.repositoryId);
  const selection = selectCredentialStore(args.home, args.credential ?? {});

  return {
    endpoint,
    repositoryId: args.repositoryId,
    // Read, never minted. Minting here would write cloud state onto a machine
    // whose human is still reading the preview and may yet say no.
    deviceId: existing?.deviceId ?? readDeviceId(args.home),
    label: args.label?.trim() || existing?.label || defaultDeviceLabel(),
    credentialMechanism: selection.store.mechanism,
    credentialFallbackReason: selection.fallbackReason,
    alreadyConnected: existing !== null,
    existingEndpoint: existing && existing.endpoint !== endpoint.origin ? existing.endpoint : null,
    autoAfterConnect: false,
  };
}

/**
 * The preview as a human reads it.
 *
 * Written as full sentences rather than a key/value table because it is asking
 * for consent, and consent to a table is not really consent. Every line answers
 * a question somebody would be right to ask: what will you talk to, what will
 * you tell it about me, where does the secret go, and what starts happening
 * afterwards.
 */
export function renderConnectPreview(preview: ConnectPreview): string {
  const lines: string[] = [];
  lines.push(preview.alreadyConnected ? "Re-connect this repository" : "Connect this repository");
  lines.push("");
  lines.push(`  service        ${preview.endpoint.origin}`);
  lines.push(`  repository     ${preview.repositoryId}`);
  lines.push(`  device         ${preview.deviceId ?? "a new device id will be minted for this machine"}`);
  lines.push(`  label          ${preview.label}   (sent to the server; override with --label)`);
  lines.push(`  credential     ${describeMechanism(preview.credentialMechanism)}`);
  if (preview.credentialFallbackReason) {
    lines.push(`                 falling back because ${preview.credentialFallbackReason}`);
  }
  if (preview.existingEndpoint) {
    lines.push("");
    lines.push(
      `  This repository is already connected to ${preview.existingEndpoint}. Connecting will ` +
        `point it at ${preview.endpoint.origin} instead and replace the stored credential.`,
    );
  }
  lines.push("");
  lines.push("What happens if you say yes:");
  lines.push("  - this device is registered with that service and given a credential");
  lines.push("  - the credential is stored on this machine only, and never in git or the workspace database");
  lines.push("  - AUTOMATIC SYNC STAYS OFF. Nothing is uploaded until you run `staple cloud sync`.");
  lines.push("    Turning it on is a separate decision: `staple cloud auto on`.");
  lines.push("  - issue titles, descriptions, comments and documents are stored in PLAINTEXT on that");
  lines.push("    service. There is no end-to-end encryption. Whoever holds that Cloudflare account");
  lines.push("    can read them.");
  lines.push("");
  lines.push("Nothing has been sent yet. Declining leaves no credential, no setting and no remote record.");
  return lines.join("\n");
}

function describeMechanism(mechanism: CredentialMechanism): string {
  switch (mechanism) {
    case "keychain":
      return "macOS keychain (service staple-sync)";
    case "secret-tool":
      return "the system secret service (libsecret)";
    case "file":
      return "a 0600 file in your staple home";
  }
}
