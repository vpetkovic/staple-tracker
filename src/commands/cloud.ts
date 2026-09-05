/**
 * `staple cloud` — the connection and credential lifecycle (STA-71).
 *
 *   cloud [status] [--refresh] [--json]
 *   cloud connect --endpoint <url> --token <secret> [--label L] [--yes]
 *                 [--credential-file] [--json]
 *   cloud sync [--pull-limit N] [--json]
 *   cloud disconnect [--yes] [--json]
 *   cloud auto <on|off> [--json]
 *   cloud devices [ls] [--json]
 *   cloud devices revoke <deviceId> [--yes] [--json]
 *   cloud purge --confirm <repositoryId> [--json]
 *
 * ## Three consents, three commands, and none of them implies another
 *
 * `connect` stores a credential. `auto on` agrees to use it without being asked
 * each time. `backup enable` agrees to a third thing entirely. Connecting does
 * not turn on automatic sync, turning automatic sync off does not disconnect,
 * and disconnecting does not delete anything on the server. Every one of those
 * sentences is a test.
 *
 * ## Why `disconnect` and `purge` are different commands and not a flag
 *
 * *"Conflating them is the most expensive mistake available here."* A flag like
 * `disconnect --purge` puts an irreversible remote deletion one keystroke away
 * from a routine local operation, and shell history plus a fast finger is all it
 * takes. They are separate verbs, `purge` demands the repository id typed back,
 * and it prints what is stored and who can read it before it will accept that.
 *
 * ## Which of these can talk to the network
 *
 * `connect` (after consent), `sync`, `devices`, `devices revoke`, `purge`, and
 * `status` ONLY with `--refresh`. Everything else — plain `status`,
 * `disconnect`, `auto` — is local files and nothing else, and
 * `test/network-silence.test.ts` asserts it with real spies rather than trusting
 * this paragraph.
 *
 * `sync` is the ONLY one of those that a human runs as part of ordinary work,
 * and it is deliberately a verb they have to type. Manual is the default and
 * stays the default; automatic mode is a separate consent and a separate lane.
 */
import { parseArgs } from "node:util";
import { dirname } from "node:path";
import { stapleHome } from "../config/home.js";
import { readRepositoryManifest } from "../core/repo-identity.js";
import { resolveWorkspace } from "../core/workspace.js";
import { StapleError, errorEnvelope } from "../core/types.js";
import { confirm, isInteractive } from "../onboarding/prompts.js";
import { setConsent } from "../core/cloud/connection.js";
import {
  fetchDevices,
  performConnect,
  performDisconnect,
  performPurge,
  performRevoke,
  retentionDisclosure,
} from "../core/cloud/connect.js";
import { buildConnectPreview, renderConnectPreview } from "../core/cloud/preview.js";
import { syncRepository, type SyncReport } from "../core/cloud/sync.js";
import { describeState, localCloudStatus, refreshCloudStatus, type CloudStatus } from "../core/cloud/status.js";

const USAGE = "Use: status, connect, disconnect, auto, devices, purge (staple cloud --help)";

