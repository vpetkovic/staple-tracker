/**
 * Random operation logs, written straight into D1.
 *
 * For the fold's equivalence test and for the scale tests. Straight into `ops` rather than
 * through `POST /ops` for two reasons: a 100,000-operation log through the push route is
 * 4,000 requests, and the log has to hold rows no current client can push — a restore's
 * staged creates, a payload that is not an object, both spellings of one field in one
 * payload — because the fold must reproduce what the single-pass fold did with every one.
 *
 * Deterministic for a seed, so a failure names the seed that reproduces it.
 */

export interface GeneratedOp {
  seq: number;
  epoch: number;
  opId: string;
  deviceId: string;
  entity: string;
  entityId: string;
  verb: string;
  baseVersion: number | null;
  /** The payload as stored: JSON text, not necessarily an object. */
  payload: string;
  actor: string;
  clientSeq: number;
  schema: number;
  createdAt: string;
  serverTs: number;
}

export interface GenerateOptions {
  seed: number;
  count: number;
  epoch?: number;
  /** The seq of the first operation. Later ones climb from it, with gaps. */
  firstSeq?: number;
  /** How many distinct ids each entity kind draws from. Smaller means more history per entity. */
  pool?: number;
  /** Include the hub registry's two entity kinds, which a protocol-1 reader is refused. */
  registry?: boolean;
  /** The chance of a gap in seq after an operation, as a reserved-but-unused slot leaves. */
  gapRate?: number;
  /**
   * Seeds the entity ids alone, so two logs — two epochs of one repository — can name the
   * same entities while their operations differ. Defaults to `seed`.
   */
  idSeed?: number;
}

/** mulberry32: small, fast and deterministic. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Ids chosen to exercise the snapshot's ORDER as well as its content: names with spaces,
 * characters above the ASCII range, a character in the BMP's top block (U+FF08) beside one
 * above it (U+1F525) — which JavaScript orders one way and SQLite's byte order the other —
 * and a control character.
 */
const AWKWARD_IDS = [
  "blocked",
  "in review",
  "é-accented",
  "ÿ-last-latin",
  "（重要）",
  "🔥 hot",
  "～-tilde",
  "a\u0001control",
  "~tilde",
  "\u007fdel",
  "10",
  "2",
];

const ISSUE_STATUSES = ["backlog", "todo", "in_progress", "in_review", "done", "cancelled"];

