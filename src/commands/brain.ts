/**
 * `staple brain` — persistent agent memory (proof of concept).
 *
 *   brain init
 *   brain remember --kind K --body TEXT [--name N] [--description D] [--why W]
 *                  [--scope global|project|<scope>] [--cwd DIR] [--tags a,b]
 *                  [--source S] [--provisional] [--supersedes ID] [--json]
 *   brain recall <question…> [--limit N] [--cwd DIR] [--json]
 *   brain show <id> [--json]
 *   brain verify <id>
 *   brain forget <id>
 *   brain list [--json]
 *   brain context [--cwd DIR] [--budget TOKENS] [--hook --provider P] [--json]
 *   brain turn [--prompt TEXT] [--session S] [--cwd DIR] [--hook --provider P] [--json]
 *   brain stop --hook --provider P
 *   brain stats [--json]
 *   brain import [--from <claude config dir>/projects] [--dry-run] [--json]
 *   brain eval --questions FILE [--limit N] [--json]
 *
 * Every subcommand takes `--db PATH` (or `STAPLE_BRAIN_DB`) to use another brain file.
 *
 * The three hooks, the same commands for Claude Code and Codex (`--provider` only labels the
 * usage log). Each reads the CLI's hook payload on stdin, answers in the shape both CLIs read,
 * and never fails the session: an error is a line on stderr and an empty answer.
 *   SessionStart       `context --hook`  the core memories and the working brief
 *   UserPromptSubmit   `turn --hook`     memories matching this prompt, not yet shown this session
 *   Stop               `stop --hook`     records which shown memories the answer cited
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { userHome } from "../config/home.js";
import { StapleError } from "../core/types.js";
import { buildContext, DEFAULT_CONTEXT_BUDGET, renderHookOutput } from "../brain/context.js";
import { planImport } from "../brain/import.js";
import { initBrain, openBrain } from "../brain/open.js";
import { recall } from "../brain/recall.js";
import { projectKeysFor, projectScope, type ProjectKeys } from "../brain/scope.js";
import { stableId } from "../brain/store.js";
import { GLOBAL_SCOPE, estimateTokens, isBrainKind, type BrainRecord } from "../brain/types.js";
import { buildTurn, TURN_DEFAULTS } from "../brain/turn.js";
import { hashPrompt, UsageLog, usagePath, withUsage } from "../brain/usage.js";
import { computeStats } from "../brain/stats.js";
import { citedIn, lastAssistantText } from "../brain/cite.js";
import { agentOf } from "../brain/config.js";

/** Milliseconds since this process started: the hook's whole cost, startup included. */
const sinceStart = () => Math.round(performance.now() * 10) / 10;

const hookOptions = {
  hook: { type: "boolean" },
  provider: { type: "string" },
  session: { type: "string" },
} as const;

