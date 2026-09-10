/**
 * `staple hub registry` — the hub's own leg to a sync service (STA-283).
 *
 *   hub registry status                       local: is the hub connected, and is publishing on
 *   hub registry id                           local: this machine's hub id, for provisioning
 *   hub registry identity <hubId> [--yes]     local: take on an existing registry identity
 *   hub registry connect --endpoint U --token S [--label L] [--yes] [--credential-file]
 *   hub registry publish [--enable|--disable] consent, or publish now with neither flag
 *   hub registry adopt [--apply]              read the service's registry and adopt it
 *   hub registry locate <slug> --path <dir>   local: attach an absent row to a copy here
 *   hub registry ignore|unignore <repoId>     local: leave an identity out, or stop doing so
 *   hub registry backup <enable|disable|create|ls|rm <id>>
 *   hub registry restore <backupId> [--apply]
 *   hub registry disconnect [--yes]           local: drop this machine's credential
 *
 * Every subcommand takes `--json`.
 *
 * ## Why this is a terminal command and not only a page
 *
 * The acceptance criterion is *"the hub is restorable from the service after a
 * machine is lost"*, and the machine that was lost took the browser with it. On a
 * fresh box the recovery path is a shell, before there is a hub for `staple ui` to
 * describe. A module API with no invocable verb is not restorable by a person, so
 * the CLI is the surface that makes the criterion true; the settings page is the
 * convenience for a machine that is already working.
 *
 * ## The transport is loaded LATE, and that is structural rather than tidy
 *
 * `hub-registry-service.ts` is the only module in this feature that can reach the
 * network, and it is imported **exclusively** through `await import()` in
 * {@link loadService} — never at the top of this file. The pattern is `auto.ts`'s,
 * for its reason: *"the transport is loaded only via `await import()` after the
 * consent gate"*.
 *
 * What that buys, precisely, and it is worth being exact because the first version of
 * this paragraph overclaimed. `staple ls` already reaches `client.ts` statically through
 * `commands/cloud.ts`, so this file cannot make the CLI's import graph pure and does not
 * pretend to — and NOR are `status` and `id` on a transport-free path, as this comment
 * used to say: `import { settle } from "./cloud.js"` at the top pulls `status.ts`, which
 * pulls `client.ts`. That claim was false when written.
 *
 * What the deferral does buy is real and narrower: no NEW static edge to the service
 * module, so the registry leg's transport is loaded only when a registry verb that needs
 * it runs. The enforceable property is the one the contract states and the one
 * `test/cloud-hub-registry-cli.test.ts` asserts with a real subprocess spy: **no command
 * that is not supposed to talk to the network makes a call.** That is proven by running
 * the CLI, not by reading it — which is the only reason the false claim above was
 * harmless rather than load-bearing.
 *
 * ## Which of these can talk to the network
 *
 * `connect`, `publish` (the verb, not the consent flags), `adopt`, `backup` and
 * `restore`. NOT `status`, NOT `id`, NOT `identity`, and NOT `publish --enable` or
 * `--disable`: granting or withdrawing this consent has no server-side half, so
 * withdrawing it works with the network down — which is the point, since a consent
 * you cannot withdraw offline is not really revocable.
 */
import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { stapleHome } from "../config/home.js";
import { Hub } from "../core/hub.js";
import { readMeta } from "../core/open.js";
import { readWorkspaceManifest } from "../core/repo-identity.js";
import { WorkspaceStore } from "../core/store.js";
import { StapleError } from "../core/types.js";
import { readConnection } from "../core/cloud/connection.js";
import { confirm, isInteractive } from "../onboarding/prompts.js";
import { settle } from "./cloud.js";
import {
  REGISTRY_DISCLOSURE,
  describeIdentityReplacement,
  locateAbsent,
  type AdoptionDecision,
  type AdoptionReport,
  type CrossLinkOutcome,
} from "../core/cloud/hub-registry.js";

/**
 * The service module, loaded on demand.
 *
 * The one place `hub-registry-service.js` is named. See the header: a static import
 * here would put the transport on every path through this file, including the two
 * that are local by definition.
 */
async function loadService() {
  return import("../core/cloud/hub-registry-service.js");
}

const USAGE =
  "usage: staple hub registry " +
  "[status|id|identity|connect|disconnect|publish|adopt|locate|backup|restore|ignore|unignore]";

export function runHubRegistryCommand(argv: string[]): void {
  const sub = argv[0] && !argv[0].startsWith("-") ? argv[0] : "status";
  const rest = argv[0] && !argv[0].startsWith("-") ? argv.slice(1) : argv;

  switch (sub) {
    case "status":
      return runStatus(rest);
    case "id":
      return runId(rest);
    case "identity":
      return runIdentity(rest);
    case "connect":
      return runConnect(rest);
    case "publish":
      return runPublish(rest);
    case "adopt":
      return runAdopt(rest);
    case "backup":
      return runBackup(rest);
    case "restore":
      return runRestore(rest);
    case "ignore":
      return runIgnore(rest, true);
    case "unignore":
      return runIgnore(rest, false);
    case "locate":
      return runLocate(rest);
    case "disconnect":
      return runDisconnect(rest);
    default:
      throw new StapleError("validation", `Unknown subcommand "${sub}". ${USAGE}`);
  }
}

/**
 * Open the hub WITHOUT minting an identity.
 *
 * `Hub.open()` migrates, which is a write and is fine — every hub command does it.
 * What must not happen is `hubId()`, which mints and stores a UUID the first time
 * anything asks. A `status` that minted an identity as a side effect of being read
 * would hand this machine a registry id it never chose, and `identity` would then
 * refuse to adopt the real one on the strength of it.
 */
function openHub(): Hub {
  return Hub.open();
}

/**
 * Open the hub, run a synchronous prelude that may refuse, and close on the refusal.
 *
 * The async verbs below hand the handle to a promise chain that closes it in a
 * `.finally`, which covers every path once the chain exists. What it does not cover is
 * a prelude that throws BEFORE the chain is created — `requireHubId` on a machine with
 * no identity — and that path would otherwise leave the database open for the rest of
 * the process. Short-lived for a CLI, and still wrong: `Hub.open()` converts the
 * journal to WAL, so an abandoned handle leaves `-wal` and `-shm` files beside the hub.
 */
function withHub<T>(prelude: (hub: Hub) => T): { hub: Hub; value: T } {
  const hub = openHub();
  try {
    return { hub, value: prelude(hub) };
  } catch (error) {
    hub.close();
    throw error;
  }
}

/** The hub id, refusing rather than minting when there is not one yet. */
function requireHubId(hub: Hub, what: string): string {
  const stored = hub.storedHubId();
  if (stored === null) {
    throw new StapleError(
      "not_found",
      `This machine's hub has no registry identity yet, so there is nothing to ${what}. ` +
        "Either run `staple hub registry id` to mint one and have it provisioned on a " +
        "service, or run `staple hub registry identity <hubId>` to take on an identity " +
        "another machine already published under.",
    );
  }
  return stored;
}

