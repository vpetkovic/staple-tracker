/**
 * A1 — the HUMAN (non-`--json`) rendering of every read command.
 *
 * `cli-json.test.ts` pins the machine payloads and states outright that "human
 * output is unaffected" — but it only checks that ONE glyph line appears. The
 * human surface is nonetheless a de-facto contract: `staple ls | grep in_progress`,
 * `staple hub ls | awk '{print $1}'`, and `staple ui | grep -o 'http://[^ ]*'`
 * are exactly how a shell agent and a wrapper script consume this tool, and the
 * column widths those pipelines depend on live in one 4-line `line()` helper.
 *
 * A6 rewrites init, adds `open`, and reformats startup messaging; A7 adds
 * `doctor` with "human output groups pass, warning and failure results". Both
 * will touch these renderers. This file makes a width change or a dropped
 * column a red test rather than a silently broken pipeline.
 *
 * Fixture data is deliberately dull and fixed so the goldens are literal
 * strings, not regexes: a regex would pass through exactly the padding change
 * this suite exists to catch.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCliAt, tempDir, removeDir } from "./fixtures/characterize-support.js";

const AGENT = "char-agent";

let home: string;
let root: string;
let repo: string;

function cli(...args: string[]) {
  return runCliAt(repo, args, { STAPLE_HOME: home, STAPLE_AGENT: AGENT, USER: "char-user" });
}

beforeAll(() => {
  home = tempDir("char-human-home");
  root = tempDir("char-human-root");
  // "humanrepo" -> slug humanrepo -> prefix HUM. Fixed so identifiers are literal.
  repo = join(root, "humanrepo");
  mkdirSync(repo, { recursive: true });

  expect(cli("init").status).toBe(0);
  expect(cli("new", "Alpha", "-p", "high").status).toBe(0);
  expect(cli("new", "Beta").status).toBe(0);
  expect(cli("new", "Gamma", "-p", "critical", "--assignee", "someone").status).toBe(0);
  expect(cli("new", "Delta", "-p", "low", "--parent", "HUM-1").status).toBe(0);
  expect(cli("blocked-by", "HUM-2", "HUM-1").status).toBe(0);
  expect(cli("block", "HUM-3", "--owner", "ops", "--action", "grant access").status).toBe(0);

  const doc = join(home, "doc.md");
  writeFileSync(doc, "body line one\n");
  expect(cli("doc", "HUM-1", "plan", "--put", doc, "--summary", "first").status).toBe(0);
}, 120_000);

afterAll(() => {
  removeDir(home);
  removeDir(root);
});

// ---------------------------------------------------------------- the line() shape

/**
 * `line()` in src/cli.ts is ONE function shared by ls, new, done, cancel,
 * status, release, block, blocked-by, checkout, tree, inbox and wait. Its layout
 * is: <status glyph><priority mark> <identifier padded to 9> <status padded to
 * 11> <title>[ @assignee][extra].
 *
 * Pinned as exact strings, including the trailing space that a medium-priority
 * row produces (PRIORITY_MARKS.medium is " ", so the glyph column is always two
 * characters wide and a medium row reads "◌  " with two spaces).
 */
describe("the shared issue line", () => {
  it("pins glyph, priority mark, both column widths, and the priority ordering", () => {
    const out = cli("ls").stdout;
    // Rows come back critical -> high -> medium -> low, NOT in identifier order.
    // A script that assumes `ls` is chronological is already wrong today.
    expect(out).toBe(
      [
        "⊘!! HUM-3     blocked     Gamma @someone",
        "◌! HUM-1     backlog     Alpha",
        "◌  HUM-2     backlog     Beta",
        "◌· HUM-4     backlog     Delta",
        "",
      ].join("\n"),
    );
  });

  /**
   * QUIRK (A6/A7): the priority column is NOT a fixed width. `critical` renders
   * "!!" where every other priority renders one character, so a critical row is
   * one column wider than its neighbours and every field after it shifts right
   * (see HUM-3 above). Any script slicing by byte offset breaks on a critical
   * issue; `awk '{print $2}'` survives. Pinned as-is.
   */
  it("KNOWN: a critical row is one column wider than every other row", () => {
    const lines = cli("ls").stdout.split("\n");
    const critical = lines.find((l) => l.includes("HUM-3"))!;
    const normal = lines.find((l) => l.includes("HUM-1"))!;
    expect(critical.indexOf("HUM-3")).toBe(normal.indexOf("HUM-1") + 1);
  });

  it("renders (no issues) rather than nothing for an empty list", () => {
    expect(cli("ls", "--status", "done").stdout).toBe("(no issues)\n");
  });

  it("hides resolved work until --all", () => {
    expect(cli("ls").stdout).not.toContain("HUM-5");
    expect(cli("new", "Epsilon").status).toBe(0);
    expect(cli("done", "HUM-5").stdout).toBe("●  HUM-5     done        Epsilon\n");
    expect(cli("ls").stdout).not.toContain("HUM-5");
    expect(cli("ls", "--all").stdout).toContain("●  HUM-5     done        Epsilon");
  }, 60_000);
});

