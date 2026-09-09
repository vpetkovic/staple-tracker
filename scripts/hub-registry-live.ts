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

/**
 * Refuse to run against a hub id that this machine's own hub is using.
 *
 * The script publishes, retracts edges and RESTORES — which rewinds the registry on the
 * service and affects every machine on that hub id. Pointed at a real hub by a copied
 * command line, it would do all of that to somebody's actual workspace list.
 */
function refuseRealHub(): void {
  const previous = process.env.STAPLE_HOME;
  delete process.env.STAPLE_HOME;
  try {
    const hub = Hub.open();
    const mine = hub.storedHubId();
    hub.close();
    if (mine === hubId) {
      console.error(
        `STAPLE_HUB_ID is this machine's REAL hub identity. This script publishes, retracts ` +
          "and restores, so it will not run against it. Provision a throwaway hub id and use " +
          "that. Nothing was sent.",
      );
      process.exit(2);
    }
  } catch {
    // No hub on this machine at all. Nothing to protect.
  } finally {
    if (previous === undefined) delete process.env.STAPLE_HOME;
    else process.env.STAPLE_HOME = previous;
  }
}
refuseRealHub();

const homes: string[] = [];

/**
 * Every request body this process actually sent, captured at the transport.
 *
 * The path assertion at the end used to serialise `diffRegistry(exportRegistry(...))`,
 * which cannot contain a path for ANY input — `RegistryEntry` has no path field, so
 * `exportRegistry` has already dropped it. The tautology moved one function earlier when
 * it was "fixed" rather than being removed.
 *
 * The only honest subject is what left the process. This wraps the global `fetch`, so the
 * bytes inspected are the bytes the deployed Worker received, from the machine whose hub
 * rows carry REAL absolute paths.
 */
const sentBodies: string[] = [];
const recordingFetch: typeof fetch = async (input, init) => {
  if (typeof init?.body === "string") sentBodies.push(init.body);
  return globalThis.fetch(input as Parameters<typeof fetch>[0], init);
};

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

/**
 * A workspace brought up the way a person brings one up.
 *
 * `initWorkspace` is what `staple init` calls. It creates the database, registers the hub
 * row, reconciles the identity from the manifest and records it on that row — and there is
 * **no `hub.recordRepositoryId` call anywhere in this script**, deliberately.
 *
 * The previous version wrote that column by hand, so the whole live proof was of a column
 * nothing populated: `workspaces.repository_id` had no writer on any user-facing path, and
 * on a real machine `publish` uploaded an empty registry. The script being green was the
 * evidence that hid it. Returns the identity `initWorkspace` established, so the
 * assertions can check the wire carried the real one.
 */
function register(home: string, slug: string): string {
  const dir = join(home, "ws", slug);
  mkdirSync(dir, { recursive: true });
  const opened = initWorkspace({ dir, slug, kind: "repo" });
  opened.store.db.close();
  return opened.repository.repositoryId;
}

function step(n: number, what: string): void {
  console.log(`\n=== ${n}. ${what}`);
}

/** Redact the hub id out of anything printed, so a paste of the output is safe. */
function safe(value: unknown): string {
  return JSON.stringify(value, null, 2).replaceAll(hubId, "<hub id>");
}