// ------------------------------------------------------------------ local verbs

/**
 * `hub registry status` — local files only, and no round trip.
 *
 * Deliberately says nothing about the SERVICE's state — not the epoch, not when
 * anything was last published. Establishing either needs an authenticated request,
 * and a status command that made one would be a poll that costs money and fails
 * when the network is down. The three facts here all come from
 * `readConnection(home, hubId)`, which is the same file whose absence
 * `connection.ts` defines as "never connected".
 */
function runStatus(argv: string[]): void {
  const { values } = parseArgs({ args: argv, options: { json: { type: "boolean" } } });
  const json = values.json === true;
  const home = stapleHome();
  const hub = openHub();
  try {
    const hubId = hub.storedHubId();
    const connection = hubId === null ? null : readConnection(home, hubId);
    const report = {
      hubId,
      connected: connection !== null,
      endpoint: connection?.endpoint ?? null,
      /** This machine's publish consent. Absent means never granted. */
      publishConsent: connection?.registry === true,
      backupConsent: connection?.backup === true,
      registered: hub.list().length,
      crossLinks: hub.listCrossLinks().length,
      /**
       * Identities this machine has opted out of, and why (STA-283).
       *
       * On `status` because an opt-out SUPPRESSES adoption, and a suppression nobody can
       * see is worse than one they can. `registry_optouts` existed from hub migration 003
       * with two readers, no CLI verb, no `--json` field and no status line, so a `prune`
       * — reachable from MCP's hub hygiene, so an agent can cause it — silently declined
       * that identity on every future adopt with the reason buried in an `adopt` decision
       * nobody had a reason to run.
       *
       * Reported even when the hub has no registry identity, because `unregister` and
       * `prune` both write these whether or not this machine ever connected.
       */
      ignored: hub.listOptOuts().map((o) => ({
        repositoryId: o.repositoryId,
        slug: o.slug,
        reason: o.reason,
      })),
    };

    if (json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    /** The opt-out list, printed wherever we get to — see `report.ignored`. */
    const printIgnored = (): void => {
      if (report.ignored.length === 0) return;
      console.log("");
      console.log(`not adopted   ${report.ignored.length} identity/identities this machine opted out of`);
      for (const o of report.ignored) {
        console.log(`  - ${o.repositoryId}  ${o.slug} (${o.reason})`);
      }
      console.log("  Bring one back with: staple hub registry unignore <repositoryId>");
    };

    if (hubId === null) {
      console.log("This machine's hub has no registry identity yet.");
      console.log("  - `staple hub registry id` mints one, for an operator to provision");
      console.log("  - `staple hub registry identity <hubId>` takes on an existing one");
      printIgnored();
      return;
    }
    console.log(`hub id        ${hubId}`);
    console.log(`registry      ${report.connected ? `connected to ${report.endpoint}` : "not connected"}`);
    console.log(`publishing    ${report.publishConsent ? "on" : "OFF"}`);
    console.log(`hub backup    ${report.backupConsent ? "on" : "off"}`);
    console.log(`workspaces    ${report.registered} registered, ${report.crossLinks} cross-workspace link(s)`);
    printIgnored();
    if (!report.connected) {
      console.log("");
      console.log("  Connect with: staple hub registry connect --endpoint <url> --token <secret>");
    } else if (!report.publishConsent) {
      console.log("");
      console.log("  Nothing is being published. Publishing is a separate consent:");
      console.log("    staple hub registry publish --enable");
    }
  } finally {
    hub.close();
  }
}

/**
 * `hub registry id` — print the hub id, minting one if this machine has none.
 *
 * The one command that mints deliberately, because it is the one an operator runs
 * to find out what to provision. `worker/README.md`'s "Provisioning a HUB" names it
 * for exactly that.
 */
function runId(argv: string[]): void {
  const { values } = parseArgs({ args: argv, options: { json: { type: "boolean" } } });
  const hub = openHub();
  try {
    const existed = hub.storedHubId() !== null;
    const hubId = hub.hubId();
    if (values.json === true) {
      console.log(JSON.stringify({ hubId, minted: !existed }));
      return;
    }
    console.log(hubId);
    if (!existed) {
      console.log("");
      console.log("Minted just now, and stored in this machine's hub.");
      console.log("It is not a secret. A repository row for it has to be created on the");
      console.log("service out of band — staple cannot do it; see worker/README.md,");
      console.log('"Provisioning a HUB".');
    }
  } finally {
    hub.close();
  }
}

/**
 * `hub registry identity <hubId>` — take on an existing registry identity.
 *
 * The step that makes recovery possible at all, and the one easiest to leave out:
 * every test written on one machine passes without it, because that machine minted
 * the id it is using.
 *
 * ## The disclosure is unconditional, and that is not caution
 *
 * When this replaces an id, the old one may or may not have had a registry
 * published under it, and **this machine cannot tell**. `adoptRegistryIdentity`
 * refuses when a connection record exists for the old id, but `staple cloud
 * disconnect` deletes that record — its contract is to leave nothing behind — so
 * `connect → publish → disconnect → adopt` passes the check and orphans the old
 * registry remotely.
 *
 * So the sentence is printed whenever there is a previous id, and it is not
 * conditioned on evidence that does not exist. It also says the operation is
 * reversible, because it is: re-adopting the old id brings it back. That is what
 * makes this a confirmation rather than a refusal.
 */
function runIdentity(argv: string[]): void {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { json: { type: "boolean" }, yes: { type: "boolean" } },
  });
  const json = values.json === true;
  const target = positionals[0];
  if (!target) {
    throw new StapleError(
      "validation",
      "usage: staple hub registry identity <hubId> [--yes]\n" +
        "The hub id comes from the machine that published the registry — " +
        "`staple hub registry id` there, or from wherever you kept it with the " +
        "enrollment secret.",
    );
  }

  const home = stapleHome();
  const hub = openHub();
  try {
    const previous = hub.storedHubId();
    /**
     * The gate is OUTSIDE `!json`; only the printing is inside.
     *
     * This whole block used to be `... && !json`, which meant machine mode skipped both
     * the orphan notice and the `--yes` gate — so `identity <new> --json` replaced the
     * identity silently, exit 0, and the notice I was told to make unconditional was
     * false in exactly the mode a script uses. Third instance of the same shape in this
     * file; `runConnect` is the one that had it right.
     */
    if (previous !== null && previous !== target.trim()) {
      if (!json) {
        console.log(`This machine's hub currently has the identity ${previous}.`);
        console.log("");
        /**
         * The shared sentence. Printed from the constant rather than written here so the
         * settings page cannot word it differently — and stated as a fact about the id
         * rather than a warning about a state, because the state is not observable: a
         * disconnect leaves no evidence that the old id was ever used.
         */
        console.log(describeIdentityReplacement(previous));
      }
      if (values.yes !== true) {
        const agreed =
          !json && isInteractive() && confirm(`\nAdopt ${target.trim()} instead?`, { default: false });
        if (!agreed) {
          if (json) {
            // The notice travels in the refusal, so a machine caller cannot reach the
            // replacement without having received it first.
            console.error(
              JSON.stringify({
                code: "validation",
                message: `Replacing a registry identity needs --yes. ${describeIdentityReplacement(previous)}`,
                retryable: false,
                previousHubId: previous,
                notice: describeIdentityReplacement(previous),
              }),
            );
          } else {
            console.error(
              isInteractive()
                ? "\nDeclined. The identity is unchanged."
                : "\nNothing was changed. Re-run with --yes to adopt.",
            );
          }
          process.exitCode = 2;
          hub.close();
          return;
        }
      }
    }

    /**
     * The hub is closed inside the chain, NOT in a synchronous `finally`.
     *
     * An earlier version of this closed it in a `finally` wrapped round `settle`,
     * which reads as careful and is wrong: `settle` returns the instant the promise
     * is created, so the `finally` ran first and the async body then called
     * `storedHubId()` on a closed database — `ERR_INVALID_STATE: database is not
     * open`. Found by running the command rather than by reading it, which is the
     * only way this class of ordering bug shows up.
     */
    settle(
      loadService()
        .then(({ adoptRegistryIdentity }) => {
          const outcome = adoptRegistryIdentity(home, hub, target.trim());
          if (json) {
            console.log(
              JSON.stringify({
                hubId: target.trim(),
                ...outcome,
                // The notice rides on the success too, not only the refusal: a machine
                // that passed --yes still has to be able to record what it did.
                ...(outcome.previousHubId === null
                  ? {}
                  : { notice: describeIdentityReplacement(outcome.previousHubId) }),
              }),
            );
            return;
          }
          if (!outcome.adopted) {
            console.log(`Already this machine's hub identity: ${target.trim()}. Nothing changed.`);
            return;
          }
          console.log(`This machine's hub is now ${target.trim()}.`);
          if (outcome.previousHubId !== null) {
            console.log(`  previous identity ${outcome.previousHubId} — see the note above`);
          }
          console.log("  connect it with: staple hub registry connect --endpoint <url> --token <secret>");
        })
        .finally(() => hub.close()),
      json,
    );
  } catch (error) {
    hub.close();
    throw error;
  }
}

