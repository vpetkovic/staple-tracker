/**
 * ONE committed artifact pinning what a device can see of the fold checkpoint, read by BOTH
 * suites: `worker/test/fold-parity.test.ts` drives the real Worker through it and
 * `test/cloud-fold-parity.test.ts` drives `test/fixtures/fake-sync-server.ts` through it, and
 * both must observe exactly {@link FOLD_PARITY_OBSERVED}. The observations are the numbers
 * the fold's limits put on the wire: the `foldedSeq` of every "still folding" answer, how many
 * entities each snapshot page and each restore turn holds, and the order a restore stages in.
 *
 * NO IMPORTS, for the same reason as `purge-fixture.ts`: it is the one kind of file both
 * tsconfigs compile.
 *
 * The log is chosen so the limits bind: payloads in characters that are two and three UTF-8
 * bytes, so a limit counted in string length and one counted in bytes cut differently; some
 * of 400 KB, so the free plan's 1 MiB of payload a request stops a fold before its 500
 * operations do, and entity states past 1 MiB a page; gaps in seq; and renumbers, so a
 * restore's claim order is not its key order.
 */

/** One operation, as `ops` stores it: the payload already JSON text. */
export interface ParityOp {
  seq: number;
  entity: string;
  entityId: string;
  verb: string;
  payload: string;
  opId: string;
  actor: string;
  createdAt: string;
  serverTs: number;
}

const BIG_TAIL = 8;

export const FOLD_PARITY_OPS: readonly ParityOp[] = (() => {
  const out: ParityOp[] = [];
  let seq = 0;
  const base = Date.parse("2026-09-01T00:00:00.000Z");
  const created = new Set<string>();
  for (let n = 0; n < 1300; n += 1) {
    seq += n % 17 === 0 ? 3 : 1;
    let entity = "issue";
    let entityId = `iss-${String((n * 37) % 150).padStart(3, "0")}`;
    let verb = "update";
    let payload: Record<string, unknown>;
    if (n % 11 === 0) {
      entity = "comment";
      entityId = `com-${String(n % 60).padStart(2, "0")}`;
      verb = "create";
      payload = { issueId: `iss-${String(n % 150).padStart(3, "0")}`, body: "コメント".repeat(1 + (n % 40)) };
    } else if (!created.has(entityId)) {
      created.add(entityId);
      verb = "create";
      payload = { identifier: `PAR-${(n % 150) + 1}`, title: `課題 ${n}`, status: "todo" };
    } else if (n % 97 === 0) {
      payload = { description: "é".repeat(200_000) };
    } else if (n % 13 === 0) {
      verb = "renumber";
      payload = { identifier: `PAR-${1000 + n}` };
    } else {
      payload = { title: `課題 ${n} ${"ü".repeat(n % 50)}`, updatedAt: new Date(base + n).toISOString() };
    }
    out.push({
      seq,
      entity,
      entityId,
      verb,
      payload: JSON.stringify(payload),
      opId: `parity-${n}`,
      actor: "parity",
      createdAt: new Date(base + n * 1000).toISOString(),
      serverTs: base + n * 1000,
    });
  }
  // A run of 400 KB edits to end on: a request folds three of them before its 1 MiB is spent, so
  // one request's budget ends exactly at the log's end — where a restore of it goes on to fold
  // the next epoch with nothing left, and its progress must still climb.
  for (let n = 0; n < BIG_TAIL; n += 1) {
    seq += 1;
    out.push({
      seq,
      entity: "issue",
      entityId: `iss-${String(n).padStart(3, "0")}`,
      verb: "update",
      payload: JSON.stringify({ description: `${n}`.padEnd(200_000, "é") }),
      opId: `parity-tail-${n}`,
      actor: "parity",
      createdAt: new Date(base + (1300 + n) * 1000).toISOString(),
      serverTs: base + (1300 + n) * 1000,
    });
  }
  return out;
})();

/** The free plan's fold limits (`worker/src/limits.ts`), as the fake is configured to mirror. */
export const FOLD_PARITY_LIMITS = {
  foldBudget: 500,
  foldStep: 500,
  foldBudgetBytes: 1024 * 1024,
  restoreStageEntities: 200,
  pageBytes: 1024 * 1024,
} as const;

export interface ParityResponse {
  status: number;
  body: Record<string, any>;
}

export interface ParityDriver {
  repoId: string;
  /** A request to the repository's routes: `path` is after `/v1/repos/{repoId}`. */
  send(method: string, path: string, body?: unknown): Promise<ParityResponse>;
  /** Forget the fold checkpoint, as a Worker deployed onto an existing log starts. */
  clearFold(): Promise<void>;
  /** The entity keys of the operations staged into `epoch`, in seq order. */
  stagedKeys(epoch: number): Promise<string[]>;
}

