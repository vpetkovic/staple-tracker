/**
 * The hub registry leg, end to end, against a REAL service: a deployed Worker, or
 * `wrangler dev --local` (real workerd with a real local D1).
 *
 * Not in the vitest suite, and deliberately: it makes real network calls and needs
 * `repos` rows that only an operator can create. It is committed because the one thing
 * neither test suite can prove is that the running Worker behaves like Miniflare and
 * like `FakeSyncServer`.
 *
 * Two walks:
 *
 *   1. **One registry, one machine lost.** Publish, back up, lose the machine, adopt on
 *      a replacement, publish damage, restore, adopt. In-process, through the service
 *      module, so it can capture every request body and prove no filesystem path left.
 *      Step 1.8 injects a response lost after the Worker committed, and shows the lost
 *      act is not sent again over another machine's newer decision.
 *   2. **Two machines sharing one registry (STA-287).** Two STAPLE_HOMEs, two separate
 *      credential files, and real `git clone`s under DIFFERENT directory names, driven
 *      only through the `staple` CLI. It shows: (a) alternating publishes settle at zero
 *      operations, (b) a cross-link is shared across different directory names, (c) a
 *      `hub unlink` propagates and no adopt brings the link back, (d) re-linking works
 *      from either machine, (e) a machine that is behind publishes safely and loses
 *      nothing of the other's.
 *
 * It exits non-zero if any assertion fails. The previous version printed `FAILED:` and
 * exited 0.
 *
 * ## Running it
 *
 * Every repository it touches is provisioned fresh on each run, with an additive
 * `INSERT` through `wrangler d1 execute`. Nothing else is written to the service's
 * database and nothing is deleted, so the script can be re-run against the same service
 * as often as you like. `STAPLE_LIVE_D1` is the argument list that points `wrangler d1
 * execute staple-sync-dev` at the service's database:
 *
 * ```sh
 * # Local workerd, on its own port and its own state directory:
 * cd worker
 * npx wrangler d1 migrations apply staple-sync-dev --local --persist-to /tmp/live-d1
 * npx wrangler dev --local --port 8797 --persist-to /tmp/live-d1 &
 * cd ..
 * STAPLE_HUB_ENDPOINT=http://127.0.0.1:8797 \
 * STAPLE_LIVE_D1="--local --persist-to /tmp/live-d1" \
 *   npx tsx scripts/hub-registry-live.ts
 *
 * # A deployed dev Worker:
 * STAPLE_HUB_ENDPOINT=https://<worker>.workers.dev \
 * STAPLE_LIVE_D1="--remote -c wrangler.local.toml" \
 *   npx tsx scripts/hub-registry-live.ts
 * ```
 *
 * Every identifier is minted per run or read from the environment. Nothing real is
 * committed here, because this repository is public.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Hub } from "../src/core/hub.js";
import { initWorkspace } from "../src/core/workspace.js";
import { buildConnectPreview } from "../src/core/cloud/preview.js";
import { REGISTRY_DISCLOSURE } from "../src/core/cloud/hub-registry.js";
import {
  adoptPublishedRegistry,
  adoptRegistryIdentity,
  connectHubRegistry,
  createHubBackup,
  listHubBackups,
  publishRegistry,
  readPublishedRegistry,
  registryDisclosure,
  restoreRegistry,
  setHubBackupConsent,
  setRegistryConsent,
} from "../src/core/cloud/hub-registry-service.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKER_DIR = join(REPO_ROOT, "worker");
const TSX = join(REPO_ROOT, "node_modules/tsx/dist/cli.mjs");
const CLI = join(REPO_ROOT, "src/cli.ts");

const endpoint = required("STAPLE_HUB_ENDPOINT");
const d1Args = required("STAPLE_LIVE_D1").split(/\s+/).filter((a) => a.length > 0);

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    console.error(`${name} is required. See this file's header for how to run it. Nothing was sent.`);
    process.exit(2);
  }
  return value.trim();
}

/** Every temporary directory this run made. All removed at the end, pass or fail. */
const scratch: string[] = [];
function tempRoot(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `staple-hublive-${label}-`));
  scratch.push(dir);
  return dir;
}

/** Every assertion's outcome. The exit code is computed from this and nothing else. */
const failures: string[] = [];
function check(ok: boolean, pass: string, fail: string): void {
  if (ok) console.log(`PASS — ${pass}`);
  else {
    console.log(`FAIL — ${fail}`);
    failures.push(fail);
  }
}

