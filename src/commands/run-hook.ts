/**
 * `staple run hook` — interactive adapters for autopilot runs (`src/core/run-hook.ts`,
 * design/runs.md "Interactive sessions: stop hooks").
 *
 *   run hook <provider>-stop [--max-repeats N] [--max-blocks N]   (the hook itself; stdin: the payload)
 *   run hook bind [--run <id>] [--session <id>] [--provider P]
 *   run hook unbind [--session <id>] [--provider P] | --run <id>
 *   run hook install <provider> [--user | --project | --local] [--print] [--staple <cmd>] [--dir <project>]
 *
 * The hook verb is called by the agent CLI, not by a person or an agent, so it follows the
 * provider's contract rather than staple's: it always exits 0, its stdout is the
 * provider's answer, and a failure of any kind lets the session stop with a message rather
 * than reaching cli.ts's catch (whose validation exit 2 is a BLOCK to Claude Code).
 *
 * No MCP twin, like `run drive`: the hook is run by the provider, and `bind` reads the
 * session id the provider exports to its tool shells (or the directory it runs in), which
 * an MCP server spawned once per session does not see change on `/clear`.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { writeFileAtomic } from "../config/atomic.js";
import { stapleHome } from "../config/home.js";
import { openWorkspace } from "../core/open.js";
import { DEFAULT_MAX_BLOCKS, DEFAULT_MAX_REPEATS, PENDING_BINDING_TTL_SECONDS, type HookVerdict, bindPending, bindSession, bindingPath, stopHook, unbindPending, unbindRun, unbindSession } from "../core/run-hook.js";
import { HOOK_INSTALL_SCOPES, HOOK_PROVIDERS, type HookInstallScope, type HookProvider, hookStanza, mergeHook, providerByCommand } from "../core/run-hook-providers.js";
import { shellQuote } from "../core/run-driver.js";
import { scopeLabel } from "../core/run-store.js";
import { editTarget } from "../core/telemetry/collection/statusline.js";
import { resolveWorkspace } from "../core/workspace.js";
import { StapleError, nowIso } from "../core/types.js";
import { positiveInteger } from "./run.js";

const PROVIDER_NAMES = Object.keys(HOOK_PROVIDERS);
const HOOK_VERBS = Object.values(HOOK_PROVIDERS).map((provider) => provider.command);

export const HOOK_HELP = `staple run hook — keep a session you are in working an autopilot run.

A stop hook runs whenever the agent is about to end its turn. For a session
bound to a live run it asks the tracker: the current ticket is still yours and
unfinished, or was handed on without a "review: ..." comment -> keep going and
finish it; run continue says take -> keep going with the next ticket (already
checked out); wait or stop -> the session may stop, and the reason is shown
where the CLI can show it. Unbound sessions, sessions run drive started, and
runs a driver is attached to are never touched.

Providers (a documented hook that can keep a turn going):
${Object.values(HOOK_PROVIDERS)
  .map((provider) => `  ${provider.name.padEnd(8)} ${provider.label}, ${provider.event} hook: staple run hook ${provider.command}`)
  .join("\n")}

  run hook install <provider> [--print] [--user | --project | --local]
              print the settings stanza that installs the hook (the default),
              or add it to the user's, the project's or (claude) the project's
              local settings file, every other setting kept (a backup goes to
              <staple home>/backups/hooks/). --print with a scope prints the
              file as it would be written. Installing twice changes nothing.
              --staple CMD: the staple command the hook runs (default: staple)
              --dir DIR: the project for --project/--local (default: here)
  run hook bind [--run <run-id>] [--session <id>] [--provider <provider>]
              bind this session to a live run (default: your one live run;
              provider: claude). The session is --session, else
              $${HOOK_PROVIDERS.claude!.sessionEnv} (claude) or $${HOOK_PROVIDERS.gemini!.sessionEnv} (gemini). A CLI that
              exports none gets a PENDING binding: its next stop in this
              directory (or below it) within ${PENDING_BINDING_TTL_SECONDS / 60} minutes claims it. Then end
              your turn: the hook hands the session the run's tickets one by
              one. One run, one session: refused (conflict) for a run another
              session is bound to (unbind --run first), an ended run, or one
              run drive is working
  run hook unbind [--session <id>] [--provider <provider>] | --run <run-id>
              stop the hook acting for this session (without a session: the
              pending binding made here), or, with --run, for every session
              bound to that run; the run is unchanged
  run hook <provider>-stop [--max-repeats N] [--max-blocks N]
              the hook itself: reads the provider's payload on stdin, answers in
              the provider's format, always exits 0. The same reminder is given
              at most N times in a row (${DEFAULT_MAX_REPEATS}), and at most N continuations in
              a row per prompt (${DEFAULT_MAX_BLOCKS}); past either the session may stop

A person ends the whole thing at any time with "staple run stop" (or the UI's
Stop): the next stop hook then lets the session stop and says why.

  --actor A        who acts (bind without --run); else $STAPLE_AGENT, else $USER
  --json           bind/unbind/install: the result as JSON`;

export function runHookCommand(rest: string[]): void {
  const verb = rest[0];
  // Help first: a person typing `run hook claude-stop --help` wants the page, not a hook answer.
  if (rest.includes("--help") || rest.includes("-h")) return console.log(HOOK_HELP);
  if (verb !== undefined && providerByCommand(verb) !== null) return runStopHook(providerByCommand(verb)!, rest.slice(1));
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      db: { type: "string" },
      ws: { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      actor: { type: "string" },
      run: { type: "string" },
      session: { type: "string" },
      provider: { type: "string" },
      print: { type: "boolean" },
      user: { type: "boolean" },
      project: { type: "boolean" },
      local: { type: "boolean" },
      staple: { type: "string" },
      dir: { type: "string" },
    },
  });
  const [sub, target] = positionals;
  if (values.help === true || sub === undefined || sub === "help") return console.log(HOOK_HELP);
  if (sub === "install") return install(target, values);
  if (sub !== "bind" && sub !== "unbind") {
    throw new StapleError("validation", `Unknown run hook command "${sub}". Use: install, bind, unbind, ${HOOK_VERBS.join(", ")} (staple run hook --help)`);
  }
  const provider = providerNamed(values.provider ?? "claude");
  const session = (values.session ?? (provider.sessionEnv === null ? "" : (process.env[provider.sessionEnv] ?? ""))).trim();

  if (sub === "unbind" && values.run !== undefined) {
    const run = resolveWorkspace({ db: values.db, ws: values.ws }).store.runs().get(values.run);
    const removed = unbindRun(run.id);
    if (values.json) return console.log(JSON.stringify({ runId: run.id, unbound: removed }));
    return console.log(`removed ${removed} binding(s) of run ${run.id}`);
  }
  if (sub === "unbind") {
    const removed = session === "" ? unbindPending(provider.name, process.cwd()) : unbindSession(provider.name, session);
    if (values.json) return console.log(JSON.stringify({ provider: provider.name, session: session || null, unbound: removed }));
    const what = session === "" ? `the pending ${provider.name} binding for ${process.cwd()}` : `${provider.name} session ${session}`;
    return console.log(removed ? `unbound ${what}` : `${what} was not bound`);
  }

  const opened = resolveWorkspace({ db: values.db, ws: values.ws });
  const runs = opened.store.runs();
  const actor = values.actor ?? process.env.STAPLE_AGENT ?? process.env.USER ?? "user";
  const run = values.run !== undefined ? runs.get(values.run) : runs.liveRunOf(actor);
  const showHook = `staple run hook install ${provider.name} --print`;
  if (session === "") {
    const pending = bindPending({ store: opened.store, run, provider: provider.name, cwd: process.cwd() });
    if (values.json) return console.log(JSON.stringify({ ...pending, session: null, pending: true }));
    console.log(`pending: the next ${provider.label} stop in ${pending.cwd} binds its session to run ${run.id} (${run.actor} over ${scopeLabel(run.scope)}), until ${pending.expiresAt}`);
    console.log(`  end your turn now: the ${provider.command} hook claims it and hands this session the run's tickets (${showHook} shows the hook)`);
    return;
  }
  const binding = bindSession({ store: opened.store, run, provider: provider.name, session });
  if (values.json) return console.log(JSON.stringify({ ...binding, file: bindingPath(provider.name, session), pending: false }));
  console.log(`bound ${provider.label} session ${session} to run ${run.id} (${run.actor} over ${scopeLabel(run.scope)})`);
  console.log(`  end your turn: the ${provider.command} hook hands this session the run's tickets (${showHook} shows the hook)`);
}

function providerNamed(name: string): HookProvider {
  const provider = HOOK_PROVIDERS[name];
  if (!provider) throw new StapleError("validation", `Unknown hook provider "${name}"; one of: ${PROVIDER_NAMES.join(", ")}.`);
  return provider;
}

// ---------------------------------------------------------------- the hook

function runStopHook(provider: HookProvider, rest: string[]): void {
  let verdict: HookVerdict;
  try {
    const { values } = parseArgs({ args: rest, options: { "max-repeats": { type: "string" }, "max-blocks": { type: "string" } } });
    const limits = {
      maxRepeats: positiveInteger(values["max-repeats"], "--max-repeats") ?? DEFAULT_MAX_REPEATS,
      maxBlocks: positiveInteger(values["max-blocks"], "--max-blocks") ?? DEFAULT_MAX_BLOCKS,
    };
    const payload = readPayload();
    const event = provider.parse(payload, process.env);
    verdict =
      event === null
        ? { action: "allow", why: "unbound", message: null }
        : stopHook({
            provider: provider.name,
            event,
            limits,
            env: process.env,
            open: (db) => {
              const { store } = openWorkspace(db);
              return { store, runs: store.runs() };
            },
          });
  } catch (error) {
    verdict = { action: "allow", why: "error", message: `staple run hook ${provider.command} failed, so the session may stop: ${(error as Error).message}` };
  }
  const output = provider.render(verdict);
  process.stdout.write(output.stdout);
  process.exitCode = output.exitCode;
}

/** The payload on stdin as an object. A terminal (a person running it by hand) sends none. */
function readPayload(): Record<string, unknown> {
  if (process.stdin.isTTY) return {};
  const text = readFileSync(0, "utf8").trim();
  if (text === "") return {};
  const parsed = JSON.parse(text) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new StapleError("validation", "The hook payload on stdin is not a JSON object.");
  return parsed as Record<string, unknown>;
}

