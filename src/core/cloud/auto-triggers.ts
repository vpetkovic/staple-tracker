/**
 * Where the three triggers meet the three surfaces.
 *
 * Contract: `docs/sync.md`, "Three consents" — *"After automatic — bounded
 * triggers only: startup, post-write, long-running session, pre-checkout."*
 * (On the absence of the fourth, see the header of `auto.ts`.)
 *
 * This module exists so that `src/cli.ts`, `src/mcp.ts` and `src/ui/server.ts`
 * each acquire a handful of lines rather than a policy. The three surfaces have
 * genuinely different shapes — one process per command, one process per session,
 * one process serving a page — and the difference between them is entirely in
 * *when* they call, never in *what* they are allowed to do. What they are allowed
 * to do is `auto.ts`, once, for all three.
 *
 * ## The everyday cost, stated plainly
 *
 * On a machine that has never connected anything, {@link runCommandTrigger} is
 * one `existsSync`. On a connected machine in manual mode it is that plus one
 * small file read. Only after both say yes does anything here open a database or
 * load the transport. That ordering is the reason a trigger can be registered on
 * the everyday path at all.
 */
import type { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { credentialDir } from "./credential-store.js";
import { readWorkspaceManifest, workspaceIdentityDir } from "../repo-identity.js";
import { findWorkspaceDb } from "../workspace.js";
import { openWorkspace } from "../open.js";
import {
  AUTO_SYNC_SESSION_INTERVAL_MS,
  autoSyncConsented,
  type AutoSyncTrigger,
} from "./auto.js";
import {
  AutoSyncScheduler,
  type AutoSyncOutcome,
  type AutoSyncSchedulerOptions,
  type AutoSyncTarget,
} from "./auto-sync.js";

/**
 * The command→trigger table, and **absence means no trigger**.
 *
 * Explicit rather than a rule like "anything that is not a read", because the
 * safe default for a command nobody has thought about is silence. A new verb
 * gets an automatic sync when somebody decides it should, in this table, in a
 * diff a reviewer can see — not by inheriting one from a predicate.
 *
 * Three groups, and the reasons they differ:
 *
 * **Writes** produce local work other devices cannot see, so they are worth
 * going for promptly. `checkout`, `start`, `done`, `cancel` and `release` are
 * here rather than under a `pre-checkout` trigger; see `auto.ts` for why the
 * claim is pushed after it is taken rather than the world consulted before.
 *
 * **Reads** get `startup`, whose minute-long floor means a shell loop of `staple
 * ls` syncs once rather than once per iteration.
 *
 * `queue`, `settings`, `statuses`, `kinds`, `doc` and `milestone` are read OR
 * write depending on their subcommand, and they are all listed as writes. The
 * classification is deliberately coarse: the two triggers differ only in budget
 * and floor, so calling a read a write costs a slightly earlier sync, whereas
 * calling a write a read would leave new local work sitting for a minute. When a
 * coarse table has to be wrong somewhere, it should be wrong in the direction
 * that loses no data.
 *
 * **Absent entirely**: every `cloud` subcommand (`cloud sync` is the explicit
 * one — a trigger on it would be a recursion), `install`, `init` and `migrate`
 * (each mutates a home or moves a database, and a sync racing that is a bad
 * idea), `open` and `ui` and the bare command (the UI server registers its own,
 * and firing here as well would double every one of them), `help`, and `doctor`
 * — which exists to report what is wrong with a machine and must not change it.
 */
export const CLI_COMMAND_TRIGGERS: Readonly<Record<string, AutoSyncTrigger>> = {
  // writes
  new: "post-write",
  checkout: "post-write",
  start: "post-write",
  done: "post-write",
  cancel: "post-write",
  status: "post-write",
  release: "post-write",
  gate: "post-write",
  approve: "post-write",
  "request-changes": "post-write",
  block: "post-write",
  "blocked-by": "post-write",
  link: "post-write",
  comment: "post-write",
  doc: "post-write",
  queue: "post-write",
  statuses: "post-write",
  kinds: "post-write",
  settings: "post-write",
  milestone: "post-write",
  add: "post-write",
  // reads
  ls: "startup",
  show: "startup",
  tree: "startup",
  board: "startup",
  inbox: "startup",
  events: "startup",
};

/** Resolved from the flags a command was given, without opening anything. */
export interface AutoSyncLocation {
  readonly workspaceDir: string;
  readonly repositoryId: string;
}

/**
 * Where a `--db`/`--ws`-less command would find its workspace, and which
 * repository that is — or null.
 *
 * `findWorkspaceDb` walks up from the directory and returns a path; nothing is
 * opened. The manifest is one file read. Both are cheap enough to sit in front of
 * the consent check, which is the only reason the consent check can sit on the
 * everyday path.
 */
export function locateAutoSyncTarget(dbPath: string | null): AutoSyncLocation | null {
  if (dbPath === null) return null;
  const workspaceDir = workspaceIdentityDir(dbPath);
  const manifest = readWorkspaceManifest(dbPath);
  if (!manifest) return null;
  return { workspaceDir, repositoryId: manifest.repositoryId };
}

/**
 * `--db` / `--ws` off a raw argv, without `parseArgs`.
 *
 * The CLI's registration point is a single call after `main()` has returned, and
 * at that point the per-command `parseArgs` result is long out of scope. Running
 * `parseArgs` again is not possible — each command declares its own option set
 * and a shared parse would reject half of them. So this reads the two global
 * flags directly, in both spellings, and tolerates anything it does not
 * understand: a flag it fails to see costs at most a trigger that resolves the
 * wrong workspace's identity and is then refused by the gate, which is the
 * failure mode you want from a best-effort background hint.
 */
export function globalFlagsOf(argv: readonly string[]): { db?: string; ws?: string } {
  const values: { db?: string; ws?: string } = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    for (const key of ["db", "ws"] as const) {
      if (arg === `--${key}`) {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("-")) values[key] = next;
      } else if (arg.startsWith(`--${key}=`)) {
        values[key] = arg.slice(key.length + 3);
      }
    }
  }
  return values;
}

