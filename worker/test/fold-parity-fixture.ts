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
 * operations do, and entity states past 1 MiB a page; gaps in seq; renumbers, so a
 * restore's claim order is not its key order; and a worklog of contested revisions with quotes
 * in every body, so steps are cut by estimated work (`worker/src/fold-work.ts`) and by what a
 * revision's placement may read (`worker/src/fold-revisions.ts`), not only by count and bytes.
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
  // A worklog saved 400 times, with quotes in every body: its revision creates are placed against
  // what D1 holds, so steps are cut where a placement needs more than a step may read — a number
  // claimed again, a stale claim far below the head, the same revision sent again, a number spelled
  // two ways, a deleted revision whose number is taken again.
  const worklog = "iss-000/worklog/";
  let next = 1;
  for (let n = 0; n < 400; n += 1) {
    seq += 1;
    let entityId: string;
    let verb = "create";
    let payload: Record<string, unknown>;
    const body = `# Worklog\n\n"entry ${n}" \\ ${"w".repeat(n % 300)}\n`;
    if (n % 17 === 16) {
      verb = "delete";
      entityId = `${worklog}${Math.max(1, next - 5)}`;
      payload = {};
    } else if (n % 11 === 10) {
      entityId = `${worklog}${Math.max(1, next - 1)}`;
      payload = { issueId: "iss-000", key: "worklog", revision: Math.max(1, next - 1), body: `# Worklog\n\n"entry ${n - 1}" \\ ${"w".repeat((n - 1) % 300)}\n`, author: "parity", changeSummary: null };
    } else {
      const claimed = n % 19 === 18 ? 1 : n % 7 === 6 ? Math.max(1, next - 3) : next++;
      entityId = `${worklog}${n % 13 === 12 ? `0${claimed}` : claimed}`;
      payload = { issueId: "iss-000", key: "worklog", revision: claimed, body, author: "parity", changeSummary: null };
    }
    out.push({
      seq,
      entity: "documentRevision",
      entityId,
      verb,
      payload: JSON.stringify(payload),
      opId: `parity-worklog-${n}`,
      actor: "parity",
      createdAt: new Date(base + (1400 + n) * 1000).toISOString(),
      serverTs: base + (1400 + n) * 1000,
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
  foldWork: 4_000_000,
  foldStepWork: 4_000_000,
  foldSteps: 2,
  restoreStageEntities: 200,
  pageBytes: 1024 * 1024,
  pageWork: 2_000_000,
  restorePageWork: 2_000_000,
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

  // A pull a step behind folds what its page leaves of its budget; the whole log pulled from nothing.
  await driver.clearFold();
  let cursor: string | null = null;
  // Every page, each cut by count or by the work of sending it, which folds only what its page leaves.
  const pulled: number[] = [];
  for (let page = 0; page < 100; page += 1) {
    const response = await driver.send("GET", `/ops?limit=500${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    pulled.push(response.body.ops.length);
    cursor = response.body.nextCursor;
    if (!response.body.hasMore) break;
  }
  observed.pulled = pulled;

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
  snapshot: {"folding":[327,517,652,759,829,927,987,1108,1213,1272,1333,1411,1469,1480,1490,1499,1509,1517,1527,1535,1545,1554,1564,1573,1582,1592,1601,1610,1619,1628,1637,1646,1655,1665,1675,1683,1693,1702,1712,1721,1731,1739,1748,1757,1767,1777,1786,1795,1803,1813,1822,1831,1840,1850,1857,1860],"cutoffSeq":1862,"pages":[234,156,2,2,12,33,22,22,22,33]},
  pulled: [291,193,193,193,193,198,246,194,4,3],
  backup: {"folding":[927,987,1108,1213,1272,1333,1411,1469,1480,1490,1499,1509,1517,1527,1535,1545,1554,1564,1573,1582,1592,1601,1610,1619,1628,1637,1646,1655,1665,1675,1683,1693,1702,1712,1721,1731,1739,1748,1757,1767,1777,1786,1795,1803,1813,1822,1831,1840,1850,1857,1860],"status":200,"entityCount":538,"opCount":1708,"cutoffSeq":1862},
  restore: [{"folding":327},{"folding":517},{"folding":652},{"folding":759},{"folding":829},{"folding":927},{"folding":987},{"folding":1108},{"folding":1213},{"folding":1272},{"folding":1333},{"folding":1411},{"folding":1469},{"folding":1480},{"folding":1490},{"folding":1499},{"folding":1509},{"folding":1517},{"folding":1527},{"folding":1535},{"folding":1545},{"folding":1554},{"folding":1564},{"folding":1573},{"folding":1582},{"folding":1592},{"folding":1601},{"folding":1610},{"folding":1619},{"folding":1628},{"folding":1637},{"folding":1646},{"folding":1655},{"folding":1665},{"folding":1675},{"folding":1683},{"folding":1693},{"folding":1702},{"folding":1712},{"folding":1721},{"folding":1731},{"folding":1739},{"folding":1748},{"folding":1757},{"folding":1767},{"folding":1777},{"folding":1786},{"folding":1795},{"folding":1803},{"folding":1813},{"folding":1822},{"folding":1831},{"folding":1840},{"folding":1850},{"folding":1857},{"folding":1860},{"status":200,"staged":0},{"status":200,"staged":24},{"status":200,"staged":29},{"status":200,"staged":65},{"status":200,"staged":79},{"status":200,"staged":97},{"status":200,"staged":134},{"status":200,"staged":165},{"status":200,"staged":201},{"status":200,"staged":401},{"status":200,"staged":538},{"status":200,"staged":538}],
  restored: {"folding":[],"cutoffSeq":2400,"pages":[299,91,2,2,12,33,22,22,22,33]},
  undo: [{"folding":327,"cutoff":1862},{"folding":517,"cutoff":1862},{"folding":652,"cutoff":1862},{"folding":759,"cutoff":1862},{"folding":829,"cutoff":1862},{"folding":927,"cutoff":1862},{"folding":987,"cutoff":1862},{"folding":1108,"cutoff":1862},{"folding":1213,"cutoff":1862},{"folding":1272,"cutoff":1862},{"folding":1333,"cutoff":1862},{"folding":1411,"cutoff":1862},{"folding":1469,"cutoff":1862},{"folding":1480,"cutoff":1862},{"folding":1490,"cutoff":1862},{"folding":1499,"cutoff":1862},{"folding":1509,"cutoff":1862},{"folding":1517,"cutoff":1862},{"folding":1527,"cutoff":1862},{"folding":1535,"cutoff":1862},{"folding":1545,"cutoff":1862},{"folding":1554,"cutoff":1862},{"folding":1564,"cutoff":1862},{"folding":1573,"cutoff":1862},{"folding":1582,"cutoff":1862},{"folding":1592,"cutoff":1862},{"folding":1601,"cutoff":1862},{"folding":1610,"cutoff":1862},{"folding":1619,"cutoff":1862},{"folding":1628,"cutoff":1862},{"folding":1637,"cutoff":1862},{"folding":1646,"cutoff":1862},{"folding":1655,"cutoff":1862},{"folding":1665,"cutoff":1862},{"folding":1675,"cutoff":1862},{"folding":1683,"cutoff":1862},{"folding":1693,"cutoff":1862},{"folding":1702,"cutoff":1862},{"folding":1712,"cutoff":1862},{"folding":1721,"cutoff":1862},{"folding":1731,"cutoff":1862},{"folding":1739,"cutoff":1862},{"folding":1748,"cutoff":1862},{"folding":1757,"cutoff":1862},{"folding":1767,"cutoff":1862},{"folding":1777,"cutoff":1862},{"folding":1786,"cutoff":1862},{"folding":1795,"cutoff":1862},{"folding":1803,"cutoff":1862},{"folding":1813,"cutoff":1862},{"folding":1822,"cutoff":1862},{"folding":1831,"cutoff":1862},{"folding":1840,"cutoff":1862},{"folding":1850,"cutoff":1862},{"folding":1857,"cutoff":1862},{"folding":1860,"cutoff":1862},{"folding":1872,"cutoff":2400},{"folding":1890,"cutoff":2400},{"folding":1928,"cutoff":2400},{"folding":1954,"cutoff":2400},{"folding":1997,"cutoff":2400},{"folding":2057,"cutoff":2400},{"folding":2285,"cutoff":2400},{"status":200,"staged":0},{"status":200,"staged":24},{"status":200,"staged":29},{"status":200,"staged":65},{"status":200,"staged":79},{"status":200,"staged":97},{"status":200,"staged":134},{"status":200,"staged":165},{"status":200,"staged":201},{"status":200,"staged":401},{"status":200,"staged":538},{"status":200,"staged":538}],
  undone: {"folding":[],"cutoffSeq":2938,"pages":[299,91,2,2,12,33,22,22,22,33]},
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
    "documentRevision iss-000/worklog/1", "documentRevision iss-000/worklog/2", "documentRevision iss-000/worklog/3", "documentRevision iss-000/worklog/4", "documentRevision iss-000/worklog/5", "documentRevision iss-000/worklog/6",
    "documentRevision iss-000/worklog/7", "documentRevision iss-000/worklog/8", "documentRevision iss-000/worklog/10", "documentRevision iss-000/worklog/11", "documentRevision iss-000/worklog/12", "documentRevision iss-000/worklog/13",
    "documentRevision iss-000/worklog/14", "documentRevision iss-000/worklog/15", "documentRevision iss-000/worklog/16", "documentRevision iss-000/worklog/9", "documentRevision iss-000/worklog/17", "documentRevision iss-000/worklog/18",
    "documentRevision iss-000/worklog/19", "documentRevision iss-000/worklog/21", "documentRevision iss-000/worklog/22", "documentRevision iss-000/worklog/23", "documentRevision iss-000/worklog/24", "documentRevision iss-000/worklog/25",
    "documentRevision iss-000/worklog/26", "documentRevision iss-000/worklog/27", "documentRevision iss-000/worklog/28", "documentRevision iss-000/worklog/29", "documentRevision iss-000/worklog/30", "documentRevision iss-000/worklog/20",
    "documentRevision iss-000/worklog/32", "documentRevision iss-000/worklog/33", "documentRevision iss-000/worklog/34", "documentRevision iss-000/worklog/35", "documentRevision iss-000/worklog/36", "documentRevision iss-000/worklog/37",
    "documentRevision iss-000/worklog/38", "documentRevision iss-000/worklog/39", "documentRevision iss-000/worklog/40", "documentRevision iss-000/worklog/41", "documentRevision iss-000/worklog/43", "documentRevision iss-000/worklog/44",
    "documentRevision iss-000/worklog/45", "documentRevision iss-000/worklog/46", "documentRevision iss-000/worklog/31", "documentRevision iss-000/worklog/47", "documentRevision iss-000/worklog/48", "documentRevision iss-000/worklog/49",
    "documentRevision iss-000/worklog/50", "documentRevision iss-000/worklog/51", "documentRevision iss-000/worklog/52", "documentRevision iss-000/worklog/53", "documentRevision iss-000/worklog/55", "documentRevision iss-000/worklog/56",
    "documentRevision iss-000/worklog/57", "documentRevision iss-000/worklog/58", "documentRevision iss-000/worklog/59", "documentRevision iss-000/worklog/60", "documentRevision iss-000/worklog/61", "documentRevision iss-000/worklog/62",
    "documentRevision iss-000/worklog/42", "documentRevision iss-000/worklog/63", "documentRevision iss-000/worklog/64", "documentRevision iss-000/worklog/66", "documentRevision iss-000/worklog/67", "documentRevision iss-000/worklog/68",
    "documentRevision iss-000/worklog/69", "documentRevision iss-000/worklog/70", "documentRevision iss-000/worklog/71", "documentRevision iss-000/worklog/72", "documentRevision iss-000/worklog/73", "documentRevision iss-000/worklog/74",
    "documentRevision iss-000/worklog/75", "documentRevision iss-000/worklog/76", "documentRevision iss-000/worklog/78", "documentRevision iss-000/worklog/54", "documentRevision iss-000/worklog/79", "documentRevision iss-000/worklog/80",
    "documentRevision iss-000/worklog/81", "documentRevision iss-000/worklog/82", "documentRevision iss-000/worklog/83", "documentRevision iss-000/worklog/84", "documentRevision iss-000/worklog/85", "documentRevision iss-000/worklog/86",
    "documentRevision iss-000/worklog/87", "documentRevision iss-000/worklog/88", "documentRevision iss-000/worklog/90", "documentRevision iss-000/worklog/91", "documentRevision iss-000/worklog/92", "documentRevision iss-000/worklog/93",
    "documentRevision iss-000/worklog/65", "documentRevision iss-000/worklog/94", "documentRevision iss-000/worklog/95", "documentRevision iss-000/worklog/96", "documentRevision iss-000/worklog/97", "documentRevision iss-000/worklog/98",
    "documentRevision iss-000/worklog/99", "documentRevision iss-000/worklog/100", "documentRevision iss-000/worklog/102", "documentRevision iss-000/worklog/103", "documentRevision iss-000/worklog/104", "documentRevision iss-000/worklog/105",
    "documentRevision iss-000/worklog/106", "documentRevision iss-000/worklog/107", "documentRevision iss-000/worklog/108", "documentRevision iss-000/worklog/77", "documentRevision iss-000/worklog/109", "documentRevision iss-000/worklog/110",
    "documentRevision iss-000/worklog/111", "documentRevision iss-000/worklog/112", "documentRevision iss-000/worklog/114", "documentRevision iss-000/worklog/115", "documentRevision iss-000/worklog/116", "documentRevision iss-000/worklog/117",
    "documentRevision iss-000/worklog/118", "documentRevision iss-000/worklog/119", "documentRevision iss-000/worklog/120", "documentRevision iss-000/worklog/121", "documentRevision iss-000/worklog/122", "documentRevision iss-000/worklog/123",
    "documentRevision iss-000/worklog/124", "documentRevision iss-000/worklog/89", "documentRevision iss-000/worklog/126", "documentRevision iss-000/worklog/127", "documentRevision iss-000/worklog/128", "documentRevision iss-000/worklog/129",
    "documentRevision iss-000/worklog/130", "documentRevision iss-000/worklog/131", "documentRevision iss-000/worklog/132", "documentRevision iss-000/worklog/133", "documentRevision iss-000/worklog/134", "documentRevision iss-000/worklog/135",
    "documentRevision iss-000/worklog/137", "documentRevision iss-000/worklog/138", "documentRevision iss-000/worklog/139", "documentRevision iss-000/worklog/101", "documentRevision iss-000/worklog/140", "documentRevision iss-000/worklog/141",
    "documentRevision iss-000/worklog/142", "documentRevision iss-000/worklog/143", "documentRevision iss-000/worklog/144", "documentRevision iss-000/worklog/145", "documentRevision iss-000/worklog/146", "documentRevision iss-000/worklog/147",
    "documentRevision iss-000/worklog/149", "documentRevision iss-000/worklog/150", "documentRevision iss-000/worklog/151", "documentRevision iss-000/worklog/152", "documentRevision iss-000/worklog/153", "documentRevision iss-000/worklog/154",
    "documentRevision iss-000/worklog/155", "documentRevision iss-000/worklog/113", "documentRevision iss-000/worklog/156", "documentRevision iss-000/worklog/157", "documentRevision iss-000/worklog/158", "documentRevision iss-000/worklog/159",
    "documentRevision iss-000/worklog/160", "documentRevision iss-000/worklog/162", "documentRevision iss-000/worklog/163", "documentRevision iss-000/worklog/164", "documentRevision iss-000/worklog/165", "documentRevision iss-000/worklog/166",
    "documentRevision iss-000/worklog/167", "documentRevision iss-000/worklog/168", "documentRevision iss-000/worklog/169", "documentRevision iss-000/worklog/170", "documentRevision iss-000/worklog/171", "documentRevision iss-000/worklog/173",
    "documentRevision iss-000/worklog/174", "documentRevision iss-000/worklog/175", "documentRevision iss-000/worklog/176", "documentRevision iss-000/worklog/177", "documentRevision iss-000/worklog/178", "documentRevision iss-000/worklog/179",
    "documentRevision iss-000/worklog/180", "documentRevision iss-000/worklog/181", "documentRevision iss-000/worklog/182", "documentRevision iss-000/worklog/183", "documentRevision iss-000/worklog/184", "documentRevision iss-000/worklog/186",
    "documentRevision iss-000/worklog/187", "documentRevision iss-000/worklog/125", "documentRevision iss-000/worklog/188", "documentRevision iss-000/worklog/189", "documentRevision iss-000/worklog/190", "documentRevision iss-000/worklog/191",
    "documentRevision iss-000/worklog/192", "documentRevision iss-000/worklog/193", "documentRevision iss-000/worklog/194", "documentRevision iss-000/worklog/196", "documentRevision iss-000/worklog/197", "documentRevision iss-000/worklog/198",
    "documentRevision iss-000/worklog/199", "documentRevision iss-000/worklog/200", "documentRevision iss-000/worklog/201", "documentRevision iss-000/worklog/202", "documentRevision iss-000/worklog/136", "documentRevision iss-000/worklog/203",
    "documentRevision iss-000/worklog/204", "documentRevision iss-000/worklog/205", "documentRevision iss-000/worklog/206", "documentRevision iss-000/worklog/208", "documentRevision iss-000/worklog/209", "documentRevision iss-000/worklog/210",
    "documentRevision iss-000/worklog/211", "documentRevision iss-000/worklog/212", "documentRevision iss-000/worklog/213", "documentRevision iss-000/worklog/214", "documentRevision iss-000/worklog/215", "documentRevision iss-000/worklog/216",
    "documentRevision iss-000/worklog/217", "documentRevision iss-000/worklog/148", "documentRevision iss-000/worklog/218", "documentRevision iss-000/worklog/220", "documentRevision iss-000/worklog/221", "documentRevision iss-000/worklog/222",
    "documentRevision iss-000/worklog/223", "documentRevision iss-000/worklog/224", "documentRevision iss-000/worklog/225", "documentRevision iss-000/worklog/226", "documentRevision iss-000/worklog/227", "documentRevision iss-000/worklog/228",
    "documentRevision iss-000/worklog/229", "documentRevision iss-000/worklog/230", "documentRevision iss-000/worklog/231", "documentRevision iss-000/worklog/232", "documentRevision iss-000/worklog/233", "documentRevision iss-000/worklog/161",
    "documentRevision iss-000/worklog/234", "documentRevision iss-000/worklog/235", "documentRevision iss-000/worklog/236", "documentRevision iss-000/worklog/237", "documentRevision iss-000/worklog/238", "documentRevision iss-000/worklog/239",
    "documentRevision iss-000/worklog/240", "documentRevision iss-000/worklog/241", "documentRevision iss-000/worklog/242", "documentRevision iss-000/worklog/243", "documentRevision iss-000/worklog/244", "documentRevision iss-000/worklog/245",
    "documentRevision iss-000/worklog/246", "documentRevision iss-000/worklog/247", "documentRevision iss-000/worklog/248", "documentRevision iss-000/worklog/249", "documentRevision iss-000/worklog/172", "documentRevision iss-000/worklog/250",
    "documentRevision iss-000/worklog/251", "documentRevision iss-000/worklog/252", "documentRevision iss-000/worklog/253", "documentRevision iss-000/worklog/254", "documentRevision iss-000/worklog/255", "documentRevision iss-000/worklog/256",
    "documentRevision iss-000/worklog/257", "documentRevision iss-000/worklog/258", "documentRevision iss-000/worklog/259", "documentRevision iss-000/worklog/260", "documentRevision iss-000/worklog/261", "documentRevision iss-000/worklog/262",
    "documentRevision iss-000/worklog/263", "documentRevision iss-000/worklog/264", "documentRevision iss-000/worklog/265", "documentRevision iss-000/worklog/266", "documentRevision iss-000/worklog/267", "documentRevision iss-000/worklog/268",
    "documentRevision iss-000/worklog/269", "documentRevision iss-000/worklog/270", "documentRevision iss-000/worklog/271", "documentRevision iss-000/worklog/272", "documentRevision iss-000/worklog/273", "documentRevision iss-000/worklog/274",
    "documentRevision iss-000/worklog/275", "documentRevision iss-000/worklog/276", "documentRevision iss-000/worklog/277", "documentRevision iss-000/worklog/278", "documentRevision iss-000/worklog/279", "documentRevision iss-000/worklog/280",
    "documentRevision iss-000/worklog/185", "documentRevision iss-000/worklog/281", "documentRevision iss-000/worklog/282", "documentRevision iss-000/worklog/283", "documentRevision iss-000/worklog/284", "documentRevision iss-000/worklog/285",
    "documentRevision iss-000/worklog/286", "documentRevision iss-000/worklog/287", "documentRevision iss-000/worklog/288", "documentRevision iss-000/worklog/289", "documentRevision iss-000/worklog/290", "documentRevision iss-000/worklog/291",
    "documentRevision iss-000/worklog/292", "documentRevision iss-000/worklog/293", "documentRevision iss-000/worklog/294", "documentRevision iss-000/worklog/295", "documentRevision iss-000/worklog/296", "documentRevision iss-000/worklog/195",
    "documentRevision iss-000/worklog/297", "documentRevision iss-000/worklog/298", "documentRevision iss-000/worklog/299", "documentRevision iss-000/worklog/300", "documentRevision iss-000/worklog/301", "documentRevision iss-000/worklog/302",
    "documentRevision iss-000/worklog/303", "documentRevision iss-000/worklog/304", "documentRevision iss-000/worklog/305", "documentRevision iss-000/worklog/306", "documentRevision iss-000/worklog/307", "documentRevision iss-000/worklog/308",
    "documentRevision iss-000/worklog/309", "documentRevision iss-000/worklog/310", "documentRevision iss-000/worklog/311", "documentRevision iss-000/worklog/312", "documentRevision iss-000/worklog/207", "documentRevision iss-000/worklog/313",
    "documentRevision iss-000/worklog/314", "documentRevision iss-000/worklog/315", "documentRevision iss-000/worklog/316", "documentRevision iss-000/worklog/317", "documentRevision iss-000/worklog/318", "documentRevision iss-000/worklog/319",
    "documentRevision iss-000/worklog/320", "documentRevision iss-000/worklog/321", "documentRevision iss-000/worklog/322", "documentRevision iss-000/worklog/323", "documentRevision iss-000/worklog/324", "documentRevision iss-000/worklog/325",
    "documentRevision iss-000/worklog/326", "documentRevision iss-000/worklog/327", "documentRevision iss-000/worklog/219", "documentRevision iss-000/worklog/328",
  ].join("|"),
};
