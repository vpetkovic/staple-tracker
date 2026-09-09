/**
 * Which machine this is — the one fact a restored backup cannot bring with it.
 *
 * Contract: `docs/sync.md`, "A copied home is not a second device".
 *
 * ## Why this exists at all
 *
 * `repo-identity.ts` prevents a silent fork in the repository case by leaning on
 * the thing that already distinguishes two checkouts: a clone arrives with the
 * manifest and NO database, so the second machine starts from a known-empty
 * local state and adopts. A workspace that lives in the staple home has no such
 * event. Restoring `~/.staple` onto a second machine copies the database, the
 * manifest, the device id and its secret, the cursor and the client-sequence
 * allocator — every byte either machine could compare — and lands them at the
 * SAME absolute path, because that path is derived from the home and the home is
 * `~/.staple` on both.
 *
 * So the discriminator cannot be a value stored in the home; it has to be a
 * value *of the machine*, recorded in the home when an identity is minted and
 * recomputed when it is used. That is all this module produces.
 *
 * ## Why a digest and not the raw identifier
 *
 * The platform identifiers below are hardware serials in all but name, and the
 * value derived from them is written into a database that a person may hand to
 * somebody else while debugging, or push into a backup that lands somewhere
 * broader than they expected. `repository.json` earned its "safe to publish"
 * property by carrying only an opaque UUID; this keeps the same discipline by
 * carrying only a digest. Nothing anywhere needs to read the identifier back —
 * every use is an equality test — so hashing costs nothing and removes a class
 * of disclosure entirely.
 *
 * ## Why the value is allowed to be wrong
 *
 * Every source below can be defeated: a machine can be renamed, an image can be
 * cloned with its machine id intact, a container gets a fresh one on every run.
 * That is tolerable because of what the answer is USED for. A false "moved"
 * produces an explicit refusal with two named ways out, which costs a person one
 * command; a false "same machine" produces a silent fork, which costs them a
 * data split discovered weeks later. The failure is therefore deliberately
 * pushed onto the loud side, and {@link HOST_ID_ENV} exists for the environments
 * where the operator knows better than the heuristic.
 *
 * ## No version control anywhere in here
 *
 * Deliberate, and asserted in the tests. The whole point of STA-273 is that a
 * workspace need not be a repository to synchronize, and a detector that reached
 * for a VCS would put the dependency back one layer down.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { hostname, networkInterfaces } from "node:os";

/**
 * Override the detected machine identity.
 *
 * Two audiences. The tests, which are two machines by being two values of it.
 * And operators whose environment breaks the heuristic in either direction — a
 * container that must present a stable identity across runs, or a golden image
 * whose baked-in machine id must NOT be treated as one machine. Setting it
 * wrongly defeats copy detection, which is why nothing sets it by default and
 * why it is not read from any config file: a value that could be restored along
 * with the home would be one more thing the copy brings with it.
 */
export const HOST_ID_ENV = "STAPLE_HOST_ID";

/** Domain separation, so this digest cannot be confused with any other. */
const DOMAIN = "staple-host-v1:";

let cached: string | null = null;

function digest(material: string): string {
  return createHash("sha256").update(DOMAIN).update(material).digest("hex");
}

/** `/etc/machine-id` and its dbus predecessor. Present on Linux, stable per install. */
function linuxMachineId(): string | null {
  for (const path of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
    try {
      const value = readFileSync(path, "utf8").trim();
      if (value.length > 0) return `linux:${value}`;
    } catch {
      // Absent or unreadable: try the next source.
    }
  }
  return null;
}

/**
 * macOS `IOPlatformUUID` — the closest thing the platform has to a machine id,
 * and it survives reinstalls and restores because it is a property of the
 * hardware rather than of the filesystem.
 *
 * Read through `ioreg` with an absolute path and a fixed argument vector: no
 * shell, nothing interpolated, and a timeout, because a hung `ioreg` must not be
 * able to hang `staple ls`.
 */
function darwinPlatformUuid(): string | null {
  try {
    const output = execFileSync("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], {
      encoding: "utf8",
      timeout: 2_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const match = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(output);
    return match ? `darwin:${match[1]}` : null;
  } catch {
    return null;
  }
}

/** Windows `MachineGuid`, minted by the OS installer and stable thereafter. */
function windowsMachineGuid(): string | null {
  try {
    const output = execFileSync(
      "reg",
      ["QUERY", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"],
      { encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "ignore"] },
    );
    const match = /MachineGuid\s+REG_SZ\s+(\S+)/.exec(output);
    return match ? `win32:${match[1]}` : null;
  } catch {
    return null;
  }
}

/**
 * The last resort: the host name plus every stable hardware address.
 *
 * Weaker than the platform sources — a name can be changed and an address can be
 * randomized — but it is derived from the machine rather than from the home, so
 * it still answers the only question being asked. Addresses are sorted so the
 * enumeration order of interfaces cannot make one machine look like two.
 */
function hostAndInterfaces(): string {
  const macs = new Set<string>();
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.internal) continue;
      if (entry.mac && entry.mac !== "00:00:00:00:00:00") macs.add(entry.mac);
    }
  }
  return `host:${hostname()}|mac:${[...macs].sort().join(",")}`;
}

function machineIdentifier(): string {
  if (process.platform === "linux") {
    const id = linuxMachineId();
    if (id) return id;
  }
  if (process.platform === "darwin") {
    const id = darwinPlatformUuid();
    if (id) return id;
  }
  if (process.platform === "win32") {
    const id = windowsMachineGuid();
    if (id) return id;
  }
  return hostAndInterfaces();
}

/**
 * This machine, as a 64-character hex digest.
 *
 * Memoized, because the detected sources cost a file read or a subprocess and
 * the answer cannot change inside one process. The override is read on every
 * call and never cached: it is the seam the tests use to be two machines within
 * one process, and a cache would make the second machine the first one again.
 */
export function hostFingerprint(): string {
  const override = process.env[HOST_ID_ENV];
  if (override !== undefined && override.length > 0) return digest(`env:${override}`);
  if (cached === null) cached = digest(machineIdentifier());
  return cached;
}