// ---------------------------------------------------------------- network verbs

/**
 * `hub registry connect` — connect the hub as a repository.
 *
 * Shows before it asks, like `cloud connect`, and for the same reason: the preview
 * is built by `buildConnectPreview`, whose module cannot reach the network at all,
 * and no code path here connects without one.
 */
function runConnect(argv: string[]): void {
  const { values } = parseArgs({
    args: argv,
    options: {
      json: { type: "boolean" },
      endpoint: { type: "string" },
      token: { type: "string" },
      label: { type: "string" },
      yes: { type: "boolean" },
      "credential-file": { type: "boolean" },
    },
  });
  const json = values.json === true;
  if (!values.endpoint) {
    throw new StapleError(
      "validation",
      "usage: staple hub registry connect --endpoint <url> --token <secret> [--label L] [--yes]",
    );
  }

  const home = stapleHome();
  /**
   * `requireHubId`, NOT `hub.hubId()`.
   *
   * Minting here was a real bug and its symptom was misleading: connect invented a
   * fresh UUID, the service had of course never heard of it, and the failure came back
   * as "not provisioned" — sending the reader to an operator to provision an id that
   * this machine had just made up, when the actual mistake was skipping
   * `hub registry identity`. Refusing up front names the real remedy.
   */
  const { hub, value: hubId } = withHub((h) => requireHubId(h, "connect"));

  settle(
    loadService()
      .then(async ({ buildHubRegistryPreview, connectHubRegistry, isNotProvisioned }) => {
        const preview = buildHubRegistryPreview({
          home,
          hub,
          endpoint: values.endpoint!,
          ...(values.label === undefined ? {} : { label: values.label }),
          credential: { forceFile: values["credential-file"] === true },
        });

        if (!json) {
          const { renderConnectPreview } = await import("../core/cloud/preview.js");
          console.log(renderConnectPreview(preview));
          console.log("");
          console.log("This is the HUB's own connection, not a workspace's. It is what lets this");
          console.log("machine publish and restore its workspace LIST. It does not publish the");
          console.log("list — that is a separate consent, `staple hub registry publish --enable`.");
        }

        if (values.yes !== true) {
          if (!(isInteractive() && confirm("\nConnect this machine's hub?", { default: false }))) {
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
            "An enrollment credential is required: --token <secret>. For a hub this is the " +
              "enrollment secret whoever runs the service created alongside the hub's " +
              "repository row. Nothing was sent.",
          );
        }

        try {
          const outcome = await connectHubRegistry(preview, {
            home,
            enrollmentSecret: values.token,
            credential: { forceFile: values["credential-file"] === true },
          });
          if (json) {
            console.log(
              JSON.stringify(
                {
                  connection: outcome.connection,
                  capabilities: outcome.capabilities,
                  credentialLocation: outcome.credentialLocation,
                },
                null,
                2,
              ),
            );
            return;
          }
          console.log(`\nConnected this machine's hub to ${outcome.connection.endpoint}.`);
          console.log(`  hub id      ${hubId}`);
          console.log(`  device      ${outcome.connection.deviceId}`);
          console.log(`  credential  ${outcome.credentialLocation}`);
          console.log("  PUBLISHING IS OFF. Nothing about your workspaces has been uploaded.");
          console.log("    turn it on with: staple hub registry publish --enable");
        } catch (error) {
          /**
           * The one failure that is not a bug, named as itself.
           *
           * `connectHubRegistry` has already replaced the message; this branch exists
           * so the CLI can add the exit code and keep the sentence off a stack trace.
           * See `worker/src/devices.ts`: an unknown repository id is `forbidden`
           * deliberately, so that a caller cannot enumerate which ids the service
           * knows about — which means "not provisioned" and "not a member" are the
           * same wire answer and always will be.
           */
          if (isNotProvisioned(error) && !json) {
            console.error(`\nerror(forbidden): ${(error as Error).message}`);
            process.exitCode = 4;
            return;
          }
          throw error;
        }
      })
      .finally(() => hub.close()),
    json,
  );
}

/**
 * `hub registry publish` — the consent with `--enable`/`--disable`, the act with
 * neither.
 *
 * One verb for both because the error message a person is most likely to arrive
 * here from says `staple hub registry publish --enable`, and a command that did not
 * exist under the name it was told to run would be worse than the overload.
 *
 * `--enable` and `--disable` make **no network call**. This consent has no
 * server-side half — there is no wire spelling for "this machine may describe
 * itself" — so withdrawing it works with the service unreachable, which is what
 * makes it genuinely revocable.
 */