const HELP = `staple cloud — connect this repository to a sync service, and manage the
credential that connection produces. Three separate consents: connecting,
synchronizing automatically, and backing up. None of them implies another.

  cloud [status] [--refresh] [--json]
              what this MACHINE's relationship to the cloud is. Local and
              silent by default: it reads three files and makes no request.
              --refresh is the only form that contacts the endpoint, and it is
              what tells offline from revoked from a rejected credential.
  cloud connect --endpoint <url> --token <secret> [--label L] [--yes]
                [--credential-file]
              show what is about to happen, then do it once you agree.
              --token is the ENROLLMENT credential: this repository's
              enrollment secret for the first machine, or an existing device
              token from a machine that is already connected. Repositories are
              provisioned out of band. Without --yes and without a terminal it
              prints the preview, exits 2, and sends nothing.
              A successful connection leaves automatic sync OFF.
  cloud disconnect [--yes]
              remove this device's credential and stop all later cloud
              traffic. LOCAL ONLY: your database, your pending operations and
              the remote state are all untouched, and other devices are
              unaffected. Makes no network call, so it works offline.
  cloud sync
              synchronize NOW: push what this device has journaled, then apply
              what the others have. The only thing that moves data in manual
              mode, which is the default and stays the default. A first run on
              a fresh clone hydrates the database from a snapshot; an
              interrupted run resumes where it stopped. Your local database
              stays the only read and write path for every other command.
  cloud auto on|off
              this DEVICE's consent to synchronize without being asked. Stored
              per-machine, because consent given on a laptop is not consent
              given on a build box. Off does not disconnect.
  cloud devices [ls]
              every device registered to this repository, as the server sees
              it. The server is the authority; the local cache is not.
  cloud devices revoke <deviceId> [--yes]
              end that device's access, server-side, effective on its very next
              request. Other devices are undisturbed. This is NOT disconnect:
              revoking is about a device you may not be holding.
  cloud purge --confirm <repositoryId>
              DESTROY the repository's remote state. Separately named because
              it is not disconnecting. Prints what is stored, for how long and
              who can read it, and then requires the repository id typed back.
              Never touches your local database. Not reversible.`;

/** cli.ts owns the real table; this is the subset an async command can reach. */
const EXIT_CODES: Record<string, number> = { validation: 2, not_found: 3, conflict: 4 };

/**
 * Route an async failure through the same envelope the synchronous commands get.
 *
 * `main()` in cli.ts is synchronous and its `try/catch` cannot see a rejected
 * promise, so an async command that let one escape would print an
 * `UnhandledPromiseRejection` and exit 1 — losing the code, the message and the
 * retry bit that every other surface agrees on. This is the price of being the
 * first async command in the tree, and it is paid here rather than by making
 * cli.ts async underneath thirty commands that are fine as they are.
 */
function settle(work: Promise<void>, json: boolean): void {
  void work.catch((error: unknown) => {
    const envelope = errorEnvelope(error);
    if (json) {
      console.error(JSON.stringify(envelope));
    } else if (error instanceof StapleError) {
      console.error(`error(${error.code}): ${error.message}`);
    } else {
      console.error(error);
    }
    process.exitCode = EXIT_CODES[envelope.code] ?? 1;
  });
}

/**
 * This workspace's repository id, from the git-recoverable manifest.
 *
 * The manifest rather than `sync_state`, for the reason `repo-identity.ts`
 * gives: on a fresh clone the manifest is the only copy, and it is the one a
 * human can see in a diff. The database handle is opened to locate the
 * workspace and closed immediately — nothing here reads a domain table.
 */
function repositoryIdFor(options: { db?: string; ws?: string }): string {
  const opened = resolveWorkspace(options);
  const workspaceDir = dirname(opened.dbPath);
  try {
    const manifest = readRepositoryManifest(workspaceDir);
    if (!manifest) {
      throw new StapleError(
        "not_found",
        `This workspace has no ${workspaceDir}/repository.json, so it has no sync identity. ` +
          `Repository identity is minted for repo-local workspaces by \`staple init\`; a global ` +
          `workspace has none and cannot be connected.`,
      );
    }
    return manifest.repositoryId;
  } finally {
    opened.store.db.close();
  }
}

function renderStatus(status: CloudStatus): string {
  const lines = [describeState(status)];
  lines.push("");
  lines.push(`  repository     ${status.repositoryId}`);
  if (status.endpoint) lines.push(`  service        ${status.endpoint}`);
  if (status.deviceId) lines.push(`  device         ${status.deviceId}${status.label ? `  (${status.label})` : ""}`);
  if (status.credentialMechanism) {
    lines.push(
      `  credential     ${status.credentialMechanism}${status.credentialPresent ? "" : "  — NOT FOUND"}`,
    );
  }
  if (status.state !== "disconnected") {
    lines.push(`  automatic sync ${status.auto ? "on" : "off"}`);
    lines.push(`  backup         ${status.backup ? "on" : "off"}`);
    lines.push(`  connected at   ${status.connectedAt}`);
  }
  lines.push(`  checked        ${status.checked ? "just now, against the endpoint" : "local files only (--refresh to ask the endpoint)"}`);
  if (status.state === "disconnected") {
    lines.push("");
    lines.push("  Connect with: staple cloud connect --endpoint <url> --token <secret>");
  }
  for (const warning of status.warnings) {
    lines.push("");
    lines.push(`  ! ${warning}`);
  }
  if (status.devices) {
    lines.push("");
    for (const device of status.devices) {
      const marks = [device.self ? "this device" : null, device.revokedAt !== null ? "revoked" : null]
        .filter(Boolean)
        .join(", ");
      lines.push(`  ${device.deviceId}  ${device.label ?? "(no label)"}${marks ? `  [${marks}]` : ""}`);
    }
  }
  return lines.join("\n");
}

