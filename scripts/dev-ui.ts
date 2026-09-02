/**
 * The dev pair, started as one process.
 *
 * `npm run dev:ui` alone is only the front half: Vite serves the React app on
 * :4401 with HMR and proxies every `/api` call to a staple server on :4400 that
 * it does not start (see the proxy block in `src/ui/app/vite.config.ts`). Run it
 * by itself and the page renders `HTTP 500` over a wall of ECONNREFUSED.
 *
 * This is the missing half. It starts `staple open --hub` first, waits until
 * :4400 actually accepts a connection — so Vite never proxies into a void, and
 * so the `ui-token` file exists before the seed-token plugin reads it — then
 * starts Vite. Ctrl-C takes both down, matching the no-daemon promise the real
 * server makes: one foreground process, one interrupt, everything closed.
 *
 * Unlike `npm run dev`, nothing here is built: the app is served from source, so
 * edits under `src/ui/app/` hot-reload. `npm run build:ui` is still what
 * refreshes the static bundle the standalone :4400 page serves.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { connect } from "node:net";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BIN = join(ROOT, "node_modules", ".bin");
const SERVER_PORT = 4400; // hardcoded in vite.config.ts's proxy target
const VITE_PORT = 4401; // hardcoded in vite.config.ts's server.port

const children: ChildProcess[] = [];
let shuttingDown = false;

/** Ctrl-C closes the pair, not just whichever child had the terminal. */
function shutdown(code = 0): void {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill("SIGTERM");
  process.exit(code);
}

function start(name: string, command: string, args: string[]): ChildProcess {
  const child = spawn(command, args, { cwd: ROOT, stdio: "inherit" });
  children.push(child);
  child.on("exit", (exitCode) => {
    if (shuttingDown) return;
    console.error(`\n[dev] ${name} exited (${exitCode ?? "signal"}) — stopping the pair.`);
    shutdown(exitCode ?? 1);
  });
  child.on("error", (error) => {
    console.error(`[dev] could not start ${name}: ${error.message}`);
    shutdown(1);
  });
  return child;
}

/** Resolves once something is listening, so Vite starts into a live API. */
async function waitForPort(port: number, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (shuttingDown) return;
    const open = await new Promise<boolean>((resolve) => {
      const socket = connect({ port, host: "127.0.0.1" });
      const done = (result: boolean) => {
        socket.destroy();
        resolve(result);
      };
      socket.once("connect", () => done(true));
      socket.once("error", () => done(false));
      socket.setTimeout(500, () => done(false));
    });
    if (open) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`:${port} never came up within ${timeoutMs}ms`);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

start("staple server", join(BIN, "tsx"), [
  join(ROOT, "src", "cli.ts"),
  "open",
  "--hub",
  "--no-browser",
  "--port",
  String(SERVER_PORT),
]);

await waitForPort(SERVER_PORT).catch((error: Error) => {
  console.error(`[dev] ${error.message}`);
  shutdown(1);
});

if (!shuttingDown) {
  start("vite", join(BIN, "vite"), ["--config", join(ROOT, "src", "ui", "app", "vite.config.ts")]);
  console.log(`\n[dev] API on :${SERVER_PORT} — open the hot-reloading app at http://localhost:${VITE_PORT}/\n`);
}