function runPublish(argv: string[]): void {
  const { values } = parseArgs({
    args: argv,
    options: {
      json: { type: "boolean" },
      enable: { type: "boolean" },
      disable: { type: "boolean" },
      yes: { type: "boolean" },
    },
  });
  const json = values.json === true;
  if (values.enable === true && values.disable === true) {
    throw new StapleError(
      "validation",
      "--enable and --disable are two different decisions. Pass one.",
    );
  }

  const home = stapleHome();
  const { hub, value: hubId } = withHub((h) => requireHubId(h, "publish"));

  if (values.enable === true || values.disable === true) {
    const enabled = values.enable === true;
    settle(
      loadService()
        .then(async (service) => {
          const { setRegistryConsent, registryDisclosure } = service;
          /**
           * Established BEFORE the disclosure is printed, not after.
           *
           * The first version printed the whole consent screen and then failed with
           * `not_found` — and with `setConsent`'s generic wording, which says "run
           * `staple cloud connect`" and sends the reader to a workspace's connection to
           * fix a hub's. Showing somebody a decision you cannot act on, and then naming
           * the wrong remedy, is two mistakes in the one moment you had their attention.
           */
          const connection = service.requireHubRegistryConnection(home, hubId);
          if (enabled) {
            /**
             * The disclosure, printed BEFORE the flag is written and taken from the module
             * rather than retyped. `REGISTRY_DISCLOSURE` is the one sentence and
             * `registryDisclosure()` is the block around it; a surface with its own wording
             * is a surface whose wording is the one nobody reviewed.
             */
            if (!json) console.log(registryDisclosure(connection.endpoint));

            /**
             * The agreement gate, and it applies in `--json` MODE TOO.
             *
             * This whole branch used to be `if (enabled && !json)`, which made `--json` a
             * way around both halves at once: `publish --enable --json` granted the
             * consent having displayed nothing and having asked nothing, with no `--yes`.
             * The acknowledgement `setRegistryConsent` requires was then supplied by this
             * command on the caller's behalf — which spends the check rather than
             * honouring it, exactly as a server filling in a client's argument would.
             *
             * A machine consumer gets the sentence in the REFUSAL, so the only way to
             * reach the grant is to have been told what it discloses and then to say
             * `--yes` deliberately. That is the same shape as the connect preview: the
             * disclosure travels out first, and consent comes back referring to it.
             */
            if (values.yes !== true) {
              const agreed = !json && isInteractive()
                && confirm("\nPublish this machine's registry?", { default: false });
              if (!agreed) {
                if (json) {
                  /**
                   * The WHOLE disclosure reaches a machine consumer, not just the sentence.
                   *
                   * `disclosure` is the one-sentence core, and it was all `--json` ever got.
                   * The block around it is the rest of what a person agrees to: what is and
                   * is not uploaded, and what publishing from several machines does (names
                   * sent once, nothing another machine published removed, adopt takes on
                   * what this machine lacks). So "stated at the point of consent" was true
                   * only on a TTY, in the command whose own fix was titled "--json was a way
                   * around the publish consent's agreement gate". Same principle, one field
                   * further out.
                   */
                  console.error(
                    JSON.stringify({
                      code: "validation",
                      message:
                        "Enabling this consent needs --yes. What it discloses: " +
                        REGISTRY_DISCLOSURE,
                      retryable: false,
                      disclosure: REGISTRY_DISCLOSURE,
                      disclosureBlock: registryDisclosure(connection.endpoint),
                    }),
                  );
                } else {
                  console.error(
                    isInteractive()
                      ? "\nDeclined. Nothing has been uploaded and the consent is unchanged."
                      : "\nNothing was changed. Re-run with --yes to enable publishing.",
                  );
                }
                process.exitCode = 2;
                return;
              }
            }
          }

          // The acknowledgement the setter now requires when enabling: the exact sentence
          // this command printed above. Withdrawing needs none.
          const outcome = enabled
            ? setRegistryConsent(home, hubId, true, REGISTRY_DISCLOSURE)
            : setRegistryConsent(home, hubId, false);
          if (json) {
            console.log(
              JSON.stringify({
                enabled: outcome.enabled,
                disclosure: REGISTRY_DISCLOSURE,
                // On the grant too, so a consumer that stores what it agreed to stores all
                // of it rather than the headline.
                ...(outcome.enabled
                  ? { disclosureBlock: registryDisclosure(connection.endpoint) }
                  : {}),
              }),
            );
            return;
          }
          if (outcome.enabled) {
            console.log("\nPublishing is ON for this machine's hub.");
            console.log("  - nothing has been uploaded yet; `staple hub registry publish` does that");
            console.log("  - this changed no other consent");
          } else {
            console.log("Publishing is OFF for this machine's hub.");
            console.log("  - what was already published was NOT deleted");
            console.log("  - no network call was needed to withdraw this");
          }
        })
        .finally(() => hub.close()),
      json,
    );
    return;
  }

  settle(
    loadService()
      .then(async ({ publishRegistry }) => {
        const report = await publishRegistry(hub, home);
        if (json) {
          console.log(JSON.stringify(report, null, 2));
          return;
        }
        const unadopted =
          report.unadopted.registrations.length + report.unadopted.crossLinks.length;
        if (report.upToDate) {
          /**
           * "Already published" means the service holds everything this machine can say.
           * The lines below still apply: a different name, a link left alone, or entries
           * this machine lacks are all normal with `upToDate` true.
           */
          console.log(
            "Nothing to send. The service already holds everything this machine can publish.",
          );
        } else {
          console.log(
            `Published ${report.published} operation(s) in ${report.batches} batch(es): ` +
              `${report.created} new, ${report.updated} changed.`,
          );
          /**
           * Surfaced, and it should always be zero. The snapshot diff excludes anything
           * that already landed, so a deduplicated operation means an id collided with
           * its own past — the failure mode that twice reported success while changing
           * nothing. Silence about it is what let it live.
           */
          if (report.deduplicated > 0) {
            console.error(
              `\n! ${report.deduplicated} operation(s) were deduplicated by the service rather ` +
                "than applied. That should not happen — the registry on the service may not " +
                "match this machine. Please report this.",
            );
            process.exitCode = 4;
          }
        }
        const links = (refs: readonly { blockerIdentifier: string; blockedIdentifier: string }[]) =>
          refs.map((r) => `${r.blockerIdentifier} -> ${r.blockedIdentifier}`).join(", ");
        if (report.retracted.length > 0) {
          console.log(`  removed from the registry: ${links(report.retracted)}`);
        }
        if (report.relinked.length > 0) {
          console.log(`  linked again in the registry: ${links(report.relinked)}`);
        }
        /**
         * Informational only. Names are create-only, so nothing was sent for these and
         * nothing was overwritten. The registry keeps the name its first writer chose.
         */
        if (report.renamed.length > 0) {
          console.log("");
          console.log(
            `${report.renamed.length} workspace(s) have a different name here from the registry's. ` +
              "Nothing was changed on either side:",
          );
          for (const item of report.renamed) {
            console.log(`  ${item.entityId}`);
            if (item.local !== item.published) {
              console.log(`    this machine calls it "${item.local}"; the registry calls it "${item.published}"`);
            }
            if (item.localPrefix !== undefined) {
              console.log(
                `    prefix ${item.localPrefix} here; ${item.publishedPrefix} in the registry, so ` +
                  `${item.publishedPrefix}-N links from other machines don't land here`,
              );
            }
            if (item.localKind !== undefined) {
              console.log(`    kind ${item.localKind} here; ${item.publishedKind} in the registry`);
            }
          }
        }
        if (report.retained.length > 0) {
          console.log("");
          console.log(
            report.retained.length === 1
              ? "1 published entry was left exactly as it was:"
              : `${report.retained.length} published entries were left exactly as they were:`,
          );
          for (const item of report.retained) {
            console.log(`  ${item.reason}`);
          }
        }
        if (unadopted > 0) {
          console.log("");
          console.log(
            `The service holds ${unadopted} entr${unadopted === 1 ? "y" : "ies"} this machine doesn't have. ` +
              `Publishing left ${unadopted === 1 ? "it" : "them"} alone. \`staple hub registry adopt\` ` +
              `previews taking ${unadopted === 1 ? "it" : "them"} on:`,
          );
          for (const r of report.unadopted.registrations) {
            console.log(`  workspace "${r.slug}"  ${r.entityId}`);
          }
          for (const l of report.unadopted.crossLinks) {
            console.log(`  link ${l.blockerIdentifier} -> ${l.blockedIdentifier}`);
          }
        }
        if (report.unpublishable.length > 0) {
          console.log("");
          console.log(`${report.unpublishable.length} workspace(s) could not be published:`);
          for (const item of report.unpublishable) {
            console.log(`  ${item.entry.slug}`);
            console.log(`    ${item.reason}`);
          }
        }
        if (report.unpublishableLinks.length > 0) {
          console.log("");
          console.log(`${report.unpublishableLinks.length} link(s) could not be published:`);
          for (const item of report.unpublishableLinks) {
            console.log(`  ${item.reason}`);
          }
        }
      })
      .finally(() => hub.close()),
    json,
  );
}

