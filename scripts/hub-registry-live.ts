/**
 * The hub registry leg, end to end, against a REAL deployed service.
 *
 * Not in the vitest suite, and deliberately: it makes real network calls and needs a
 * `repos` row that only an operator can create. It is committed because the one thing
 * neither test suite can prove is that the deployed Worker behaves like Miniflare and
 * like `FakeSyncServer` — and this epic has already produced four green suites that
 * proved nothing.
 *
 * It IS re-runnable against the same seeded hub id, and step 2 is where that is earned:
 * each run mints fresh identities, so the previous run's registrations are foreign to
 * this one and the scope refusal would stop the publish. Step 2 therefore performs the
 * escape the refusal names — `ignore` each identity this machine does not have — rather
 * than the header asserting repeatability the code did not have. It did not have it: a
 * second unmodified run used to exit 1 at step 2 before reaching a single assertion.
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
 * It publishes, adopts and RESTORES, so it refuses to run against this machine's own hub id
 * or against a workspace repository id — see `refuseRealHub`.
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
 * The script publishes, adopts and RESTORES — which rewinds the registry on the
 * service and affects every machine on that hub id. Pointed at a real hub by a copied
 * command line, it would do all of that to somebody's actual workspace list.
 */
function refuseRealHub(): void {
  const previous = process.env.STAPLE_HOME;
  delete process.env.STAPLE_HOME;
  try {
    /**
     * `openReadOnly`, NOT `open`. `Hub.open()` MIGRATES and converts the journal to WAL, so
     * the guard was creating `~/.staple/hub.db` on a machine that had none — a check with a
     * side effect on the thing it is protecting.
     */
    const hub = Hub.openReadOnly();
    const mine = hub.storedHubId();
    /**
     * Also refuse a WORKSPACE's `repositoryId`. The hub id travels by hand next to
     * repository ids, so a mispaste is ordinary — and pushing registry operations into a
     * workspace's log is precisely the incident `worker/README.md`'s recipe exists to clean
     * up. Cheaper to refuse here than to document the cleanup and then cause it.
     */
    const asWorkspace = hub.findByRepositoryId(hubId);
    hub.close();
    if (asWorkspace !== undefined) {
      console.error(
        `STAPLE_HUB_ID is the sync identity of the workspace "${asWorkspace.slug}" on this ` +
          "machine, not a hub id. Publishing registry operations into a workspace's log " +
          "permanently 426s every protocol-1 client of it. Nothing was sent.",
      );
      process.exit(2);
    }
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
/**
 * Leave behind what an EARLIER RUN of this script published, the way the product says to.
 *
 * Every run mints fresh temporary homes and therefore fresh `repositoryId`s, so on any run
 * after the first the service holds registrations this machine has neither got nor opted
 * out of — which is exactly what `dd29ef2`'s scope refusal refuses. The header used to
 * claim the script was re-runnable and it was not: run two exited 1 before any assertion.
 *
 * This is called before EVERY publish rather than once, and that is not defensiveness — the
 * first version of this fix guarded only step 2, and run two then failed at the replacement
 * machine's publish instead, where an earlier run's `live-other` also collides on prefix so
 * adoption parks it rather than adopting it. Measured, by running the script twice; the
 * one-call version would have shipped with the same false "re-runnable" claim one step
 * further along.
 *
 * It sends nothing: `registry_optouts` is local, and the read it does is a snapshot GET the
 * publish would have made anyway.
 */
async function ignoreEarlierRuns(
  c: { home: string; hub: Hub },
  hubId: string,
  label: string,
): Promise<void> {
  const held = await readPublishedRegistry(c.home, hubId, { fetchImpl: recordingFetch });
  const mine = new Set(
    c.hub.list().map((r) => r.repositoryId).filter((id): id is string => id !== null),
  );
  const strangers = held.registry.workspaces
    .filter((w) => w.repositoryId !== null && !mine.has(w.repositoryId))
    .map((w) => ({ repositoryId: w.repositoryId as string, slug: w.slug }));
  for (const s of strangers) c.hub.addOptOut(s.repositoryId, s.slug, "ignored");
  console.log(
    strangers.length === 0
      ? `${label}: no earlier run's entries on this hub id; publishing directly`
      : `${label}: ignored ${strangers.length} entr(ies) from an earlier run, the way the ` +
        `refusal says to: ${JSON.stringify(strangers.map((s) => s.slug))}`,
  );
}

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
    throw new Error("published without consent — this is a bug");
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

  /**
   * A PREVIOUS RUN'S registrations are foreign to this one, and clearing them is a step.
   *
   * The header claimed this script was re-runnable and it was not: every run mints fresh
   * temporary homes and therefore fresh `repositoryId`s, so on the second run the service
   * holds four registrations this machine has neither got nor opted out of — which is
   * exactly what the scope refusal added in `dd29ef2` refuses. A second unmodified run
   * exited 1 at this step, before any assertion, with *"The service holds 4 workspace
   * entries this machine does not have"*. Both the header's "re-runnable" and step 8's
   * superset justification were written before that refusal landed and were false after it.
   *
   * Rather than delete the claim, the script now does what the refusal tells a person to
   * do: `ignore` each identity it does not have. That makes the run genuinely repeatable
   * AND turns the documented escape into something this script proves live, which it did
   * not before. It is additive, local, and sends nothing.
   */
  await ignoreEarlierRuns(a, hubId, "first machine");

  const published = await publishRegistry(a.hub, a.home, { fetchImpl: recordingFetch });
  console.log(
    safe({
      published: published.published,
      created: published.created,
      updated: published.updated,
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

  step(4, "cross-links: additive-only, and a local removal does NOT propagate");
  /**
   * REWRITTEN. This step used to publish an edge, `removeCrossLink` it, publish again, and
   * assert the service showed zero edges — a claim about retraction, which no longer exists.
   * At the previous head it failed deterministically (`afterRetract` 1, exit 1), so the
   * "live-verified" claim for that commit was not true. The step was written from the design
   * of an earlier round and never re-run against the code it was describing.
   *
   * What it asserts now is the behaviour that IS there: an edge publishes, a local removal
   * emits nothing and leaves the service unchanged, and the removal is REPORTED to the
   * person who made it rather than silently dropped.
   *
   * Registered ABSENT on purpose: `Hub.addCrossLink` only opens a workspace database when the
   * row is `available`, so absent rows exercise the real cross-link path — the content-derived
   * key, the fold, the backup, the restore — without two more workspaces carrying real issues.
   */
  a.hub.registerAbsent({ slug: "live-edge-a", prefix: "LEA", kind: "repo", repositoryId: WS_C });
  a.hub.registerAbsent({ slug: "live-edge-b", prefix: "LEB", kind: "repo", repositoryId: WS_D });
  a.hub.addCrossLink("LEA-1", "LEB-2");
  const withEdge = await publishRegistry(a.hub, a.home, { fetchImpl: recordingFetch });
  console.log(
    `published with edge: ${safe({ published: withEdge.published, applied: withEdge.applied, deduplicated: withEdge.deduplicated })}`,
  );
  const edgesAfterPublish = (
    await readPublishedRegistry(a.home, hubId, { fetchImpl: recordingFetch })
  ).registry.crossLinks.map((l) => `${l.blockerIdentifier}->${l.blockedIdentifier}`);
  console.log(`service edges: ${safe(edgesAfterPublish)}`);

  a.hub.removeCrossLink("LEA-1", "LEB-2");
  const afterRemoval = await publishRegistry(a.hub, a.home, { fetchImpl: recordingFetch });
  const edgesAfterRemoval = (
    await readPublishedRegistry(a.home, hubId, { fetchImpl: recordingFetch })
  ).registry.crossLinks.length;
  console.log(
    `after local removal: ${safe({
      published: afterRemoval.published,
      retained: afterRemoval.retained.length,
      serviceEdges: edgesAfterRemoval,
    })}`,
  );
  const additiveOnly =
    edgesAfterPublish.length === 1 &&
    afterRemoval.published === 0 &&
    edgesAfterRemoval === 1 &&
    afterRemoval.retained.length === 1 &&
    afterRemoval.retained[0]!.reason.includes("does not propagate");
  console.log(
    additiveOnly
      ? "PASS — the edge published, the local removal sent nothing, the service kept it, and " +
          "the removal was reported"
      : `FAIL — published=${afterRemoval.published} serviceEdges=${edgesAfterRemoval} ` +
          `retained=${afterRemoval.retained.length}`,
  );

  // Re-adding locally is a no-op against the service, because it never left.
  a.hub.addCrossLink("LEA-1", "LEB-2");
  const afterReadd = await publishRegistry(a.hub, a.home, { fetchImpl: recordingFetch });
  console.log(
    `after re-adding locally: ${safe({ published: afterReadd.published, upToDate: afterReadd.upToDate })}`,
  );
  const readdClean = afterReadd.published === 0 && afterReadd.upToDate;
  console.log(
    readdClean
      ? "PASS — re-adding converges to zero operations rather than churning the log"
      : `FAIL — re-add published ${afterReadd.published}`,
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
  /**
   * ASSERTED, which it was not before — step 6 is the ticket's actual acceptance criterion
   * (a replacement machine learns what the lost one had) and it previously only failed by
   * accident at step 7.
   */
  const adoptedSlugs = b.hub.list().map((r) => r.slug).sort();
  const adoptOk =
    adoptedSlugs.length === 4 &&
    adoptedSlugs.join(",") === "live-edge-a,live-edge-b,live-other,live-tracker" &&
    b.hub.list().every((r) => r.repositoryId !== null) &&
    adopted.adoption.dryRun === false;
  console.log(
    adoptOk
      ? `PASS — the replacement machine adopted all four rows with identities: ${safe(adoptedSlugs)}`
      : `FAIL — adopted ${safe(adoptedSlugs)} dryRun=${adopted.adoption.dryRun}`,
  );
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
  /**
   * ONE row holds the identity, under a new name.
   *
   * The first version added a second row with the same `repositoryId`, which the
   * duplicate-identity rule now correctly parks — so `damage published: 0` and the restore
   * assertion below passed against no damage at all. That is the vacuous-assertion class
   * this whole review keeps finding, so the step now asserts the damage LANDED.
   */
  b.hub.unregister("live-tracker");
  b.hub.registerAbsent({
    slug: "renamed-by-mistake",
    prefix: "RBM",
    kind: "repo",
    repositoryId: trackerId,
  });
  await ignoreEarlierRuns(b, hubId, "replacement machine");
  const damaged = await publishRegistry(b.hub, b.home, { fetchImpl: recordingFetch });
  console.log(`damage published: ${safe({ published: damaged.published, updated: damaged.updated })}`);
  if (damaged.published === 0) {
    throw new Error(
      "the damage step published nothing, so the restore assertion below would pass against " +
        "an unchanged service. Refusing to report a pass on that.",
    );
  }
  console.log(
    `service now says: ${safe((await readPublishedRegistry(b.home, hubId, { fetchImpl: recordingFetch })).registry.workspaces.map((w) => w.slug))}`,
  );

  const c = machine("restorer");
  await connectHubRegistry(
    buildConnectPreview({ home: c.home, repositoryId: hubId, endpoint }),
    { home: c.home, enrollmentSecret, credential: { forceFile: true } },
  );
  await setHubBackupConsent(c.home, hubId, true);
  /**
   * BOTH consents. A restore mutates the published registry, so it is behind the publish
   * consent as well as the backup one — it used to need only `backup`, which meant
   * `publish --disable` left a machine able to replace everything on the service.
   */
  setRegistryConsent(c.home, hubId, true, REGISTRY_DISCLOSURE);
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
  /**
   * Keyed on IDENTITY, not on slug presence.
   *
   * The superset check alone gutted this step in the very re-run case that motivated it: a
   * previous run's registration survives under slug `live-tracker`, so a restore that
   * silently failed to rewind THIS run's `renamed-by-mistake` would still find the slug
   * present and pass. The registration `entityId` IS the `repositoryId`, so asking what
   * slug THIS run's identity carries is unambiguous whatever else is in the log.
   */
  const trackerSlugNow = restored.registry.workspaces.find((w) => w.repositoryId === trackerId)?.slug;
  const rewound = trackerSlugNow === "live-tracker";
  console.log(
    rewound
      ? "PASS — the restore rewound this run's identity back to live-tracker"
      : `FAIL — this run's identity reads as "${String(trackerSlugNow)}", so the restore did not rewind it`,
  );
  const missing = expected.filter((slug) => !slugs.includes(slug));
  const ok = missing.length === 0 && rewound;
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
    throw new Error("captured no push body, so the path assertion proves nothing");
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
  if (!ok || leaked.length > 0 || !additiveOnly || !readdClean || !adoptOk || !realIdsTravelled) {
    throw new Error("one or more assertions failed — see the FAIL lines above");
  }
}

/**
 * Clean up first, THEN exit — and set `exitCode` rather than calling `process.exit`.
 *
 * The previous shape was `.catch(… process.exit(1)).finally(cleanup)`, and it printed
 * `FAILED: …` while the shell saw **exit 0**: `process.exit` inside the `catch` did not win
 * against the pending `finally`, so the failing status was lost. A proof script that reports a
 * failure and exits 0 is the worst possible version of this file — every caller, including a
 * future CI job, would read it as a pass.
 */
main()
  .then(() => 0)
  .catch((error) => {
    console.error(`\nFAILED: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  })
  .then((code) => {
    for (const home of homes) rmSync(home, { recursive: true, force: true });
    process.exitCode = code;
  });