// ---------------------------------------------------------------- install

function install(name: string | undefined, values: { print?: boolean; user?: boolean; project?: boolean; local?: boolean; staple?: string; dir?: string; json?: boolean }): void {
  if (name === undefined) throw new StapleError("validation", `run hook install needs a provider: ${PROVIDER_NAMES.join(", ")}.`);
  const provider = providerNamed(name);
  const scopes = HOOK_INSTALL_SCOPES.filter((scope) => values[scope] === true);
  if (scopes.length > 1) throw new StapleError("validation", "Pick one of --user, --project and --local.");
  const command = `${commandWord(values.staple ?? "staple")} run hook ${provider.command}`;
  const scope: HookInstallScope | undefined = scopes[0];

  if (scope === undefined) {
    const stanza = hookStanza(provider, command);
    if (values.json) return console.log(JSON.stringify({ provider: provider.name, command, stanza, path: null, action: "print" }));
    return console.log(JSON.stringify(stanza, null, 2));
  }

  const path = provider.settingsPath(scope, resolve(values.dir ?? process.cwd()), process.env);
  if (path === null) throw new StapleError("validation", `${provider.label} has no ${scope} settings file; use --user or --project.`);
  const target = editTarget(path);
  if ("problem" in target) throw new StapleError("validation", target.problem);
  let settings: Record<string, unknown> = {};
  if (existsSync(target.path)) {
    const text = readFileSync(target.path, "utf8");
    let parsed: unknown;
    try {
      parsed = text.trim() === "" ? {} : JSON.parse(text);
    } catch (error) {
      throw new StapleError("validation", `${target.path} is not valid JSON (${(error as Error).message}); nothing was written.`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new StapleError("validation", `${target.path} does not hold a JSON object; nothing was written.`);
    settings = parsed as Record<string, unknown>;
  }
  const merged = mergeHook(provider, settings, command);
  const text = `${JSON.stringify(merged ?? settings, null, 2)}\n`;
  if (values.print === true) {
    if (values.json) return console.log(JSON.stringify({ provider: provider.name, command, path: target.path, action: merged === null ? "already_installed" : "would_install", settings: merged ?? settings }));
    return console.log(text.trimEnd());
  }
  if (merged === null) {
    if (values.json) return console.log(JSON.stringify({ provider: provider.name, command, path: target.path, action: "already_installed", backup: null }));
    return console.log(`already installed: ${target.path} runs "staple run hook ${provider.command}"`);
  }
  let backup: string | null = null;
  let mode = 0o644;
  if (existsSync(target.path)) {
    mode = statSync(target.path).mode & 0o777;
    const dir = join(stapleHome(), "backups", "hooks");
    mkdirSync(dir, { recursive: true });
    backup = join(dir, `${nowIso().replace(/[:.]/g, "-")}-${provider.name}-${scope}-${basename(target.path)}`);
    copyFileSync(target.path, backup);
  }
  writeFileAtomic(target.path, text, { mode });
  if (values.json) return console.log(JSON.stringify({ provider: provider.name, command, path: target.path, action: "installed", backup }));
  console.log(`installed: ${target.path} now runs "${command}" on ${provider.event}${backup ? ` (backup ${backup})` : ""}`);
}

/** The staple command as the hook's shell sees it: quoted only when it has to be. */
function commandWord(value: string): string {
  return /^[A-Za-z0-9_./~-]+$/.test(value) ? value : shellQuote(value);
}