/**
 * One decision per incoming entry, rendered.
 *
 * A count tells an operator nothing about the two rows that parked, and parked rows
 * are the entire reason adoption reports rather than resolves. So every decision
 * gets a line and its own sentence — `hub-registry.ts` guarantees `reason` is never
 * empty and never a code, which is what makes this printable rather than a lookup
 * table maintained here.
 */
/**
 * @param after What has ALREADY happened, for the footer. See the `dryRun` branch.
 */
function renderDecisions(
  report: AdoptionReport,
  describe: (r: AdoptionReport) => string,
  after: "nothing" | "service_already_restored" = "nothing",
): void {
  console.log(describe(report));
  if (report.decisions.length > 0) console.log("");
  for (const decision of report.decisions) {
    console.log(`  ${outcomeLabel(decision)}  ${decision.entry.slug}`);
    console.log(`    ${decision.reason}`);
  }
  /**
   * Every link line except `current`, each with its own sentence. A link that is already
   * here needs no line, and the summary above counts it. A skipped or kept-removed link
   * is exactly what a person needs to read, and the reason says why.
   */
  const linkLines = report.crossLinkDecisions.filter((d) => d.outcome !== "current");
  if (linkLines.length > 0) {
    console.log("");
    console.log("  cross-workspace links:");
    for (const decision of linkLines) {
      console.log(`    ${linkOutcomeLabel(decision.outcome, report.dryRun)}  ${decision.reason}`);
    }
  }
  if (report.dryRun) {
    console.log("");
    /**
     * The footer has to know what already happened, and this is why it takes a parameter.
     *
     * `restore --yes` without `--apply` performs the whole DESTRUCTIVE half — the service is
     * rewound to a new epoch, everything published since is discarded, a pre-restore backup
     * is minted — and then only the LOCAL adoption is previewed. This footer said "Nothing
     * was written. Re-run with --apply to make these changes", four lines under
     * `Restored on the service: epoch 1 -> 2`. Both halves were wrong: something very
     * large was written, and the invited re-run performs a SECOND destructive restore.
     *
     * `runRestore`'s own docstring claimed "`--apply` gates only the LOCAL half, and the
     * wording says so." It did not, because this function could not tell an adopt preview
     * from a restore aftermath. Now it is told.
     */
    if (after === "service_already_restored") {
      console.log(
        "The service HAS been restored — that half is done and is not a preview. What was " +
          "not written is this machine's own hub: the rows above are what adopting would " +
          "change here.",
      );
      console.log(
        "  Re-run with --apply AND --yes to apply them locally. Note that doing so restores " +
          "the service again, which is safe but costs another epoch; the undo id printed " +
          "above is from this run.",
      );
      return;
    }
    console.log("Nothing was written. Re-run with --apply to make these changes.");
  }
}

/** A fixed-width label per link outcome, in the tense of the report. */
function linkOutcomeLabel(outcome: CrossLinkOutcome, preview: boolean): string {
  const labels: Record<CrossLinkOutcome, string> = {
    added: preview ? "to link     " : "linked      ",
    current: "current     ",
    skipped: "skipped     ",
    removed: preview ? "to remove   " : "removed     ",
    kept_removed: "kept removed",
    kept_linked: "kept linked ",
  };
  return labels[outcome];
}

/** A fixed-width label per outcome, so a column of them reads as a column. */
function outcomeLabel(decision: AdoptionDecision): string {
  const labels: Record<AdoptionDecision["outcome"], string> = {
    current: "current    ",
    adopted: "adopted    ",
    absent: "absent     ",
    declined: "skipped    ",
    conflict: "PARKED     ",
    unmatchable: "no identity",
  };
  return labels[decision.outcome];
}

/**
 * `hub registry adopt` — read the service's registry and adopt it. Previews by
 * default.
 *
 * The everyday path for a second machine, and the first half of recovery for a
 * replacement one: it has lost nothing, it simply wants the set another machine
 * published. `restore` is for when the SERVICE's current state is also wrong.
 */
function runAdopt(argv: string[]): void {
  const { values } = parseArgs({
    args: argv,
    options: { json: { type: "boolean" }, apply: { type: "boolean" } },
  });
  const json = values.json === true;
  const home = stapleHome();
  const { hub } = withHub((h) => requireHubId(h, "adopt a registry into"));

  settle(
    loadService()
      .then(async (service) => {
        const { registry, adoption } = await service.adoptPublishedRegistry(hub, home, {
          apply: values.apply === true,
        });
        if (json) {
          console.log(JSON.stringify({ registry, adoption }, null, 2));
          return;
        }
        const { describeAdoption } = await import("../core/cloud/hub-registry.js");
        renderDecisions(adoption, describeAdoption);
      })
      .finally(() => hub.close()),
    json,
  );
}

