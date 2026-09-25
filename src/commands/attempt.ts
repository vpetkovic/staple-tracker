/**
 * `staple attempt …` and the attempt flags on `checkout`, `status`, `done` and `release`.
 *
 * Contract: `docs/execution-telemetry.md`, "Surfaces". Every verb here is one store
 * method (`WorkspaceStore.recordAttemptEvent`, `reconstructAttemptHistory`), called by the
 * CLI, the MCP tool and the HTTP route alike, so the surfaces cannot drift. The read
 * surfaces (`staple attempts`, `staple attempt <id>`) are in `attempts.ts`; this file only
 * routes an attempt id there.
 */
import { parseArgs } from "node:util";
import type { WorkspaceStore } from "../core/store.js";
import type { AttemptOptions, AttemptView } from "../core/telemetry/attempts.js";
import { StapleError } from "../core/types.js";
import { resolveWorkspace } from "../core/workspace.js";
import { showAttempt } from "./attempts.js";

/** The self-reported flags an attempt-opening write accepts (`checkout`, `status`, `done`). */
export const ATTEMPT_OPEN_OPTIONS = {
  "harness-session": { type: "string" },
  harness: { type: "string" },
  model: { type: "string" },
  account: { type: "string" },
  "attempt-key": { type: "string" },
} as const;

/** What a claim-clearing write accepts (`release`, `status`, `done`). */
export const ATTEMPT_END_OPTIONS = {
  outcome: { type: "string" },
  reason: { type: "string" },
} as const;

/** The attempt options a command's parsed flags carry, or undefined when it names none. */
export function attemptOptionsFrom(values: Record<string, unknown>): AttemptOptions | undefined {
  const text = (name: string): string | undefined => (typeof values[name] === "string" ? (values[name] as string) : undefined);
  const options: AttemptOptions = {
    ...(text("harness-session") !== undefined ? { harnessSession: text("harness-session") } : {}),
    ...(text("harness") !== undefined ? { harness: text("harness") } : {}),
    ...(text("model") !== undefined ? { model: text("model") } : {}),
    ...(text("account") !== undefined ? { account: text("account") } : {}),
    ...(text("attempt-key") !== undefined ? { idempotencyKey: text("attempt-key") } : {}),
    ...(text("outcome") !== undefined ? { outcome: text("outcome") } : {}),
    ...(text("reason") !== undefined ? { reason: text("reason") } : {}),
  };
  return Object.keys(options).length === 0 ? undefined : options;
}

/** A write's payload unchanged, plus the attempt it opened, ended or kept (`attempt`, or null). */
export function withAttempt<T extends object>(store: WorkspaceStore, payload: T): T & { attempt: AttemptView | null } {
  return { ...payload, attempt: store.attempts().result() };
}

const HELP = `staple attempt — report on the attempt you hold

  attempt pause <ref> --reason R         running -> paused; R: checkpoint_before_reset, awaiting_reset,
                                         awaiting_input, operator, other. Keeps the claim.
  attempt resume <ref> [--reason R]      paused -> running
  attempt milestone <ref> -m <label>     a one-line checkpoint on a running attempt; point it at the
                [--comment-id ID] [--doc key@rev]   comment or worklog revision it summarizes
  attempt interrupt <ref> --reason R     end the attempt as interrupted; R: provider_limit, harness_exit,
                                         operator_stop, unknown. The claim stays: resume with checkout.
  attempt reconstruct                    rebuild attempts for work done before they were recorded,
                                         from the event log (idempotent)
  attempt <attempt-id> [--limit N] [--cursor C]
                                         read one attempt: transitions, chain, burn

  --agent A        who acts; else $STAPLE_AGENT, else $USER
  --json           the attempt as it now reads`;

function parseDoc(raw: string | undefined): { key: string; revision: number } | undefined {
  if (raw === undefined) return undefined;
  const match = /^(.+)@r?(\d+)$/.exec(raw.trim());
  if (!match) throw new StapleError("validation", `--doc takes <key>@<revision>, e.g. worklog@3; got "${raw}".`);
  return { key: match[1]!, revision: Number(match[2]) };
}

export function runAttemptCommand(rest: string[]): void {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      db: { type: "string" },
      ws: { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      agent: { type: "string" },
      reason: { type: "string" },
      message: { type: "string", short: "m" },
      "comment-id": { type: "string" },
      doc: { type: "string" },
      limit: { type: "string" },
      cursor: { type: "string" },
    },
  });
  const [sub, ref] = positionals;
  if (values.help === true || sub === undefined || sub === "help") return console.log(HELP);
  const verbs = ["pause", "resume", "milestone", "interrupt", "reconstruct"];
  // Any other single word is an attempt id: the read surface.
  if (!verbs.includes(sub) && ref === undefined) return showAttempt(values, sub);
  const store = resolveWorkspace({ db: values.db, ws: values.ws }).store;

  if (sub === "reconstruct") {
    const report = store.reconstructAttemptHistory();
    if (values.json) return console.log(JSON.stringify(report));
    return console.log(
      `reconstructed ${report.reconstructed} ${report.reconstructed === 1 ? "attempt" : "attempts"} from ${report.issues} ` +
        `${report.issues === 1 ? "issue's" : "issues'"} events` +
        (report.alreadyPresent > 0 ? ` (${report.alreadyPresent} already present)` : ""),
    );
  }
  if (!["pause", "resume", "milestone", "interrupt"].includes(sub)) {
    throw new StapleError("validation", `Unknown attempt command "${sub}". Use pause, resume, milestone, interrupt or reconstruct, or name one attempt by its id.`);
  }
  if (ref === undefined) throw new StapleError("validation", `staple attempt ${sub} needs the issue: staple attempt ${sub} <ref>.`);
  const actor = values.agent ?? process.env.STAPLE_AGENT ?? process.env.USER ?? "user";
  const attempt = store.recordAttemptEvent(ref, sub, actor, {
    ...(values.reason !== undefined ? { reason: values.reason } : {}),
    ...(values.message !== undefined ? { label: values.message } : {}),
    ...(values["comment-id"] !== undefined ? { commentId: values["comment-id"] } : {}),
    ...(values.doc !== undefined ? { document: parseDoc(values.doc) } : {}),
  });
  if (values.json) return console.log(JSON.stringify(attempt));
  const identifier = attempt.identifier ?? ref;
  console.log(`${identifier} attempt ${attempt.ordinal}: ${attempt.state}${attempt.outcome ? ` (${attempt.outcome}, ${attempt.endReason})` : ""}`);
}
