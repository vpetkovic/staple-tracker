/**
 * Every `issues` column is either replicated or explicitly excluded.
 *
 * This exists because of a real bug, and it pins the invariant rather than the
 * instance. The merged mutation seam journaled ten of the twenty-four columns
 * `createIssue` writes, and the missing ones — `description`, `labels`,
 * `acceptance_criteria`, `created_by`, `estimated_seconds` among them — were
 * silently unreplicated. A second device hydrating from a snapshot got issues
 * with no description and no acceptance criteria, and nothing anywhere failed.
 *
 * A create is the ONLY operation that will ever carry most of these columns:
 * nothing journals an update for a field set once at birth and never touched
 * again, so a field missing from the create is a field that never reaches another
 * device at all.
 *
 * So the test is not "does the payload contain description". It is: take the
 * `issues` schema as it actually is, and require every column to be accounted
 * for. The next column added to that table has to make the replication decision
 * explicitly, in the exclusion list below, with a reason — which is the only
 * mechanism that survives the eleventh column nobody thought about.
 */
import { describe, expect, it } from "vitest";
import { ISSUE_COLUMNS } from "../src/core/cloud/apply.js";
import { openDb } from "../src/core/db.js";
import { bindJournal } from "../src/core/journal.js";
import { writeStoredRepositoryId } from "../src/core/repo-identity.js";
import { migrateWorkspace } from "../src/core/schema.js";
import { WorkspaceStore } from "../src/core/store.js";

const REPO_ID = "0e77fa01-1111-4222-8333-444455556666";

/**
 * Columns that deliberately do not travel in an `issue.create`, and why.
 *
 * Each entry is a decision, not an oversight. Deleting one from this list without
 * adding the field to the payload is what the test is for.
 */
const EXCLUDED: Record<string, string> = {
  id: "the entity id itself — it is the envelope's `entityId`, not a payload field",
  status_version:
    "0 by schema default on every device; the optimistic-concurrency token, carried by the operations that move status",
  checkout_agent:
    "never a plain field write — the projection of a lease (docs/sync.md, 'Claims')",
  checkout_at: "as checkout_agent",
  blocked_transition_at:
    "local timing state; not in the contract's issues field inventory",
  completed_at: "null at create by construction; set by the status transition that journals it",
  cancelled_at: "as completed_at",
  gate_state: "null at create; every gate transition journals its own update",
  gate_owner: "as gate_state",
  gate_requested_by: "as gate_state",
  gate_requested_at: "as gate_state",
  gate_resolved_by: "as gate_state",
  gate_resolved_at: "as gate_state",
  gate_released: "0 at create; as gate_state",
};

function armed(): WorkspaceStore {
  const db = openDb(":memory:");
  migrateWorkspace(db);
  writeStoredRepositoryId(db, REPO_ID);
  bindJournal(db, "device-coverage");
  return new WorkspaceStore(db, "test", "TST");
}

function issueColumns(store: WorkspaceStore): string[] {
  return (store.db.prepare("PRAGMA table_info(issues)").all() as Array<{ name: string }>).map(
    (row) => row.name,
  );
}

/** The payload of the one `issue.create` a fully-populated create journals. */
function createPayload(store: WorkspaceStore): Record<string, unknown> {
  const blocker = store.createIssue({ title: "A blocker" });
  const parent = store.createIssue({ title: "A parent" });
  const before = (
    store.db.prepare("SELECT COUNT(*) AS n FROM sync_outbox").get() as { n: number }
  ).n;

  store.createIssue({
    title: "Every field populated",
    description: "a description that must travel",
    priority: "high",
    parent: parent.identifier,
    assignee: "agent-a",
    createdBy: "agent-b",
    labels: ["one", "two"],
    acceptanceCriteria: ["it converges"],
    blockedBy: [blocker.identifier],
    estimatedSeconds: 7200,
    idempotencyKey: "idem-1",
    originKind: "github",
    originId: "gh-7",
  });

  const rows = store.db
    .prepare(
      "SELECT entity, verb, payload FROM sync_outbox ORDER BY client_seq LIMIT -1 OFFSET ?",
    )
    .all(before) as Array<{ entity: string; verb: string; payload: string }>;
  const create = rows.find((row) => row.entity === "issue" && row.verb === "create");
  expect(create, "createIssue must journal exactly one issue.create").toBeDefined();
  return JSON.parse(create!.payload) as Record<string, unknown>;
}

describe("issue.create replicates every issues column, or says why not", () => {
  it("accounts for every column in the issues table", () => {
    const store = armed();
    const payload = createPayload(store);

    // The payload keys are mapped to columns through the SAME table the applier
    // uses, so a key the applier cannot place does not count as coverage.
    const covered = new Set<string>();
    for (const key of Object.keys(payload)) {
      const mapped = ISSUE_COLUMNS[key];
      if (mapped) covered.add(mapped.column);
    }

    const unaccounted = issueColumns(store).filter(
      (column) => !covered.has(column) && !(column in EXCLUDED),
    );

    expect(
      unaccounted,
      `These issues columns are neither journaled by issue.create nor on the documented ` +
        `exclusion list in this file. A column that is neither never reaches another device. ` +
        `Add it to the payload in WorkspaceStore.createIssue, or add it to EXCLUDED with the ` +
        `reason it does not travel.`,
    ).toEqual([]);
    store.db.close();
  });

  it("excludes nothing that no longer exists", () => {
    const store = armed();
    const columns = new Set(issueColumns(store));
    const stale = Object.keys(EXCLUDED).filter((column) => !columns.has(column));
    expect(stale, "EXCLUDED names columns the schema no longer has").toEqual([]);
    store.db.close();
  });

  it("carries the fields whose absence was the original bug", () => {
    const store = armed();
    const payload = createPayload(store);

    expect(payload.description).toBe("a description that must travel");
    expect(payload.labels).toEqual(["one", "two"]);
    expect(payload.acceptanceCriteria).toEqual(["it converges"]);
    expect(payload.createdBy).toBe("agent-b");
    expect(payload.estimatedSeconds).toBe(7200);
    expect(payload.idempotencyKey).toBe("idem-1");
    expect(payload.originKind).toBe("github");
    expect(payload.originId).toBe("gh-7");
    // `blockedBy` is not an issues column; it rides inside the create so a
    // receiver never sees an issue whose declared blockers have not arrived.
    expect(Array.isArray(payload.blockedBy)).toBe(true);
    store.db.close();
  });

  it("maps every payload key it carries onto a real column, except blockedBy", () => {
    const store = armed();
    const payload = createPayload(store);
    const columns = new Set(issueColumns(store));

    const unplaceable = Object.keys(payload).filter(
      (key) => key !== "blockedBy" && !(ISSUE_COLUMNS[key] && columns.has(ISSUE_COLUMNS[key]!.column)),
    );
    expect(
      unplaceable,
      "the seam journals a field the applier cannot write, so it would be silently dropped on arrival",
    ).toEqual([]);
    store.db.close();
  });
});