/** `hub registry backup` — point-in-time copies of the registry, a further consent. */
function runBackup(argv: string[]): void {
  const subs = new Set(["enable", "disable", "create", "ls", "rm"]);
  /**
   * A typo is REFUSED, not silently treated as `ls`.
   *
   * Defaulting an unrecognised word to `ls` made `backup enabel` a network call that
   * listed backups — doing something the person did not ask for, against a paid service,
   * and reporting success. A bare `backup` still means `ls`, because that is a choice
   * rather than a mistake.
   */
  const first = argv[0];
  if (first !== undefined && !first.startsWith("-") && !subs.has(first)) {
    throw new StapleError(
      "validation",
      `Unknown backup subcommand "${first}". ` +
        "usage: staple hub registry backup [enable|disable|create|ls|rm <backupId>]",
    );
  }
  const sub = first && subs.has(first) ? first : "ls";
  const rest = first && subs.has(first) ? argv.slice(1) : argv;

  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: { json: { type: "boolean" }, label: { type: "string" }, yes: { type: "boolean" } },
  });
  const json = values.json === true;
  const home = stapleHome();
  const { hub, value: hubId } = withHub((h) => requireHubId(h, "back up"));

  settle(
    loadService()
      .then(async (service) => {
        if (sub === "enable" || sub === "disable") {
          const outcome = await service.setHubBackupConsent(home, hubId, sub === "enable");
          if (json) {
            console.log(JSON.stringify(outcome));
          } else if (outcome.enabled) {
            console.log("Hub backup is on. Take one with: staple hub registry backup create");
            console.log("  - a separate decision from publishing; it changed no other consent");
          } else {
            console.log("Hub backup is off on this machine. Existing backups were NOT deleted.");
          }
          if (outcome.warning) {
            console.error(`\n! ${outcome.warning}`);
            process.exitCode = 4;
          }
          return;
        }

        if (sub === "create") {
          const backup = await service.createHubBackup(home, hubId, values.label ?? null);
          if (json) {
            console.log(JSON.stringify({ backup }, null, 2));
            return;
          }
          console.log(`Backed up the registry as ${backup.backupId}.`);
          console.log(`  ${backup.entityCount} entities, epoch ${backup.epoch}, sequence ${backup.cutoffSeq}`);
          const { HUB_BACKUP_HEADLINE } = await import("../core/cloud/hub-registry.js");
          console.log(`  ${HUB_BACKUP_HEADLINE}`);
          return;
        }

        if (sub === "ls") {
          const backups = await service.listHubBackups(home, hubId);
          if (json) {
            console.log(JSON.stringify({ backups }, null, 2));
            return;
          }
          if (backups.length === 0) {
            console.log("No hub backups. Take one with: staple hub registry backup create");
            return;
          }
          for (const backup of backups) {
            console.log(
              `${backup.backupId}  ${new Date(backup.createdAt).toISOString().slice(0, 19)}  ` +
                `${String(backup.entityCount).padStart(4)} entities  ${backup.kind}`,
            );
          }
          return;
        }

        const target = positionals[0];
        if (!target) {
          throw new StapleError("validation", "usage: staple hub registry backup rm <backupId>");
        }

        /**
         * The gate `rm` never had, in EITHER mode.
         *
         * `--yes` was declared in this function's options and never read — which is worse
         * than omitting it, because an operator who types it habitually got no error and no
         * confirmation. Found by grepping for declared-but-unread options rather than for
         * `!json`, since there was no `!json` here to find.
         *
         * It composes into real damage with the restore path: `runRestore` prints
         * "undo with: staple hub registry restore <preRestoreBackupId>", and one unconfirmed
         * `backup rm` of that id destroys the only undo for an epoch-rewinding, fleet-wide
         * restore — previously exiting 0 having printed nothing.
         *
         * `cloud.ts` gates the workspace twin the same way, and this now matches it.
         */
        if (values.yes !== true) {
          /**
           * The notice makes NO REQUEST, and the first version of it did.
           *
           * It called `listHubBackups` to report whether the doomed backup was a
           * `pre-restore` copy — which is useful, and put a network call inside a gate whose
           * whole job is to refuse BEFORE anything is sent. The subprocess test caught it as
           * exit 4 rather than 2, which is the right way to find out.
           *
           * So the pre-restore case is covered by wording that does not need to know:
           * whatever this id is, saying what a pre-restore copy would mean costs nothing and
           * is true of the ones that matter most.
           */
          const lines = [
            `Deleting hub backup ${target}.`,
            "  - a backup is the only way back to a moment; this destroys that one",
            "  - if it is a PRE-RESTORE copy, it is the undo for a restore somebody ran, and",
            "    deleting it makes that restore permanent. `backup ls` shows each one's kind.",
            "  - it does not affect the registry itself, or any other backup",
          ];
          if (!json) for (const line of lines) console.log(line);
          const agreed =
            !json && isInteractive() && confirm(`\nDelete backup ${target}?`, { default: false });
          if (!agreed) {
            if (json) {
              console.error(
                JSON.stringify({
                  code: "validation",
                  message: `Deleting a hub backup needs --yes. ${lines.join(" ")}`,
                  retryable: false,
                  backupId: target,
                  notice: lines,
                }),
              );
            } else {
              console.error(
                isInteractive()
                  ? "\nDeclined. The backup is intact."
                  : "\nNothing was deleted. Re-run with --yes.",
              );
            }
            process.exitCode = 2;
            return;
          }
        }

        await service.deleteHubBackup(home, hubId, target);
        if (json) console.log(JSON.stringify({ backupId: target, deleted: true }));
        else console.log(`Deleted hub backup ${target}.`);
      })
      .finally(() => hub.close()),
    json,
  );
}

/**
 * `hub registry restore <backupId>` — restore on the service, then adopt what comes
 * back. Previews the adoption by default.
 *
 * Two halves, and the second is why this is not a wrapper round a route. The
 * restore leaves the SERVICE holding the backed-up registry on a fresh epoch; that
 * is worth nothing on its own to a machine whose hub is empty. So the restored
 * epoch is read back and handed to `adoptRegistry`, whose rules are what make it
 * safe on a machine that is not empty — this machine's stamps win, no prefix is ever
 * renumbered, collisions park, and an opted-out identity stays out.
 *
 * Note what `--apply` does and does not gate. The remote restore is NOT a preview:
 * by the time the adoption is shown, the service has already moved epoch, and the
 * undo for that is the pre-restore backup this prints. `--apply` gates the LOCAL
 * half only, and the output says so rather than letting a reader assume otherwise.
 */
