/**
 * The suite's defences against a worker whose event loop does not turn.
 *
 * CI failed with "[vitest-worker]: Timeout calling onTaskUpdate" while every test
 * passed, and once with `fetch failed: other side closed` from an in-process UI
 * server. Both came from `spawnSync` holding a worker's thread for long stretches:
 * see `test/setup/turn-event-loop.ts` and `test/fixtures/spawn-async.ts`.
 *
 * The HTTP cases pin the precondition of the second failure rather than the race
 * itself, which is timing-dependent: an idle keep-alive socket whose timeout
 * passed while the thread was blocked must be closed before the next request is
 * sent. It is closed only if the loop turned in between.
 */
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnAsync } from "./fixtures/spawn-async.js";

const KEEP_ALIVE_MS = 1_000;
/** Longer than the keep-alive timeout, so the idle socket's timer is overdue. */
const BLOCK_SECONDS = "1.5";

let server: Server;
let origin: string;
const sockets: Socket[] = [];

beforeAll(async () => {
  server = createServer((_request, response) => response.end("ok"));
  server.keepAliveTimeout = KEEP_ALIVE_MS;
  server.on("connection", (socket) => sockets.push(socket));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});

afterAll(() => {
  server.closeAllConnections();
  server.close();
});

/** One request; resolves with the server-side socket that carried it. */
async function request(): Promise<Socket> {
  const before = sockets.length;
  expect(await (await fetch(origin)).text()).toBe("ok");
  const socket = sockets.at(-1)!;
  expect(sockets.length, "a fresh connection").toBe(before + 1);
  return socket;
}

describe("a timer that falls due during a blocking test", () => {
  let fired = false;

  it("is armed, and the thread is then blocked past it", () => {
    setTimeout(() => {
      fired = true;
    }, 0);
    spawnSync("sleep", ["0.2"]);
    expect(fired).toBe(false);
  });

  it("has run before the next test starts", () => {
    expect(fired).toBe(true);
  });
});

describe("input that arrives during a blocking test", () => {
  // The shape of vitest's RPC reply: bytes on a pipe, read only in the poll phase.
  let received = "";

  it("is sent while the thread is blocked", () => {
    const child = spawn("echo", ["reply"]);
    child.stdout.on("data", (chunk: Buffer) => {
      received += chunk.toString();
    });
    spawnSync("sleep", ["0.3"]);
    expect(received).toBe("");
  });

  it("has been read before the next test starts", () => {
    expect(received).toBe("reply\n");
  });
});

describe("a keep-alive socket left idle past its timeout by a blocking test", () => {
  let idle: Socket;

  it("is used, then the thread is blocked past the keep-alive timeout", async () => {
    idle = await request();
    spawnSync("sleep", [BLOCK_SECONDS]);
    expect(idle.destroyed, "nothing can close it while the thread is blocked").toBe(false);
  });

  it("is closed before the next test can send a request on it", () => {
    expect(idle.destroyed).toBe(true);
  });
});

describe("spawnAsync keeps the loop turning while the child runs", () => {
  it("so a socket idle for longer than the child ran is closed when the child exits", async () => {
    const idle = await request();
    const child = await spawnAsync("sleep", [BLOCK_SECONDS]);
    expect(child.status).toBe(0);
    expect(idle.destroyed).toBe(true);
  });
});