export function runCloudCommand(argv: string[]): void {
  if (argv[0] === "--help" || argv[0] === "help") {
    console.log(HELP);
    return;
  }

  const sub = argv[0] && !argv[0].startsWith("-") ? argv[0] : "status";
  const rest = argv[0] && !argv[0].startsWith("-") ? argv.slice(1) : argv;

  switch (sub) {
    case "status":
      return runStatus(rest);
    case "connect":
      return runConnect(rest);
    case "disconnect":
      return runDisconnect(rest);
    case "auto":
      return runAuto(rest);
    case "sync":
      return runSync(rest);
    case "devices":
      return runDevices(rest);
    case "purge":
      return runPurge(rest);
    default:
      throw new StapleError("validation", `Unknown subcommand "${sub}". ${USAGE}`);
  }
}

const common = { db: { type: "string" as const }, ws: { type: "string" as const }, json: { type: "boolean" as const } };

function runStatus(argv: string[]): void {
  const { values } = parseArgs({ args: argv, options: { ...common, refresh: { type: "boolean" } } });
  const json = values.json === true;
  const home = stapleHome();
  const repositoryId = repositoryIdFor(values);

  if (values.refresh !== true) {
    // The silent path. No await, no client import reached, no request.
    const status = localCloudStatus(home, repositoryId);
    console.log(json ? JSON.stringify(status, null, 2) : renderStatus(status));
    return;
  }

  settle(
    refreshCloudStatus(home, repositoryId).then((status) => {
      console.log(json ? JSON.stringify(status, null, 2) : renderStatus(status));
    }),
    json,
  );
}

function runConnect(argv: string[]): void {
  const { values } = parseArgs({
    args: argv,
    options: {
      ...common,
      endpoint: { type: "string" },
      token: { type: "string" },
      label: { type: "string" },
      yes: { type: "boolean" },
      "credential-file": { type: "boolean" },
    },
  });
  const json = values.json === true;
  const home = stapleHome();
  const repositoryId = repositoryIdFor(values);

  if (!values.endpoint) {
    throw new StapleError(
      "validation",
      "usage: staple cloud connect --endpoint <url> --token <secret>. The endpoint is the sync " +
        "service this repository will be connected to; nothing is contacted until you agree to it.",
    );
  }

  /**
   * The preview is built and shown before ANYTHING else. `buildConnectPreview`
   * cannot make a network call — it does not import the client — so this is not
   * an ordering that has to be maintained by care.
   */
  const preview = buildConnectPreview({
    home,
    repositoryId,
    endpoint: values.endpoint,
    label: values.label,
    credential: { forceFile: values["credential-file"] === true },
  });

  if (json) {
    // A script's preview. Same promise, machine-readable, still no request made.
    console.log(JSON.stringify({ preview: { ...preview, endpoint: preview.endpoint.origin } }, null, 2));
  } else {
    console.log(renderConnectPreview(preview));
  }

  /**
   * Consent. `--yes` is consent given in advance; a terminal gets asked. With
   * neither, the command PREVIEWS and exits 2 — the same shape `add`,
   * `discover`, `install` and `migrate` already use — and no request has been
   * made at the moment it exits. `confirm`'s default is false, so a piped stdin
   * refuses rather than blocking or assuming.
   */
  if (values.yes !== true) {
    const agreed = isInteractive() && confirm("\nConnect this repository?", { default: false });
    if (!agreed) {
      console.error(
        isInteractive()
          ? "\nDeclined. Nothing was sent, and no credential or setting was written."
          : "\nNothing was sent. Re-run with --yes to connect.",
      );
      process.exitCode = 2;
      return;
    }
  }

  if (!values.token) {
    throw new StapleError(
      "validation",
      "--token is required: this repository's enrollment secret for the first machine, or an " +
        "existing device token from a machine that is already connected. Repositories are " +
        "provisioned out of band, and an unknown repository is refused rather than created.",
    );
  }

  settle(
    performConnect(preview, {
      home,
      enrollmentSecret: values.token,
      credential: { forceFile: values["credential-file"] === true },
    }).then((outcome) => {
      if (json) {
        // The connection record, which by construction has no token in it.
        console.log(JSON.stringify({ connection: outcome.connection, capabilities: outcome.capabilities }, null, 2));
        return;
      }
      console.log("");
      console.log(`Connected to ${outcome.connection.endpoint}.`);
      console.log(`  device       ${outcome.connection.deviceId}  (${outcome.connection.label})`);
      console.log(`  credential   stored in ${outcome.credentialLocation}`);
      console.log("");
      console.log("Automatic sync is OFF. Nothing leaves this machine until you run `staple cloud sync`.");
      console.log("Turn it on for THIS device with `staple cloud auto on`.");
    }),
    json,
  );
}

