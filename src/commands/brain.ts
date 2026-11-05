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
 *   brain context [--cwd DIR] [--budget TOKENS] [--hook] [--json]
 *   brain import [--from <claude config dir>/projects] [--dry-run] [--json]
 *   brain eval --questions FILE [--limit N] [--json]
 *
 * Every subcommand takes `--db PATH` (or `STAPLE_BRAIN_DB`) to use another brain file.
 * `context --hook` is the SessionStart hook for Claude Code and Codex: it reads the hook
 * payload on stdin for `cwd`, prints the hook answer, and never fails the session.
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
  brain context [--cwd DIR] [--budget TOKENS] [--hook]
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
        const hits = recall(opened.brain.live(), question, { limit: Number(values.limit ?? 3), keys });
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
        options: { ...common, budget: { type: "string" }, hook: { type: "boolean" } },
      });
      const hook = values.hook === true;
      try {
        const payload = hook ? readStdinJson() : {};
        const cwd = values.cwd ?? (typeof payload.cwd === "string" ? payload.cwd : process.cwd());
        const opened = openBrain(values.db);
        try {
          const block = buildContext(opened.brain.all(), projectKeysFor(cwd), Number(values.budget ?? DEFAULT_CONTEXT_BUDGET));
          if (hook) process.stdout.write(renderHookOutput(block));
          else print(values.json === true, { cwd, ...block }, () => block.text);
        } finally {
          opened.close();
        }
      } catch (error) {
        // A memory hook must never stop a session from starting.
        if (!hook) throw error;
        process.stderr.write(`staple brain context: ${error instanceof Error ? error.message : String(error)}\n`);
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
        print(values.json === true, result, () => formatEval(result));
      } finally {
        opened.close();
      }
      return;
    }

    default:
      throw new StapleError(
        "validation",
        `Unknown brain subcommand "${sub ?? ""}". One of: init, remember, recall, show, verify, forget, list, context, import, eval.`,
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