export interface CommandTriggerOptions {
  readonly home: string;
  readonly cwd?: string;
  /** Injected in tests; production opens a real handle and closes it. */
  readonly open?: (dbPath: string) => { db: DatabaseSync; close: () => void };
  readonly scheduler?: (options: AutoSyncSchedulerOptions) => AutoSyncScheduler;
}

/**
 * The CLI's whole registration: one call, after the command has printed.
 *
 * **After**, not before, and not around. The command's output, its exit code and
 * its error envelope are already settled by the time this runs, so there is no
 * path by which an automatic sync can change what a script sees. That is the
 * property that makes it safe to put on `checkout`: the claim is taken, printed
 * and exit-coded exactly as it is today, and only then does this device mention
 * it to anybody.
 *
 * The process stays alive until the returned promise settles — bounded by the
 * trigger's budget — which is the cost of automatic mode and is paid only by a
 * device that asked for it.
 */
export async function runCommandTrigger(
  command: string | undefined,
  argv: readonly string[],
  options: CommandTriggerOptions,
): Promise<AutoSyncOutcome> {
  const trigger = command === undefined ? undefined : CLI_COMMAND_TRIGGERS[command];
  if (trigger === undefined) return { status: "skipped", reason: "no-connections" };

  /**
   * The fresh-install short circuit, and the first thing that happens.
   *
   * One `existsSync` on a directory that does not exist. Everything below —
   * walking for a workspace, reading a manifest, reading a connection record —
   * is skipped on every machine that has never connected a repository, which is
   * every machine until somebody decides otherwise.
   */
  if (!existsSync(credentialDir(options.home))) {
    return { status: "skipped", reason: "no-connections" };
  }

  const flags = globalFlagsOf(argv);
  let dbPath: string | null;
  try {
    dbPath = flags.db ?? findWorkspaceDb(options.cwd ?? process.cwd());
  } catch {
    return { status: "skipped", reason: "no-identity" };
  }
  const location = locateAutoSyncTarget(dbPath);
  if (!location) return { status: "skipped", reason: "no-identity" };

  /**
   * The consent, checked before a database is opened.
   *
   * `autoSyncGate` would check it again — and does, inside the run, which is
   * where it is authoritative. This earlier check exists so that a connected
   * machine in manual mode never pays for opening a workspace it was never going
   * to sync.
   */
  if (!autoSyncConsented(options.home, location.repositoryId)) {
    return { status: "skipped", reason: "manual" };
  }

  const open = options.open ?? defaultOpen;
  let handle: { db: DatabaseSync; close: () => void };
  try {
    handle = open(dbPath!);
  } catch {
    // An unreadable or migrating workspace is not this trigger's business.
    return { status: "skipped", reason: "no-identity" };
  }

  const scheduler = (options.scheduler ?? ((o) => new AutoSyncScheduler(o)))({ home: options.home });
  try {
    return await scheduler.request({ db: handle.db, repositoryId: location.repositoryId }, trigger);
  } finally {
    try {
      handle.close();
    } catch {
      /* already closed */
    }
  }
}