function step(what: string): void {
  console.log(`\n=== ${what}`);
}

/**
 * Create a repository on the service: an additive `INSERT` of a `repos` row and the
 * digest of a fresh enrollment secret. The same recipe as `worker/README.md`,
 * "Provisioning a repository". Returns the secret, which never leaves this process
 * except as the `--token` of a connect.
 */
function provision(repoId: string): string {
  const secret = randomBytes(32).toString("hex");
  const digest = createHash("sha256").update(secret).digest("hex");
  const sql =
    "INSERT INTO repos (repo_id, epoch, last_seq, last_fencing_token, enroll_sha256, created_at) " +
    `VALUES ('${repoId}', 1, 0, 0, X'${digest}', ${Date.now()});`;
  const result = spawnSync("npx", ["wrangler", "d1", "execute", "staple-sync-dev", ...d1Args, "--command", sql], {
    cwd: WORKER_DIR,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`provisioning ${repoId} failed:\n${result.stdout}\n${result.stderr}`);
  }
  return secret;
}

// =============================================================== walk 1: one machine lost

const sentBodies: string[] = [];
/**
 * Every request body walk 1 sent, captured at the transport. The path assertion checks
 * what actually left the process, from the machine whose hub rows carry REAL absolute
 * paths, and not a payload type that structurally cannot hold one.
 */
const recordingFetch: typeof fetch = async (input, init) => {
  if (typeof init?.body === "string") sentBodies.push(init.body);
  return globalThis.fetch(input as Parameters<typeof fetch>[0], init);
};

function machine(label: string, hubId: string): { home: string; hub: Hub } {
  const home = tempRoot(label);
  process.env.STAPLE_HOME = home;
  const hub = Hub.open();
  // Adopted, not minted: every machine joins the same registry identity.
  adoptRegistryIdentity(home, hub, hubId);
  return { home, hub };
}

/** A workspace brought up the way `staple init` brings one up. Returns its identity. */
function register(home: string, slug: string): string {
  const dir = join(home, "ws", slug);
  mkdirSync(dir, { recursive: true });
  const opened = initWorkspace({ dir, slug, kind: "repo" });
  opened.store.db.close();
  return opened.repository.repositoryId;
}

