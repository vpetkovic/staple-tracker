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
import {
  assertOwnHost,
  describeHostBinding,
  forkWorkspaceIdentity,
  readWorkspaceManifest,
} from "../core/repo-identity.js";
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
import {
  type RemoteBackup,
  createBackup,
  deleteBackup,
  listBackups,
  localEpochOf,
  restoreDisclosure,
  restoreFromBackup,
  setBackupConsent,
} from "../core/cloud/backup.js";
import { listConflicts, resolveConflict } from "../core/cloud/conflicts.js";
import { buildConnectPreview, renderConnectPreview } from "../core/cloud/preview.js";
import { buildHubConnectPreview, renderHubConnectPreview } from "../core/cloud/hub-preview.js";
import {
  performHubConnect,
  performHubDisconnect,
  renderHubConnectOutcome,
} from "../core/cloud/hub-connect.js";
import { renderHubSyncOutcome, syncAllWorkspaces } from "../core/cloud/hub-sync.js";
import { describeHubReport, hubCloudReport } from "../core/cloud/hub-surface.js";
import {
  acquireClaim,
  releaseClaim,
  renewClaim,
  summarizeLeases,
  type LeaseSummary,
} from "../core/cloud/lease.js";
import { runHeartbeat } from "../core/cloud/lease-heartbeat.js";
import { syncRepository, type SyncReport } from "../core/cloud/sync.js";
import { localCloudStatus, refreshCloudStatus, type CloudStatus } from "../core/cloud/status.js";
import {
  cloudSurfaceReport,
  describeReport,
  missingIdentityRemedy,
  type CloudSurfaceReport,
} from "../core/cloud/surface.js";

const USAGE =
  "Use: status, connect, disconnect, auto, sync, lease, devices, conflicts, resolve, backup, restore, fork-id, purge (staple cloud --help)";

