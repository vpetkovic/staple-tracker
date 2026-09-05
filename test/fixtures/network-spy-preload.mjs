/**
 * The network spy, installed into a CHILD process through `node --import`.
 *
 * ## Why this exists as well as `network-spy.ts`
 *
 * `docs/sync.md` names the scenarios that must assert zero, and the list is
 * `install` · `init` · `new` · `ls` · … · `staple open` startup plus one
 * authenticated API request · an MCP `initialize` handshake. Those are real CLI
 * invocations. They run as subprocesses, and *a spy installed in the test
 * process cannot see a subprocess* — which is the same blind spot the contract
 * warns about for `wrangler dev`:
 *
 *   *"the offending call happens in a `wrangler` subprocess, not in the Staple
 *   process the spy is watching, so a network-silence test could pass at the
 *   exact moment the suite was talking to the internet."*
 *
 * So the spy goes into the child. `NODE_OPTIONS=--import <this file>` attaches
 * it before anything else loads, including tsx's loader and therefore including
 * every line of `src/`.
 *
 * ## Why this is plain `.mjs` and duplicates `network-spy.ts`
 *
 * `--import` runs before the TypeScript loader is registered, so this file
 * cannot be TypeScript and cannot import the TypeScript one. The duplication is
 * deliberate and is the price of covering subprocesses at all. The two files
 * spy on the same list; if you add a target to one, add it to the other.
 *
 * ## How a violation is reported
 *
 * Appended as one JSON line to the file named by `STAPLE_NETWORK_SPY_LOG`, and
 * then thrown. The write happens FIRST: a throw that killed the process before
 * recording anything would look, from the parent, exactly like a command that
 * failed for an unrelated reason.
 */
import { appendFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const LOG = process.env.STAPLE_NETWORK_SPY_LOG;

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost", "0.0.0.0", "::", ""]);

function isExempt(destination) {
  if (destination.startsWith("/") || destination.startsWith("\\\\.\\pipe")) return true;
  const host = destination.replace(/^\[|\]$/g, "").toLowerCase();
  if (LOOPBACK.has(host)) return true;
  return /^127\./.test(host);
}

function hostOf(value) {
  if (typeof value === "string") {
    try {
      return new URL(value).hostname;
    } catch {
      return value;
    }
  }
  if (value instanceof URL) return value.hostname;
  // `net.connect(path)` normalizes and calls `Socket.prototype.connect([opts, cb])`.
  // Keep this in step with the same branch in network-spy.ts.
  if (Array.isArray(value)) return value.length > 0 ? hostOf(value[0]) : "unknown";
  if (value && typeof value === "object") {
    if (typeof value.url === "string") return hostOf(value.url);
    if (typeof value.path === "string" && value.host === undefined) {
      return value.path;
    }
    for (const key of ["host", "hostname", "address"]) {
      if (typeof value[key] === "string") return hostOf(value[key]);
    }
  }
  return "unknown";
}

function record(target, member, destination) {
  const violation = {
    target,
    member,
    destination,
    argv: process.argv.slice(1),
    stack: new Error("network-silence").stack ?? "",
  };
  if (LOG) {
    try {
      appendFileSync(LOG, `${JSON.stringify(violation)}\n`);
    } catch {
      // Nothing useful to do; the throw below is still the loud failure.
    }
  }
  const error = new Error(
    `network-silence violation: ${target}.${member} -> ${destination}`,
  );
  error.name = "NetworkViolation";
  throw error;
}

function patch(holder, target, member, argIndex = 0) {
  const original = holder[member];
  if (typeof original !== "function") return;
  holder[member] = function spy(...args) {
    const destination = hostOf(args[argIndex]);
    if (!isExempt(destination)) record(target, member, destination);
    return original.apply(this, args);
  };
}

patch(globalThis, "globalThis", "fetch");

const net = require("node:net");
patch(net, "node:net", "connect");
patch(net, "node:net", "createConnection");
patch(net.Socket.prototype, "node:net.Socket", "connect");

const tls = require("node:tls");
patch(tls, "node:tls", "connect");
patch(tls.TLSSocket.prototype, "node:tls.TLSSocket", "connect");

for (const [name, mod] of [
  ["node:dns", require("node:dns")],
  ["node:dns/promises", require("node:dns/promises")],
]) {
  for (const member of ["lookup", "resolve", "resolve4", "resolve6", "resolveAny", "resolveSrv", "resolveTxt"]) {
    patch(mod, name, member);
  }
}

for (const [name, mod] of [
  ["node:http", require("node:http")],
  ["node:https", require("node:https")],
]) {
  patch(mod, name, "request");
  patch(mod, name, "get");
  patch(mod.Agent.prototype, `${name}.Agent`, "createConnection");
}

patch(require("node:http2"), "node:http2", "connect");

const dgram = require("node:dgram");
{
  const original = dgram.createSocket;
  if (typeof original === "function") {
    dgram.createSocket = function spy(...args) {
      record("node:dgram", "createSocket", "udp");
      return original.apply(this, args);
    };
  }
}

if (typeof globalThis.WebSocket === "function") {
  const Original = globalThis.WebSocket;
  globalThis.WebSocket = function spy(url, ...rest) {
    const destination = hostOf(url);
    if (!isExempt(destination)) record("globalThis", "WebSocket", destination);
    return Reflect.construct(Original, [url, ...rest]);
  };
}