async function oneMachineLost(): Promise<void> {
  const hubId = randomUUID();
  const enrollmentSecret = provision(hubId);
  const safe = (value: unknown) => JSON.stringify(value, null, 2).replaceAll(hubId, "<hub id>");
  // Absent rows carry invented identities; `register` gets real ones from `initWorkspace`.
  const EDGE_A = randomUUID();
  const EDGE_B = randomUUID();

  step("1.1 connect the hub as a repository");
  const a = machine("first", hubId);
  const trackerId = register(a.home, "live-tracker");
  const otherId = register(a.home, "live-other");
  const nameless = join(a.home, "ws", "live-nameless");
  mkdirSync(nameless, { recursive: true });
  writeFileSync(join(nameless, "staple.db"), "");
  a.hub.register({ slug: "live-nameless", prefix: "LVN", path: join(nameless, "staple.db"), kind: "repo" });
  const connected = await connectHubRegistry(buildConnectPreview({ home: a.home, repositoryId: hubId, endpoint }), {
    home: a.home,
    enrollmentSecret,
    credential: { forceFile: true },
  });
  check(
    connected.connection.registry !== true && connected.connection.backup !== true,
    "connecting leaves every consent off",
    "connecting turned a consent on",
  );

  step("1.2 publish: refused without consent, then published");
  let refused = false;
  try {
    await publishRegistry(a.hub, a.home, { fetchImpl: recordingFetch });
  } catch {
    refused = true;
  }
  check(refused, "publishing without the consent is refused before any push", "published without consent");
  console.log(registryDisclosure(endpoint));
  setRegistryConsent(a.home, hubId, true, REGISTRY_DISCLOSURE);
  const published = await publishRegistry(a.hub, a.home, { fetchImpl: recordingFetch });
  console.log(safe({ published: published.published, applied: published.applied, unpublishable: published.unpublishable.map((u) => u.entry.slug) }));
  check(
    published.published === 2 && published.applied === 2 && published.unpublishable.length === 1,
    "two workspaces published, the one with no identity reported by name",
    `published=${published.published} applied=${published.applied} unpublishable=${published.unpublishable.length}`,
  );

  step("1.3 a link, removed and linked again: the removal propagates, and so does the re-link");
  a.hub.registerAbsent({ slug: "live-edge-a", prefix: "LEA", kind: "repo", repositoryId: EDGE_A });
  a.hub.registerAbsent({ slug: "live-edge-b", prefix: "LEB", kind: "repo", repositoryId: EDGE_B });
  a.hub.addCrossLink("LEA-1", "LEB-2");
  const withEdge = await publishRegistry(a.hub, a.home, { fetchImpl: recordingFetch });
  const edgesOnService = async () =>
    (await readPublishedRegistry(a.home, hubId, { fetchImpl: recordingFetch })).registry.crossLinks.length;
  const afterCreate = await edgesOnService();
  a.hub.removeCrossLink("LEA-1", "LEB-2");
  const afterRemoval = await publishRegistry(a.hub, a.home, { fetchImpl: recordingFetch });
  const edgesAfterRemoval = await edgesOnService();
  a.hub.addCrossLink("LEA-1", "LEB-2");
  const afterRelink = await publishRegistry(a.hub, a.home, { fetchImpl: recordingFetch });
  const edgesAfterRelink = await edgesOnService();
  const settled = await publishRegistry(a.hub, a.home, { fetchImpl: recordingFetch });
  console.log(
    safe({
      create: { published: withEdge.published, serviceEdges: afterCreate },
      unlink: { retracted: afterRemoval.retracted.length, serviceEdges: edgesAfterRemoval },
      relink: { relinked: afterRelink.relinked.length, serviceEdges: edgesAfterRelink },
      again: { published: settled.published, deduplicated: settled.deduplicated },
    }),
  );
  check(
    afterCreate === 1 && afterRemoval.retracted.length === 1 && edgesAfterRemoval === 0 &&
      afterRelink.relinked.length === 1 && edgesAfterRelink === 1 && settled.upToDate,
    "created, retracted, linked again, and then nothing left to send",
    "the link did not go create -> retract -> re-link -> settled",
  );

  step("1.4 back up the registry");
  await setHubBackupConsent(a.home, hubId, true);
  const backup = await createHubBackup(a.home, hubId, "hub-registry-live");
  console.log(safe((await listHubBackups(a.home, hubId)).map((b) => ({ id: b.backupId, kind: b.kind }))));
  a.hub.close();

  step("1.5 a replacement machine adopts the registry it never had");
  const b = machine("replacement", hubId);
  await connectHubRegistry(buildConnectPreview({ home: b.home, repositoryId: hubId, endpoint }), {
    home: b.home,
    enrollmentSecret,
    credential: { forceFile: true },
  });
  const adopted = await adoptPublishedRegistry(b.hub, b.home, { apply: true });
  const ids = new Set(b.hub.list().map((r) => r.repositoryId));
  console.log(
    safe({
      decisions: adopted.adoption.decisions.map((d) => ({ slug: d.entry.slug, outcome: d.outcome })),
      crossLinks: adopted.adoption.crossLinks,
    }),
  );
  check(
    [trackerId, otherId, EDGE_A, EDGE_B].every((id) => ids.has(id)) && b.hub.listCrossLinks().length === 1,
    "the replacement machine holds all four workspaces, by identity, and the link",
    `replacement holds ${safe([...ids])} and ${b.hub.listCrossLinks().length} link(s)`,
  );

  step("1.6 damage (another machine unlinks by mistake), then restore the backup and adopt");
  setRegistryConsent(b.home, hubId, true, REGISTRY_DISCLOSURE);
  b.hub.removeCrossLink("LEA-1", "LEB-2");
  const damaged = await publishRegistry(b.hub, b.home, { fetchImpl: recordingFetch });
  check(damaged.retracted.length === 1, "the damage landed: the link is retracted on the service", "the damage step retracted nothing, so the restore would prove nothing");
  const c = machine("restorer", hubId);
  await connectHubRegistry(buildConnectPreview({ home: c.home, repositoryId: hubId, endpoint }), {
    home: c.home,
    enrollmentSecret,
    credential: { forceFile: true },
  });
  await setHubBackupConsent(c.home, hubId, true);
  setRegistryConsent(c.home, hubId, true, REGISTRY_DISCLOSURE);
  const restored = await restoreRegistry(c.hub, c.home, backup.backupId, { apply: true });
  console.log(
    safe({
      fromEpoch: restored.fromEpoch,
      toEpoch: restored.toEpoch,
      links: restored.registry.crossLinks.map((l) => `${l.blockerIdentifier}->${l.blockedIdentifier}`),
      rows: c.hub.list().map((r) => r.slug),
    }),
  );
  check(
    restored.registry.crossLinks.length === 1 && c.hub.listCrossLinks().length === 1 &&
      restored.registry.workspaces.find((w) => w.repositoryId === trackerId)?.slug === "live-tracker",
    "the restore brought the retracted link back, and the restoring machine adopted it",
    "the restore did not bring the link back",
  );

  step("1.7 no filesystem path in what was pushed");
  const pushed = sentBodies.filter((body) => body.includes('"registration"'));
  const leaked = [a.home, b.home, c.home].filter((home) => sentBodies.some((body) => body.includes(home)));
  check(
    pushed.length > 0 && leaked.length === 0,
    `no path in ${sentBodies.length} request bodies (${pushed.length} carrying registrations)`,
    pushed.length === 0 ? "captured no push body, so the path check proves nothing" : `leaked ${leaked.join(", ")}`,
  );
  b.hub.close();
  c.hub.close();
}

