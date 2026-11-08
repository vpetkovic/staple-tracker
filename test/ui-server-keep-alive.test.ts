/**
 * The page's server holds a kept-alive connection longer than any stall it can be put through.
 *
 * Every API handler runs on the server's one event loop, and a synchronous one (a write waiting
 * out SQLite's busy timeout, a burst of requests queued behind each other) stalls the rest. With
 * Node's five-second default, the idle timer of a socket a client had just reused could run out
 * during such a stall, before the server read the request already on it, and the client got
 * ECONNRESET. A kept-alive socket is held well past the busy timeout, and still reused after an
 * idle gap longer than the old default.
 */
import { once } from "node:events";
import { Agent, request } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KEEP_ALIVE_MS, startUiServer, type UiHandle } from "../src/ui/server.js";

const BUSY_TIMEOUT_MS = 5_000;

let home: string;
let ui: UiHandle;
let origin: string;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "staple-keepalive-home-"));
  process.env.STAPLE_HOME = home;
  ui = startUiServer({ port: 0, hub: true });
  await once(ui.server, "listening");
  origin = `http://127.0.0.1:${(ui.server.address() as AddressInfo).port}`;
});

afterAll(() => {
  ui?.close();
  rmSync(home, { recursive: true, force: true });
});

describe("a kept-alive connection", () => {
  it("is held well past SQLite's busy timeout, and the server says so to its clients", async () => {
    expect(ui.server.keepAliveTimeout).toBe(KEEP_ALIVE_MS);
    expect(KEEP_ALIVE_MS).toBeGreaterThanOrEqual(BUSY_TIMEOUT_MS * 10);
    // Headers of a request on a reused socket are never timed out before the socket itself is.
    expect(ui.server.headersTimeout).toBeGreaterThan(KEEP_ALIVE_MS);
    const response = await fetch(`${origin}/api/plan`, { headers: { "x-staple-token": ui.token } });
    await response.arrayBuffer();
    expect(response.headers.get("keep-alive")).toBe(`timeout=${KEEP_ALIVE_MS / 1000}`);
  });

  it("stays open across an idle gap longer than Node's default, and the next request reuses it", async () => {
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    const get = () =>
      new Promise<{ status: number; reused: boolean }>((resolve, reject) => {
        const req = request(`${origin}/api/plan`, { agent, headers: { "x-staple-token": ui.token } }, (res) => {
          res.resume();
          res.on("end", () => resolve({ status: res.statusCode ?? 0, reused: req.reusedSocket }));
        });
        req.on("error", reject);
        req.end();
      });
    try {
      const first = await get();
      await new Promise((resolve) => setTimeout(resolve, 7_000));
      const second = await get();
      expect(second).toEqual({ status: first.status, reused: true });
    } finally {
      agent.destroy();
    }
  }, 15_000);
});