const HELP = `staple cloud — connect this repository to a sync service, and manage the
credential that connection produces. Three separate consents: connecting,
synchronizing automatically, and backing up. None of them implies another.

  cloud [status] [--refresh] [--json]
              what this MACHINE's relationship to the cloud is. Local and
              silent by default: it reads three files and makes no request.
              --refresh is the only form that contacts the endpoint, and it is
              what tells offline from revoked from a rejected credential.
  cloud status --all
              every workspace the hub has registered, each with its OWN
              connection state, endpoint and consents. Reads the registry and
              some files in your staple home; opens no workspace database and
              makes no request. A workspace registered a minute ago is in this
              list, because the list is enumerated when you ask rather than
              stored. Not combinable with --refresh: that is one request per
              workspace from a single word.
  cloud connect --endpoint <url> --token <secret> [--label L] [--yes]
                [--credential-file]
              show what is about to happen, then do it once you agree.
              --token is the ENROLLMENT credential: this repository's
              enrollment secret for the first machine, or an existing device
              token from a machine that is already connected. Repositories are
              provisioned out of band. Without --yes and without a terminal it
              prints the preview, exits 2, and sends nothing.
              A successful connection leaves automatic sync OFF.
  cloud connect --all --endpoint <url> --token <secret> [--reconnect]
              one gesture, every registered workspace. Prints the whole list
              first — what would be connected, what would be skipped, and why
              for each — and sends nothing until you agree to that list.
              EACH WORKSPACE KEEPS ITS OWN CREDENTIAL: revoking one does not
              disconnect the others. This machine is one device in all of them.
              The enrollment secret is offered to each workspace in turn; one
              that refuses it is reported and skipped, and THE REST STILL
              CONNECT. Already-connected workspaces are left exactly as they
              are, so re-running after a staple init connects only the new one.
              --reconnect replaces every existing credential instead.
              Automatic sync stays OFF for every one of them.
  cloud disconnect [--yes] [--all]
              remove this device's credential and stop all later cloud
              traffic. LOCAL ONLY: your database, your pending operations and
              the remote state are all untouched, and other devices are
              unaffected. Makes no network call, so it works offline. --all
              does it for every registered workspace, including ones whose disk
              is not currently mounted — the credential is on this machine.
  cloud sync [--all]
              synchronize NOW: push what this device has journaled, then apply
              what the others have. The only thing that moves data in manual
              mode, which is the default and stays the default. A first run on
              a fresh clone hydrates the database from a snapshot; an
              interrupted run resumes where it stopped. Your local database
              stays the only read and write path for every other command.
              --all synchronizes every connected workspace and reports a
              PER-WORKSPACE outcome: one failing does not stop the others, and
              the exit code is non-zero if any of them failed. Workspaces that
              are not connected, and ones whose disk is not mounted, are
              skipped rather than failed.
  cloud auto on|off
              this DEVICE's consent to synchronize without being asked. Stored
              per-machine, because consent given on a laptop is not consent
              given on a build box. Off does not disconnect. There is no --all
              here on purpose: connecting everywhere must not be one word away
              from agreeing to background traffic everywhere.
  cloud lease [status] [<ref>]
              what this machine may honestly say about who holds what. Local
              and silent: it reads the mirror and the connection record and
              makes no request. A claim is either "local" — this database
              only, no global exclusivity — or "lease", held under a fenced
              server lease.
  cloud lease acquire <ref> [--agent A] [--ttl <dur>]
              claim <ref> GLOBALLY: take the server lease, then check the work
              out locally. Two machines racing produce one winner and one
              conflict that is not worth retrying. On a repository that is not
              connected this still claims locally, and says so — offline work
              is allowed, it is just not exclusive.
  cloud lease renew <ref> [--ttl <dur>] [--heartbeat <dur> [--for <dur>]]
              extend the lease, presenting the fencing token. --heartbeat
              renews on an interval instead of once, bounded by --for and
              stoppable with ctrl-c. A refusal stops it: the lease expired or
              was taken over, and asking again will not change that.
  cloud lease release <ref>
              give the lease back, presenting the fencing token, and release
              the local claim. If the lease was expired, stolen or revoked the
              server refuses it and this says so rather than reporting a
              release that did not happen.
  cloud devices [ls]
              every device registered to this repository, as the server sees
              it. The server is the authority; the local cache is not.
  cloud devices revoke <deviceId> [--yes]
              end that device's access, server-side, effective on its very next
              request. Other devices are undisturbed. This is NOT disconnect:
              revoking is about a device you may not be holding.
  cloud backup enable|disable
              this DEVICE's consent to keep point-in-time copies of this
              repository on the service. A THIRD consent: connecting does not
              turn it on and neither does automatic sync. Disabling stops new
              backups and deletes none of the existing ones.
  cloud backup create [--label L]
              take a backup NOW. A point-in-time export, not a checkpoint:
              it moves no cursor and changes nothing about convergence.
  cloud backup ls
              every backup the service holds for this repository. Metadata
              only. A "pre-restore" one is the undo a restore took for you.
  cloud backup rm <backupId> [--yes]
              delete one backup. Retention is yours to manage; nothing here
              expires on its own.
  cloud restore <backupId> --confirm <repositoryId>
              put the repository back to what that backup holds. Takes a
              pre-restore backup first, writes the contents into a NEW epoch
              and moves every device onto it, which forces each one through a
              bounded re-bootstrap. DISCARDS anything synchronized since the
              backup was taken. Prints all of that before it will accept the
              repository id typed back. Never merges database files.
  cloud conflicts [--all]
              fields two devices changed to different things. Both values are
              kept, in full, and NOTHING is applied on your behalf — a conflict
              is data, not an error, and the rest of the repository keeps
              synchronizing around it. Local read; makes no request. --all
              includes the ones already settled, which are kept as the record of
              who chose what. NOTE: --all here means "settled ones too", for one
              workspace. It is the older sense of the flag and predates the
              hub-wide --all on status, connect, sync and disconnect.
  cloud resolve <id> --take local|remote
  cloud resolve <id> --value <text>
              settle one, explicitly. Emits a NEW operation carrying the choice,
              so the other devices agree; it never rewrites the two operations
              that disagreed and never picks for you. Resolving the same
              conflict the same way twice does nothing the second time.
  cloud fork-id [--yes]
              make this workspace an INDEPENDENT one: mint a new sync identity
              and drop every position in the old repository's log — cursors,
              outbox, dedup ledger, leases and the device cache. The answer
              when a directory was copied, or a staple home was restored onto a
              second machine and both are now live. The workspace it was copied
              FROM is untouched: this makes no network call. Local edit history,
              tombstones and settled conflicts are kept.
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
 *
 * EXPORTED for `hub-registry.ts` (STA-283), which is the second async command
 * group and needs exactly this. Shared rather than copied: the reasoning above is
 * the whole value, and a second copy of it is a second thing to keep true.
 */
export function settle(work: Promise<void>, json: boolean): void {
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
 * The refusal when a workspace has no manifest at all.
 *
 * One wording, four call sites, and since STA-281 the remedy half of it is
 * {@link missingIdentityRemedy} — the same sentence `staple cloud status`, the
 * MCP report and the page render, because there is one true answer to "what can
 * I do about this" and it depends on the workspace rather than on the surface
 * that noticed.
 *
 * It takes the DATABASE path rather than the identity directory, for the same
 * reason: only the database path can tell whether this workspace is inside a
 * checkout, and that is what decides whether `staple init` is the answer or the
 * very thing not to do.
 */
function noIdentity(dbPath: string, consequence: string): StapleError {
  return new StapleError(
    "not_found",
    `This workspace is registered and its data is intact, but it has no sync identity and ` +
      `${consequence}. ${missingIdentityRemedy(dbPath)}`,
  );
}

/**
 * This workspace's repository id, from the recoverable manifest.
 *
 * The manifest rather than `sync_state`, for the reason `repo-identity.ts`
 * gives: on a fresh checkout the manifest is the only copy, and it is the one a
 * human can see in a diff. The database handle is opened to locate the
 * workspace and closed immediately — nothing here reads a domain table.
 *
 * `assertOwnHost` deliberately does NOT run here. This is the read every
 * subcommand starts with, `staple cloud status` included, and status must be
 * able to REPORT that this home was restored elsewhere rather than dying of it.
 * The refusal belongs on the paths that move something, and it is spelled out
 * there.
 */
function repositoryIdFor(options: { db?: string; ws?: string }): string {
  const opened = resolveWorkspace(options);
  try {
    const manifest = readWorkspaceManifest(opened.dbPath);
    if (!manifest) throw noIdentity(opened.dbPath, "cannot be connected");
    return manifest.repositoryId;
  } finally {
    opened.store.db.close();
  }
}

/**
 * The human rendering, which is now `describeReport` plus the one thing the
 * shared report deliberately does not carry.
 *
 * **Why `devices` is not on `CloudSurfaceReport`.** Every other field is derived
 * from local files and the local database, which is what makes the report safe
 * for a polled UI to render unconditionally. The device list is not: it exists
 * only after an authenticated `GET /devices`, so a report that carried it would
 * be a report whose completeness depended on whether the caller had paid for a
 * network round trip — and the first surface to render it would quietly acquire
 * a reason to ask for one. `--refresh` already has the list in hand here, so the
 * CLI appends it; nothing else needs to.
 */
function renderStatus(status: CloudStatus, report: CloudSurfaceReport): string {
  const lines = [describeReport(report)];
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
    case "lease":
      return runLease(rest);
    case "devices":
      return runDevices(rest);
    case "backup":
      return runBackup(rest);
    case "restore":
      return runRestore(rest);
    case "conflicts":
      return runConflicts(rest);
    case "resolve":
      return runResolve(rest);
    case "fork-id":
      return runForkId(rest);
    case "purge":
      return runPurge(rest);
    default:
      throw new StapleError("validation", `Unknown subcommand "${sub}". ${USAGE}`);
  }
}

const common = { db: { type: "string" as const }, ws: { type: "string" as const }, json: { type: "boolean" as const } };

/**
 * `--all`: every workspace the hub has registered, instead of this one.
 *
 * Accepted by `status`, `connect`, `sync` and `disconnect`. Deliberately NOT by
 * `auto` — see {@link runAuto} — and note that `cloud conflicts --all` is an
 * older, unrelated flag meaning "include the settled ones", which is why the
 * help says so under that subcommand rather than leaving somebody to find out.
 */
const withAll = { ...common, all: { type: "boolean" as const } };

/**
 * `--all` names the hub; `--db` and `--ws` name one workspace. Passing both is
 * not an ambiguity to resolve, it is a sentence with two subjects.
 *
 * Refused rather than silently preferring one. A `--all --ws foo` that quietly
 * ignored `--ws` would be a fan-out somebody thought was scoped, which on
 * `connect` means credentials minted for workspaces they did not mean to touch.
 */
function refuseTargeted(values: { all?: boolean; db?: string; ws?: string }, verb: string): void {
  if (values.all !== true) return;
  if (values.db === undefined && values.ws === undefined) return;
  throw new StapleError(
    "validation",
    `--all ${verb} every registered workspace, so it cannot be combined with ` +
      `${values.db !== undefined ? "--db" : "--ws"}, which names one. Drop one of them.`,
  );
}

function runStatus(argv: string[]): void {
  const { values } = parseArgs({ args: argv, options: { ...withAll, refresh: { type: "boolean" } } });
  const json = values.json === true;
  const home = stapleHome();

  if (values.all === true) {
    refuseTargeted(values, "reports");
    /**
     * `--refresh --all` is refused rather than implemented.
     *
     * A refresh is one authenticated `GET /devices`. Across a hub it is N of
     * them fired by one word, which is the "one human's page-open into a
     * heartbeat" shape `surface.ts` warns about, arriving through the CLI
     * instead. And it would be N round trips to decorate a LIST — a surface for
     * choosing, not for diagnosing. The remedy is named because it is short:
     * refresh the one workspace whose reachability is actually in question.
     */
    if (values.refresh === true) {
      throw new StapleError(
        "validation",
        "--refresh contacts the endpoint, and --all would contact one per registered workspace " +
          "from a single word. Refresh a single workspace instead: `staple cloud status --refresh " +
          "--ws <slug>`.",
      );
    }
    /**
     * `probeCredentials` is ON here and off for the polled HTTP surface. A human
     * typed this once and wants to be told that a credential has gone missing;
     * the settings page renders every few seconds and must not spawn a keychain
     * subprocess per workspace per poll. See `hub-surface.ts`.
     */
    const report = hubCloudReport(home, { probeCredentials: true });
    console.log(json ? JSON.stringify(report, null, 2) : describeHubReport(report));
    return;
  }

  const repositoryId = repositoryIdFor(values);

  /**
   * The counters (`pending`, `cursor`, `epoch`, conflicts, leases) come off this
   * workspace's database, so unlike every other `cloud` subcommand this one needs
   * a handle open while it renders. Opened here and closed in `finally` — the
   * report is a plain object, so nothing escapes the handle's lifetime.
   */
  const emit = (status: CloudStatus): void => {
    const opened = resolveWorkspace(values);
    try {
      const report = cloudSurfaceReport(status, opened.store.db);
      console.log(json ? JSON.stringify(report, null, 2) : renderStatus(status, report));
    } finally {
      opened.store.db.close();
    }
  };

  if (values.refresh !== true) {
    // The silent path. No await, no client import reached, no request.
    emit(localCloudStatus(home, repositoryId));
    return;
  }

  settle(
    refreshCloudStatus(home, repositoryId).then(emit),
    json,
  );
}