export function generateLog(options: GenerateOptions): GeneratedOp[] {
  const random = prng(options.seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
  const chance = (p: number) => random() < p;
  const pool = options.pool ?? 40;
  const epoch = options.epoch ?? 1;
  const gapRate = options.gapRate ?? 0.05;
  const base = Date.parse("2026-09-01T00:00:00.000Z");

  const idRandom = prng(options.idSeed ?? options.seed);
  const ids = (prefix: string) =>
    Array.from({ length: pool }, (_, n) => `${prefix}-${String(n).padStart(4, "0")}-${Math.floor(idRandom() * 1e9).toString(16)}`);
  const issues = ids("issue");
  const comments = ids("comment");
  const milestones = ids("milestone");
  const documents = ids("doc");
  const registrations = ids("reg");

  const kinds: Array<[string, number]> = [
    ["issue", 50],
    ["comment", 12],
    ["milestone", 6],
    ["queue", 4],
    ["setting", 6],
    ["status", 6],
    ["document", 6],
    // The two rules that read other entities: a revision written as a number another holds
    // (`settleRevision`), and a status or kind created again after its vocabulary's order
    // named it (`forgetPlace`).
    ["documentRevision", 10],
    ["kind", 4],
    ...(options.registry ? ([["registration", 5], ["crossLink", 3]] as Array<[string, number]>) : []),
  ];
  const weight = kinds.reduce((sum, [, w]) => sum + w, 0);
  const pickKind = (): string => {
    let r = random() * weight;
    for (const [kind, w] of kinds) {
      r -= w;
      if (r < 0) return kind;
    }
    return "issue";
  };

  const out: GeneratedOp[] = [];
  let seq = (options.firstSeq ?? 1) - 1;
  const versions = new Map<string, number>();

  const push = (entity: string, entityId: string, verb: string, payload: unknown, extra: { actor?: string; raw?: string } = {}) => {
    seq += 1;
    const n = out.length;
    const key = `${entity} ${entityId}`;
    const version = versions.get(key) ?? 0;
    versions.set(key, version + 1);
    out.push({
      seq,
      epoch,
      opId: `op-${options.seed}-${epoch}-${n}`,
      deviceId: pick(["device-a", "device-b", "device-c"]),
      entity,
      entityId,
      verb,
      baseVersion: verb === "create" ? null : version,
      payload: extra.raw ?? JSON.stringify(payload),
      actor: extra.actor ?? pick(["opus-a", "sonnet-b", "vp"]),
      clientSeq: n + 1,
      schema: 8 + Math.floor(random() * 4),
      createdAt: new Date(base + n * 1000 + Math.floor(random() * 999)).toISOString(),
      serverTs: base + n * 1000 + 500,
    });
    if (chance(gapRate)) seq += 1 + Math.floor(random() * 3);
  };

  // A field under one spelling or the other, as builds before and after the journal fix wrote it.
  const spelled = (camel: string, value: unknown): Record<string, unknown> => {
    const snake = camel.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
    return chance(0.5) ? { [camel]: value } : { [snake]: value };
  };
  const at = () => new Date(base + Math.floor(random() * 1e9)).toISOString();

  while (out.length < options.count) {
    const kind = pickKind();
    const r = random();
    switch (kind) {
      case "issue": {
        const id = pick(issues);
        if (r < 0.1) {
          const create: Record<string, unknown> = {
            identifier: `STA-${Math.floor(random() * 900) + 1}`,
            title: `Issue ${id.slice(-4)}`,
            status: pick(ISSUE_STATUSES),
            priority: "medium",
            description: chance(0.3) ? "x".repeat(Math.floor(random() * 400)) : null,
            labels: [],
            estimatedSeconds: null,
            createdAt: at(),
            updatedAt: at(),
          };
          // A restored create from before one spelling carries both, the column's second.
          if (chance(0.2)) create.updated_at = at();
          if (chance(0.1)) create["1"] = "integer-like key";
          push("issue", id, "create", create, chance(0.15) ? { actor: `restore:${Math.floor(random() * 9)}` } : {});
        } else if (r < 0.16) {
          push("issue", id, "delete", {});
        } else if (r < 0.19) {
          push("issue", id, "renumber", { identifier: `STA-${Math.floor(random() * 900) + 1}` });
        } else if (r < 0.2) {
          // A payload the envelope refuses today and a log written before the refusal may hold.
          push("issue", id, "update", null, { raw: pick(["null", "[1,2]", "\"text\"", "7"]) });
        } else if (r < 0.45) {
          push("issue", id, "update", { status: pick(ISSUE_STATUSES), ...spelled("updatedAt", at()) });
        } else {
          const fields: Record<string, unknown> = {};
          if (chance(0.5)) fields.title = `Retitled ${Math.floor(random() * 1e6)}`;
          if (chance(0.3)) Object.assign(fields, spelled("estimatedSeconds", Math.floor(random() * 9000)));
          if (chance(0.3)) Object.assign(fields, spelled("blockedTransitionAt", at()));
          if (chance(0.2)) fields.assignee = pick([null, "opus-a", "sonnet-b"]);
          if (chance(0.1)) fields.reopens = true;
          if (chance(0.05)) Object.assign(fields, { updatedAt: at(), updated_at: at() });
          Object.assign(fields, spelled("updatedAt", at()));
          push("issue", id, "update", fields);
        }
        break;
      }
      case "comment": {
        const id = pick(comments);
        if (r < 0.7) push("comment", id, "create", { issueId: pick(issues), body: `c${Math.floor(random() * 1e5)}`, author: "vp" });
        else if (r < 0.85) push("comment", id, "delete", {});
        else push("comment", id, "update", { body: `edited ${Math.floor(random() * 1e5)}` });
        break;
      }
      case "milestone": {
        const id = pick(milestones);
        if (r < 0.2) push("milestone", id, "create", { name: `M ${id.slice(-3)}`, startsOn: at(), members: [] });
        else if (r < 0.6) {
          const members = issues.filter(() => chance(0.1));
          push("milestone", id, "replace", chance(0.4) ? { members, dueOn: at() } : { members });
        } else if (r < 0.7) push("milestone", id, "delete", {});
        else push("milestone", id, "update", { ...spelled("startsOn", at()) });
        break;
      }
      case "queue": {
        push("queue", pick(["default", "later"]), r < 0.8 ? "replace" : "create", { order: issues.filter(() => chance(0.15)) });
        break;
      }
      case "setting": {
        const id = pick(["repository.prefix", "sync.auto", "ui.theme", "x"]);
        if (r < 0.35) push("setting", id, "create", { value: pick(["STA", "TRA", true, 3]) });
        else if (r < 0.55) push("setting", id, "delete", {});
        else push("setting", id, "update", { value: pick(["dark", "light", false, 9]) });
        break;
      }
      case "status":
      case "kind": {
        // The vocabulary's order travels on its own entity, `@order` (`src/core/store.ts`).
        if (r < 0.3) {
          const order = AWKWARD_IDS.filter(() => chance(0.5));
          if (chance(0.5)) order.reverse();
          push(kind, "@order", pick(["create", "update", "update", "update"]), { order });
          break;
        }
        if (r < 0.33) {
          // An order with nothing to filter: `forgetPlace` leaves it alone.
          push(kind, "@order", chance(0.5) ? "delete" : "update", chance(0.5) ? {} : { order: "not a list" });
          break;
        }
        const id = pick(AWKWARD_IDS);
        // Some creates say whether they are a built-in, as a build that seeds the vocabulary
        // does; created again after a delete, the fold says it is not, unless the create does.
        if (r < 0.65) {
          push(kind, id, "create", {
            name: id,
            category: pick(["open", "done"]),
            sortOrder: Math.floor(random() * 10),
            ...(chance(0.3) ? { isBuiltin: chance(0.5) } : {}),
          });
        }
        else if (r < 0.85) push(kind, id, "delete", {});
        else push(kind, id, "update", { ...spelled("sortOrder", Math.floor(random() * 10)) });
        break;
      }
      case "documentRevision": {
        // `<issue>/<key>/<n>`, a few documents with few numbers, so two creates of one number
        // collide often; bodies, authors and times from small sets, so "the same revision
        // again" happens too. One document key holds a slash of its own.
        const document = `${pick(issues.slice(0, 6))}/${pick(["plan", "notes", "a/b"])}/`;
        const n = 1 + Math.floor(random() * 4);
        const id = `${document}${n}`;
        if (r < 0.75) {
          const summary = pick([
            null,
            "first pass",
            "",
            "first pass — renumbered from r1 to r2: written at the same time as another r1, which the repository's log holds first",
            "renumbered from r2 to r3: written at the same time as another r2, which the repository's log holds first",
          ]);
          push("documentRevision", id, "create", {
            issueId: document.split("/")[0],
            key: document.slice(document.indexOf("/") + 1, -1),
            revision: n,
            body: pick(["A's plan", "B's plan", "C's plan", "x".repeat(300)]),
            ...(chance(0.8) ? { author: pick(["alice", "bob"]) } : {}),
            ...(chance(0.8) ? { createdAt: pick(["2026-09-11T00:00:01.000Z", "2026-09-11T00:00:02.000Z"]) } : {}),
            changeSummary: summary,
          });
        } else if (r < 0.9) push("documentRevision", id, "delete", {});
        else push("documentRevision", id, "update", { changeSummary: "edited" });
        break;
      }
      case "document": {
        const id = pick(documents);
        if (r < 0.3) push("document", id, "create", { title: `Doc ${id.slice(-3)}`, body: "b".repeat(Math.floor(random() * 2000)) });
        else if (r < 0.4) push("document", id, "delete", {});
        else push("document", id, "update", { body: "u".repeat(Math.floor(random() * 2000)), ...spelled("updatedAt", at()) });
        break;
      }
      case "registration": {
        const id = pick(registrations);
        push("registration", id, r < 0.5 ? "create" : "update", { slug: id.slice(0, 8), path: `/tmp/${id}` });
        break;
      }
      case "crossLink": {
        push("crossLink", `${pick(registrations)}->${pick(registrations)}`, r < 0.7 ? "create" : "delete", { kind: "blocks" });
        break;
      }
    }
  }
  return out.slice(0, options.count);
}

/**
 * Write operations straight into `ops`, packed into few statements, and move the repository's
 * high-water mark to the last of them — never backwards.
 */
export async function insertOps(db: D1Database, repoId: string, ops: readonly GeneratedOp[]): Promise<void> {
  // At most 1,000 to a statement and under 900 KB of them: a bound value has D1's 2 MB ceiling.
  const slices: GeneratedOp[][] = [];
  let slice: GeneratedOp[] = [];
  let bytes = 0;
  for (const op of ops) {
    const size = op.payload.length + 300;
    if (slice.length > 0 && (slice.length === 1000 || bytes + size > 900_000)) {
      slices.push(slice);
      slice = [];
      bytes = 0;
    }
    slice.push(op);
    bytes += size;
  }
  if (slice.length > 0) slices.push(slice);
  for (const slice of slices) {
    await db
      .prepare(
        `INSERT INTO ops (repo_id, seq, epoch, op_id, device_id, entity, entity_id, verb, base_version,
                          payload, actor, client_seq, schema_version, created_at, server_ts)
         SELECT ?1, json_extract(value, '$.seq'), json_extract(value, '$.epoch'), json_extract(value, '$.opId'),
                json_extract(value, '$.deviceId'), json_extract(value, '$.entity'), json_extract(value, '$.entityId'),
                json_extract(value, '$.verb'), json_extract(value, '$.baseVersion'), json_extract(value, '$.payload'),
                json_extract(value, '$.actor'), json_extract(value, '$.clientSeq'), json_extract(value, '$.schema'),
                json_extract(value, '$.createdAt'), json_extract(value, '$.serverTs')
           FROM json_each(?2)`,
      )
      .bind(repoId, JSON.stringify(slice))
      .run();
  }
  const last = ops.reduce((max, op) => Math.max(max, op.seq), 0);
  await db.prepare(`UPDATE repos SET last_seq = MAX(last_seq, ?2) WHERE repo_id = ?1`).bind(repoId, last).run();
}