/** Run a hook body; any failure is a stderr line and an empty answer, never a failed session. */
function asHook(hook: boolean, name: string, fn: () => void): void {
  try {
    fn();
  } catch (error) {
    if (!hook) throw error;
    process.stderr.write(`staple brain ${name}: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

const stringField = (payload: Record<string, unknown>, key: string) => (typeof payload[key] === "string" && payload[key] ? (payload[key] as string) : null);

const common = {
  db: { type: "string" },
  json: { type: "boolean" },
  cwd: { type: "string" },
} as const;

function print(json: boolean, payload: unknown, human: () => string): void {
  process.stdout.write(json ? `${JSON.stringify(payload, null, 2)}\n` : `${human()}\n`);
}

function readStdinJson(): Record<string, unknown> {
  if (process.stdin.isTTY) return {};
  try {
    const text = readFileSync(0, "utf8");
    const parsed = text.trim() ? (JSON.parse(text) as unknown) : {};
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function full(r: BrainRecord): string {
  return [
    `${r.name ?? r.id} [${r.kind}] ${r.id}`,
    `scope: ${r.scope}  source: ${r.source ?? "-"}  verified: ${r.verifiedAt ?? "-"}${r.provisional ? "  PROVISIONAL" : ""}${r.supersededBy ? `  superseded by ${r.supersededBy}` : ""}`,
    r.description ? `about: ${r.description}` : null,
    "",
    r.body,
  ]
    .filter((l) => l !== null)
    .join("\n");
}

function scopeFrom(value: string | undefined, cwd: string): string {
  if (value === "global") return GLOBAL_SCOPE;
  if (value === undefined || value === "project") return projectScope(cwd);
  return value;
}

const USAGE = `staple brain — persistent agent memory (proof of concept)

  brain init                                   create the global brain workspace
  brain remember --kind K --body TEXT [--name N] [--description D] [--why W]
                 [--scope global|project|<scope>] [--cwd DIR] [--tags a,b]
                 [--source S] [--provisional] [--supersedes ID]
  brain recall <question…> [--limit N] [--cwd DIR]
  brain show|verify|forget <id>
  brain list
  brain context [--cwd DIR] [--budget TOKENS] [--hook --provider P]   SessionStart hook
  brain turn [--prompt TEXT] [--session S] [--hook --provider P]      UserPromptSubmit hook
  brain stop --hook --provider P                                     Stop hook (citations)
  brain stats
  brain import [--from <claude config dir>/projects] [--dry-run]
  brain eval --questions FILE

  Every subcommand takes --db PATH (or STAPLE_BRAIN_DB) and --json.
  SessionStart hook (Claude Code and Codex): staple brain context --hook`;

export function runBrainCommand(argv: string[]): void {
  const [sub, ...rest] = argv;
  if (sub === undefined || sub === "help" || sub === "--help" || sub === "-h" || rest.includes("--help") || rest.includes("-h")) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  switch (sub) {
    case "init": {
      const { values } = parseArgs({ args: rest, options: { json: { type: "boolean" } } });
      const result = initBrain();
      print(values.json === true, result, () => `${result.created ? "Created" : "Already present:"} brain at ${result.dbPath}`);
      return;
    }

    case "remember": {
      const { values } = parseArgs({
        args: rest,
        options: {
          ...common,
          kind: { type: "string" },
          body: { type: "string" },
          name: { type: "string" },
          description: { type: "string" },
          why: { type: "string" },
          scope: { type: "string" },
          tags: { type: "string" },
          source: { type: "string" },
          provisional: { type: "boolean" },
          supersedes: { type: "string" },
        },
      });
      if (!isBrainKind(values.kind)) throw new StapleError("validation", "--kind must be user, feedback, project or reference.");
      if (!values.body) throw new StapleError("validation", "--body is required.");
      const cwd = resolve(values.cwd ?? process.cwd());
      const opened = openBrain(values.db);
      try {
        const record = opened.brain.remember({
          kind: values.kind,
          body: values.body,
          name: values.name ?? null,
          description: values.description ?? null,
          why: values.why ?? null,
          scope: scopeFrom(values.scope, cwd),
          tags: values.tags ? values.tags.split(",").map((t) => t.trim()).filter(Boolean) : [],
          source: values.source ?? (process.env.STAPLE_AGENT ? `agent:${process.env.STAPLE_AGENT}` : "human:cli"),
          provisional: values.provisional === true,
          supersedes: values.supersedes ?? null,
        });
        withUsage(opened.dbPath, (log) =>
          log.log({ event: "remember", provider: "cli", session: process.env.CLAUDE_CODE_SESSION_ID ?? null, recordIds: [record.id], latencyMs: sinceStart(), detail: { source: record.source, supersedes: values.supersedes ?? null } }),
        );
        print(values.json === true, record, () => `Remembered ${record.id} (${record.kind}, ${record.scope})`);
      } finally {
        opened.close();
      }
      return;
    }

    case "recall": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { ...common, limit: { type: "string" } },
      });
      const question = positionals.join(" ");
      if (!question.trim()) throw new StapleError("validation", "recall needs a question.");
      const opened = openBrain(values.db);
      try {
        const keys = projectKeysFor(values.cwd ?? process.cwd());
        const started = performance.now();
        const hits = recall(opened.brain.live(), question, { limit: Number(values.limit ?? 3), keys });
        withUsage(opened.dbPath, (log) =>
          log.log({ event: "recall", provider: "cli", session: process.env.CLAUDE_CODE_SESSION_ID ?? null, promptHash: hashPrompt(question), recordIds: hits.map((h) => h.record.id), latencyMs: Math.round((performance.now() - started) * 10) / 10 }),
        );
        print(
          values.json === true,
          hits.map((h) => ({ score: h.score, ...h.record })),
          () => (hits.length ? hits.map((h) => `${full(h.record)}\n`).join("\n---\n\n") : "No memory matches."),
        );
      } finally {
        opened.close();
      }
      return;
    }

    case "show":
    case "verify":
    case "forget": {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: common });
      if (!positionals[0]) throw new StapleError("validation", `brain ${sub} needs an id.`);
      const opened = openBrain(values.db);
      try {
        const record =
          sub === "show"
            ? opened.brain.get(positionals[0])
            : sub === "verify"
              ? opened.brain.verify(positionals[0])
              : opened.brain.forget(positionals[0]);
        if (sub !== "show") withUsage(opened.dbPath, (log) => log.log({ event: sub, provider: "cli", recordIds: [record.id] }));
        print(values.json === true, record, () => (sub === "show" ? full(record) : `${sub === "verify" ? "Verified" : "Forgot"} ${record.id}`));
      } finally {
        opened.close();
      }
      return;
    }

    case "list": {
      const { values } = parseArgs({ args: rest, options: common });
      const opened = openBrain(values.db);
      try {
        const records = opened.brain.all();
        print(values.json === true, records, () =>
          records.map((r) => `${r.id.slice(0, 8)}  ${r.kind.padEnd(9)} ${r.supersededBy ? "(superseded) " : ""}${r.name ?? ""}  [${r.scope}]`).join("\n"),
        );
      } finally {
        opened.close();
      }
      return;
    }

    case "context": {
      const { values } = parseArgs({
        args: rest,
        options: { ...common, ...hookOptions, budget: { type: "string" } },
      });
      const hook = values.hook === true;
      asHook(hook, "context", () => {
        const payload = hook ? readStdinJson() : {};
        const cwd = values.cwd ?? stringField(payload, "cwd") ?? process.cwd();
        const session = values.session ?? stringField(payload, "session_id");
        const opened = openBrain(values.db);
        try {
          const config = opened.brain.config();
          // Off for the brain or for this agent: answer nothing, and say so in the log.
          if (hook && (!config.enabled || !config.agents[agentOf(values.provider)].enabled)) {
            withUsage(opened.dbPath, (log) =>
              log.log({ event: "session_start", provider: values.provider ?? null, session, tokens: 0, latencyMs: sinceStart(), detail: { skipped: config.enabled ? "agent_off" : "brain_off" } }),
            );
            return;
          }
          const block = buildContext(opened.brain.live(), projectKeysFor(cwd), Number(values.budget ?? config.budgets.sessionTokens ?? DEFAULT_CONTEXT_BUDGET));
          if (hook) {
            process.stdout.write(renderHookOutput(block, "SessionStart"));
            withUsage(opened.dbPath, (log) =>
              log.log({
                event: "session_start",
                provider: values.provider ?? null,
                session,
                recordIds: block.ids,
                tokens: block.tokens,
                latencyMs: sinceStart(),
                detail: { cwd, source: stringField(payload, "source"), eligible: block.eligible },
              }),
            );
          } else print(values.json === true, { cwd, ...block }, () => block.text);
        } finally {
          opened.close();
        }
      });
      return;
    }

    case "turn": {
      const { values } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { ...common, ...hookOptions, prompt: { type: "string" }, budget: { type: "string" }, "time-budget": { type: "string" } },
      });
      const hook = values.hook === true;
      asHook(hook, "turn", () => {
        const payload = hook ? readStdinJson() : {};
        const prompt = values.prompt ?? stringField(payload, "prompt") ?? "";
        const cwd = values.cwd ?? stringField(payload, "cwd") ?? process.cwd();
        const session = values.session ?? stringField(payload, "session_id");
        const opened = openBrain(values.db);
        const config = opened.brain.config();
        const timeBudget = Number(values["time-budget"] ?? config.budgets.turnMs ?? TURN_DEFAULTS.timeBudgetMs);
        let log: UsageLog | null = null;
        try {
          try {
            log = new UsageLog(usagePath(opened.dbPath));
          } catch {
            log = null;
          }
          if (hook && (!config.enabled || !config.agents[agentOf(values.provider)].enabled)) {
            log?.log({ event: "turn", provider: values.provider ?? null, session, promptHash: hashPrompt(prompt), tokens: 0, latencyMs: sinceStart(), detail: { skipped: config.enabled ? "agent_off" : "brain_off" } });
            return;
          }
          const seen = session && log ? log.injectedIn(session) : new Set<string>();
          // Past the budget before scoring: say so in one line rather than make the prompt wait.
          if (sinceStart() > timeBudget) {
            const notice = `# Brain\n(per-prompt recall skipped: over its ${timeBudget} ms budget; call \`recall\` if this task touches past decisions.)`;
            if (hook) process.stdout.write(renderHookOutput({ text: notice }, "UserPromptSubmit"));
            log?.log({ event: "turn", provider: values.provider ?? null, session, promptHash: hashPrompt(prompt), tokens: 0, latencyMs: sinceStart(), detail: { skipped: "time_budget" } });
            return;
          }
          const block = buildTurn(opened.brain.live(), prompt, {
            keys: projectKeysFor(cwd),
            seen,
            tokenBudget: values.budget ? Number(values.budget) : config.budgets.turnTokens,
          });
          if (hook) process.stdout.write(renderHookOutput(block, "UserPromptSubmit"));
          else print(values.json === true, { session, ...block }, () => block.text || "(nothing above the floor that this session has not seen)");
          log?.log({
            event: "turn",
            provider: values.provider ?? null,
            session,
            promptHash: hashPrompt(prompt),
            recordIds: block.ids,
            tokens: block.tokens,
            latencyMs: sinceStart(),
            detail: { considered: block.considered, skippedAsSeen: block.skippedAsSeen, belowFloor: block.belowFloor, topScore: block.topScore },
          });
        } finally {
          log?.close();
          opened.close();
        }
      });
      return;
    }

    case "stop": {
      const { values } = parseArgs({ args: rest, options: { ...common, ...hookOptions } });
      const hook = values.hook === true;
      asHook(hook, "stop", () => {
        const payload = hook ? readStdinJson() : {};
        const session = values.session ?? stringField(payload, "session_id");
        if (!session) return;
        const text = stringField(payload, "last_assistant_message") ?? lastAssistantText(stringField(payload, "transcript_path"));
        if (!text) return;
        const opened = openBrain(values.db);
        try {
          withUsage(opened.dbPath, (log) => {
            const shown = log.injectedIn(session);
            const already = new Set(
              log
                .rows(5000)
                .filter((r) => r.session === session && r.event === "cite")
                .flatMap((r) => r.recordIds),
            );
            const cited = citedIn(text, opened.brain.all().filter((r) => shown.has(r.id) || text.includes(`[brain:${r.name ?? ""}]`))).filter((id) => !already.has(id));
            if (cited.length) log.log({ event: "cite", provider: values.provider ?? null, session, recordIds: cited, latencyMs: sinceStart() });
          });
        } finally {
          opened.close();
        }
      });
      return;
    }

    case "stats": {
      const { values } = parseArgs({ args: rest, options: common });
      const opened = openBrain(values.db);
      try {
        let rows: ReturnType<UsageLog["rows"]> = [];
        withUsage(opened.dbPath, (log) => {
          rows = log.rows();
        });
        const stats = computeStats(opened.brain.all(), rows);
        print(values.json === true, stats, () => JSON.stringify({ health: { ...stats.health, stale: stats.health.stale.length, duplicates: stats.health.duplicates.length }, usage: { ...stats.usage, perSession: undefined, neverUsed: stats.usage.neverUsed.length } }, null, 2));
      } finally {
        opened.close();
      }
      return;
    }

    case "import": {
      const { values } = parseArgs({
        args: rest,
        options: { ...common, from: { type: "string" }, "dry-run": { type: "boolean" } },
      });
      const from = resolve(values.from ?? join(userHome(), ".claude", "projects"));
      const plan = planImport(from);
      const summary = {
        from,
        files: plan.memories.length,
        skipped: plan.skipped,
        byKind: Object.fromEntries(
          ["user", "feedback", "project", "reference"].map((k) => [k, plan.memories.filter((m) => m.input.kind === k).length]),
        ),
        global: plan.memories.filter((m) => m.input.scope === GLOBAL_SCOPE).length,
      };
      if (values["dry-run"] !== true) {
        const opened = openBrain(values.db);
        try {
          for (const memory of plan.memories) opened.brain.remember(memory.input);
        } finally {
          opened.close();
        }
      }
      print(values.json === true, summary, () =>
        `${values["dry-run"] ? "Would import" : "Imported"} ${summary.files} memories from ${from} ` +
          `(${Object.entries(summary.byKind).map(([k, n]) => `${k} ${n}`).join(", ")}; ${summary.global} global). ` +
          `Skipped ${summary.skipped.length}.`,
      );
      return;
    }

    case "eval": {
      const { values } = parseArgs({
        args: rest,
        options: { ...common, questions: { type: "string" }, limit: { type: "string" } },
      });
      if (!values.questions) throw new StapleError("validation", "--questions FILE is required.");
      const questions = JSON.parse(readFileSync(values.questions, "utf8")) as Array<{
        id: string;
        question: string;
        target: string;
        also?: string[];
        difficulty?: string;
      }>;
      const opened = openBrain(values.db);
      try {
        const records = opened.brain.live();
        const started = performance.now();
        const report = runEval(records, questions);
        const ms = performance.now() - started;
        const result = { ...report, questions: questions.length, records: records.length, msPerQuery: ms / questions.length };
        withUsage(opened.dbPath, (log) =>
          log.log({
            event: "eval",
            provider: "cli",
            latencyMs: Math.round(result.msPerQuery * 10) / 10,
            detail: {
              questions: result.questions,
              records: result.records,
              all: result.all,
              easy: result.easy,
              hard: result.hard,
              meanRecallTokensTop3: result.meanRecallTokensTop3,
              misses: result.misses.map((m) => ({ id: m.id, difficulty: m.difficulty, target: m.target, rank: m.rankUnscoped, got: m.top3Unscoped })),
            },
          }),
        );
        print(values.json === true, result, () => formatEval(result));
      } finally {
        opened.close();
      }
      return;
    }

    default:
      throw new StapleError(
        "validation",
        `Unknown brain subcommand "${sub ?? ""}". One of: init, remember, recall, show, verify, forget, list, context, turn, stop, stats, import, eval.`,
      );
  }
}