function runRestore(argv: string[]): void {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { json: { type: "boolean" }, apply: { type: "boolean" }, yes: { type: "boolean" } },
  });
  const json = values.json === true;
  const target = positionals[0];
  if (!target) {
    throw new StapleError(
      "validation",
      "usage: staple hub registry restore <backupId> [--apply]\n" +
        "List them with: staple hub registry backup ls",
    );
  }

  const home = stapleHome();
  const { hub } = withHub((h) => requireHubId(h, "restore into"));

  /**
   * The gate is OUTSIDE `!json`, and this is the instance that mattered most.
   *
   * It used to be `if (!json && values.yes !== true)`, so `restore <id> --json` skipped
   * the whole disclosure AND the confirmation and went straight to the remote restore —
   * which moves the epoch, discards everything published since the backup, and affects
   * every machine on that hub id. Only the unrelated backup-consent check stood in the
   * way, and anyone who has taken a backup has that consent. A destructive, fleet-wide,
   * one-keystroke operation with no confirmation is precisely what `cloud.ts` refuses to
   * let `disconnect --purge` be.
   *
   * `--apply` gates only the LOCAL half, and the wording says so: by the time an
   * adoption is shown the service has already moved.
   */
  const restoreNotice = [
    "Restoring rewinds the registry ON THE SERVICE to this backup.",
    "  - the service moves to a new epoch; work published since is discarded",
    "  - every machine on this hub id is affected, not just this one",
    "  - a pre-restore copy is taken first, and this prints its id",
    "  - your local hub is only changed if you pass --apply",
  ];
  if (values.yes !== true) {
    if (!json) for (const line of restoreNotice) console.log(line);
    const agreed =
      !json && isInteractive() && confirm(`\nRestore from ${target}?`, { default: false });
    if (!agreed) {
      if (json) {
        console.error(
          JSON.stringify({
            code: "validation",
            message: `Restoring needs --yes. ${restoreNotice.join(" ")}`,
            retryable: false,
            notice: restoreNotice,
          }),
        );
      } else {
        console.error(
          isInteractive()
            ? "\nDeclined. Nothing was changed, here or on the service."
            : "\nNothing was changed. Re-run with --yes to restore.",
        );
      }
      process.exitCode = 2;
      hub.close();
      return;
    }
  }

  settle(
    loadService()
      .then(async (service) => {
        const report = await service.restoreRegistry(hub, home, target, {
          apply: values.apply === true,
        });
        if (json) {
          console.log(JSON.stringify(report, null, 2));
          return;
        }
        console.log(
          `\nRestored on the service: epoch ${report.fromEpoch} -> ${report.toEpoch}, ` +
            `${report.entityCount} entities, ${report.turns} turn(s).`,
        );
        if (report.preRestoreBackupId !== null) {
          console.log(`  undo with: staple hub registry restore ${report.preRestoreBackupId}`);
        }
        console.log("");
        const { describeAdoption } = await import("../core/cloud/hub-registry.js");
        // The service half is already done by the time we get here — see the footer.
        renderDecisions(report.adoption, describeAdoption, "service_already_restored");
      })
      .finally(() => hub.close()),
    json,
  );
}

/**
 * `hub registry ignore <repositoryId>` / `unignore <repositoryId>` — this machine's own
 * opt-out list, made reachable.
 *
 * `registry_optouts` has existed since hub migration 003 and had no CLI verb, which left two
 * things unreachable. The publish refusal can now name a real escape for an entry adoption
 * PARKS — a prefix collision adoption will not renumber, which otherwise made publishing
 * permanently impossible with no local way out, because the opt-out set is keyed on
 * `repositoryId` and there is no local row to `hub unregister`. And `adoptRegistry`'s
 * `declined` outcome said "undo with ..." and named nothing that existed.
 *
 * Local only, and it never leaves the machine — that is the whole point of the table, and
 * what makes `staple hub unregister` a local act rather than a propagated delete.
 */
function runIgnore(argv: string[], ignoring: boolean): void {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { json: { type: "boolean" }, slug: { type: "string" } },
  });
  const json = values.json === true;
  const target = positionals[0];
  const verb = ignoring ? "ignore" : "unignore";
  if (!target) {
    throw new StapleError(
      "validation",
      `usage: staple hub registry ${verb} <repositoryId>\n` +
        "The id is the one `staple hub registry publish` names in its refusal, or the " +
        "`repositoryId` of a row in `staple hub ls --json`.",
    );
  }

  const hub = openHub();
  try {
    if (ignoring) {
      /**
       * REFUSED on a live row, because this is the exact contradiction the C1 fix forbids.
       *
       * `Hub.recordRepositoryId` retires an opt-out the moment an identity binds to a row,
       * so "an opt-out never coexists with a registered row for the same identity" is the
       * invariant. This verb wrote one straight past it — and the usage text above points
       * the user at "the `repositoryId` of a row in `staple hub ls --json`", i.e. at live
       * rows, so it was an easy thing to do by following the instructions.
       *
       * What that produced, in one command's output about one row:
       *
       *     workspaces   2 registered, 1 cross-workspace link(s)
       *     not adopted  - 22d08ff6-…  (not registered here) (ignored)
       *
       * And it did not self-heal, because `initWorkspace` and `reconcileRepositoryIds` only
       * call `recordRepositoryId` when the value CHANGES — and for a row that already holds
       * its identity it does not change. So the write is the only place to catch it.
       *
       * `unregister` is the verb that actually removes a workspace from this machine, and it
       * records the opt-out itself. Naming it is the whole remedy.
       */
      const live = hub.findByRepositoryId(target.trim());
      if (live) {
        throw new StapleError(
          "conflict",
          `${target.trim()} is registered on this machine right now, as "${live.slug}"` +
            `${live.available ? "" : " (its database is not on this machine)"}. Ignoring is for ` +
            "an identity this machine does NOT have — the two together would say both things " +
            "about one workspace, and `staple hub registry status` would report it as " +
            "registered and not-registered at once. Nothing was changed. To stop listing it " +
            `here, run \`staple hub unregister ${live.slug}\`, which removes the row and ` +
            "records the opt-out for you.",
        );
      }
      hub.addOptOut(target.trim(), values.slug ?? "(not registered here)", "ignored");
      if (json) console.log(JSON.stringify({ repositoryId: target.trim(), ignored: true }));
      else {
        console.log(`This machine will leave ${target.trim()} out of its own registry.`);
        console.log("  - it stays published, and stays on every other machine");
        console.log("  - adopting will not bring it back here until you `unignore` it");
        console.log("  - nothing was sent; this is a local list that never leaves the machine");
      }
      return;
    }
    const cleared = hub.clearOptOut(target.trim());
    if (json) console.log(JSON.stringify({ repositoryId: target.trim(), cleared }));
    else if (cleared) {
      console.log(`${target.trim()} is no longer ignored. The next adopt may bring it back.`);
    } else {
      console.log(`${target.trim()} was not on this machine's ignore list. Nothing changed.`);
    }
  } finally {
    hub.close();
  }
}

/**
 * `hub registry locate <slug> --path <dir>` — attach an absent row to a copy on this machine.
 *
 * ## Why this verb had to exist before this PR could land
 *
 * `locateAbsent` has been in `hub-registry.ts` since the first commit of this epic, complete
 * with the three refusals that make it safe to offer, and NOTHING called it. That made the
 * `absent` decision a dead end: adoption registered a placeholder row and told the operator
 * to "point this row at it", naming no way to do so. Restoring a registry onto a machine that
 * already holds some of the clones is the ordinary case, so the dead end was on the main
 * recovery path rather than at the edge of it.
 *
 * ## Why it takes a path instead of searching
 *
 * A crawl is `staple discover`, it is slow, and it guesses. This verb is for the operator who
 * already knows where the workspace is — and `locateAbsent` then refuses unless the directory's
 * own identity matches the row's, because *"the operator cannot be expected to"* check that
 * and pointing a registry row at the wrong repository is silent and durable.
 *
 * The identity and the prefix are read from the candidate itself, never taken as arguments:
 * they are facts about that directory, and accepting them from the command line would let a
 * confident typo satisfy the very check that exists to catch it.
 */
