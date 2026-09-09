/**
 * The hub registry leg, end to end, against a REAL deployed service.
 *
 * Not in the vitest suite, and deliberately: it makes real network calls and needs a
 * `repos` row that only an operator can create. It is committed and re-runnable
 * because the one thing neither test suite can prove is that the deployed Worker
 * behaves like Miniflare and like `FakeSyncServer` — and this epic has already
 * produced four green suites that proved nothing.
 *
 * ## What it proves that the suites cannot
 *
 * `worker/test/registry.test.ts` runs inside workerd against Miniflare's D1.
 * `test/cloud-hub-registry-wire.test.ts` runs under Node against an in-process fake.
 * Both read the same shapes from `worker/test/registry-fixture.ts`, so they cannot
 * disagree with each other — but they could both disagree with what is deployed.
 * This drives the real client module over HTTPS to the real Worker and asserts on
 * what comes back.
 *
 * ## Before running it
 *
 * The hub's `repos` row must exist. Staple cannot create it — see
 * `worker/README.md`, "Provisioning a HUB". Additive INSERT only; there is no
 * destructive Cloudflare operation anywhere in this script and none may be added.
 *
 * ```sh
 * HUB_ID=$(uuidgen | tr 'A-Z' 'a-z')
 * SECRET=$(openssl rand -hex 32)
 * DIGEST=$(printf '%s' "$SECRET" | shasum -a 256 | cut -d' ' -f1)
 * cat > /tmp/seed-hub.sql <<SQL
 * INSERT INTO repos (repo_id, epoch, last_seq, last_fencing_token, enroll_sha256, created_at)
 * VALUES ('$HUB_ID', 1, 0, 0, X'$DIGEST', $(date +%s)000);
 * SQL
 * npx wrangler d1 execute staple-sync-dev --remote -c wrangler.local.toml --file /tmp/seed-hub.sql
 *
 * STAPLE_HUB_ENDPOINT=https://<worker>.workers.dev \
 * STAPLE_HUB_ID=$HUB_ID \
 * STAPLE_HUB_ENROLL=$SECRET \
 *   npx tsx scripts/hub-registry-live.ts
 * ```
 *
 * Every identifier is read from the environment. Nothing real is committed here,
 * because this repository is public.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub } from "../src/core/hub.js";
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

const endpoint = required("STAPLE_HUB_ENDPOINT");
const hubId = required("STAPLE_HUB_ID");
const enrollmentSecret = required("STAPLE_HUB_ENROLL");

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    console.error(
      `${name} is required. See this file's header for the provisioning recipe.\n` +
        "Nothing was sent.",
    );
    process.exit(2);
  }
  return value.trim();
}

const homes: string[] = [];

/** A machine: its own staple home and its own hub, with the shared registry identity. */
function machine(label: string): { home: string; hub: Hub } {
  const home = mkdtempSync(join(tmpdir(), `staple-hublive-${label}-`));
  homes.push(home);
  process.env.STAPLE_HOME = home;
  const hub = Hub.open();
  // Adopted, not minted. A machine scoped to a freshly minted id reads an empty
  // repository and reports, truthfully and uselessly, that there is nothing to restore.
  adoptRegistryIdentity(home, hub, hubId);
  return { home, hub };
}

function register(home: string, hub: Hub, slug: string, prefix: string, repositoryId: string): void {
  const dir = join(home, "ws", slug);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "staple.db");
  writeFileSync(path, "");
  hub.register({ slug, prefix, path, kind: "repo" });
  hub.recordRepositoryId(slug, repositoryId);
}

function step(n: number, what: string): void {
  console.log(`\n=== ${n}. ${what}`);
}

/** Redact the hub id out of anything printed, so a paste of the output is safe. */
function safe(value: unknown): string {
  return JSON.stringify(value, null, 2).replaceAll(hubId, "<hub id>");
}