function runConnect(argv: string[]): void {
  const { values } = parseArgs({
    args: argv,
    options: {
      ...withAll,
      endpoint: { type: "string" },
      token: { type: "string" },
      label: { type: "string" },
      yes: { type: "boolean" },
      reconnect: { type: "boolean" },
      "credential-file": { type: "boolean" },
    },
  });
  const json = values.json === true;
  const home = stapleHome();

  if (values.all === true) {
    runConnectAll(values);
    return;
  }
  if (values.reconnect === true) {
    throw new StapleError(
      "validation",
      "--reconnect only means something with --all, where it distinguishes 'connect the " +
        "workspaces that are not connected yet' from 'replace every credential'. A single-workspace " +
        "`staple cloud connect` already re-connects.",
    );
  }

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

/**
 * `staple cloud connect --all` — one gesture, every registered workspace.
 *
 * Structurally identical to the single-workspace path above, and deliberately
 * so: preview first, from a module that cannot reach the network; then consent;
 * then, and only then, the enrollment secret is even looked at. The one
 * difference is that the preview is a list and the outcome is a list, because
 * *"partial failure is the normal case"* — nine connected, two skipped and one
 * refused by the service is a perfectly ordinary Tuesday, and an aggregate
 * result would describe it as a failure.
 *
 * `--token` is checked AFTER consent here, exactly as it is for one workspace.
 * Asking for a secret before showing what it will be spent on is the ordering
 * this whole design exists to avoid.
 */
function runConnectAll(values: {
  all?: boolean;
  db?: string;
  ws?: string;
  json?: boolean;
  endpoint?: string;
  token?: string;
  label?: string;
  yes?: boolean;
  reconnect?: boolean;
  "credential-file"?: boolean;
}): void {
  refuseTargeted(values, "connects");
  const json = values.json === true;
  const home = stapleHome();

  if (!values.endpoint) {
    throw new StapleError(
      "validation",
      "usage: staple cloud connect --all --endpoint <url> --token <secret>. Every registered " +
        "workspace is connected to that one service; nothing is contacted until you agree to the " +
        "list it prints.",
    );
  }

  const preview = buildHubConnectPreview({
    home,
    endpoint: values.endpoint,
    label: values.label,
    credential: { forceFile: values["credential-file"] === true },
    reconnect: values.reconnect === true,
  });

  if (json) {
    console.log(JSON.stringify({ preview }, null, 2));
  } else {
    console.log(renderHubConnectPreview(preview));
  }

  /**
   * Nothing to do is not a thing to ask about. Every workspace is either already
   * connected or not actionable, so there is no consent to seek and no request
   * to make — and prompting anyway would train a person to say yes to a question
   * that never means anything.
   */
  if (preview.willConnect === 0 && preview.willReconnect === 0) {
    if (!json) {
      console.error(
        "\nNothing to do. Every registered workspace is either already connected or not " +
          "actionable; nothing was sent.",
      );
    }
    return;
  }

  if (values.yes !== true) {
    const agreed = isInteractive() && confirm("\nConnect these workspaces?", { default: false });
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
      "--token is required: the enrollment secret these workspaces were provisioned with. It is " +
        "offered to each one in turn, and a workspace that does not accept it is reported rather " +
        "than aborting the others.",
    );
  }

  settle(
    performHubConnect(preview, {
      home,
      enrollmentSecret: values.token,
      credential: { forceFile: values["credential-file"] === true },
    }).then((outcome) => {
      if (json) {
        console.log(JSON.stringify(outcome, null, 2));
      } else {
        console.log("");
        console.log(renderHubConnectOutcome(outcome));
      }
      /**
       * A partial failure is a non-zero exit and a complete report, not an
       * exception. The rows above already say which workspaces failed and why;
       * throwing here would replace N precise statements with one vague one.
       */
      if (outcome.failed > 0) process.exitCode = 1;
    }),
    json,
  );
}