/**
 * A handle of this trigger's OWN, closed in the caller's `finally`.
 *
 * Not the one the command used: by the time this runs that store is out of
 * scope, and reaching for it would have meant threading a handle through every
 * command case — the opposite of a thin registration. A second connection to the
 * same SQLite file in the same process is what WAL is for, and it is opened only
 * after the consent gate has already said yes, so no machine that has not opted
 * in ever pays for it.
 */
function defaultOpen(dbPath: string): { db: DatabaseSync; close: () => void } {
  const ws = openWorkspace(dbPath);
  return { db: ws.store.db, close: () => ws.store.db.close() };
}

// --------------------------------------------------------- long-running surfaces

export interface SurfaceAutoSyncOptions {
  readonly home: () => string;
  /**
   * The surface's own workspace resolution, which it already has and this module
   * must not duplicate: the UI server has `handleFor(slug)` over a hub, MCP has
   * `storeFor(ws)`. Returns null when there is no identity to sync — and **must
   * not throw**, because a trigger is never a reason for a request to fail.
   */
  readonly resolve: (ws?: string) => AutoSyncTarget | null;
  readonly sessionIntervalMs?: number;
  readonly scheduler?: (options: AutoSyncSchedulerOptions) => AutoSyncScheduler;
}

/**
 * The UI server's and the MCP server's registration.
 *
 * Both are long-running, so both get the `session` trigger the contract names,
 * and both need `stop()` — a server that closed while a sync was in flight would
 * otherwise keep the process alive for the rest of the budget and, worse, keep
 * writing to a database handle its owner had just closed.
 */
export class SurfaceAutoSync {
  /**
   * Built on first use, not in the constructor.
   *
   * `stapleHome()` reads configuration and an environment variable, and a server
   * is constructed before it is listening — in tests, before `STAPLE_HOME` has
   * been pointed at the temporary home the case is about. Reading it lazily means
   * the home a run uses is the home in force when the run happens, which is the
   * only reading that is ever right.
   */
  private scheduler: AutoSyncScheduler | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(private readonly options: SurfaceAutoSyncOptions) {}

  private ensure(): AutoSyncScheduler {
    if (!this.scheduler) {
      this.scheduler = (this.options.scheduler ?? ((o) => new AutoSyncScheduler(o)))({
        home: this.options.home(),
      });
    }
    return this.scheduler;
  }

  /**
   * Fire and forget, with every failure absorbed.
   *
   * The three public triggers below all funnel through here, and none of them
   * returns a promise the surface has to handle. A UI route that awaited its own
   * post-write sync would make every write on a connected machine as slow as the
   * link, which is precisely the *"a tracker command never blocks indefinitely on
   * Cloudflare"* failure wearing a different hat.
   */
  private fire(trigger: AutoSyncTrigger, ws?: string): void {
    if (this.stopped) return;
    let target: AutoSyncTarget | null;
    try {
      target = this.options.resolve(ws);
    } catch {
      return;
    }
    if (!target) return;
    try {
      void this.ensure()
        .request(target, trigger)
        .catch(() => undefined);
    } catch {
      /* an unusable home is not a reason for a request to fail */
    }
  }

  /** Once, when the server binds or the transport connects. */
  startup(ws?: string): void {
    this.fire("startup", ws);
  }

  /** After a mutating route or a mutating tool has already answered. */
  postWrite(ws?: string): void {
    this.fire("post-write", ws);
  }

  /**
   * The long-running-session trigger.
   *
   * `unref`'d, so it can never be the reason a process refuses to exit — a server
   * that has closed its socket and finished its work must not be held open by its
   * own heartbeat. And it is a plain interval rather than a self-rescheduling
   * timeout so that a run which overruns the interval does not compound: the next
   * tick coalesces into the run already in flight and adds at most one follow-up.
   */
  startSession(ws?: string): void {
    if (this.timer) return;
    const every = this.options.sessionIntervalMs ?? AUTO_SYNC_SESSION_INTERVAL_MS;
    this.timer = setInterval(() => this.fire("session", ws), every);
    this.timer.unref?.();
  }

  /**
   * *"Disabling automatic mode stops background requests while preserving manual
   * sync."* This is the in-process half: the interval stops, the in-flight run's
   * transport is aborted, and every later request is refused. The durable half is
   * the consent record — a new process reads `auto: false` and never reaches a
   * scheduler at all.
   */
  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.scheduler?.stop();
  }

  /** For tests, and for a surface that wants to report whether one is running. */
  get busy(): boolean {
    return this.scheduler?.busy ?? false;
  }
}