// ----------------------------------------------------------------- per-command shapes

describe("read command renderings", () => {
  it("pins the `show` header block and its section labels", () => {
    const out = cli("show", "HUM-1").stdout;
    expect(out).toBe(
      [
        "HUM-1 · Alpha",
        // STA-124 put `kind` on this line, unconditionally — `show` is the
        // detail surface, so it names the kind even when it is the default.
        // `ls`/`tree`/`inbox` rows deliberately do NOT: `line()` suppresses the
        // default kind, which is why every other golden in this file is
        // unchanged by that ticket and HUM-1 still renders `◌! HUM-1 …` bare.
        // Note HUM-1 is a `task` despite having a child: kind is DECLARED, and
        // migration 005's parents-become-epics backfill only ever ran against
        // rows that predated it, not against issues a fixture creates.
        "status backlog (v0) · kind task · priority high",
        // No `path` line: HUM-1 is a root, and the path line is emitted only
        // when there is at least one ancestor — so a top-level issue and a
        // depth-1 child are formatted differently.
        "blocks:     HUM-2(backlog)",
        "",
        "children:",
        "  ◌· HUM-4     backlog     Delta",
        "",
        "documents: plan@r1",
        "",
      ].join("\n"),
    );
  });

  it("pins the `show` path line for a child, which the root case omits", () => {
    const out = cli("show", "HUM-4").stdout;
    expect(out.split("\n")[2]).toBe("path   HUM-1 > HUM-4");
  });

  it("pins the `board` column order, header format, and per-row indent", () => {
    const out = cli("board").stdout;
    expect(out).toBe(
      [
        "",
        "◌ BACKLOG (3)",
        "   HUM-1     Alpha",
        "   HUM-2     Beta",
        "   HUM-4     Delta",
        "",
        "○ TODO (0)",
        "",
        "◐ IN_PROGRESS (0)",
        "",
        "◑ IN_REVIEW (0)",
        "",
        "● DONE (1)",
        "   HUM-5     Epsilon",
        "",
        "⊘ BLOCKED (1)",
        "   HUM-3     Gamma @someone",
        "",
      ].join("\n"),
    );
  });

  it("pins the `tree` two-space indent per level", () => {
    expect(cli("tree", "HUM-1").stdout).toBe(
      ["◌! HUM-1     backlog     Alpha", "  ◌· HUM-4     backlog     Delta", ""].join("\n"),
    );
  });

  it("pins the `inbox` section labels and the blocked reason suffix", () => {
    const out = cli("inbox").stdout;
    expect(out).toBe(
      [
        "READY (pickup order):",
        "  ◌! HUM-1     backlog     Alpha",
        "  ◌· HUM-4     backlog     Delta",
        "BLOCKED:",
        // Blocked rows are priority-ordered too: the critical status-blocked
        // issue precedes the medium dependency-blocked one, and the two carry
        // DIFFERENT reason suffixes from the same `[...]` slot.
        "  ⊘!! HUM-3     blocked     Gamma @someone  [ops must grant access]",
        "  ◌  HUM-2     backlog     Beta  [waiting on HUM-1]",
        "",
      ].join("\n"),
    );
  });

  it("pins the `events` line format: seq padded to 4, second-precision time, JSON payload", () => {
    const first = cli("events").stdout.split("\n")[0]!;
    // kind is padEnd(18) followed by two literal spaces, so a 13-character kind
    // is trailed by exactly seven spaces before the payload.
    expect(first).toMatch(
      /^ {3}1 {2}\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2} {2}issue_created {7}\{"identifier":"HUM-1","title":"Alpha","status":"backlog"\}$/,
    );
    // The timestamp is sliced to 19 chars, so it carries NO trailing Z and is
    // not a parseable ISO instant the way the --json form is.
    expect(first).not.toContain("Z ");
  });

  it("pins the `doc` read header and body separation", () => {
    const out = cli("doc", "HUM-1", "plan").stdout;
    expect(out).toMatch(/^# plan @ r1 \(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}\)\n\nbody line one\n\n$/);
  });

  it("pins the `doc --revisions` row format", () => {
    const out = cli("doc", "HUM-1", "plan", "--revisions").stdout;
    expect(out).toMatch(/^r1 {2}\d{4}-\d{2}-\d{2}T\d{2}:\d{2} {2}char-agent {2}first\n$/);
  });

  it("pins the `comment` acknowledgement, which reveals nothing about what was written", () => {
    expect(cli("comment", "HUM-2", "a note").stdout).toBe("commented.\n");
  });
});