function runDisconnect(argv: string[]): void {
  const { values } = parseArgs({ args: argv, options: { ...withAll, yes: { type: "boolean" } } });
  const json = values.json === true;
  const home = stapleHome();

  if (values.all === true) {
    refuseTargeted(values, "disconnects");
    /**
     * No confirmation prompt, matching the single-workspace path, which also has
     * none by default: disconnect is local, reversible by re-connecting, and
     * destroys no data. `--yes` is accepted and ignored for symmetry with the
     * single form rather than refused, because a script that passes it to both
     * should not have to know which one cares.
     */
    const outcome = performHubDisconnect(home);
    if (json) {
      console.log(JSON.stringify(outcome, null, 2));
      return;
    }
    if (outcome.workspaces.length === 0) {
      console.log("No workspaces are registered on this machine, so nothing was disconnected.");
      return;
    }
    const width = Math.max(...outcome.workspaces.map((row) => row.slug.length), 9);
    for (const row of outcome.workspaces) {
      console.log(`  ${row.status.padEnd(13)} ${row.slug.padEnd(width)}  ${row.reason}`);
    }
    console.log("");
    console.log(
      `  ${outcome.disconnected} disconnected, ${outcome.skipped} were not connected` +
        (outcome.failed > 0 ? `, ${outcome.failed} failed` : "") +
        `. No network call was made, and no local data was touched.`,
    );
    if (outcome.failed > 0) {
      console.log("");
      /**
       * A row can only fail here by having a connection record this build
       * refuses to parse, and the others were disconnected anyway — which is the
       * whole point of the per-row catch. Said explicitly because the counts
       * alone would leave a reader wondering whether the run had stopped early.
       */
      console.log(
        "The failures above did not stop the others. Each is a connection record in your " +
          "staple home that could not be read; the message on each row names the file.",
      );
    }
    return;
  }

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

/**
 * `staple cloud fork-id` — the way out of "two machines, one identity".
 *
 * Three messages in the tree have named this command since S2 and none of them
 * could be obeyed, because the core operation existed and nothing exposed it.
 * S15 makes that reachable for a workspace that has no repository, where there
 * is no `checkout -- repository.json` to undo a copy with, so it is wired here.
 *
 * Confirmed rather than immediate, and the preview says what is dropped, because
 * a fork is not reversible from inside staple: the positions it deletes are the
 * only local record of where this device had got to in the old repository's log.
 * It is nonetheless SAFE in the direction people worry about — no network call,
 * no effect on the machine this workspace was copied from, and every domain row
 * left exactly where it is.
 */
function runForkId(argv: string[]): void {
  const { values } = parseArgs({ args: argv, options: { ...common, yes: { type: "boolean" } } });
  const json = values.json === true;
  const opened = resolveWorkspace(values);

  try {
    const manifest = readWorkspaceManifest(opened.dbPath);
    if (!manifest) throw noIdentity(opened.dbPath, "nothing to fork");

    if (values.yes !== true) {
      const binding = describeHostBinding(opened.store.db);
      console.log(`Fork this workspace away from repository ${manifest.repositoryId}.`);
      console.log("");
      if (binding.status === "moved") {
        console.log("  - this staple home was restored from another machine, which is why");
        console.log("    synchronizing is currently refused");
      }
      console.log("  - a NEW sync identity is minted and written to the manifest");
      console.log("  - cursors, the outbox, the dedup ledger, leases and the device cache");
      console.log("    are dropped: they are positions in the OLD repository's log");
      console.log("  - your issues, comments, tombstones and settled conflicts are untouched");
      console.log("  - the workspace this was copied from is untouched; nothing is sent");
      console.log("  - unsent local work is regenerated against the new identity when it syncs");
      if (!(isInteractive() && confirm("\nFork?", { default: false }))) {
        console.error(isInteractive() ? "\nDeclined. Identity unchanged." : "\nRe-run with --yes to fork.");
        process.exitCode = 2;
        return;
      }
    }

    const result = forkWorkspaceIdentity(opened.store.db, opened.dbPath);
    if (json) {
      console.log(JSON.stringify(result));
      return;
    }
    console.log(`Forked. ${result.previousRepositoryId ?? "(none)"} -> ${result.repositoryId}`);
    console.log(`Manifest: ${result.manifestPath}`);
    console.log(
      "This workspace is now independent and unconnected. `staple cloud connect` enrols it as a " +
        "repository of its own.",
    );
  } finally {
    opened.store.db.close();
  }
}

function runAuto(argv: string[]): void {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: withAll });
  const choice = positionals[0];
  if (choice !== "on" && choice !== "off") {
    throw new StapleError("validation", "usage: staple cloud auto on|off");
  }
  /**
   * **`--all` is REFUSED here, and that refusal is the point.**
   *
   * `connect`, `sync` and `disconnect` all grew a fan-out in STA-275 and this
   * one deliberately did not. Connecting is one decision about one service, and
   * doing it in twelve places at once is the same decision twelve times.
   * Agreeing that a machine may talk to a service **without being asked again**
   * is a different kind of decision, and `--all` would make the most consequential
   * consent in the product the cheapest thing to type — one word away from a
   * hub-wide connect that a person is already saying yes to.
   *
   * The option is parsed rather than left to `parseArgs` to reject as unknown, so
   * that somebody who reasonably assumes it exists is told WHY it does not
   * instead of getting `ERR_PARSE_ARGS_UNKNOWN_OPTION`. Accepted into the parser,
   * refused by the command: the argument, not the arity, is what is wrong.
   */
  if (values.all === true) {
    throw new StapleError(
      "validation",
      "There is no `staple cloud auto --all`, on purpose. Connecting and agreeing to background " +
        "synchronization are two separate consents, and a hub-wide connect must not be able to " +
        "become a hub-wide automatic-sync consent by adding one word. Turn it on per workspace: " +
        "`staple cloud auto on --ws <slug>`.",
    );
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
    options: { ...withAll, "pull-limit": { type: "string" } },
  });
  const json = values.json === true;
  const home = stapleHome();

  const pullLimitAll = values["pull-limit"] ? Number(values["pull-limit"]) : undefined;
  if (pullLimitAll !== undefined && (!Number.isInteger(pullLimitAll) || pullLimitAll < 1)) {
    throw new StapleError("validation", "--pull-limit must be a positive integer");
  }

  if (values.all === true) {
    refuseTargeted(values, "synchronizes");
    settle(
      syncAllWorkspaces({ home, pullLimit: pullLimitAll }).then((outcome) => {
        if (json) {
          console.log(JSON.stringify(outcome, null, 2));
        } else {
          console.log(renderHubSyncOutcome(outcome));
        }
        /**
         * The ONLY aggregation this command does, and the only one a shell can
         * consume. Everything else a caller might want to know is a row.
         */
        if (outcome.failed > 0) process.exitCode = 1;
      }),
      json,
    );
    return;
  }

  const opened = resolveWorkspace(values);
  const manifest = readWorkspaceManifest(opened.dbPath);
  if (!manifest) {
    opened.store.db.close();
    throw noIdentity(opened.dbPath, "nothing to synchronize");
  }

  /**
   * No copied-home check here, deliberately.
   *
   * `syncRepository` asserts it as its very first statement, ahead of opening
   * the session, so this command already refuses a restored home before it
   * reaches for a credential or an endpoint. A second check here was written
   * first and then deleted: removing it changed no observable behaviour in any
   * test, which is the definition of a guard that can only ever drift away from
   * the one that matters. The lease path below is different — it does not go
   * through `syncRepository`, so it does its own.
   */
  // Already validated above, before the workspace was opened, because the
  // `--all` path needs the same check and must not open anything to make it.
  const pullLimit = pullLimitAll;

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