/**
 * A transport that lets the next push reach the service and then loses the answer: the
 * Worker commits, and the client sees a connection reset. Only an in-process walk can
 * inject this, which is why it lives here and not in walk 2.
 */
function losingNextPushResponse(): typeof fetch {
  let lost = false;
  return async (input, init) => {
    const response = await recordingFetch(input, init);
    if (!lost && init?.method === "POST" && String(input).endsWith("/ops")) {
      lost = true;
      throw new TypeError("injected: connection reset after the service committed");
    }
    return response;
  };
}

/**
 * Walk 1b: a retraction whose response is lost must not be sent again later over another
 * machine's newer re-link (found in review of #99). Against the real Worker, because
 * whether the retried operation is a duplicate or a fresh write is decided by the real
 * opId index and the real fold.
 */
async function lostResponse(): Promise<void> {
  const hubId = randomUUID();
  const enrollmentSecret = provision(hubId);
  const X = randomUUID();
  const Y = randomUUID();
  const join2 = async (label: string) => {
    const m = machine(label, hubId);
    await connectHubRegistry(buildConnectPreview({ home: m.home, repositoryId: hubId, endpoint }), {
      home: m.home,
      enrollmentSecret,
      credential: { forceFile: true },
    });
    setRegistryConsent(m.home, hubId, true, REGISTRY_DISCLOSURE);
    return m;
  };
  const linksOnService = async (home: string) =>
    (await readPublishedRegistry(home, hubId, { fetchImpl: recordingFetch })).registry.crossLinks.length;

  step("1.8 a retraction whose response is lost is not re-sent over a newer re-link");
  const x = await join2("lost-x");
  x.hub.registerAbsent({ slug: "lost-one", prefix: "LXO", kind: "repo", repositoryId: X });
  x.hub.registerAbsent({ slug: "lost-two", prefix: "LXT", kind: "repo", repositoryId: Y });
  x.hub.addCrossLink("LXO-1", "LXT-1");
  await publishRegistry(x.hub, x.home, { fetchImpl: recordingFetch });
  const y = await join2("lost-y");
  await adoptPublishedRegistry(y.hub, y.home, { apply: true });

  x.hub.removeCrossLink("LXO-1", "LXT-1");
  let threw = false;
  try {
    await publishRegistry(x.hub, x.home, { fetchImpl: losingNextPushResponse() });
  } catch {
    threw = true;
  }
  const afterLost = await linksOnService(x.home);
  await adoptPublishedRegistry(y.hub, y.home, { apply: true });
  y.hub.addCrossLink("LXO-1", "LXT-1");
  const yRelink = await publishRegistry(y.hub, y.home, { fetchImpl: recordingFetch });
  const xRetry = await publishRegistry(x.hub, x.home, { fetchImpl: recordingFetch });
  const finalLinks = await linksOnService(x.home);
  console.log(
    JSON.stringify({
      lostPublishThrew: threw,
      serviceLinksAfterLostPublish: afterLost,
      yRelinked: yRelink.relinked.length,
      xRetry: { published: xRetry.published, retracted: xRetry.retracted.length },
      serviceLinksAtEnd: finalLinks,
    }),
  );
  check(
    threw && afterLost === 0 && yRelink.relinked.length === 1 && xRetry.published === 0 && finalLinks === 1,
    "the lost retraction landed once; X's next publish sent nothing, and Y's newer re-link stands",
    `threw=${threw} afterLost=${afterLost} yRelinked=${yRelink.relinked.length} xRetry=${xRetry.published} final=${finalLinks}`,
  );
  x.hub.close();
  y.hub.close();
}

