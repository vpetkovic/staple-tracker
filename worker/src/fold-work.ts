/**
 * What folding, paging and staging cost in isolate time, estimated from sizes SQLite measures
 * before anything large is read.
 *
 * NO IMPORTS: `test/fixtures/fake-sync-server.ts` cuts its steps and pages with this same model,
 * and it cannot compile a file that reaches the Worker's types.
 *
 * ## Why escapes, not bytes
 *
 * The isolate time of this Worker is JSON: payloads parsed, stored states parsed and serialized,
 * and packed statements serialized again. V8 copies a plain string through `JSON.parse` and
 * `JSON.stringify` at memcpy speed and pays for every character it has to escape. Measured on
 * workerd (`wrangler dev --local`), per megabyte of JSON text:
 *
 * | Content                  | parse   | stringify | stringify, then into a packed statement |
 * |--------------------------|---------|-----------|-----------------------------------------|
 * | ASCII letters            | 0.05 ms | 0.1 ms    | 0.2 ms                                  |
 * | `é` (2 UTF-8 bytes)      | 0.05 ms | 0.1 ms    | 0.2 ms                                  |
 * | CJK (3 UTF-8 bytes)      | 0.2 ms  | 0.25 ms   | 0.45 ms                                 |
 * | `\n` (a third escapes)   | 1.5 ms  | 1.6 ms    | 3.1 ms                                  |
 * | `"` (60% escapes)        | 3.7 ms  | 2.9 ms    | 8.4 ms                                  |
 * | `\` (all escapes)        | 1.7 ms  | 2.2 ms    | 6.7 ms                                  |
 *
 * So a megabyte of quotes costs forty times a megabyte of letters, and a budget in bytes is either
 * far too tight for one or far too loose for the other. The model counts both: a nanosecond cost
 * per byte, and one per quote or backslash in the text (what `escapes` counts, in SQL as
 * `length(x) - length(replace(replace(x, '\', ''), '"', ''))`), plus a fixed cost per operation
 * and per entity for everything that is not JSON. Its coefficients sit above every row of the
 * table, and worker/README.md, "The fold checkpoint", has the isolate time it predicted against
 * what requests measured.
 */

/**
 * The coefficients are about TWICE the JSON cost measured above, and deliberately.
 *
 * What a budget has to predict is the isolate time of a REQUEST, and JSON is only most of it: the
 * route's own parsing and response, the strings D1 hands back, the maps and rows a step builds, and
 * whatever garbage collection the run provokes are the rest. Measured against real devices on
 * workerd, a request whose fold was estimated at the JSON cost alone took about two and a half
 * times that. At twice, a request estimated at four milliseconds measures about four — see
 * worker/README.md for the per-request maximums these produced.
 */

/** Fixed isolate time per operation a step folds: its row, keys, placement, maps and pack item. */
export const OP_NS = 24_000;
/** Fixed isolate time per entity a page serves or a restore stages. */
export const ENTITY_NS = 12_000;
/** Parsing, per byte and per escape. */
export const PARSE_NS_PER_BYTE = 1;
export const PARSE_NS_PER_ESCAPE = 12;
/** Serializing an entity's state and provenance and packing it into a statement, per byte and escape. */
export const WRITE_NS_PER_BYTE = 3;
export const WRITE_NS_PER_ESCAPE = 36;
/** Provenance an operation adds to what its entity writes: at most, per operation. */
export const PROVENANCE_BYTES = 200;
export const PROVENANCE_ESCAPES = 16;

/** Quotes and backslashes in `text`: SQL's `escapes`, counted in the isolate. */
export function countEscapes(text: string): number {
  let count = 0;
  for (let index = text.indexOf('"'); index >= 0; index = text.indexOf('"', index + 1)) count += 1;
  for (let index = text.indexOf("\\"); index >= 0; index = text.indexOf("\\", index + 1)) count += 1;
  return count;
}

/** Isolate time to parse JSON text of this size. */
export function parseWork(bytes: number, escapes: number): number {
  return PARSE_NS_PER_BYTE * bytes + PARSE_NS_PER_ESCAPE * escapes;
}

/** Isolate time to serialize an entity of this size and write it. */
export function writeWork(bytes: number, escapes: number): number {
  return WRITE_NS_PER_BYTE * bytes + WRITE_NS_PER_ESCAPE * escapes;
}

/** Isolate time to read an entity and put it on the wire: parse its stored text, serialize it again. */
export function serveWork(bytes: number, escapes: number): number {
  return ENTITY_NS + 2 * parseWork(bytes, escapes);
}

/**
 * The estimated work of every prefix of a run of operations: each payload parsed, each entity
 * loaded once (its stored size), and each entity written once at its stored size plus everything
 * folded into it. `stored` answers an entity's stored size, or undefined for one not stored.
 * Entry `i` is the work of folding operations `0..i`.
 */
export function runWork(
  rows: ReadonlyArray<{ keys: readonly string[]; bytes: number; escapes: number }>,
  stored: (key: string) => { size: number; escapes: number } | undefined,
): number[] {
  const out: number[] = [];
  const writes = new Map<string, { bytes: number; escapes: number }>();
  let read = 0;
  let written = 0;
  for (const row of rows) {
    read += OP_NS + parseWork(row.bytes, row.escapes);
    for (const key of row.keys) {
      if (writes.has(key)) continue;
      const size = stored(key);
      if (size) read += parseWork(size.size, size.escapes);
      writes.set(key, { bytes: size?.size ?? 0, escapes: size?.escapes ?? 0 });
      written += writeWork(size?.size ?? 0, size?.escapes ?? 0);
    }
    // What the operation adds to its own entity's write.
    written += writeWork(row.bytes + PROVENANCE_BYTES, row.escapes + PROVENANCE_ESCAPES);
    out.push(read + written);
  }
  return out;
}
