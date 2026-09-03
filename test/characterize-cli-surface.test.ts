/**
 * A1 — the CLI SURFACE INVENTORY, frozen before STA-24 rewrites it.
 *
 * `contract-cli.test.ts` already pins what an error LOOKS like (envelope triple,
 * exit code) once a command has run. This suite pins something earlier and more
 * fragile: which command tokens and which flag tokens exist at all, and what the
 * dispatcher does with input it does not recognise.
 *
 * A2 replaces `tsx src/cli.ts` with a bundled `staple` executable and A6 adds a
 * bare command, `init --yes`, `open`, `doctor`, `add`, `discover`, `connect` and
 * `install`. Both tickets are re-plumbing this exact dispatcher. When a command
 * silently disappears or an existing flag stops parsing, THIS is the file that
 * has to go red — an inventory drift is otherwise invisible until an agent's
 * shell script fails in production.
 *
 * Every golden below is CURRENT behaviour, verified by probe before it was
 * written. Quirks are pinned as-is under a `QUIRK` comment, never fixed here.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCliAt, tempDir, removeDir } from "./fixtures/characterize-support.js";

let home: string;
let scratch: string;
/** A --db target that is guaranteed absent, so a command fails at resolution. */
let absentDb: string;

beforeAll(() => {
  home = tempDir("char-surface-home");
  scratch = tempDir("char-surface-cwd");
  absentDb = `${scratch}/nowhere/absent.db`;
});

afterAll(() => {
  removeDir(home);
  removeDir(scratch);
});

function cli(...args: string[]) {
  return runCliAt(scratch, args, { STAPLE_HOME: home, USER: "char-user" });
}

// ------------------------------------------------------------ command inventory

/**
 * Every token `main()`'s switch answers to, plus the flags each one declares in
 * its own parseArgs call. Hand-written from src/cli.ts and then PROVEN below by
 * running the real binary, so this table cannot quietly drift from the source.
 *
 * `values` are throwaway arguments for string-typed flags; a flag listed in
 * `booleans` is passed bare.
 */