function runDisconnect(argv: string[]): void {
  const { values } = parseArgs({ args: argv, options: { ...common, yes: { type: "boolean" } } });
  const json = values.json === true;
  const home = stapleHome();
  const repositoryId = repositoryIdFor(values);
  const status = localCloudStatus(home, repositoryId);

  if (status.state === "disconnected") {
    const message = "This repository is not connected on this machine. Nothing to do.";
    console.log(json ? JSON.stringify({ wasConnected: false }) : message);
    return;
  }

  if (values.yes !== true) {
    console.log(`Disconnect this repository from ${status.endpoint}.`);
    console.log("");
    console.log("  - this device's credential is removed from this machine");
    console.log("  - no later command contacts that service");
    console.log("  - your local database is untouched, INCLUDING pending unsent operations");
    console.log("  - the remote state is untouched and other devices are unaffected");
    console.log("  - to destroy the remote state instead, that is `staple cloud purge`");
    if (!(isInteractive() && confirm("\nDisconnect?", { default: false }))) {
      console.error(isInteractive() ? "\nDeclined. Still connected." : "\nRe-run with --yes to disconnect.");
      process.exitCode = 2;
      return;
    }
  }

  const outcome = performDisconnect(home, repositoryId);
  if (json) {
    console.log(JSON.stringify(outcome));
    return;
  }
  console.log("Disconnected. Local state, including pending operations, is unchanged.");
  if (!outcome.credentialRemoved) {
    console.log(
      `! The ${status.credentialMechanism} store would not release the credential. The connection ` +
        `record is gone so nothing will use it, but remove it by hand and consider revoking this ` +
        `device from a machine that is still connected.`,
    );
  }
}

function runAuto(argv: string[]): void {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: common });
  const choice = positionals[0];
  if (choice !== "on" && choice !== "off") {
    throw new StapleError("validation", "usage: staple cloud auto on|off");
  }
  const home = stapleHome();
  const repositoryId = repositoryIdFor(values);
  const connection = setConsent(home, repositoryId, { auto: choice === "on" });

  if (values.json === true) {
    console.log(JSON.stringify({ auto: connection.auto, repositoryId, deviceId: connection.deviceId }));
    return;
  }
  console.log(
    choice === "on"
      ? "Automatic sync is ON for THIS device only. Other devices are unchanged; each one decides for itself."
      : "Automatic sync is OFF for this device. Still connected — `staple cloud sync` works, nothing runs on its own.",
  );
}

