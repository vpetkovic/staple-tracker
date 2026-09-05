/**
 * Where a repository's cloud credential lives on THIS machine.
 *
 * Contract: `docs/sync.md`, "Trust boundaries" — "Tokens are least-privilege,
 * stored on the device in OS-protected storage with a `0600` file fallback, and
 * never written to the workspace database, the repository manifest, or git."
 *
 * ## Three places a credential must never be, and why each is fatal
 *
 *  - **The workspace database.** It synchronizes. A credential stored there
 *    would replicate itself to every other device, which turns one device's
 *    consent into every device's credential and makes revocation meaningless.
 *  - **`.staple/repository.json`.** It is checked in. Its entire security
 *    property is that its contents are exhaustively known and publishable.
 *  - **git, in any form.** The repository is public.
 *
 * So the credential lives in the staple home, keyed by repository id, and this
 * module is the only thing that reads or writes it.
 *
 * ## The mechanism is chosen at write time and then REMEMBERED
 *
 * `connect` tries the OS keychain and falls back to a `0600` file, and records
 * which one won in the connection record. Reads then go straight to the recorded
 * mechanism instead of probing both.
 *
 * That is not just an optimization. A read that probed "keychain, then file"
 * would silently succeed from the file on a machine whose keychain had become
 * unavailable — which is exactly the moment a human wants to be told that their
 * credential is sitting in a file rather than in the keychain they thought they
 * had chosen. Remembering the choice makes the degradation visible instead of
 * automatic.
 *
 * ## What the OS stores actually do with the secret
 *
 * `secret-tool` reads the secret from **stdin**. `security` does not: macOS's
 * `add-generic-password` takes the password as an argv element, and there is no
 * non-interactive stdin form of it. Argv is visible to other processes running
 * as the same user, so on macOS the write is briefly observable to same-uid
 * code.
 *
 * That is stated rather than hidden because it is a real disclosure — but it is
 * not an escalation. Same-uid code can already run `security find-generic-password`
 * and read the credential out of the keychain directly, so the argv window
 * exposes nothing that was not already reachable. It would be an escalation
 * against a *different* user, and argv is not readable across users on macOS.
 *
 * ## Redaction
 *
 * Nothing in this module puts a token in an error message, and
 * {@link redactToken} exists so that no caller has to invent its own way of not
 * doing so. There is no "first few characters" form: the contract calls a
 * prefix a real disclosure, and it is right.
 */