const COMMANDS: ReadonlyArray<{
  name: string;
  /** string-typed flags, given a dummy value */
  strings: readonly string[];
  /** boolean-typed flags, passed bare */
  booleans: readonly string[];
  /** single-dash aliases parseArgs declares via `short` */
  shorts: readonly string[];
}> = [
  // MOVED BY A6 (STA-36): `init` gained the consent and output flags the plan's
  // TTY matrix names — `--yes` (permits a legacy path migration), `--json` (one
  // finite result), `--no-gitignore` (declines `.staple/.gitignore`), and
  // `--dir` so a caller can name a project other than the cwd. `--db` and
  // `--ws` are still deliberately absent; see the KNOWN test below.
  { name: "init", strings: ["slug", "global", "dir"], booleans: ["yes", "json", "no-gitignore"], shorts: [] },
  // STA-81 added `--estimate` (a duration) and `--no-estimate` (the explicit
  // clear). Both are hand-added here because this inventory never goes red on
  // its own — a flag that exists in src/cli.ts and not in this table is exactly
  // the drift the suite was written to catch.
  {
    name: "new",
    strings: [
      "db", "ws", "description", "priority", "parent", "assignee", "blocked-by", "status",
      "kind", "criteria", "estimate",
    ],
    booleans: ["json", "allow-duplicate", "no-estimate"],
    shorts: ["d", "p"],
  },
  { name: "ls", strings: ["db", "ws", "status", "kind", "assignee", "q"], booleans: ["json", "all"], shorts: ["q"] },
  { name: "show", strings: ["db", "ws"], booleans: ["json"], shorts: [] },
  { name: "checkout", strings: ["db", "ws", "agent", "steal-if-stale"], booleans: ["json"], shorts: [] },
  { name: "start", strings: ["db", "ws", "agent", "steal-if-stale"], booleans: ["json"], shorts: [] },
  { name: "done", strings: ["db", "ws", "message"], booleans: ["json"], shorts: ["m"] },
  { name: "cancel", strings: ["db", "ws", "message"], booleans: ["json"], shorts: ["m"] },
  // `status` is the CLI's only update path, so STA-81's re-estimate lands here
  // too — same two flags as `new`.
  { name: "status", strings: ["db", "ws", "estimate"], booleans: ["json", "no-estimate"], shorts: [] },
  { name: "release", strings: ["db", "ws", "if-stale"], booleans: ["json"], shorts: [] },
  { name: "block", strings: ["db", "ws", "owner", "action"], booleans: ["json"], shorts: [] },
  { name: "blocked-by", strings: ["db", "ws"], booleans: ["json", "none"], shorts: [] },
  { name: "wait", strings: ["db", "ws", "timeout", "interval"], booleans: ["json"], shorts: [] },
  { name: "link", strings: ["db", "ws"], booleans: ["json"], shorts: [] },
  { name: "comment", strings: ["db", "ws", "author"], booleans: ["json"], shorts: [] },
  { name: "tree", strings: ["db", "ws"], booleans: ["json"], shorts: [] },
  { name: "board", strings: ["db", "ws"], booleans: ["json"], shorts: [] },
  { name: "inbox", strings: ["db", "ws", "assignee"], booleans: ["json", "hub"], shorts: [] },
  { name: "doc", strings: ["db", "ws", "put", "base", "summary"], booleans: ["json", "revisions"], shorts: [] },
  { name: "events", strings: ["db", "ws", "since", "interval", "exec", "max"], booleans: ["json", "follow"], shorts: [] },
  // QUIRK (A6): `hub` never calls parseArgs. It picks its subcommand with
  // `rest.filter(a => !a.startsWith("--"))[0] ?? "ls"` and reads --json off the
  // process argv, so it accepts ANY flag and ignores --db/--ws entirely.
  { name: "hub", strings: [], booleans: [], shorts: [] },
  // MOVED BY A6 (STA-36). `ui` is now a compatibility alias for `open` and both
  // share one parseArgs table, so `ui` gained --browser/--no-browser and `open`
  // accepts the historical --no-open. `--json` is still PARSED (it is advertised
  // as global) and refused at runtime with a validation error, because a
  // long-lived foreground server has no finite result to emit.
  { name: "ui", strings: ["db", "ws", "port"], booleans: ["json", "hub", "no-open", "browser", "no-browser"], shorts: [] },
  { name: "open", strings: ["db", "ws", "port"], booleans: ["json", "hub", "no-open", "browser", "no-browser"], shorts: [] },
  // A3 (STA-33) added `config` per the STA-24 plan command table. `--home` is
  // scoped to it — the plan gives that flag to configuration and diagnostic
  // commands only — so no other row above changed.
  { name: "config", strings: ["home"], booleans: ["json", "move", "yes"], shorts: [] },
  // A5 (STA-35) added `migrate`, the explicit `.tasks` -> `.staple` path
  // migration. The plan's command table folds migration into `init` and bare
  // `staple`, both of which need A6's consent machinery — and plan §1 step 4
  // requires printing "the exact migration command", which has to exist.
  { name: "migrate", strings: ["dir"], booleans: ["json", "yes"], shorts: [] },
  // A8 (STA-38) added `install`, the user-owned runtime installer. Its flags are
  // parsed inside src/install/index.ts (own parseArgs), not the shared `common`
  // set, so the flag row here names the top-level surface only.
  { name: "install", strings: ["from", "bin-dir", "home", "profile"], booleans: ["json", "yes", "update-path", "rollback"], shorts: [] },
  // A7 (STA-37) added `doctor`. `--home` and `--dir` scope it (the plan gives
  // `--home` to the configuration and DIAGNOSTIC commands); `--only` names the
  // one check `--fix` may repair, and `--keep` is the extra consent a failed
  // path migration needs before anything chooses between two databases.
  { name: "doctor", strings: ["only", "keep", "dir", "home"], booleans: ["json", "fix", "yes"], shorts: [] },
  // A9 (STA-39) added `add` and `discover` — the explicit one-project operation
  // and the bounded scan. Neither takes --db or --ws: both name a PATH, and a
  // path is not a workspace selector.
  { name: "add", strings: ["slug"], booleans: ["json", "yes", "no-gitignore", "migrate"], shorts: [] },
  {
    name: "discover",
    strings: ["select", "depth"],
    booleans: ["json", "yes", "all-found", "follow-symlinks", "cross-filesystems"],
    shorts: [],
  },
];