/**
 * `staple cloud sync` — the only command in manual mode that moves data.
 *
 * The database handle stays open across the whole operation, unlike every other
 * subcommand here, because this is the one that writes to it. It is closed in a
 * `finally` on both paths: a sync that fails halfway has still applied whole
 * pages, and leaving the connection open would hold the WAL against the next
 * command in the same shell.
 */
function runSync(argv: string[]): void {
  const { values } = parseArgs({
    args: argv,
    options: { ...common, "pull-limit": { type: "string" } },
  });
  const json = values.json === true;
  const home = stapleHome();

  const opened = resolveWorkspace(values);
  const workspaceDir = dirname(opened.dbPath);
  const manifest = readRepositoryManifest(workspaceDir);
  if (!manifest) {
    opened.store.db.close();
    throw new StapleError(
      "not_found",
      `This workspace has no ${workspaceDir}/repository.json, so it has no sync identity and ` +
        `nothing to synchronize. Repository identity is minted for repo-local workspaces by ` +
        `\`staple init\`; a global workspace has none and cannot be connected.`,
    );
  }

  const pullLimit = values["pull-limit"] ? Number(values["pull-limit"]) : undefined;
  if (pullLimit !== undefined && (!Number.isInteger(pullLimit) || pullLimit < 1)) {
    opened.store.db.close();
    throw new StapleError("validation", "--pull-limit must be a positive integer");
  }

  settle(
    syncRepository(opened.store.db, manifest.repositoryId, { home, pullLimit })
      .then((report) => {
        if (json) {
          console.log(JSON.stringify(report, null, 2));
          return;
        }
        console.log(renderSyncReport(report));
      })
      .finally(() => opened.store.db.close()),
    json,
  );
}

/**
 * The report, in the order a human wants to read it.
 *
 * `duplicate` is reported beside `applied` rather than hidden, because it is the
 * visible evidence that a lost acknowledgement was absorbed rather than
 * duplicated — and somebody debugging a flaky link needs to see it.
 */
function renderSyncReport(report: SyncReport): string {
  const lines: string[] = [];

  if (report.bootstrap) {
    const b = report.bootstrap;
    lines.push(
      `${b.resumed ? "Resumed" : "Hydrated"} from a snapshot at seq ${b.cutoffSeq}: ` +
        `${b.entities} ${b.entities === 1 ? "entity" : "entities"} over ` +
        `${b.pages} ${b.pages === 1 ? "page" : "pages"}.`,
    );
  }

  const { attempted, applied, duplicate } = report.pushed;
  lines.push(
    attempted === 0
      ? "Pushed nothing — this device had no unsent operations."
      : `Pushed ${attempted}: ${applied} applied` +
        (duplicate > 0 ? `, ${duplicate} already present (a retry the service absorbed)` : ""),
  );

  lines.push(
    report.pulled.operations === 0 && report.pulled.alreadyApplied === 0
      ? "Pulled nothing — no other device has written since this one last looked."
      : `Applied ${report.pulled.operations} remote ${report.pulled.operations === 1 ? "operation" : "operations"}` +
        (report.pulled.alreadyApplied > 0
          ? `, and skipped ${report.pulled.alreadyApplied} already applied here`
          : ""),
  );

  lines.push("");
  lines.push(`  service    ${report.endpoint}`);
  lines.push(`  device     ${report.deviceId}`);
  lines.push(`  epoch      ${report.epoch}`);
  lines.push(`  watermark  ${report.headSeq}`);
  if (report.pending > 0) {
    lines.push(`  pending    ${report.pending}  — still queued; run sync again`);
  }
  if (report.conflicts > 0) {
    lines.push("");
    lines.push(
      `  ! ${report.conflicts} unresolved ${report.conflicts === 1 ? "conflict" : "conflicts"}. ` +
        `Both sides are preserved; nothing was merged or discarded.`,
    );
  }
  return lines.join("\n");
}