// --------------------------------------------------------------------- lease

/**
 * `--ttl`, `--heartbeat` and `--for`, in the duration grammar the rest of the
 * CLI already uses: `90s`, `30m`, `2h`, `3d`, or a bare number of seconds.
 *
 * A local copy of `cli.ts`'s parser rather than an import of it. `cli.ts` is a
 * shared surface with several lanes in it this wave, and exporting a helper from
 * it to save ten lines here would be the more expensive change. Folding the two
 * into one exported helper is an additive follow-up.
 *
 * A bad duration is a hard error and never a silent zero, for the reason the
 * original gives: a `--ttl` that collapsed to nothing would ask for a lease that
 * expires immediately, which is the failure mode hardest to see.
 */
function durationSeconds(raw: string, flag: string): number {
  const match = /^(\d+(?:\.\d+)?)([smhd]?)$/.exec(raw.trim());
  if (!match) {
    throw new StapleError(
      "validation",
      `--${flag} must be a duration like 90s, 30m, 2h, 3d, or a number of seconds, got "${raw}"`,
    );
  }
  const scale = { "": 1, s: 1, m: 60, h: 3600, d: 86400 }[match[2]!]!;
  return Math.round(Number(match[1]) * scale);
}

/**
 * Open the workspace and its repository identity together.
 *
 * Every lease subcommand needs both, and the store must outlive the async work —
 * unlike `repositoryIdFor`, which closes immediately because it reads nothing.
 */
function leaseContext(values: { db?: string; ws?: string }): {
  store: ReturnType<typeof resolveWorkspace>["store"];
  repositoryId: string;
} {
  const opened = resolveWorkspace(values);
  const manifest = readWorkspaceManifest(opened.dbPath);
  if (!manifest) {
    opened.store.db.close();
    throw noIdentity(opened.dbPath, "cannot hold a server lease");
  }
  // A lease is an exclusive claim on shared state, so a copied home taking one
  // out is the same hazard as a copied home pushing: two machines, one identity.
  try {
    assertOwnHost(opened.store.db);
  } catch (error) {
    opened.store.db.close();
    throw error;
  }
  return { store: opened.store, repositoryId: manifest.repositoryId };
}