/** Every command token in one place, so a removal is a one-line diff. */
const COMMAND_NAMES = COMMANDS.map((c) => c.name);

describe("command inventory", () => {
  it("pins the exact set of command tokens the dispatcher answers to", () => {
    expect(COMMAND_NAMES).toEqual([
      "init", "new", "ls", "show", "checkout", "start", "done", "cancel",
      "status", "release", "block", "blocked-by", "wait", "link", "comment",
      "tree", "board", "inbox", "doc", "events", "hub", "ui", "open", "config",
      "migrate", "install", "doctor", "add", "discover",
    ]);
    // 29 tokens, 26 distinct behaviours: checkout/start, done/cancel and ui/open
    // each share a case. Was 22 before A3 (STA-33) added `config`, 23 before A5
    // (STA-35) added `migrate`, 24 before A8 (STA-38) added `install`, 25 before
    // A6 (STA-36) added `open`, 26 before A7 (STA-37) added `doctor`, 27 before
    // A9 (STA-39) added `add` and `discover`. The rest of the epic still owes
    // this list: connect, disconnect (STA-25 / B1-B4), and mcp — which today is
    // handled by the PACKAGED entrypoint (src/package/staple.ts) rather than by
    // this dispatcher. Whoever adds an `mcp` case here must delete that branch
    // in the same change rather than leaving two.
    expect(COMMAND_NAMES).toHaveLength(29);
  });

  it.each(COMMANDS.map((c) => c.name))(
    "`%s` is a known command, not an unknown one",
    (name) => {
      // Probed with no arguments at all: whatever it does next, it must not be
      // rejected by the default branch. `wait` and `events` would block, so the
      // runner's timeout is the backstop and a timeout still proves the token
      // was dispatched rather than rejected.
      const result = runCliAt(scratch, [name, "--db", absentDb], { STAPLE_HOME: home }, 20_000);
      expect(result.stderr).not.toContain("Unknown command");
    },
    30_000,
  );

  // MOVED BY A6 then A7: `open` and `doctor` each left this list when they
  // became real commands.
  it.each(["bogus", "Init", "INIT", "ini", "--version", "-h", "task", "list", "diagnose"])(
    "`%s` is NOT a command and is rejected as validation",
    (token) => {
      const result = cli(token);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("Unknown command");
    },
    20_000,
  );

  /**
   * The message a wrapper script greps. Pinned verbatim, backticks included.
   *
   * QUIRK (A6): this is the ONE error the CLI prints without the
   * `error(<code>): ` prefix that every StapleError gets — it is written
   * straight to stderr from the default branch, not thrown. A script matching
   * /^error\(/ to detect failure misses it entirely, even though the exit code
   * is a correct 2.
   */
  it("pins the unknown-command message verbatim, prefix-less", () => {
    const result = cli("bogus");
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe('Unknown command "bogus". Run `staple help`.\n');
    expect(result.stderr.startsWith("error(")).toBe(false);
    expect(result.status).toBe(2);
  });

  it("pins the unknown-command JSON envelope, which carries no detail key", () => {
    const result = cli("bogus", "--json");
    expect(result.stdout).toBe("");
    const envelope = JSON.parse(result.stderr.trim()) as Record<string, unknown>;
    expect(envelope).toEqual({
      code: "validation",
      message: 'Unknown command "bogus". Run `staple help`.',
      retryable: false,
    });
    // Hand-built at the default branch rather than routed through errorEnvelope,
    // so unlike every thrown error it has no `detail` key at all.
    expect(Object.keys(envelope).sort()).toEqual(["code", "message", "retryable"]);
  });
});

// ----------------------------------------------------------------- flag inventory

