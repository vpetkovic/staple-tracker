/**
 * The network-silence harness.
 *
 * Contract: `docs/sync.md`, "The network rule — and the test that proves it".
 *
 * ## What counts as a violation
 *
 * *"**Any attempted outbound call to a non-loopback destination, from the Staple
 * process, is a violation** — attempted, not succeeded. A DNS lookup that fails
 * is a violation. A socket that is refused is a violation. Intent is what is
 * being tested, so the spy counts calls, not results."*
 *
 * So every spy records and then **throws**, rather than recording and letting
 * the call proceed. A violation fails loudly at its own call site, with a stack
 * that names the line that did it, instead of being counted and discovered later
 * as a number.
 *
 * Not violations, per the same section: a loopback listener (`staple open` is
 * one), a connection whose destination is `127.0.0.1`, `::1`, `localhost` or a
 * unix socket path, and a subprocess the user explicitly invoked.
 *
 * ## Why `createRequire` and not `import * as net`
 *
 * An ESM namespace object is immutable — assigning to `net.connect` on one
 * throws in strict mode and would make this file a spy that cannot spy. The CJS
 * exports object that `require("node:net")` returns is the same object the rest
 * of the process resolves its imports through, and it is writable. Patching
 * there is what makes the spy visible to code that has already been imported.
 *
 * ## The self-check
 *
 * *"The harness self-checks: it makes one sentinel call to a non-loopback
 * address and asserts the spy recorded it. A network-silence test that passes
 * because the spy was never installed is worse than no test, and this is the
 * assertion that distinguishes the two."*
 *
 * {@link NetworkSpy.selfCheck} is that assertion, and every test that installs
 * the spy calls it. A green suite with a spy that silently failed to attach is
 * the exact failure this whole mechanism exists to make impossible.
 *
 * ## The list is a minimum, not a ceiling
 *
 * *"It is written as 'every egress primitive Node exposes', so a lane that
 * reaches for one not named here adds it to the harness rather than concluding
 * it is permitted."*
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export interface Violation {
  /** The module or global that was patched, e.g. `node:dns`. */
  target: string;
  /** The member called, e.g. `lookup`. */
  member: string;
  /** Best-effort description of where it was going. */
  destination: string;
  stack: string;
}

/** Thrown at the call site of a violation, so the stack names the offender. */
export class NetworkViolation extends Error {
  constructor(readonly violation: Violation) {
    super(
      `network-silence violation: ${violation.target}.${violation.member} -> ${violation.destination}`,
    );
    this.name = "NetworkViolation";
  }
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost", "0.0.0.0", "::", ""]);

/**
 * Is this destination exempt?
 *
 * Loopback and unix sockets only. There is no allowlist and no environment
 * variable — the exemption is an address that cannot be pointed elsewhere,
 * which is the only kind of exemption that stays true.
 */
export function isExempt(destination: string): boolean {
  if (destination.startsWith("/") || destination.startsWith("\\\\.\\pipe")) return true; // unix socket / named pipe
  const host = destination.replace(/^\[|\]$/g, "").toLowerCase();
  if (LOOPBACK.has(host)) return true;
  // `127.0.0.0/8` in full: 127.1 and 127.0.0.2 are loopback too.
  return /^127\./.test(host);
}

function hostOf(value: unknown): string {
  if (typeof value === "string") {
    // A URL, or a bare hostname.
    try {
      return new URL(value).hostname;
    } catch {
      return value;
    }
  }
  if (value instanceof URL) return value.hostname;
  /**
   * `net.connect(path)` normalizes its arguments and calls
   * `Socket.prototype.connect([options, callback])` — an ARRAY, not the options
   * object. Without this branch every internally-normalized connection reads as
   * `unknown`, which fails closed and reports a violation for a unix socket that
   * the contract explicitly exempts. tsx's own IPC connection is exactly that,
   * so the harness would have flagged the test runner rather than the code under
   * test — and intermittently, because the throw lands inside a promise.
   */
  if (Array.isArray(value)) return value.length > 0 ? hostOf(value[0]) : "unknown";
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.url === "string") return hostOf(record.url); // a Request
    if (typeof record.path === "string" && record.host === undefined) {
      return record.path; // unix socket or named pipe
    }
    for (const key of ["host", "hostname", "address"]) {
      const candidate = record[key];
      if (typeof candidate === "string") return hostOf(candidate);
    }
  }
  return "unknown";
}

export interface NetworkSpy {
  readonly violations: Violation[];
  /** Assert the spy is actually attached. Throws when it is not. */
  selfCheck(): void;
  restore(): void;
}

/**
 * Install the spies. Call this BEFORE importing the code under test, so a module
 * that captured `fetch` at import time captured the patched one.
 */