function runLease(argv: string[]): void {
  const sub = argv[0] && !argv[0].startsWith("-") ? argv[0] : "status";
  const known = new Set(["status", "acquire", "renew", "release"]);
  if (!known.has(sub)) {
    throw new StapleError(
      "validation",
      `Unknown lease subcommand "${sub}". Use: status, acquire, renew, release.`,
    );
  }
  const rest = argv[0] && !argv[0].startsWith("-") ? argv.slice(1) : argv;

  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      ...common,
      agent: { type: "string" },
      ttl: { type: "string" },
      heartbeat: { type: "string" },
      for: { type: "string" },
    },
  });
  const json = values.json === true;
  const home = stapleHome();
  const ref = positionals[0];

  if (sub !== "status" && ref === undefined) {
    throw new StapleError("validation", `\`staple cloud lease ${sub}\` needs an issue reference.`);
  }

  const ttlSeconds = values.ttl === undefined ? undefined : durationSeconds(values.ttl, "ttl");
  const { store, repositoryId } = leaseContext(values);

  /**
   * `status` is the silent one, and it is synchronous on purpose: it must not be
   * able to reach the async path at all. Local files, then out.
   */
  if (sub === "status") {
    try {
      const summary = summarizeLeases(store.db, home, repositoryId);
      const filtered = ref === undefined ? summary.leases : summary.leases.filter((lease) => {
        const issue = store.getIssue(ref);
        return lease.entityId === issue.id;
      });
      const payload = { ...summary, leases: filtered };
      console.log(json ? JSON.stringify(payload, null, 2) : renderLeaseStatus(store, payload));
    } finally {
      store.db.close();
    }
    return;
  }

  const options = { home, ...(ttlSeconds === undefined ? {} : { ttlSeconds }) };

  if (sub === "acquire") {
    const holder = values.agent ?? process.env.STAPLE_AGENT ?? process.env.USER ?? "user";
    settle(
      acquireClaim(store, repositoryId, ref!, holder, options)
        .then((outcome) => {
          if (json) {
            console.log(JSON.stringify(outcome, null, 2));
            return;
          }
          console.log(
            `claimed ${outcome.issue.identifier} — scope ${outcome.scope}\n\n  ${outcome.note}`,
          );
        })
        .finally(() => store.db.close()),
      json,
    );
    return;
  }

  if (sub === "release") {
    settle(
      releaseClaim(store, repositoryId, ref!, options)
        .then((outcome) => {
          if (json) {
            console.log(JSON.stringify(outcome, null, 2));
            return;
          }
          /**
           * The headline distinguishes "there was no lease" from "there was one
           * and it is still out there". Only the second deserves an alarm; a
           * disconnected release is the ordinary case and shouting at it would
           * teach people to ignore the shouting.
           */
          const headline = outcome.remoteReleased
            ? "released"
            : outcome.stranded
              ? "NOT released"
              : "released (local only)";
          console.log(`${headline}\n\n  ${outcome.note}`);
        })
        .finally(() => store.db.close()),
      json,
    );
    return;
  }

  // renew, with or without the loop
  const everyMs =
    values.heartbeat === undefined ? null : durationSeconds(values.heartbeat, "heartbeat") * 1000;
  const budgetMs = values.for === undefined ? undefined : durationSeconds(values.for, "for") * 1000;

  if (everyMs === null) {
    settle(
      renewClaim(store, repositoryId, ref!, options)
        .then((outcome) => {
          if (json) {
            console.log(JSON.stringify(outcome, null, 2));
            return;
          }
          console.log(`renewed lease ${outcome.lease.fencingToken}\n\n  ${outcome.note}`);
        })
        .finally(() => store.db.close()),
      json,
    );
    return;
  }

  /**
   * The bounded heartbeat. Ctrl-C is the cancellation, wired to the same
   * `AbortSignal` the loop already understands, so an interrupted heartbeat
   * finishes its report rather than dying mid-beat with nothing to show.
   */
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  const entityId = store.getIssue(ref!).id;
  settle(
    runHeartbeat(store.db, repositoryId, entityId, {
      ...options,
      everyMs,
      ...(budgetMs === undefined ? {} : { budgetMs }),
      signal: controller.signal,
      onBeat: json
        ? undefined
        : (beat) => {
            console.log(
              `  beat ${beat.n}  ${beat.outcome}` +
                (beat.serverExpiresAt ? `  until ${beat.serverExpiresAt}` : "") +
                (beat.message ? `  — ${beat.message}` : ""),
            );
          },
    })
      .then((report) => {
        if (json) {
          console.log(JSON.stringify(report, null, 2));
          return;
        }
        console.log(
          `\nstopped: ${report.stopped} after ${report.beats.length} ` +
            `${report.beats.length === 1 ? "beat" : "beats"}. ` +
            (report.holds
              ? "The lease is still held."
              : "The lease is NOT held — it expired or was taken over."),
        );
      })
      .finally(() => {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        store.db.close();
      }),
    json,
  );
}

function renderLeaseStatus(
  store: ReturnType<typeof resolveWorkspace>["store"],
  summary: LeaseSummary,
): string {
  const lines: string[] = [];
  lines.push(
    summary.connected
      ? `Connected as ${summary.deviceId}. A claim here can be globally exclusive.`
      : "Not connected on this machine. Every claim here is local to this database.",
  );
  lines.push("");
  if (summary.leases.length === 0) {
    lines.push("  no leases known to this device");
    lines.push("");
    lines.push("  Take one with: staple cloud lease acquire <ref>");
    return lines.join("\n");
  }
  for (const lease of summary.leases) {
    let identifier = lease.entityId;
    try {
      identifier = store.getIssue(lease.entityId).identifier;
    } catch {
      // A lease for an issue this device has not pulled yet. Show the id.
    }
    lines.push(
      `  ${identifier}  ${lease.holder}  scope ${lease.scope}  token ${lease.fencingToken}`,
    );
    lines.push(`      service says it expires at ${lease.serverExpiresAt}`);
  }
  lines.push("");
  lines.push(`  ${summary.note}`);
  return lines.join("\n");
}