describe("flag inventory", () => {
  it.each(COMMANDS.filter((c) => c.strings.length + c.booleans.length > 0))(
    "`$name` accepts every flag in its golden and no parse error names one",
    ({ name, strings, booleans }) => {
      const args = [name];
      for (const flag of strings) {
        // --db points at a file that is not there, so resolution fails fast
        // instead of touching a real workspace; --port gets a value that makes
        // server.listen throw synchronously rather than bind and hang.
        args.push(`--${flag}`, flag === "db" ? absentDb : flag === "port" ? "abc" : "x");
      }
      for (const flag of booleans) args.push(`--${flag}`);
      const result = runCliAt(scratch, args, { STAPLE_HOME: home }, 20_000);
      // The command itself is expected to fail (no workspace); what must NOT
      // appear is parseArgs rejecting one of the tokens above.
      expect(result.stderr).not.toContain("Unknown option");
    },
    30_000,
  );

  it.each(COMMANDS.filter((c) => c.shorts.length > 0))(
    "`$name` accepts its single-dash aliases",
    ({ name, shorts }) => {
      for (const short of shorts) {
        const result = runCliAt(scratch, [name, `-${short}`, "x", "--db", absentDb], { STAPLE_HOME: home }, 20_000);
        expect(result.stderr, `-${short}`).not.toContain("Unknown option");
      }
    },
    30_000,
  );

  it.each(COMMANDS.filter((c) => c.name !== "hub"))(
    "`$name` rejects a flag that is not in its golden",
    ({ name }) => {
      const result = runCliAt(scratch, [name, "--zzz-not-a-real-flag", "--json"], { STAPLE_HOME: home }, 20_000);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("Unknown option");
      expect(result.stderr).toContain("--zzz-not-a-real-flag");
    },
    30_000,
  );

  /**
   * PARTLY MOVED BY A6 (STA-36). `--json` is now accepted by `init` and emits
   * the finite result the plan requires; `--db` and `--ws` are still rejected,
   * deliberately, because the plan is explicit that they "continue to target
   * EXISTING workspaces; they do not change what `init` means".
   *
   * QUIRK (still open, for whoever unifies the flag surface): both are
   * advertised in the help text as GLOBAL flags while two commands do not take
   * them.
   */
  it("KNOWN: `init` still rejects the documented global flags --db and --ws", () => {
    for (const flag of ["--db", "--ws"]) {
      const result = runCliAt(scratch, ["init", flag, "x"], { STAPLE_HOME: home }, 20_000);
      expect(result.status, flag).toBe(2);
      expect(result.stderr, flag).toContain("Unknown option");
    }
  }, 40_000);

  /**
   * QUIRK (A6): `hub` parses nothing. Any flag is silently swallowed, --db and
   * --ws are ignored (the hub is machine-global by design, but the flags are
   * still accepted without complaint), and an unrecognised SUBCOMMAND prints a
   * usage line to STDOUT and exits 0 rather than failing validation.
   */
  it("KNOWN: `hub` swallows unknown flags and exits 0 on an unknown subcommand", () => {
    const flagged = cli("hub", "--zzz-not-a-real-flag");
    expect(flagged.status).toBe(0);
    expect(flagged.stderr).toBe("");

    const badSub = cli("hub", "not-a-subcommand");
    expect(badSub.status).toBe(0);
    expect(badSub.stdout).toBe("usage: staple hub [ls|links|events]\n");
    expect(badSub.stderr).toBe("");
  }, 30_000);

  /**
   * QUIRK (A2): a parseArgs failure without --json prints the RAW Node error
   * object — `TypeError [ERR_PARSE_ARGS_UNKNOWN_OPTION]`, a full stack, and the
   * absolute path of src/cli.ts — because the catch block only formats errors
   * that are `instanceof StapleError`, and it normalizes the parse error into a
   * StapleError for the exit code WITHOUT using it for the message.
   *
   * A2 bundles the CLI into a single .mjs; this leaks the bundle's internals to
   * any user who mistypes a flag. Pinned, not fixed.
   */
  it("KNOWN: a parse error without --json prints a raw stack, not error(validation)", () => {
    const result = cli("ls", "--nope");
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("ERR_PARSE_ARGS_UNKNOWN_OPTION");
    expect(result.stderr).toContain("Unknown option '--nope'");
    expect(result.stderr).toContain("src/cli.ts"); // absolute source path leaked
    expect(result.stderr).toContain("at parseArgs");
    expect(result.stderr).not.toContain("error(validation):");
    // The SAME failure under --json is a clean one-line envelope, which is what
    // contract-cli.test.ts pins. The divergence is the point of this test.
    const asJson = cli("ls", "--nope", "--json");
    expect(JSON.parse(asJson.stderr.trim())).toEqual({
      code: "validation",
      message: "Unknown option '--nope'",
      retryable: false,
    });
  }, 30_000);
});