async function main(): Promise<void> {
  const WS_A = "aaaaaaaa-0000-4000-8000-000000000001";
  const WS_B = "bbbbbbbb-0000-4000-8000-000000000002";
  const WS_C = "cccccccc-0000-4000-8000-000000000003";
  const WS_D = "dddddddd-0000-4000-8000-000000000004";

  step(1, "connect the hub as a repository");
  const a = machine("first");
  register(a.home, a.hub, "live-tracker", "LVT", WS_A);
  register(a.home, a.hub, "live-other", "LVO", WS_B);
  // A workspace with no identity, so the unpublishable report is exercised for real.
  const nameless = join(a.home, "ws", "live-nameless");
  mkdirSync(nameless, { recursive: true });
  writeFileSync(join(nameless, "staple.db"), "");
  a.hub.register({ slug: "live-nameless", prefix: "LVN", path: join(nameless, "staple.db"), kind: "repo" });

  const preview = buildConnectPreview({ home: a.home, repositoryId: hubId, endpoint });
  const connected = await connectHubRegistry(preview, {
    home: a.home,
    enrollmentSecret,
    credential: { forceFile: true },
  });
  console.log(
    safe({
      endpoint: connected.connection.endpoint,
      deviceId: connected.connection.deviceId,
      protocol: connected.connection.protocol,
      capabilities: connected.capabilities,
      // Every consent off, as a connect leaves them.
      consents: {
        auto: connected.connection.auto,
        backup: connected.connection.backup,
        registry: connected.connection.registry,
      },
    }),
  );

  step(2, "publish the registry (refused first, to prove the consent gates egress)");
  try {
    await publishRegistry(a.hub, a.home);
    console.error("!! published without consent — this is a bug");
    process.exit(1);
  } catch (error) {
    console.log(`refused: ${error instanceof Error ? error.message.slice(0, 120) : error}…`);
  }
  /**
   * The disclosure is RENDERED and then handed back, which is what `setRegistryConsent`
   * now requires when enabling. A script is a surface too, and it does not get an
   * exemption from showing what it is agreeing to.
   */
  console.log(registryDisclosure(endpoint));
  setRegistryConsent(a.home, hubId, true, REGISTRY_DISCLOSURE);
  const published = await publishRegistry(a.hub, a.home);
  console.log(
    safe({
      published: published.published,
      created: published.created,
      updated: published.updated,
      retracted: published.retracted,
      applied: published.applied,
      deduplicated: published.deduplicated,
      retained: published.retained.length,
      batches: published.batches,
      epoch: published.epoch,
      unpublishable: published.unpublishable.map((u) => u.entry.slug),
    }),
  );

  step(3, "GET /snapshot — read the registry back off the real service");
  const readBack = await readPublishedRegistry(a.home, hubId);
  console.log(safe(readBack.registry));

  step(4, "cross-links: publish, retract, and re-add — the half a delete could not do")
  /**
   * Registered ABSENT on purpose. `Hub.addCrossLink` only opens a workspace database when
   * the row is `available`, so absent rows let this script exercise the real cross-link
   * path — the content-derived key, the retraction, the re-add — without standing up two
   * workspaces with real issues in them. What is under test is the WIRE, not `addCrossLink`.
   */
  a.hub.registerAbsent({ slug: "live-edge-a", prefix: "LEA", kind: "repo", repositoryId: WS_C });
  a.hub.registerAbsent({ slug: "live-edge-b", prefix: "LEB", kind: "repo", repositoryId: WS_D });
  a.hub.addCrossLink("LEA-1", "LEB-2");
  const withEdge = await publishRegistry(a.hub, a.home);
  console.log(`published with edge: ${safe({ published: withEdge.published, applied: withEdge.applied, deduplicated: withEdge.deduplicated })}`);
  console.log(
    `service edges: ${safe((await readPublishedRegistry(a.home, hubId)).registry.crossLinks.map((l) => `${l.blockerIdentifier}->${l.blockedIdentifier}`))}`,
  );

  a.hub.removeCrossLink("LEA-1", "LEB-2");
  const retracted = await publishRegistry(a.hub, a.home);
  console.log(`retracted: ${safe({ published: retracted.published, retracted: retracted.retracted, applied: retracted.applied, deduplicated: retracted.deduplicated })}`);
  const afterRetract = (await readPublishedRegistry(a.home, hubId)).registry.crossLinks.length;
  console.log(`service edges after retract: ${afterRetract}`);

  /**
   * THE assertion this script exists to add. Under the `delete` verb the re-add produced
   * the same entity id, landed on a tombstone, and was discarded while the push reported
   * success — for ever. `present: false` makes it an ordinary field update.
   */
  a.hub.addCrossLink("LEA-1", "LEB-2");
  const readded = await publishRegistry(a.hub, a.home);
  console.log(`re-added: ${safe({ published: readded.published, applied: readded.applied, deduplicated: readded.deduplicated })}`);
  const afterReadd = (await readPublishedRegistry(a.home, hubId)).registry.crossLinks;
  console.log(`service edges after re-add: ${safe(afterReadd.map((l) => `${l.blockerIdentifier}->${l.blockedIdentifier}`))}`);
  const cycleOk = afterRetract === 0 && afterReadd.length === 1 && readded.deduplicated === 0;
  console.log(
    cycleOk
      ? "PASS — a cross-link survives remove-then-re-add against the real service"
      : `FAIL — retract left ${afterRetract}, re-add left ${afterReadd.length}, deduplicated ${readded.deduplicated}`,
  );

  step(5, "POST /backups — the fold, persisted");
  await setHubBackupConsent(a.home, hubId, true);
  const backup = await createHubBackup(a.home, hubId, "hub-registry-live");
  console.log(safe(backup));
  console.log(
    safe((await listHubBackups(a.home, hubId)).map((b) => ({ id: b.backupId, kind: b.kind, protocol: b.protocol }))),
  );
  a.hub.close();

  step(6, "a replacement machine adopts the registry it never had");
  const b = machine("replacement");
  await connectHubRegistry(
    buildConnectPreview({ home: b.home, repositoryId: hubId, endpoint }),
    { home: b.home, enrollmentSecret, credential: { forceFile: true } },
  );
  console.log(`before: ${safe(b.hub.list().map((r) => r.slug))}`);
  const adopted = await adoptPublishedRegistry(b.hub, b.home, { apply: true });
  console.log(
    safe({
      decisions: adopted.adoption.decisions.map((d) => ({ slug: d.entry.slug, outcome: d.outcome })),
      crossLinks: adopted.adoption.crossLinks,
      rows: b.hub.list().map((r) => ({ slug: r.slug, prefix: r.prefix, available: r.available })),
    }),
  );

  step(7, "publish damage, then restore the backup and adopt what comes back");
  setRegistryConsent(b.home, hubId, true, REGISTRY_DISCLOSURE);
  // The identity moves to a new slug — a real second write to one registration, and the
  // case that a content-addressed opId exists to let land.
  register(b.home, b.hub, "renamed-by-mistake", "RBM", WS_A);
  b.hub.recordRepositoryId("live-tracker", null);
  const damaged = await publishRegistry(b.hub, b.home);
  console.log(`damage published: ${safe({ published: damaged.published, updated: damaged.updated })}`);
  console.log(
    `service now says: ${safe((await readPublishedRegistry(b.home, hubId)).registry.workspaces.map((w) => w.slug))}`,
  );

  const c = machine("restorer");
  await connectHubRegistry(
    buildConnectPreview({ home: c.home, repositoryId: hubId, endpoint }),
    { home: c.home, enrollmentSecret, credential: { forceFile: true } },
  );
  await setHubBackupConsent(c.home, hubId, true);
  const restored = await restoreRegistry(c.hub, c.home, backup.backupId, { apply: true });
  console.log(
    safe({
      turns: restored.turns,
      fromEpoch: restored.fromEpoch,
      toEpoch: restored.toEpoch,
      entityCount: restored.entityCount,
      preRestoreBackupId: restored.preRestoreBackupId,
      registry: restored.registry.workspaces.map((w) => w.slug),
      decisions: restored.adoption.decisions.map((d) => ({ slug: d.entry.slug, outcome: d.outcome })),
      rows: c.hub.list().map((r) => r.slug),
    }),
  );

  step(8, "assertions");
  const slugs = restored.registry.workspaces.map((w) => w.slug).sort();
  // All four: the two named workspaces plus the two the cross-link cycle registered.
  const expected = ["live-edge-a", "live-edge-b", "live-other", "live-tracker"];
  const ok = JSON.stringify(slugs) === JSON.stringify(expected);
  console.log(ok ? `PASS — restored ${JSON.stringify(slugs)}` : `FAIL — got ${JSON.stringify(slugs)}, wanted ${JSON.stringify(expected)}`);
  /**
   * No path in what was PUSHED.
   *
   * The earlier version of this check serialized `restored.registry` — a
   * `HubRegistryPayload`, which has no path field at all, so `registryFromSnapshot` would
   * have dropped any path before the check ever saw it. It could not fail. The meaningful
   * subject is the operation batch this machine emitted, which is what actually left the
   * process, so that is what is checked here.
   */
  const { diffRegistry, publishedStateOf } = await import("../src/core/cloud/hub-registry-ops.js");
  const { exportRegistry } = await import("../src/core/cloud/hub-registry.js");
  const emitted = JSON.stringify(
    diffRegistry(exportRegistry(c.hub), publishedStateOf([])).operations,
  );
  const leaked = homes.filter((home) => emitted.includes(home));
  console.log(
    leaked.length === 0
      ? "PASS — no filesystem path in the operations this machine emits"
      : `FAIL — leaked ${leaked}`,
  );

  b.hub.close();
  c.hub.close();
  if (!ok || leaked.length > 0 || !cycleOk) process.exit(1);
}

main()
  .catch((error) => {
    console.error(`\nFAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  })
  .finally(() => {
    for (const home of homes) rmSync(home, { recursive: true, force: true });
  });