// -------------------------------------------------------------------- write feedback

describe("write command feedback", () => {
  /**
   * These mutate, so each one works on an issue it creates itself and reads the
   * minted identifier back out of the `new` line rather than assuming a count.
   * That also pins `new`'s own rendering: the identifier has to be greppable
   * out of it, which is how a shell script chains `new` into `checkout`.
   */
  function freshIssue(title: string): string {
    const created = cli("new", title).stdout;
    const identifier = /\b(HUM-\d+)\b/.exec(created)?.[1];
    expect(identifier, created).toBeTruthy();
    expect(created).toBe(`◌  ${identifier!.padEnd(9)} backlog     ${title}\n`);
    return identifier!;
  }

  it("pins the checkout and release lines, and that checkout also sets the assignee", () => {
    const ref = freshIssue("Checkoutee");
    // QUIRK worth carrying forward: `checkout` assigns the issue to the claiming
    // agent as a side effect, so the rendered line gains an "@agent" segment that
    // was not there a moment ago — and `release` does NOT take it away.
    expect(cli("checkout", ref).stdout).toBe(
      `claimed ◐  ${ref.padEnd(9)} in_progress Checkoutee @${AGENT}\n`,
    );
    expect(cli("release", ref).stdout).toBe(`○  ${ref.padEnd(9)} todo        Checkoutee @${AGENT}\n`);
  }, 60_000);

  it("pins the blocked-by suffixes for both the waiting and the clear case", () => {
    expect(cli("blocked-by", "HUM-2", "--none").stdout).toBe(
      "◌  HUM-2     backlog     Beta  [no unresolved blockers]\n",
    );
    expect(cli("blocked-by", "HUM-2", "HUM-1").stdout).toBe(
      "◌  HUM-2     backlog     Beta  [waiting on HUM-1]\n",
    );
  }, 60_000);

  it("pins the block line's unblock descriptor suffix", () => {
    const ref = freshIssue("Blockee");
    expect(cli("block", ref, "--owner", "ops", "--action", "approve").stdout).toBe(
      `⊘  ${ref.padEnd(9)} blocked     Blockee  [unblock: ops → approve]\n`,
    );
  }, 60_000);

  /**
   * The two lines `staple init` prints are the closest thing staple has to an
   * onboarding transcript, and A6 rewrites init wholesale. Both are pinned with
   * the db path substituted, since the path itself is the temp fixture.
   */
  /**
   * MOVED BY A6 (STA-36): a THIRD line, for `.staple/.gitignore` (STA-59's
   * resolution — see characterize-layout.test.ts for the reasoning). The first
   * two lines are byte-identical to what A5 left; the new one appears only on
   * the run that actually writes the file, which is why the re-init below is
   * still exactly two lines.
   *
   * The asymmetry is deliberate and is the same rule the guide already follows:
   * init reports what it DID, so a re-run that changed nothing says nothing new.
   */
  it("pins the `init` lines for a fresh repo workspace and for a re-init", () => {
    const fresh = tempDir("char-human-fresh");
    const project = join(fresh, "freshrepo");
    mkdirSync(project, { recursive: true });
    const db = join(project, ".staple", "staple.db");
    const guide = join(project, ".staple", "AGENTS.md");
    const ignore = join(project, ".staple", ".gitignore");

    const first = runCliAt(project, ["init"], { STAPLE_HOME: home });
    expect(first.status).toBe(0);
    expect(first.stdout).toBe(
      `Created workspace "freshrepo" (prefix FRE) at ${db} — registered in hub.\n` +
        `Wrote the agent protocol guide to ${guide} — read it before working this repo.\n` +
        `Wrote ${ignore} so the database stays out of git; AGENTS.md is deliberately NOT ignored.\n`,
    );

    const again = runCliAt(project, ["init"], { STAPLE_HOME: home });
    expect(again.status).toBe(0);
    // "Opened", not "Created", and the guide is reported as kept — the only
    // signal a user gets that their edits survived. The ignore file was already
    // there, so it is not mentioned at all.
    expect(again.stdout).toBe(
      `Opened workspace "freshrepo" (prefix FRE) at ${db} — registered in hub.\n` +
        `Kept the existing ${guide} (not overwritten).\n`,
    );
    removeDir(fresh);
  }, 60_000);

  it("pins the `init --global` second line, which explains the missing guide", () => {
    const result = runCliAt(repo, ["init", "--global", "charglobal"], { STAPLE_HOME: home });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(
      `Created workspace "charglobal" (prefix CHA) at ${join(home, "workspaces", "charglobal.db")} — registered in hub.\n` +
        // MOVED BY A5: the sentence names the current layout directory.
        "Global workspace — no AGENTS.md guide (it belongs beside a repo's .staple).\n",
    );
  }, 30_000);
});