function runDevices(argv: string[]): void {
  const sub = argv[0] === "revoke" ? "revoke" : "ls";
  const rest = argv[0] === "ls" || argv[0] === "revoke" ? argv.slice(1) : argv;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: { ...common, yes: { type: "boolean" } },
  });
  const json = values.json === true;
  const home = stapleHome();
  const repositoryId = repositoryIdFor(values);

  if (sub === "ls") {
    settle(
      fetchDevices(home, repositoryId).then((devices) => {
        if (json) {
          console.log(JSON.stringify({ devices }, null, 2));
          return;
        }
        for (const device of devices) {
          const marks = [device.self ? "this device" : null, device.revokedAt !== null ? "revoked" : null]
            .filter(Boolean)
            .join(", ");
          console.log(`${device.deviceId}  ${device.label ?? "(no label)"}${marks ? `  [${marks}]` : ""}`);
        }
      }),
      json,
    );
    return;
  }

  const target = positionals[0];
  if (!target) throw new StapleError("validation", "usage: staple cloud devices revoke <deviceId>");

  if (values.yes !== true) {
    console.log(`Revoke device ${target} from repository ${repositoryId}.`);
    console.log("  - effective on that device's very next request");
    console.log("  - every other device is undisturbed");
    console.log("  - that device keeps its local data; it just stops being able to sync");
    if (!(isInteractive() && confirm("\nRevoke?", { default: false }))) {
      console.error(isInteractive() ? "\nDeclined." : "\nRe-run with --yes to revoke.");
      process.exitCode = 2;
      return;
    }
  }

  settle(
    performRevoke(home, repositoryId, target).then((outcome) => {
      if (json) {
        console.log(JSON.stringify(outcome));
        return;
      }
      console.log(`Revoked ${outcome.deviceId}.`);
      if (outcome.self) {
        console.log(
          "That was THIS device. Its credential is still on this machine and is now useless — " +
            "run `staple cloud disconnect` to remove it, or `staple cloud connect` to re-enroll.",
        );
      }
    }),
    json,
  );
}

function runPurge(argv: string[]): void {
  const { values } = parseArgs({ args: argv, options: { ...common, confirm: { type: "string" } } });
  const json = values.json === true;
  const home = stapleHome();
  const repositoryId = repositoryIdFor(values);
  const status = localCloudStatus(home, repositoryId);

  if (status.state === "disconnected") {
    throw new StapleError(
      "not_found",
      "This repository is not connected on this machine, so there is no endpoint to purge and no " +
        "credential to purge it with.",
    );
  }

  /**
   * The disclosure prints unconditionally, BEFORE the confirmation is even
   * looked at. A disclosure shown only to people who got the confirmation wrong
   * is not a disclosure.
   */
  console.log(retentionDisclosure(status.endpoint!, repositoryId));

  /**
   * Typed confirmation, and specifically the repository id typed back rather
   * than a `--yes`. `--yes` is muscle memory and lives in shell history; the id
   * has to be read off the disclosure that was just printed, which is the only
   * form of confirmation that requires having looked at it.
   */
  if (values.confirm !== repositoryId) {
    console.error("");
    console.error(
      values.confirm === undefined
        ? `Nothing was purged. To proceed, re-run with --confirm ${repositoryId}`
        : `Nothing was purged: --confirm did not match this repository's id. Expected ${repositoryId}.`,
    );
    process.exitCode = 2;
    return;
  }

  settle(
    performPurge(home, repositoryId).then((outcome) => {
      if (outcome.unsupported) {
        // Not success, and not a generic failure either. Say exactly what is true.
        const message =
          `NOTHING WAS PURGED. ${status.endpoint} does not implement remote purge — the route ` +
          `answered "not found". Your remote data is still there, and your local credential has ` +
          `been left in place so you can try again once the service supports it.`;
        if (json) console.error(JSON.stringify({ purged: false, unsupported: true, message }));
        else console.error(`\n${message}`);
        process.exitCode = 4;
        return;
      }
      if (json) {
        console.log(JSON.stringify({ purged: true, repositoryId }));
        return;
      }
      console.log("");
      console.log("Remote state for this repository has been destroyed. Your local database is unchanged.");
      console.log("Every other device's next request will fail; they keep their local state.");
    }),
    json,
  );
}