/** Drive one server through the scenario, and answer what a device observed. */
export async function observeFoldParity(driver: ParityDriver): Promise<Record<string, unknown>> {
  const observed: Record<string, unknown> = {};

  // Until a request answers something other than "still folding": the foldedSeq of each.
  const untilFolded = async (send: () => Promise<ParityResponse>) => {
    const folding: number[] = [];
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const response = await send();
      if (response.status !== 503) return { response, folding };
      folding.push(response.body.foldedSeq);
    }
    throw new Error("never folded");
  };

  const snapshot = async () => {
    const first = await untilFolded(() => driver.send("GET", "/snapshot?limit=500"));
    const pages: number[] = [];
    let response = first.response;
    for (;;) {
      if (response.status !== 200) throw new Error(JSON.stringify(response.body).slice(0, 300));
      pages.push(response.body.entities.length);
      if (!response.body.hasMore) break;
      response = await driver.send("GET", `/snapshot?limit=500&cursor=${encodeURIComponent(response.body.nextCursor)}`);
    }
    return { folding: first.folding, cutoffSeq: first.response.body.cutoffSeq, pages };
  };

  await driver.clearFold();
  observed.snapshot = await snapshot();

  // A pull a step behind folds a step; three pull pages from nothing.
  await driver.clearFold();
  let cursor: string | null = null;
  for (let page = 0; page < 3; page += 1) {
    const response = await driver.send("GET", `/ops?limit=500${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    cursor = response.body.nextCursor;
  }

  const backup = await untilFolded(() => driver.send("POST", "/backups", {}));
  observed.backup = {
    folding: backup.folding,
    status: backup.response.status,
    entityCount: backup.response.body.backup?.entityCount,
    opCount: backup.response.body.backup?.opCount,
    cutoffSeq: backup.response.body.backup?.cutoffSeq,
  };
  const backupId = backup.response.body.backup.backupId as string;

  await driver.clearFold();
  const turns: unknown[] = [];
  let restoreId: string | undefined;
  let toEpoch = 0;
  let lastUndo: string | undefined;
  for (let turn = 0; turn < 100; turn += 1) {
    const response = await driver.send("POST", `/backups/${backupId}/restore`, {
      confirm: driver.repoId,
      ...(restoreId ? { restoreId } : {}),
    });
    turns.push(response.status === 503 ? { folding: response.body.foldedSeq } : { status: response.status, staged: response.body.staged });
    if (response.status === 503) continue;
    if (response.status !== 200) break;
    restoreId = response.body.restoreId;
    toEpoch = response.body.toEpoch;
    lastUndo = response.body.preRestoreBackupId ?? lastUndo;
    if (response.body.done) break;
  }
  observed.restore = turns;
  observed.stagedOrder = (await driver.stagedKeys(toEpoch)).join("|");
  observed.restored = await snapshot();

  // The undo, restored from the next epoch with nothing folded: two epochs' folds before it
  // begins, whose progress climbs across both.
  const undo = turns.length > 0 ? lastUndo : undefined;
  await driver.clearFold();
  const back: unknown[] = [];
  restoreId = undefined;
  for (let turn = 0; turn < 100 && undo; turn += 1) {
    const response = await driver.send("POST", `/backups/${undo}/restore`, {
      confirm: driver.repoId,
      ...(restoreId ? { restoreId } : {}),
    });
    back.push(response.status === 503 ? { folding: response.body.foldedSeq, cutoff: response.body.cutoffSeq } : { status: response.status, staged: response.body.staged });
    if (response.status === 503) continue;
    if (response.status !== 200) break;
    restoreId = response.body.restoreId;
    if (response.body.done) break;
  }
  observed.undo = back;
  observed.undone = await snapshot();
  return observed;
}

/**
 * What the Worker answered, recorded from `worker/test/fold-parity.test.ts`. The fake must
 * answer the same.
 */
export const FOLD_PARITY_OBSERVED: Record<string, unknown> = {
  snapshot: {"folding": [544, 869, 1303, 1456, 1459], "cutoffSeq": 1462, "pages": [62, 2, 2, 12, 33, 22, 22, 22, 33]},
  backup: {"folding": [1456, 1459], "status": 200, "entityCount": 210, "opCount": 1308, "cutoffSeq": 1462},
  restore: [{"folding": 544}, {"folding": 869}, {"folding": 1303}, {"folding": 1456}, {"folding": 1459}, {"status": 200, "staged": 0}, {"status": 200, "staged": 24}, {"status": 200, "staged": 29}, {"status": 200, "staged": 65}, {"status": 200, "staged": 79}, {"status": 200, "staged": 97}, {"status": 200, "staged": 134}, {"status": 200, "staged": 165}, {"status": 200, "staged": 201}, {"status": 200, "staged": 210}, {"status": 200, "staged": 210}],
  restored: {"folding": [], "cutoffSeq": 1672, "pages": [62, 2, 2, 12, 33, 22, 22, 22, 33]},
  undo: [{"folding": 544, "cutoff": 1462}, {"folding": 869, "cutoff": 1462}, {"folding": 1303, "cutoff": 1462}, {"folding": 1456, "cutoff": 1462}, {"folding": 1459, "cutoff": 1462}, {"folding": 1462, "cutoff": 1672}, {"folding": 1487, "cutoff": 1672}, {"folding": 1524, "cutoff": 1672}, {"folding": 1542, "cutoff": 1672}, {"folding": 1584, "cutoff": 1672}, {"folding": 1628, "cutoff": 1672}, {"status": 200, "staged": 0}, {"status": 200, "staged": 24}, {"status": 200, "staged": 29}, {"status": 200, "staged": 65}, {"status": 200, "staged": 79}, {"status": 200, "staged": 97}, {"status": 200, "staged": 134}, {"status": 200, "staged": 165}, {"status": 200, "staged": 201}, {"status": 200, "staged": 210}, {"status": 200, "staged": 210}],
  undone: {"folding": [], "cutoffSeq": 1882, "pages": [62, 2, 2, 12, 33, 22, 22, 22, 33]},
  stagedOrder: [
    "issue iss-037", "issue iss-074", "issue iss-109", "issue iss-146", "issue iss-031", "issue iss-068",
    "issue iss-105", "issue iss-140", "issue iss-027", "issue iss-062", "issue iss-099", "issue iss-136",
    "issue iss-058", "issue iss-093", "issue iss-130", "issue iss-017", "issue iss-052", "issue iss-089",
    "issue iss-124", "issue iss-011", "issue iss-048", "issue iss-083", "issue iss-120", "issue iss-007",
    "issue iss-005", "issue iss-079", "issue iss-114", "issue iss-001", "issue iss-036", "issue iss-073",
    "issue iss-110", "issue iss-145", "issue iss-032", "issue iss-069", "issue iss-067", "issue iss-104",
    "issue iss-141", "issue iss-028", "issue iss-026", "issue iss-100", "issue iss-137", "issue iss-098",
    "issue iss-135", "issue iss-022", "issue iss-096", "issue iss-057", "issue iss-094", "issue iss-131",
    "issue iss-055", "issue iss-129", "issue iss-016", "issue iss-053", "issue iss-014", "issue iss-088",
    "issue iss-125", "issue iss-012", "issue iss-123", "issue iss-010", "issue iss-047", "issue iss-082",
    "issue iss-119", "issue iss-006", "issue iss-043", "issue iss-078", "issue iss-115", "issue iss-000",
    "issue iss-072", "issue iss-103", "issue iss-134", "issue iss-021", "issue iss-015", "issue iss-046",
    "issue iss-042", "issue iss-077", "issue iss-108", "issue iss-139", "issue iss-063", "issue iss-020",
    "issue iss-051", "issue iss-084", "issue iss-041", "issue iss-113", "issue iss-144", "issue iss-025",
    "issue iss-056", "issue iss-087", "issue iss-118", "issue iss-149", "issue iss-030", "issue iss-061",
    "issue iss-092", "issue iss-004", "issue iss-035", "issue iss-066", "issue iss-097", "issue iss-128",
    "issue iss-009", "issue iss-040", "issue iss-071", "issue iss-102", "issue iss-133", "issue iss-045",
    "issue iss-076", "issue iss-107", "issue iss-138", "issue iss-019", "comment com-49", "issue iss-050",
    "comment com-00", "issue iss-081", "comment com-11", "issue iss-112", "comment com-22", "issue iss-143",
    "comment com-33", "issue iss-024", "comment com-44", "comment com-55", "comment com-06", "issue iss-086",
    "comment com-17", "issue iss-117", "comment com-28", "issue iss-148", "comment com-39", "issue iss-029",
    "comment com-50", "issue iss-060", "comment com-01", "comment com-12", "issue iss-091", "comment com-23",
    "issue iss-122", "comment com-34", "issue iss-003", "comment com-45", "issue iss-034", "comment com-56",
    "issue iss-065", "comment com-07", "comment com-18", "comment com-29", "issue iss-127", "comment com-40",
    "issue iss-008", "comment com-51", "issue iss-039", "comment com-02", "issue iss-070", "comment com-13",
    "issue iss-101", "comment com-24", "comment com-35", "issue iss-132", "comment com-46", "issue iss-013",
    "comment com-57", "issue iss-044", "comment com-08", "issue iss-075", "comment com-19", "issue iss-106",
    "comment com-30", "comment com-41", "comment com-52", "issue iss-018", "comment com-03", "issue iss-049",
    "comment com-14", "issue iss-080", "comment com-25", "issue iss-111", "comment com-36", "issue iss-142",
    "comment com-47", "comment com-58", "issue iss-023", "comment com-09", "issue iss-054", "comment com-20",
    "issue iss-085", "comment com-31", "issue iss-116", "comment com-42", "issue iss-147", "comment com-53",
    "comment com-04", "comment com-15", "issue iss-059", "comment com-26", "issue iss-090", "comment com-37",
    "issue iss-121", "comment com-48", "issue iss-002", "comment com-59", "issue iss-033", "comment com-10",
    "comment com-21", "issue iss-064", "comment com-32", "issue iss-095", "comment com-43", "issue iss-126",
    "comment com-54", "comment com-05", "issue iss-038", "comment com-16", "comment com-27", "comment com-38",
  ].join("|"),
};