import { execFileSync } from "node:child_process";
import { existsSync, rmSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../../config/atomic.js";
import { StapleError } from "../types.js";

/** The keychain service name, and the directory name under the staple home. */
export const CREDENTIAL_SERVICE = "staple-sync";

export type CredentialMechanism = "keychain" | "secret-tool" | "file";

export interface CredentialStore {
  readonly mechanism: CredentialMechanism;
  /** The plaintext token, or null when this repository has none here. */
  read(repositoryId: string): string | null;
  write(repositoryId: string, token: string): void;
  /** Idempotent. Removing a credential that is not there is not an error. */
  delete(repositoryId: string): void;
}

/**
 * Never render a token, in whole or in part.
 *
 * Returns a fixed marker rather than a length or a prefix, because both of those
 * are information about a secret and neither helps anyone debug anything.
 */
export function redactToken(_token: string | null | undefined): string {
  return "<redacted>";
}

/** Thrown when an OS store is not usable here, so the caller can fall back. */
export class CredentialStoreUnavailable extends Error {
  constructor(readonly mechanism: CredentialMechanism, message: string) {
    super(message);
    this.name = "CredentialStoreUnavailable";
  }
}

// ------------------------------------------------------------------ the file

export function credentialDir(home: string): string {
  return join(home, "cloud");
}

export function credentialFilePath(home: string, repositoryId: string): string {
  return join(credentialDir(home), `${repositoryId}.token`);
}

/**
 * The portable fallback: one file per repository, `0600`, in a `0700` directory.
 *
 * Written through `writeFileAtomic`, which applies the mode explicitly with
 * `chmodSync` after creating the file rather than trusting `open(2)`'s mode
 * argument — umask can trim the latter, and a credential written `0644` because
 * of an inherited umask is a credential every account on the machine can read.
 */
export function fileCredentialStore(home: string): CredentialStore {
  return {
    mechanism: "file",
    read(repositoryId) {
      const path = credentialFilePath(home, repositoryId);
      if (!existsSync(path)) return null;
      const token = readFileSync(path, "utf8").trim();
      return token.length > 0 ? token : null;
    },
    write(repositoryId, token) {
      writeFileAtomic(credentialFilePath(home, repositoryId), `${token}\n`, {
        mode: 0o600,
        dirMode: 0o700,
      });
    },
    delete(repositoryId) {
      rmSync(credentialFilePath(home, repositoryId), { force: true });
    },
  };
}

/**
 * Is the stored credential file as private as it is supposed to be?
 *
 * Reported rather than silently repaired, and reported by `staple cloud status`
 * and `staple doctor`. A file that has been widened to `0644` since it was
 * written is evidence about the machine — a careless `chmod -R`, a restore from
 * a backup that did not preserve modes — and quietly tightening it would erase
 * the only sign that happened. Windows has no meaningful mode bits, so the
 * check does not run there rather than reporting a permanent false alarm.
 */
export function fileCredentialIsPrivate(
  home: string,
  repositoryId: string,
  platform: NodeJS.Platform = process.platform,
): boolean | null {
  if (platform === "win32") return null;
  const path = credentialFilePath(home, repositoryId);
  if (!existsSync(path)) return null;
  return (statSync(path).mode & 0o077) === 0;
}

// -------------------------------------------------------------- the OS store

/** The subprocess seam, so tests never touch a real keychain. */
export type ExecFn = (file: string, args: string[], input?: string) => string;

const defaultExec: ExecFn = (file, args, input) =>
  execFileSync(file, args, {
    encoding: "utf8",
    input,
    // A keychain prompt on a headless machine would otherwise hang a tracker
    // command forever. Bounded, and a timeout falls back to the file store.
    timeout: 10_000,
    stdio: ["pipe", "pipe", "pipe"],
  });

function unavailable(mechanism: CredentialMechanism, error: unknown): never {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  throw new CredentialStoreUnavailable(
    mechanism,
    code === "ENOENT" ? `${mechanism} is not available on this machine` : `${mechanism} refused the operation`,
  );
}

/**
 * macOS. `security(1)`, generic password, service `staple-sync`, account = the
 * repository id.
 *
 * `find-generic-password` exits non-zero when the item is absent, which is
 * indistinguishable at the exit-code level from a locked keychain — so absence
 * is inferred from the message rather than the status, and anything else
 * propagates as unavailable rather than being read as "no credential". Treating
 * a locked keychain as "not connected" would tell a human they had never
 * connected, which is a lie that costs them their credential when they
 * re-connect over it.
 */
export function keychainCredentialStore(exec: ExecFn = defaultExec): CredentialStore {
  return {
    mechanism: "keychain",
    read(repositoryId) {
      try {
        return exec("security", [
          "find-generic-password",
          "-s",
          CREDENTIAL_SERVICE,
          "-a",
          repositoryId,
          "-w",
        ]).trim();
      } catch (error) {
        const stderr = String((error as { stderr?: unknown }).stderr ?? "");
        if (/could not be found/i.test(stderr)) return null;
        return unavailable("keychain", error);
      }
    },
    write(repositoryId, token) {
      try {
        // `-U` updates an existing item instead of failing, so re-connecting
        // replaces the credential rather than leaving the old one in place.
        exec("security", [
          "add-generic-password",
          "-U",
          "-s",
          CREDENTIAL_SERVICE,
          "-a",
          repositoryId,
          "-w",
          token,
        ]);
      } catch (error) {
        unavailable("keychain", error);
      }
    },
    delete(repositoryId) {
      try {
        exec("security", ["delete-generic-password", "-s", CREDENTIAL_SERVICE, "-a", repositoryId]);
      } catch (error) {
        const stderr = String((error as { stderr?: unknown }).stderr ?? "");
        if (/could not be found/i.test(stderr)) return; // already gone; idempotent
        unavailable("keychain", error);
      }
    },
  };
}

/**
 * Linux. `secret-tool(1)` from libsecret, against whatever secret service the
 * session provides.
 *
 * The secret goes in on **stdin**, which is why this one has no argv exposure at
 * all. `lookup` exits non-zero and prints nothing when the item is absent.
 */
export function secretToolCredentialStore(exec: ExecFn = defaultExec): CredentialStore {
  const attrs = ["service", CREDENTIAL_SERVICE, "account"];
  return {
    mechanism: "secret-tool",
    read(repositoryId) {
      try {
        const value = exec("secret-tool", ["lookup", ...attrs, repositoryId]).trim();
        return value.length > 0 ? value : null;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return unavailable("secret-tool", error);
        // A miss and a broken session are both non-zero here; libsecret prints
        // nothing on a miss and a diagnostic otherwise.
        const stderr = String((error as { stderr?: unknown }).stderr ?? "").trim();
        if (stderr.length === 0) return null;
        return unavailable("secret-tool", error);
      }
    },
    write(repositoryId, token) {
      try {
        exec(
          "secret-tool",
          ["store", "--label", `${CREDENTIAL_SERVICE} ${repositoryId}`, ...attrs, repositoryId],
          token,
        );
      } catch (error) {
        unavailable("secret-tool", error);
      }
    },
    delete(repositoryId) {
      try {
        exec("secret-tool", ["clear", ...attrs, repositoryId]);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") unavailable("secret-tool", error);
        // `clear` on a missing item is a no-op that still exits non-zero.
      }
    },
  };
}

export interface StoreSelection {
  readonly store: CredentialStore;
  /** Why the OS store was not used, when it was not. For the preview to print. */
  readonly fallbackReason: string | null;
}

export interface SelectOptions {
  platform?: NodeJS.Platform;
  exec?: ExecFn;
  /** Force the file store — `staple cloud connect --credential-file`. */
  forceFile?: boolean;
}

/** The OS store this platform would use, or null when there is not one. */
export function osCredentialStore(options: SelectOptions = {}): CredentialStore | null {
  const platform = options.platform ?? process.platform;
  const exec = options.exec ?? defaultExec;
  if (platform === "darwin") return keychainCredentialStore(exec);
  if (platform === "linux") return secretToolCredentialStore(exec);
  // Windows has no equivalent that is reachable without a PowerShell round trip
  // through the Credential Manager, and a half-working one would be worse than
  // the honest `0600` file: it would report "keychain" in the status while
  // storing the credential somewhere nobody had audited.
  return null;
}

/**
 * Pick the store to WRITE with, preferring the OS one, and say why if it lost.
 *
 * The probe is a real round trip — a write and a read-back of a sentinel — not a
 * "does the binary exist" check. A `security` binary that is present but whose
 * keychain is locked passes an existence check and then fails at the moment it
 * matters, halfway through connect, after the server has already minted a token.
 * Finding that out before the network call is the difference between falling
 * back cleanly and stranding a credential that only the server knows about.
 */
export function selectCredentialStore(home: string, options: SelectOptions = {}): StoreSelection {
  const file = fileCredentialStore(home);
  if (options.forceFile === true) {
    return { store: file, fallbackReason: "--credential-file was passed" };
  }

  const os = osCredentialStore(options);
  if (!os) {
    return {
      store: file,
      fallbackReason: `no OS credential store on ${options.platform ?? process.platform}`,
    };
  }

  const probeId = `${CREDENTIAL_SERVICE}-probe`;
  try {
    os.write(probeId, "probe");
    const readBack = os.read(probeId);
    os.delete(probeId);
    if (readBack !== "probe") {
      return { store: file, fallbackReason: `${os.mechanism} did not return what it stored` };
    }
    return { store: os, fallbackReason: null };
  } catch (error) {
    try {
      os.delete(probeId);
    } catch {
      // The probe is best effort in both directions.
    }
    const reason =
      error instanceof CredentialStoreUnavailable ? error.message : `${os.mechanism} is not usable here`;
    return { store: file, fallbackReason: reason };
  }
}

/** The store for a mechanism already recorded in a connection record. */
export function credentialStoreFor(
  home: string,
  mechanism: CredentialMechanism,
  options: SelectOptions = {},
): CredentialStore {
  const exec = options.exec ?? defaultExec;
  switch (mechanism) {
    case "file":
      return fileCredentialStore(home);
    case "keychain":
      return keychainCredentialStore(exec);
    case "secret-tool":
      return secretToolCredentialStore(exec);
    default: {
      const never: never = mechanism;
      throw new StapleError("validation", `unknown credential mechanism "${String(never)}"`);
    }
  }
}