/**
 * `staple cloud conflicts` — what two devices disagree about.
 *
 * A local read of one table. It makes no request and needs no connection: the
 * disagreement is already recorded, and asking the service about it would tell
 * nobody anything the row does not already say.
 *
 * The rendering leads with what was contested and shows BOTH values with equal
 * weight. There is no "current" or "incoming" framing and no ordering that
 * implies a default, because the whole point is that neither has been chosen —
 * a surface that made one look settled would reintroduce last-write-wins in the
 * only place it still could, which is the reader's head.
 */
function runConflicts(argv: string[]): void {
  const { values } = parseArgs({ args: argv, options: { ...common, all: { type: "boolean" } } });
  const json = values.json === true;
  const opened = resolveWorkspace(values);
  try {
    const conflicts = listConflicts(opened.store.db, { includeResolved: values.all === true });
    if (json) {
      console.log(JSON.stringify({ conflicts }, null, 2));
      return;
    }
    if (conflicts.length === 0) {
      console.log(values.all === true ? "No conflicts, ever." : "No open conflicts.");
      return;
    }
    for (const conflict of conflicts) {
      console.log(`${conflict.id}  ${conflict.entity}.${conflict.field} on ${conflict.entityId}`);
      console.log(`  here     ${render(conflict.localValue)}  (${conflict.localDeviceId ?? "this device"})`);
      console.log(`  arrived  ${render(conflict.remoteValue)}  (${conflict.remoteDeviceId ?? "unknown device"})`);
      if (conflict.baseValue !== undefined) console.log(`  was      ${render(conflict.baseValue)}`);
      if (conflict.resolvedAt === null) {
        console.log(`  open since ${conflict.detectedAt} — staple cloud resolve ${conflict.id} --take local|remote`);
      } else {
        console.log(
          `  settled by ${conflict.resolvedBy ?? "someone"} at ${conflict.resolvedAt}: ` +
            `${render(conflict.resolvedValue)} (${conflict.resolvedChoice})`,
        );
      }
      console.log("");
    }
  } finally {
    opened.store.db.close();
  }
}

function render(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value ?? null);
}

/**
 * `staple cloud resolve` — settle one, on the record.
 *
 * `--take` and `--value` are separate flags rather than one, so that choosing a
 * side and writing a third answer cannot be confused for each other in shell
 * history. Neither has a default: a resolve with no flag is a usage error, not
 * a guess.
 */
function runResolve(argv: string[]): void {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { ...common, take: { type: "string" }, value: { type: "string" } },
  });
  const json = values.json === true;
  const id = positionals[0];
  if (!id) {
    throw new StapleError(
      "validation",
      "usage: staple cloud resolve <id> --take local|remote  |  --value <text>",
    );
  }
  if (values.take !== undefined && values.value !== undefined) {
    throw new StapleError(
      "validation",
      "--take and --value are two different decisions. Pass one.",
    );
  }
  if (values.take !== undefined && values.take !== "local" && values.take !== "remote") {
    throw new StapleError("validation", `--take is "local" or "remote", not "${values.take}".`);
  }
  if (values.take === undefined && values.value === undefined) {
    throw new StapleError(
      "validation",
      "Nothing chosen. Pass --take local, --take remote, or --value <text>.",
    );
  }

  const opened = resolveWorkspace(values);
  try {
    const outcome = resolveConflict(opened.store.db, {
      id,
      choice: values.take === undefined ? "custom" : (values.take as "local" | "remote"),
      value: values.value,
      actor: process.env.STAPLE_AGENT ?? null,
    });
    if (json) {
      console.log(JSON.stringify(outcome, null, 2));
      return;
    }
    console.log(
      outcome.changed
        ? `${outcome.conflict.entity}.${outcome.conflict.field} is now ${render(outcome.conflict.resolvedValue)}.`
        : `Already resolved to ${render(outcome.conflict.resolvedValue)}. Nothing to do.`,
    );
    for (const move of outcome.renumbered) {
      console.log(`  ${move.from} was taken, so ${move.issueId} is now ${move.to}.`);
    }
  } finally {
    opened.store.db.close();
  }
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

/**
 * `staple cloud backup <enable|disable|create|ls|rm>`.
 *
 * Two-level, like `devices`. The default when no subcommand is given is `ls`,
 * because listing is the only one of the five that changes nothing — a bare
 * `staple cloud backup` should never be the command that took a backup.
 */