interface EvalRow {
  id: string;
  difficulty: string;
  question: string;
  target: string;
  rankUnscoped: number | null;
  rankInProject: number | null;
  top3Unscoped: string[];
  recallTokensTop3: number;
}

function runEval(
  records: BrainRecord[],
  questions: Array<{ id: string; question: string; target: string; also?: string[]; difficulty?: string }>,
) {
  const nameOf = new Map(records.map((r) => [r.id, r.name ?? r.id]));
  const rows: EvalRow[] = [];
  for (const q of questions) {
    const accepted = new Set([q.target, ...(q.also ?? [])].map((p) => stableId(`claude-memory:${p}`)));
    const slug = q.target.split("/").slice(-3, -2)[0] ?? "";
    const inProject: ProjectKeys = { slugs: [slug], repoName: null };
    const rankOf = (keys: ProjectKeys | null) => {
      const hits = recall(records, q.question, { limit: 10, keys });
      const at = hits.findIndex((h) => accepted.has(h.record.id));
      return { rank: at < 0 ? null : at + 1, hits };
    };
    const unscoped = rankOf(null);
    const scoped = rankOf(inProject);
    rows.push({
      id: q.id,
      difficulty: q.difficulty ?? "?",
      question: q.question,
      target: nameOf.get(stableId(`claude-memory:${q.target}`)) ?? q.target,
      rankUnscoped: unscoped.rank,
      rankInProject: scoped.rank,
      top3Unscoped: unscoped.hits.slice(0, 3).map((h) => h.record.name ?? h.record.id),
      recallTokensTop3: unscoped.hits.slice(0, 3).reduce((n, h) => n + estimateTokens(full(h.record)), 0),
    });
  }
  const at = (k: number, pick: (r: EvalRow) => number | null, subset = rows) =>
    subset.length ? subset.filter((r) => (pick(r) ?? Infinity) <= k).length / subset.length : 0;
  const summarize = (subset: EvalRow[]) => ({
    n: subset.length,
    unscoped: { r1: at(1, (r) => r.rankUnscoped, subset), r3: at(3, (r) => r.rankUnscoped, subset) },
    inProject: { r1: at(1, (r) => r.rankInProject, subset), r3: at(3, (r) => r.rankInProject, subset) },
  });
  return {
    all: summarize(rows),
    easy: summarize(rows.filter((r) => r.difficulty === "easy")),
    hard: summarize(rows.filter((r) => r.difficulty === "hard")),
    meanRecallTokensTop3: Math.round(rows.reduce((n, r) => n + r.recallTokensTop3, 0) / Math.max(rows.length, 1)),
    misses: rows.filter((r) => r.rankUnscoped === null || r.rankUnscoped > 3),
    rows,
  };
}

function formatEval(result: ReturnType<typeof runEval> & { questions: number; records: number; msPerQuery: number }): string {
  const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
  const line = (label: string, s: ReturnType<typeof runEval>["all"]) =>
    `${label.padEnd(5)} n=${String(s.n).padEnd(3)} unscoped R@1 ${pct(s.unscoped.r1).padStart(4)} R@3 ${pct(s.unscoped.r3).padStart(4)} | in-project R@1 ${pct(s.inProject.r1).padStart(4)} R@3 ${pct(s.inProject.r3).padStart(4)}`;
  return [
    `${result.questions} questions over ${result.records} records, ${result.msPerQuery.toFixed(1)} ms/query (index rebuilt per query)`,
    line("all", result.all),
    line("easy", result.easy),
    line("hard", result.hard),
    `mean tokens of a top-3 recall answer: ~${result.meanRecallTokensTop3}`,
    "",
    `misses (target not in unscoped top 3): ${result.misses.length}`,
    ...result.misses.map(
      (m) => `  ${m.id} [${m.difficulty}] rank ${m.rankUnscoped ?? ">10"} / in-project ${m.rankInProject ?? ">10"}  want ${m.target}\n      got ${m.top3Unscoped.join(", ")}`,
    ),
  ].join("\n");
}