async function main(): Promise<void> {
  // Only the two ABSENT rows need invented ids; the real workspaces get theirs from
  // `initWorkspace`, which is the whole point of this script no longer faking the column.
  const WS_C = "cccccccc-0000-4000-8000-000000000003";
  const WS_D = "dddddddd-0000-4000-8000-000000000004";

  step(1, "connect the hub as a repository");
  const a = machine("first");
  const trackerId = register(a.home, "live-tracker");
  const otherId = register(a.home, "live-other");
  console.log(
    `identities recorded by initWorkspace: ${safe([trackerId.slice(0, 8), otherId.slice(0, 8)])}`,
  );
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
    await publishRegistry(a.hub, a.home, { fetchImpl: recordingFetch });
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
  const published = await publishRegistry(a.hub, a.home, { fetchImpl: recordingFetch });
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
  const readBack = await readPublishedRegistry(a.home, hubId, { fetchImpl: recordingFetch });
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
  /**
   * These two are `registerAbsent`, which is the one legitimate writer of the column on a
   * real path — it is how a restore lands a row for a workspace this machine does not have.
   * They exist so `addCrossLink` has two registered slugs to join without needing two more
   * workspace databases; the two ABOVE are the ones that prove the ordinary path works.
   */
  a.hub.addCrossLink("LEA-1", "LEB-2");
  const withEdge = await publishRegistry(a.hub, a.home, { fetchImpl: recordingFetch });
  console.log(`published with edge: ${safe({ published: withEdge.published, applied: withEdge.applied, deduplicated: withEdge.deduplicated })}`);
  console.log(
    `service edges: ${safe((await readPublishedRegistry(a.home, hubId, { fetchImpl: recordingFetch })).registry.crossLinks.map((l) => `${l.blockerIdentifier}->${l.blockedIdentifier}`))}`,
  );

  a.hub.removeCrossLink("LEA-1", "LEB-2");
  const retracted = await publishRegistry(a.hub, a.home, { fetchImpl: recordingFetch });
  console.log(`retracted: ${safe({ published: retracted.published, retracted: retracted.retracted, applied: retracted.applied, deduplicated: retracted.deduplicated })}`);
  const afterRetract = (await readPublishedRegistry(a.home, hubId, { fetchImpl: recordingFetch })).registry.crossLinks.length;
  console.log(`service edges after retract: ${afterRetract}`);

  /**
   * THE assertion this script exists to add. Under the `delete` verb the re-add produced
   * the same entity id, landed on a tombstone, and was discarded while the push reported
   * success — for ever. `present: false` makes it an ordinary field update.
   */
  a.hub.addCrossLink("LEA-1", "LEB-2");
  const readded = await publishRegistry(a.hub, a.home, { fetchImpl: recordingFetch });
  console.log(`re-added: ${safe({ published: readded.published, applied: readded.applied, deduplicated: readded.deduplicated })}`);
  const afterReadd = (await readPublishedRegistry(a.home, hubId, { fetchImpl: recordingFetch })).registry.crossLinks;
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
  /**
   * The damage: machine B publishes a DIFFERENT name for the same repository. Registered
   * absent under the identity machine A recorded, which is what a second machine holding a
   * clone under another directory name looks like.
   */
  b.hub.registerAbsent({
    slug: "renamed-by-mistake",
    prefix: "RBM",
    kind: "repo",
    repositoryId: trackerId,
  });
  const damaged = await publishRegistry(b.hub, b.home, { fetchImpl: recordingFetch });
  console.log(`damage published: ${safe({ published: damaged.published, updated: damaged.updated })}`);
  console.log(
    `service now says: ${safe((await readPublishedRegistry(b.home, hubId, { fetchImpl: recordingFetch })).registry.workspaces.map((w) => w.slug))}`,
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
  /**
   * A SUPERSET check, because this script is re-runnable and each run mints new identities.
   *
   * Every run creates fresh temporary homes, so `initWorkspace` mints new `repositoryId`s
   * and publishes new `registration` entities into the same hub log. Two runs against one
   * seeded hub id therefore leave two registrations per slug — which is correct behaviour
   * (they ARE different repositories) and made an equality assertion fail on the second
   * run. Asserting the slugs this run created are PRESENT keeps the script honest without
   * requiring a freshly provisioned hub id every time.
   */
  const slugs = [...new Set(restored.registry.workspaces.map((w) => w.slug))].sort();
  const expected = ["live-edge-a", "live-edge-b", "live-other", "live-tracker"];
  // The identities on the wire are the ones initWorkspace established, not invented ones.
  const publishedIds = restored.registry.workspaces.map((w) => w.repositoryId);
  const realIdsTravelled = publishedIds.includes(trackerId) && publishedIds.includes(otherId);
  console.log(realIdsTravelled ? "PASS — the identities initWorkspace recorded are the ones published" : "FAIL — published ids do not match what initWorkspace recorded");
  const missing = expected.filter((slug) => !slugs.includes(slug));
  const ok = missing.length === 0;
  console.log(
    ok
      ? `PASS — restored every slug this run published ${JSON.stringify(expected)}`
      : `FAIL — missing ${JSON.stringify(missing)} from ${JSON.stringify(slugs)}`,
  );
  /**
   * No path in what was PUSHED.
   *
   * The earlier version of this check serialized `restored.registry` — a
   * `HubRegistryPayload`, which has no path field at all, so `registryFromSnapshot` would
   * have dropped any path before the check ever saw it. It could not fail. The meaningful
   * subject is the operation batch this machine emitted, which is what actually left the
   * process, so that is what is checked here.
   */
  /**
   * The REQUEST BODIES, not a payload type that structurally cannot hold a path.
   *
   * Machine `a` is the one whose hub rows carry real absolute paths — `register()` writes
   * `join(home, "ws", slug, "staple.db")` — so its pushes are the meaningful subject. The
   * assertion can fail: if `RegistrationPayload` ever grew a path field, or if a slug were
   * built from a path, these bytes would contain `homes[0]`.
   */
  const pushed = sentBodies.filter((body) => body.includes('"registration"'));
  if (pushed.length === 0) {
    console.log("FAIL — captured no push body, so the path assertion proves nothing");
    process.exit(1);
  }
  const leaked = homes.filter((home) => sentBodies.some((body) => body.includes(home)));
  console.log(
    leaked.length === 0
      ? `PASS — no filesystem path in ${sentBodies.length} request bodies actually sent ` +
          `(${pushed.length} carrying registrations)`
      : `FAIL — leaked ${leaked}`,
  );

  b.hub.close();
  c.hub.close();
  if (!ok || leaked.length > 0 || !cycleOk || !realIdsTravelled) process.exit(1);
}

main()
  .catch((error) => {
    console.error(`\nFAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  })
  .finally(() => {
    for (const home of homes) rmSync(home, { recursive: true, force: true });
  });