function runBackup(argv: string[]): void {
  const subs = new Set(["enable", "disable", "create", "ls", "rm"]);
  const sub = argv[0] && subs.has(argv[0]) ? argv[0] : "ls";
  const rest = argv[0] && subs.has(argv[0]) ? argv.slice(1) : argv;

  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: { ...common, label: { type: "string" }, yes: { type: "boolean" } },
  });
  const json = values.json === true;
  const home = stapleHome();
  const repositoryId = repositoryIdFor(values);

  if (sub === "enable" || sub === "disable") {
    const enabled = sub === "enable";
    settle(
      setBackupConsent(home, repositoryId, enabled).then((outcome) => {
        if (json) {
          console.log(JSON.stringify(outcome));
        } else {
          console.log(`Backup is ${outcome.enabled ? "on" : "off"} for this repository on this machine.`);
          if (outcome.enabled) {
            console.log("  - this is a separate consent; it did not change automatic sync");
            console.log("  - take one with: staple cloud backup create");
          } else {
            console.log("  - existing backups were NOT deleted; remove one with `backup rm`");
          }
        }
        if (outcome.warning) {
          console.error(`\n! ${outcome.warning}`);
          process.exitCode = 4;
        }
      }),
      json,
    );
    return;
  }

  if (sub === "create") {
    settle(
      createBackup(home, repositoryId, values.label ?? null).then((backup) => {
        if (json) {
          console.log(JSON.stringify({ backup }, null, 2));
          return;
        }
        console.log(`Backed up ${backup.entityCount} entities as ${backup.backupId}.`);
        console.log(`  epoch ${backup.epoch}, at sequence ${backup.cutoffSeq}`);
        console.log("  no cursor moved; this changed nothing about synchronization");
      }),
      json,
    );
    return;
  }

  if (sub === "ls") {
    settle(
      listBackups(home, repositoryId).then((backups) => {
        if (json) {
          console.log(JSON.stringify({ backups }, null, 2));
          return;
        }
        if (backups.length === 0) {
          console.log("No backups. Take one with: staple cloud backup create");
          return;
        }
        for (const backup of backups) {
          console.log(renderBackupLine(backup));
        }
      }),
      json,
    );
    return;
  }

  const target = positionals[0];
  if (!target) throw new StapleError("validation", "usage: staple cloud backup rm <backupId>");

  if (values.yes !== true) {
    console.log(`Delete backup ${target} from repository ${repositoryId}.`);
    console.log("  - the backup is destroyed on the service. Not reversible.");
    console.log("  - your local database and every other backup are untouched");
    console.log("  - nothing about synchronization changes");
    if (!(isInteractive() && confirm("\nDelete?", { default: false }))) {
      console.error(isInteractive() ? "\nDeclined." : "\nRe-run with --yes to delete.");
      process.exitCode = 2;
      return;
    }
  }

  settle(
    deleteBackup(home, repositoryId, target).then(() => {
      if (json) console.log(JSON.stringify({ deleted: true, backupId: target }));
      else console.log(`Deleted ${target}.`);
    }),
    json,
  );
}

function renderBackupLine(backup: RemoteBackup): string {
  const taken = new Date(backup.createdAt).toISOString();
  const mark = backup.kind === "pre-restore" ? "  [pre-restore — the undo of a restore]" : "";
  return (
    `${backup.backupId}  ${taken}  ${backup.entityCount} entities  ` +
    `epoch ${backup.epoch}@${backup.cutoffSeq}${mark}`
  );
}

/**
 * `staple cloud restore <backupId> --confirm <repositoryId>`.
 *
 * Shaped exactly like `purge`, because it is the other irreversible remote
 * operation and a human should recognise the ceremony: the disclosure prints
 * FIRST and unconditionally, and only then is the typed confirmation looked at.
 * A disclosure shown only to people who got the confirmation wrong is not a
 * disclosure.
 *
 * The workspace database is opened because a committed restore has a local
 * consequence — this device must re-bootstrap — and it is closed on every path,
 * including the ones that refuse before making a request.
 */
function runRestore(argv: string[]): void {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { ...common, confirm: { type: "string" } },
  });
  const json = values.json === true;
  const home = stapleHome();

  const backupId = positionals[0];
  if (!backupId) {
    throw new StapleError(
      "validation",
      "usage: staple cloud restore <backupId> --confirm <repositoryId>. " +
        "`staple cloud backup ls` lists the backups that exist.",
    );
  }

  const opened = resolveWorkspace(values);
  const manifest = readWorkspaceManifest(opened.dbPath);
  if (!manifest) {
    opened.store.db.close();
    throw noIdentity(opened.dbPath, "nothing to restore into");
  }
  const repositoryId = manifest.repositoryId;
  const status = localCloudStatus(home, repositoryId);

  if (status.state === "disconnected") {
    opened.store.db.close();
    throw new StapleError(
      "not_found",
      "This repository is not connected on this machine, so there is no service to restore from.",
    );
  }

  /**
   * The disclosure needs the backup's metadata, so this one request happens
   * before the confirmation is checked. It is a read, it changes nothing, and it
   * is the only way to tell a human what they are about to discard rather than
   * asking them to confirm an id.
   */
  settle(
    listBackups(home, repositoryId)
      .then(async (backups) => {
        const backup = backups.find((candidate) => candidate.backupId === backupId);
        if (!backup) {
          throw new StapleError(
            "not_found",
            `No backup ${backupId} on ${status.endpoint}. ` +
              `\`staple cloud backup ls\` lists the ones that exist.`,
          );
        }

        const disclosure = restoreDisclosure(
          status.endpoint ?? "",
          repositoryId,
          backup,
          localEpochOf(opened.store.db),
        );
        if (!json) {
          console.log(disclosure);
          console.log("");
        }

        if (values.confirm !== repositoryId) {
          const message =
            values.confirm === undefined
              ? `Nothing was restored. To proceed, re-run with --confirm ${repositoryId}`
              : `Nothing was restored: --confirm did not match this repository's id. ` +
                `Expected ${repositoryId}.`;
          if (json) console.error(JSON.stringify({ restored: false, message }));
          else console.error(message);
          process.exitCode = 2;
          return;
        }

        const report = await restoreFromBackup(opened.store.db, home, repositoryId, backupId);
        if (json) {
          console.log(JSON.stringify({ restored: true, ...report }, null, 2));
          return;
        }
        console.log("");
        console.log(
          `Restored ${report.entityCount} entities from ${report.backupId} in ${report.turns} ` +
            `${report.turns === 1 ? "request" : "requests"}.`,
        );
        console.log(`  epoch ${report.fromEpoch} -> ${report.toEpoch}`);
        if (report.preRestoreBackupId) {
          console.log(`  the way back: staple cloud restore ${report.preRestoreBackupId}`);
        }
        console.log("");
        console.log(
          "Every device, including this one, must re-bootstrap before it syncs again. " +
            "This device's cursor has been cleared; its pending work is untouched. Run " +
            "`staple cloud sync` to hydrate.",
        );
      })
      .finally(() => opened.store.db.close()),
    json,
  );
}
