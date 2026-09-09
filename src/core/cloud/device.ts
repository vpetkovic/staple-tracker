/**
 * This machine's device identity.
 *
 * ## Why it is per-MACHINE and not per-repository
 *
 * A device is a machine. One laptop connected to three repositories is one
 * device three times over, not three devices, and `staple cloud devices` on any
 * of those repositories should show the laptop once with a label a human
 * recognises. The server keys devices by `(repo_id, device_id)`, so reusing one
 * id across repositories is exactly what it expects.
 *
 * ## Why it must survive a database rebuild
 *
 * `worker/README.md`, on why the dedupe index carries the epoch: *"`deviceId`
 * lives in machine config and survives a client-side database rebuild;
 * `clientSeq` lives only in the workspace database, which a re-bootstrap
 * rebuilds from zero."* Operation ids are derived from
 * `sha256(repoId, epoch, deviceId, clientSeq)`. If the device id were rebuilt
 * along with the database, every operation id would change, the server's dedupe
 * would stop recognising this device's retries, and a lost acknowledgement would
 * duplicate work instead of being absorbed.
 *
 * So it lives in the staple home, beside the connection records, and nothing
 * short of deleting the home regenerates it.
 *
 * ## It is not a secret and it is not an identifier of a person
 *
 * A random UUID, minted locally, never derived from a MAC address, a hostname, a
 * serial number or a username. Derivation would make it a stable machine
 * fingerprint that travels to a server, which is a disclosure nobody asked for
 * and which no part of the protocol needs. The label — which IS derived from the
 * hostname, because a human has to tell their machines apart — is a separate,
 * optional field the user can override.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "../../config/atomic.js";
import { credentialDir } from "./credential-store.js";

export function deviceIdPath(home: string): string {
  return join(credentialDir(home), "device-id");
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The device id if one has been minted here, else null. Never mints. */
export function readDeviceId(home: string): string | null {
  const path = deviceIdPath(home);
  if (!existsSync(path)) return null;
  const value = readFileSync(path, "utf8").trim();
  return UUID_RE.test(value) ? value : null;
}

/**
 * The device id, minting one if this machine has never had it.
 *
 * Called by `connect` and by nothing on an ordinary command path. Minting is a
 * local file write with no network component, but it is still a side effect, and
 * a `staple ls` that created a device id would be writing cloud state on a
 * machine that had never connected — which the zero-network invariant's
 * companion clause forbids: *"before a repository is connected, no cloud
 * setting, credential or request may exist at all."*
 */
export function ensureDeviceId(home: string): string {
  const existing = readDeviceId(home);
  if (existing) return existing;
  const deviceId = randomUUID();
  writeFileAtomic(deviceIdPath(home), `${deviceId}\n`, { mode: 0o600, dirMode: 0o700 });
  return deviceId;
}

/**
 * The default label offered in the connect preview.
 *
 * The hostname, because that is the word a human uses for the machine they are
 * sitting at. It is shown in the preview before it is sent, so a person who does
 * not want their hostname on a server can see it and pass `--label` instead.
 * That is the difference between a default and a disclosure.
 */
export function defaultDeviceLabel(): string {
  const name = hostname().trim();
  return name.length > 0 ? name : "unnamed device";
}