export function installNetworkSpy(): NetworkSpy {
  const violations: Violation[] = [];
  const restores: Array<() => void> = [];

  function record(target: string, member: string, destination: string): never {
    const violation: Violation = {
      target,
      member,
      destination,
      stack: new Error("network-silence").stack ?? "",
    };
    violations.push(violation);
    throw new NetworkViolation(violation);
  }

  /** Patch one member, exempting loopback by inspecting the first argument. */
  function patch(holder: Record<string, unknown>, target: string, member: string, argIndex = 0): void {
    const original = holder[member];
    if (typeof original !== "function") return;
    holder[member] = function spy(this: unknown, ...args: unknown[]) {
      const destination = hostOf(args[argIndex]);
      if (!isExempt(destination)) record(target, member, destination);
      return (original as (...a: unknown[]) => unknown).apply(this, args);
    };
    restores.push(() => {
      holder[member] = original;
    });
  }

  // globalThis.fetch — the one every HTTP client in this tree would use.
  patch(globalThis as unknown as Record<string, unknown>, "globalThis", "fetch");

  const net = require("node:net") as Record<string, unknown>;
  patch(net, "node:net", "connect");
  patch(net, "node:net", "createConnection");
  const netSocket = (net.Socket as { prototype: Record<string, unknown> }).prototype;
  patch(netSocket, "node:net.Socket", "connect");

  const tls = require("node:tls") as Record<string, unknown>;
  patch(tls, "node:tls", "connect");
  const tlsSocket = (tls.TLSSocket as { prototype: Record<string, unknown> }).prototype;
  patch(tlsSocket, "node:tls.TLSSocket", "connect");

  for (const [name, mod] of [
    ["node:dns", require("node:dns")],
    ["node:dns/promises", require("node:dns/promises")],
  ] as Array<[string, Record<string, unknown>]>) {
    for (const member of [
      "lookup",
      "resolve",
      "resolve4",
      "resolve6",
      "resolveAny",
      "resolveSrv",
      "resolveTxt",
    ]) {
      patch(mod, name, member);
    }
  }

  for (const [name, mod] of [
    ["node:http", require("node:http")],
    ["node:https", require("node:https")],
  ] as Array<[string, Record<string, unknown>]>) {
    patch(mod, name, "request");
    patch(mod, name, "get");
    const agent = (mod.Agent as { prototype: Record<string, unknown> }).prototype;
    patch(agent, `${name}.Agent`, "createConnection");
  }

  const http2 = require("node:http2") as Record<string, unknown>;
  patch(http2, "node:http2", "connect");

  /**
   * UDP is still egress. `createSocket` takes no destination, so it cannot be
   * exempted by address — a Staple process has no reason to open a UDP socket at
   * all, and the honest thing is to treat any as a violation rather than to wave
   * it through because the argument did not name a host.
   */
  const dgram = require("node:dgram") as Record<string, unknown>;
  {
    const original = dgram.createSocket;
    if (typeof original === "function") {
      dgram.createSocket = function spy(this: unknown, ...args: unknown[]) {
        record("node:dgram", "createSocket", "udp");
        return (original as (...a: unknown[]) => unknown).apply(this, args);
      };
      restores.push(() => {
        dgram.createSocket = original;
      });
    }
  }

  const globalRecord = globalThis as unknown as Record<string, unknown>;
  const OriginalWebSocket = globalRecord.WebSocket;
  if (typeof OriginalWebSocket === "function") {
    globalRecord.WebSocket = function spy(this: unknown, url: unknown, ...rest: unknown[]) {
      const destination = hostOf(url);
      if (!isExempt(destination)) record("globalThis", "WebSocket", destination);
      return Reflect.construct(OriginalWebSocket as new (...a: unknown[]) => unknown, [url, ...rest]);
    };
    restores.push(() => {
      globalRecord.WebSocket = OriginalWebSocket;
    });
  }

  return {
    violations,
    selfCheck(): void {
      const before = violations.length;
      try {
        // A sentinel. `.invalid` is reserved by RFC 2606 and can never resolve,
        // so even if the spy were absent this would fail rather than reach a
        // real host — the point is that the spy must stop it BEFORE that.
        void (globalThis.fetch as (input: string) => unknown)("https://spy-self-check.invalid/");
      } catch {
        // Expected: the spy throws. A miss is caught by the count below.
      }
      if (violations.length !== before + 1) {
        throw new Error(
          "network spy self-check FAILED: the sentinel call was not recorded, so the spy is not " +
            "installed and every zero-violation assertion in this file is meaningless.",
        );
      }
      violations.length = before; // the sentinel is not a real violation
    },
    restore(): void {
      for (const undo of restores.reverse()) undo();
    },
  };
}

/** A readable one-line summary of what was attempted, for an assertion message. */
export function describeViolations(violations: readonly Violation[]): string {
  if (violations.length === 0) return "none";
  return violations
    .map((v) => `${v.target}.${v.member} -> ${v.destination}\n${v.stack}`)
    .join("\n---\n");
}