function runLocate(argv: string[]): void {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { json: { type: "boolean" }, path: { type: "string" } },
  });
  const json = values.json === true;
  const slug = positionals[0];
  if (!slug || values.path === undefined) {
    throw new StapleError(
      "validation",
      "usage: staple hub registry locate <slug> --path <directory>\n" +
        "The slug is the one `staple hub registry adopt` listed as absent, and the directory is " +
        "the workspace's own root — the one holding `.staple/`. The identity is read from there " +
        "and must match, so a wrong directory is refused rather than attached.",
    );
  }

  const hub = openHub();
  try {
    const dbPath = resolveWorkspaceDb(values.path);
    const found = probeCandidate(dbPath);
    const row = locateAbsent(hub, slug, {
      path: dbPath,
      prefix: found.prefix,
      repositoryId: found.repositoryId,
    });
    if (json) {
      console.log(JSON.stringify({ slug: row.slug, path: row.path, prefix: row.prefix }, null, 2));
      return;
    }
    console.log(`"${row.slug}" now points at ${row.path}`);
    console.log("  - nothing was renumbered, and no request was made");
    console.log("  - `staple hub ls` should now show it as available");
  } finally {
    hub.close();
  }
}

/**
 * A workspace root, or the database inside one, resolved to the database path.
 *
 * Both spellings are accepted because both are things a person reasonably types, and the
 * error when neither exists names the layout rather than the failed `open`.
 */
function resolveWorkspaceDb(given: string): string {
  const direct = resolve(given);
  if (existsSync(direct) && statSync(direct).isFile()) return direct;
  const nested = join(direct, ".staple", "staple.db");
  if (existsSync(nested)) return nested;
  throw new StapleError(
    "not_found",
    `No staple workspace at ${direct}. Expected either the workspace root (holding ` +
      "`.staple/staple.db`) or that database file itself. Nothing was changed.",
  );
}

/**
 * The candidate's own prefix and identity, read WITHOUT migrating it.
 *
 * Read-only for the same reason `discovery.ts` is: a directory being offered as a candidate
 * is something to check, not something to convert to WAL or migrate. A refusal must be able
 * to leave the stranger's database exactly as it was.
 */
function probeCandidate(dbPath: string): { prefix: string; repositoryId: string | null } {
  const repositoryId = readWorkspaceManifest(dbPath)?.repositoryId ?? null;
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const prefix = readMeta(new WorkspaceStore(db, "", ""), "prefix");
    if (prefix === null) {
      throw new StapleError(
        "conflict",
        `The database at ${dbPath} has no prefix stamped in it, so it is not a workspace this ` +
          "registry row could be pointing at. Nothing was changed.",
      );
    }
    return { prefix, repositoryId };
  } finally {
    db.close();
  }
}

/**
 * `hub registry disconnect` — the verb `adoptRegistryIdentity`'s refusal names.
 *
 * It said "Disconnect it first" and there was nothing to run: `staple cloud disconnect`
 * resolves a WORKSPACE manifest through `repositoryIdFor`, so it cannot reach a hub, and the
 * only escape was deleting `~/.staple/cloud/<hubId>.json` by hand.
 *
 * `performDisconnect` is already keyed by repository id, so this is that function pointed at
 * the hub's own identity. Local and offline by contract — *"a person who has decided to stop
 * talking to a service must not need that service's permission to stop"* — so it makes no
 * request, and what was published stays published.
 */
function runDisconnect(argv: string[]): void {
  const { values } = parseArgs({
    args: argv,
    options: { json: { type: "boolean" }, yes: { type: "boolean" } },
  });
  const json = values.json === true;
  const home = stapleHome();
  const { hub, value: hubId } = withHub((h) => requireHubId(h, "disconnect"));

  try {
    if (values.yes !== true) {
      const lines = [
        `Disconnecting this machine's hub (${hubId}).`,
        "  - the credential for it is removed from this machine",
        "  - the published registry is NOT deleted, and other machines are unaffected",
        "  - your local hub, and every workspace, is untouched",
        "  - re-connecting later needs the enrollment secret again",
      ];
      if (!json) for (const line of lines) console.log(line);
      const agreed =
        !json && isInteractive() && confirm("\nDisconnect the hub?", { default: false });
      if (!agreed) {
        if (json) {
          console.error(
            JSON.stringify({
              code: "validation",
              message: `Disconnecting the hub needs --yes. ${lines.join(" ")}`,
              retryable: false,
              notice: lines,
            }),
          );
        } else {
          console.error(
            isInteractive() ? "\nDeclined. Still connected." : "\nRe-run with --yes to disconnect.",
          );
        }
        process.exitCode = 2;
        return;
      }
    }

    settle(
      loadService()
        .then(async () => {
          const { performDisconnect } = await import("../core/cloud/connect.js");
          const outcome = performDisconnect(home, hubId);
          if (json) {
            console.log(JSON.stringify({ hubId, ...outcome }));
            return;
          }
          if (!outcome.wasConnected) {
            console.log("This machine's hub was not connected. Nothing changed.");
            return;
          }
          console.log("\nDisconnected this machine's hub.");
          if (!outcome.credentialRemoved) {
            /**
             * Both remedies here are ones a person can actually run against a HUB.
             *
             * This used to name `staple cloud devices revoke`, which cannot reach a hub at
             * all: it resolves its target through `repositoryIdFor`, which reads a
             * WORKSPACE manifest, and no flag retargets it. So the one instruction offered
             * to somebody whose hub credential is stuck — the security-relevant case — was
             * unperformable by any argv.
             *
             * Re-connecting is the real server-side answer, and it is not a workaround:
             * the device id is persisted in the staple home, and the Worker's enrollment
             * upserts on `(repo_id, device_id)` with
             * `DO UPDATE SET token_sha256 = excluded.token_sha256`. So a new connect
             * REPLACES the token this credential holds, which is what makes the stuck copy
             * useless whether or not it was ever deleted.
             */
            console.error(
              "! the credential could not be removed from the store (a locked keychain does " +
                "this). The connection record is gone, so this machine will not use it — but " +
                "the secret is still in the store and still valid server-side.",
            );
            console.error("  To finish:");
            console.error(
              "    1. remove it from your keychain by hand (search for the hub id above), and",
            );
            console.error(
              "    2. run `staple hub registry connect` again — that re-enrolls this same " +
                "device and REPLACES the token, so the copy you could not delete stops working.",
            );
            console.error(
              "  `staple cloud devices revoke` cannot do this: it targets a workspace's " +
                "repository, not the hub.",
            );
            process.exitCode = 4;
          }
        })
        .finally(() => hub.close()),
      json,
    );
  } catch (error) {
    hub.close();
    throw error;
  }
}