// -------------------------------------------------------------------- help surface

describe("help surface", () => {
  /**
   * MOVED BY A6 (STA-36), exactly as A1 said it would be. The original assertion
   * pinned bare `staple` == `staple help` and carried the note: "a bare `staple`
   * is help today. The accepted plan makes it 'initialize if needed, then open
   * the UI' — so this assertion is EXPECTED to be rewritten by A6, deliberately,
   * rather than to break by surprise."
   *
   * What survives unchanged is the half a script depends on: `help` and
   * `--help` are still the same text and still exit 0. What changed is that a
   * bare invocation is now the interactive lifecycle, which in this (non-TTY)
   * runner is the plan's refusal — validation exit 2, no mutation. The full
   * behaviour lives in `init-lifecycle.test.ts`.
   */
  it("prints the same help for `help` and `--help`, both exit 0", () => {
    const word = cli("help");
    const flag = cli("--help");
    for (const result of [word, flag]) {
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
    }
    expect(flag.stdout).toBe(word.stdout);
    expect(word.stdout.startsWith("staple — local-first task tracker for coding agents")).toBe(true);
  }, 30_000);

  it("a bare invocation is the lifecycle command, not help", () => {
    const bare = cli();
    expect(bare.status).toBe(2);
    expect(bare.stdout).toBe("");
    expect(bare.stderr).toContain("Bare `staple` is the interactive command");
    expect(bare.stderr).not.toContain("Unknown command");
  }, 30_000);

  it("documents every command token it dispatches", () => {
    const help = cli("help").stdout;
    // `start` and `cancel` are documented on shared lines with their aliases.
    for (const name of COMMAND_NAMES) {
      expect(help, name).toContain(name);
    }
  });

  it("pins the help section headings a reader navigates by", () => {
    const help = cli("help").stdout;
    const headings = help.split("\n").filter((l) => /^[A-Z][A-Za-z &]*$/.test(l));
    // "Approval gates" arrived with STA-143 and sits with the flow it belongs to;
    // "Workspace vocabulary" arrived with STA-140 (staple statuses / kinds) and sits
    // last, after the global flags, because it is configuration rather than work.
    expect(headings).toEqual([
      "Workspace",
      "Tasks",
      "Flow",
      "Approval gates",
      "Documents & events",
      "UI",
      "Workspace vocabulary",
    ]);
  });

  it("pins the global-flag and status footer scripts read", () => {
    const help = cli("help").stdout;
    expect(help).toContain("Global flags: --db <path>, --ws <slug|prefix>  (default: walk up for .staple/staple.db,");
    /**
     * ISSUE_STATUSES order, verbatim — `board` renders its columns in exactly
     * this sequence for a DEFAULT workspace, so `done` sitting BEFORE `blocked`
     * is load-bearing, not a typo in the help text.
     *
     * STA-140 made the footer say "built-in seed" out loud, because `staple help`
     * has no workspace in hand and can only ever print the seed — the workspace's
     * actual set comes from `staple statuses ls`. STA-143 added
     * `awaiting_approval` to that seed, between `in_review` and `done`, which is
     * where the life of a ticket puts it.
     */
    expect(help).toContain("Statuses (built-in seed;");
    expect(help).toContain(
      "backlog todo in_progress in_review awaiting_approval done blocked cancelled",
    );
  });

  /**
   * QUIRK (A6): flags that exist but are undocumented. `new --allow-duplicate`
   * and `ui --no-open` are real, load-bearing flags — `--no-open` is what CI and
   * the dev script use — and neither appears in the help text. Anything
   * generating documentation or completions from `staple help` will miss them.
   */
  it("KNOWN: --allow-duplicate and --no-open work but are absent from help", () => {
    const help = cli("help").stdout;
    expect(help).not.toContain("--allow-duplicate");
    expect(help).not.toContain("--no-open");
    // …yet both parse.
    expect(runCliAt(scratch, ["new", "t", "--allow-duplicate", "--db", absentDb], { STAPLE_HOME: home }).stderr)
      .not.toContain("Unknown option");
  }, 30_000);
});