// ======================================================= walk 2: two machines, one registry

interface Machine {
  readonly label: string;
  readonly home: string;
  readonly env: Record<string, string>;
}

/** Two machines: each its own HOME, its own STAPLE_HOME, and so its own credential files. */
function twoMachineRig(): { root: string; A: Machine; B: Machine; origins: string } {
  const root = tempRoot("union");
  const make = (label: string): Machine => {
    const base = join(root, label);
    mkdirSync(join(base, "home"), { recursive: true });
    return {
      label,
      home: join(base, "home"),
      env: {
        PATH: process.env.PATH ?? "",
        HOME: base,
        STAPLE_HOME: join(base, "home"),
        STAPLE_AGENT: `live-${label}`,
        NODE_NO_WARNINGS: "1",
      },
    };
  };
  const origins = join(root, "origins");
  mkdirSync(origins, { recursive: true });
  return { root, A: make("A"), B: make("B"), origins };
}

/** `staple <args>` on a machine, printed as a transcript line. Returns stdout. */
function staple(m: Machine, cwd: string, args: string[], options: { quiet?: boolean; allowFail?: boolean } = {}): string {
  const result = spawnSync(process.execPath, [TSX, CLI, ...args], { cwd, env: m.env, encoding: "utf8" });
  const shown = args.map((a) => (a.length > 40 ? `${a.slice(0, 8)}…` : a)).join(" ");
  console.log(`\n[${m.label}] ${cwd.split("/").pop()}$ staple ${shown}`);
  if (!options.quiet) {
    const out = result.stdout.trim();
    if (out.length > 0) console.log(out.split("\n").map((l) => `  ${l}`).join("\n"));
  }
  if (result.status !== 0 && !options.allowFail) {
    throw new Error(`staple ${shown} exited ${result.status}:\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

function stapleJson<T>(m: Machine, cwd: string, args: string[]): T {
  return JSON.parse(staple(m, cwd, [...args, "--json"], { quiet: true })) as T;
}

function git(m: Machine, cwd: string, args: string[]): void {
  const result = spawnSync("git", ["-c", "user.name=live", "-c", "user.email=live@example.invalid", ...args], {
    cwd,
    env: m.env,
    encoding: "utf8",
  });
  console.log(`\n[${m.label}] ${cwd.split("/").pop()}$ git ${args.join(" ")}`);
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed:\n${result.stderr}`);
}

interface PublishJson {
  published: number;
  retracted: unknown[];
  relinked: unknown[];
  retained: { reason: string }[];
  renamed: { local: string; published: string }[];
  unadopted: { registrations: { slug: string }[]; crossLinks: { blockerIdentifier: string; blockedIdentifier: string }[] };
  upToDate: boolean;
}
interface AdoptJson {
  registry: { workspaces: { slug: string; repositoryId: string }[]; crossLinks: { blockerIdentifier: string; blockedIdentifier: string }[] };
  adoption: { crossLinks: Record<string, number>; crossLinkDecisions: { outcome: string; reason: string }[] };
}
interface LinkJson {
  blockerWs: string;
  blockerIdentifier: string;
  blockedWs: string;
  blockedIdentifier: string;
}

async function twoMachines(): Promise<void> {
  const { A, B, origins } = twoMachineRig();
  const links = (m: Machine, cwd: string) =>
    stapleJson<LinkJson[]>(m, cwd, ["hub", "links"]).map(
      (l) => `${l.blockerWs}/${l.blockerIdentifier} -> ${l.blockedWs}/${l.blockedIdentifier}`,
    );
  step("2.0 two machines, two homes, real git clones under different directory names");
  for (const name of ["alpha", "beta", "gamma"]) git(A, origins, ["init", "--bare", "-b", "main", `${name}.git`]);
  const aDir = (name: string) => join(A.home, "..", name);
  const bDir = (name: string) => join(B.home, "..", name);
  for (const name of ["alpha", "beta"]) {
    git(A, join(A.home, ".."), ["clone", join(origins, `${name}.git`), name]);
    staple(A, aDir(name), ["init", "--yes"], { quiet: true });
    git(A, aDir(name), ["add", ".staple"]);
    git(A, aDir(name), ["commit", "-m", "track the staple identity"]);
    git(A, aDir(name), ["push", "origin", "HEAD:main"]);
  }
  /**
   * Workspaces sync through the service, so B gets A's issues the way a person's second
   * machine would. Each repository is provisioned fresh.
   *
   * The ORDER is deliberate: each workspace is connected BEFORE its issues are written.
   * That works around a real workspace-sync gap, the first-connect upload gap, and it is
   * not arbitrary. An unconnected workspace journals nothing (`src/core/journal.ts`,
   * "Disarmed by default"), and nothing seeds a workspace's existing data into the outbox
   * when it connects. So issues written before `staple cloud connect` never upload:
   * measured in this script's first run, where A's `cloud sync` said "Pushed nothing —
   * this device had no unsent operations" and B's clone came up with no issues. The gap
   * is being fixed in its own PR, outside the hub registry. Until that lands, keep this
   * order.
   */
  const identityOf = (dir: string) =>
    (JSON.parse(readFileSync(join(dir, ".staple", "repository.json"), "utf8")) as { repositoryId: string }).repositoryId;
  const wsSecret = new Map<string, string>();
  for (const name of ["alpha", "beta"]) {
    wsSecret.set(name, provision(identityOf(aDir(name))));
    staple(A, aDir(name), ["cloud", "connect", "--endpoint", endpoint, "--token", wsSecret.get(name)!, "--yes", "--credential-file"], { quiet: true });
  }
  staple(A, aDir("alpha"), ["new", "alpha work"]);
  staple(A, aDir("beta"), ["new", "beta work"]);
  staple(A, aDir("beta"), ["new", "more beta work"]);
  for (const name of ["alpha", "beta"]) staple(A, aDir(name), ["cloud", "sync"]);
  staple(A, aDir("beta"), ["ls"]);

  const hubId = (stapleJson<{ hubId: string }>(A, aDir("alpha"), ["hub", "registry", "id"])).hubId;
  const hubSecret = provision(hubId);
  staple(A, aDir("alpha"), ["hub", "registry", "connect", "--endpoint", endpoint, "--token", hubSecret, "--yes", "--credential-file"], { quiet: true });
  staple(A, aDir("alpha"), ["hub", "registry", "publish", "--enable", "--yes"], { quiet: true });
  staple(A, aDir("alpha"), ["link", "ALP-1", "BET-1"]);

  for (const name of ["alpha", "beta"]) {
    git(B, join(B.home, ".."), ["clone", join(origins, `${name}.git`), `${name}-clone`]);
    staple(B, bDir(`${name}-clone`), ["init", "--yes"], { quiet: true });
    staple(B, bDir(`${name}-clone`), ["cloud", "connect", "--endpoint", endpoint, "--token", wsSecret.get(name)!, "--yes", "--credential-file"], { quiet: true });
    staple(B, bDir(`${name}-clone`), ["cloud", "sync"]);
  }
  staple(B, bDir("alpha-clone"), ["ls"]);
  staple(B, bDir("alpha-clone"), ["hub", "registry", "identity", hubId, "--yes"], { quiet: true });
  staple(B, bDir("alpha-clone"), ["hub", "registry", "connect", "--endpoint", endpoint, "--token", hubSecret, "--yes", "--credential-file"], { quiet: true });
  staple(B, bDir("alpha-clone"), ["hub", "registry", "publish", "--enable", "--yes"], { quiet: true });
  staple(A, aDir("alpha"), ["hub", "ls"]);
  staple(B, bDir("alpha-clone"), ["hub", "ls"]);

  step("2.a alternating publishes converge to zero operations");
  const passes: number[] = [];
  for (let pass = 1; pass <= 6; pass += 1) {
    const [m, cwd] = pass % 2 === 1 ? [A, aDir("alpha")] : [B, bDir("alpha-clone")];
    const report = stapleJson<PublishJson>(m, cwd, ["hub", "registry", "publish"]);
    passes.push(report.published);
    console.log(`  pass ${pass} (${m.label}): published=${report.published} renamed=${report.renamed.map((r) => `${r.local}~${r.published}`).join(",") || "-"}`);
  }
  staple(B, bDir("alpha-clone"), ["hub", "registry", "publish"]);
  check(
    JSON.stringify(passes) === JSON.stringify([3, 0, 0, 0, 0, 0]),
    `ops per pass ${JSON.stringify(passes)}: A's three creates, then nothing from either machine`,
    `ops per pass ${JSON.stringify(passes)}, expected [3,0,0,0,0,0]`,
  );

  step("2.b a cross-link is shared across different directory names");
  staple(B, bDir("alpha-clone"), ["hub", "registry", "adopt"]);
  const adoptedB = stapleJson<AdoptJson>(B, bDir("alpha-clone"), ["hub", "registry", "adopt", "--apply"]);
  staple(B, bDir("alpha-clone"), ["hub", "links"]);
  const bLinks = links(B, bDir("alpha-clone"));
  const afterAdopt = stapleJson<PublishJson>(B, bDir("alpha-clone"), ["hub", "registry", "publish"]);
  check(
    adoptedB.adoption.crossLinks.added === 1 &&
      JSON.stringify(bLinks) === JSON.stringify(["alpha-clone/ALP-1 -> beta-clone/BET-1"]) &&
      afterAdopt.published === 0,
    "B adopted A's link between its OWN names (alpha-clone -> beta-clone), and it is the same entity: B publishes nothing",
    `B added=${adoptedB.adoption.crossLinks.added} links=${JSON.stringify(bLinks)} publish=${afterAdopt.published}`,
  );

  step("2.c `hub unlink` on A propagates, and B's adopt does not bring it back");
  staple(A, aDir("alpha"), ["hub", "unlink", "ALP-1", "BET-1"]);
  const aRetract = stapleJson<PublishJson>(A, aDir("alpha"), ["hub", "registry", "publish"]);
  console.log(`  A publish: published=${aRetract.published} retracted=${aRetract.retracted.length}`);
  // B still holds its adopted copy. Publishing it back would undo A's removal.
  staple(B, bDir("alpha-clone"), ["hub", "registry", "publish"]);
  const bStale = stapleJson<PublishJson>(B, bDir("alpha-clone"), ["hub", "registry", "publish"]);
  staple(B, bDir("alpha-clone"), ["hub", "registry", "adopt", "--apply"]);
  const bAfter = links(B, bDir("alpha-clone"));
  const bAgain = stapleJson<AdoptJson>(B, bDir("alpha-clone"), ["hub", "registry", "adopt", "--apply"]);
  const serviceLinks = bAgain.registry.crossLinks.length;
  check(
    aRetract.retracted.length === 1 && bStale.published === 0 && bAfter.length === 0 &&
      bAgain.adoption.crossLinkDecisions.length === 0 && serviceLinks === 0 && links(B, bDir("alpha-clone")).length === 0,
    "A retracted it; B's stale copy was not sent back; B's adopt removed it; a second adopt brought nothing back",
    `retracted=${aRetract.retracted.length} bStale=${bStale.published} bLinks=${JSON.stringify(bAfter)} again=${bAgain.adoption.crossLinkDecisions.length} service=${serviceLinks}`,
  );

  step("2.d re-linking works, from the machine that removed it and from the other one");
  staple(A, aDir("alpha"), ["link", "ALP-1", "BET-1"]);
  staple(A, aDir("alpha"), ["hub", "registry", "publish"]);
  const bBack = stapleJson<AdoptJson>(B, bDir("alpha-clone"), ["hub", "registry", "adopt", "--apply"]);
  const relinkedOnB = links(B, bDir("alpha-clone"));
  // Now B removes it, A takes that on, and A links it again.
  staple(B, bDir("alpha-clone"), ["hub", "unlink", "ALP-1", "BET-1"]);
  staple(B, bDir("alpha-clone"), ["hub", "registry", "publish"]);
  staple(A, aDir("alpha"), ["hub", "registry", "adopt", "--apply"]);
  const aAfterB = links(A, aDir("alpha"));
  staple(A, aDir("alpha"), ["link", "ALP-1", "BET-1"]);
  staple(A, aDir("alpha"), ["hub", "registry", "publish"]);
  staple(B, bDir("alpha-clone"), ["hub", "registry", "adopt", "--apply"]);
  // B removed it itself, so B keeps its copy removed; the registry has A's newer link.
  const bKept = links(B, bDir("alpha-clone"));
  const bKeptJson = stapleJson<AdoptJson>(B, bDir("alpha-clone"), ["hub", "registry", "adopt"]);
  check(
    bBack.adoption.crossLinks.added === 1 && relinkedOnB.length === 1 && aAfterB.length === 0 &&
      bKept.length === 0 && bKeptJson.registry.crossLinks.length === 1 &&
      bKeptJson.adoption.crossLinkDecisions.map((d) => d.outcome).join() === "kept_removed",
    "A's re-link reached B; B's unlink reached A; A's re-link after that stands in the registry, and B keeps its own removal",
    `bBack=${bBack.adoption.crossLinks.added} relinkedOnB=${relinkedOnB.length} aAfterB=${aAfterB.length} bKept=${bKept.length} decisions=${bKeptJson.adoption.crossLinkDecisions.map((d) => d.outcome).join()}`,
  );
  // B takes it back deliberately, which is the remedy the report names.
  staple(B, bDir("alpha-clone"), ["link", "ALP-1", "BET-1"]);

  step("2.e a machine that is behind publishes safely and loses nothing of A's");
  git(A, join(A.home, ".."), ["clone", join(origins, "gamma.git"), "gamma"]);
  staple(A, aDir("gamma"), ["init", "--yes"], { quiet: true });
  staple(A, aDir("gamma"), ["new", "gamma work"]);
  staple(A, aDir("gamma"), ["link", "BET-2", "GAM-1"]);
  staple(A, aDir("alpha"), ["hub", "registry", "publish"]);
  // B has not adopted any of that.
  staple(B, bDir("alpha-clone"), ["hub", "registry", "publish"]);
  const bBehind = stapleJson<PublishJson>(B, bDir("alpha-clone"), ["hub", "registry", "publish"]);
  const aView = stapleJson<AdoptJson>(A, aDir("alpha"), ["hub", "registry", "adopt"]);
  const aFinal = stapleJson<PublishJson>(A, aDir("alpha"), ["hub", "registry", "publish"]);
  check(
    bBehind.published === 0 &&
      bBehind.unadopted.registrations.map((r) => r.slug).join() === "gamma" &&
      aView.registry.workspaces.some((w) => w.slug === "gamma") &&
      aView.registry.crossLinks.some((l) => l.blockerIdentifier === "BET-2" && l.blockedIdentifier === "GAM-1") &&
      aFinal.published === 0,
    "B, behind, published and the service still holds all of A's (gamma and BET-2 -> GAM-1); A has nothing to re-send",
    `bBehind=${bBehind.published} unadopted=${JSON.stringify(bBehind.unadopted)} aFinal=${aFinal.published}`,
  );

  step("2.f and B catches up, after which neither machine has anything to say");
  staple(B, bDir("alpha-clone"), ["hub", "registry", "adopt", "--apply"]);
  staple(B, bDir("alpha-clone"), ["hub", "links"]);
  const endA = stapleJson<PublishJson>(A, aDir("alpha"), ["hub", "registry", "publish"]);
  const endB = stapleJson<PublishJson>(B, bDir("alpha-clone"), ["hub", "registry", "publish"]);
  check(
    endA.published === 0 && endB.published === 0 && endB.unadopted.registrations.length === 0 && endB.unadopted.crossLinks.length === 0,
    "converged: zero operations from either machine, and B lacks nothing",
    `endA=${endA.published} endB=${endB.published} unadopted=${JSON.stringify(endB.unadopted)}`,
  );
}

async function main(): Promise<void> {
  await oneMachineLost();
  await lostResponse();
  await twoMachines();
}

/**
 * Clean up first, THEN set the exit code. `process.exit` inside a `catch` used to lose
 * against a pending `finally`, so a run that printed `FAILED:` exited 0.
 */
main()
  .then(() => (failures.length === 0 ? 0 : 1))
  .catch((error) => {
    console.error(`\nFAILED: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  })
  .then((code) => {
    for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
    if (code !== 0 && failures.length > 0) console.error(`\n${failures.length} assertion(s) failed:\n- ${failures.join("\n- ")}`);
    console.log(code === 0 ? "\nALL PASSED" : "\nFAILED");
    process.exitCode = code;
  });
