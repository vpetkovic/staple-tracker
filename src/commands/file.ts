/**
 * `staple file` — attach, list, export and remove a typed file on a ticket.
 *
 *   file attach <ref> <path> [--caption C] [--filename N]
 *   file ls <ref>
 *   file get <id> --out <path>
 *   file rm <id>
 *   file adopt <ref> [<doc-key>] [--revision N]
 *
 * `show --json` lists the same metadata and never the bytes. A file over the cap
 * exits 16. A file whose bytes did not travel exits 3 on get, naming that fact.
 *
 * `adopt` turns a document an agent wrote as base64 evidence (a `Media type:`
 * and `SHA-256:` header over base64) into a real file. With no key it adopts
 * every such document on the ticket. A document whose bytes do not match is
 * reported and skipped. The current body becomes a note naming the file, and
 * the revision that held the bytes stays. A second run creates nothing.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { parseArgs } from "node:util";
import { acknowledgeRenumbers } from "../core/identifier-moves.js";
import { StapleError } from "../core/types.js";
import { resolveWorkspace } from "../core/workspace.js";

const USAGE = "Use: attach <ref> <path>, ls <ref>, get <id> --out <path>, rm <id>, adopt <ref> [<doc-key>]";

export function runFileCommand(rest: string[]): void {
  const [sub, ...args] = rest;
  if (sub === undefined || sub === "--help" || sub === "-h") {
    console.log(USAGE);
    return;
  }
  switch (sub) {
    case "attach":
      return attach(args);
    case "ls":
      return list(args);
    case "get":
      return get(args);
    case "rm":
      return remove(args);
    case "adopt":
      return adopt(args);
    default:
      throw new StapleError("validation", `Unknown file command "${sub}". ${USAGE}`);
  }
}

const flags = {
  db: { type: "string" as const },
  ws: { type: "string" as const },
  json: { type: "boolean" as const },
  "ack-renumber": { type: "boolean" as const },
};

function open(values: { db?: string; ws?: string; "ack-renumber"?: boolean }) {
  if (values["ack-renumber"] === true) acknowledgeRenumbers();
  return resolveWorkspace({ db: values.db, ws: values.ws }).store;
}

function author(): string {
  return process.env.STAPLE_AGENT ?? process.env.USER ?? "user";
}

function attach(args: string[]): void {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { ...flags, caption: { type: "string" }, filename: { type: "string" } },
  });
  const [ref, path] = positionals;
  if (!ref || !path) throw new StapleError("validation", "file attach needs a ticket and a path. " + USAGE);
  const bytes = readFileSync(path);
  const result = open(values).attachFile(ref, {
    filename: values.filename ?? basename(path),
    bytes,
    caption: values.caption ?? null,
    author: author(),
  });
  if (values.json) {
    console.log(JSON.stringify(result));
    return;
  }
  console.log(`${result.id}  ${result.mediaType}  ${result.size}  ${result.sha256}  ${result.byteSync}  ${result.filename}`);
}

function list(args: string[]): void {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: flags });
  const ref = positionals[0];
  if (!ref) throw new StapleError("validation", "file ls needs a ticket. " + USAGE);
  const files = open(values).listFiles(ref);
  if (values.json) {
    console.log(JSON.stringify(files));
    return;
  }
  if (files.length === 0) {
    console.log("(no files)");
    return;
  }
  for (const file of files) {
    console.log(`${file.id}  ${file.mediaType}  ${file.size}  ${file.byteSync}  ${file.filename}`);
  }
}

function get(args: string[]): void {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { ...flags, out: { type: "string" } },
  });
  const id = positionals[0];
  if (!id || !values.out) throw new StapleError("validation", "file get needs an id and --out. " + USAGE);
  const file = open(values).readFile(id);
  writeFileSync(values.out, file.bytes);
  const meta = { ...file.meta };
  if (values.json) {
    console.log(JSON.stringify(meta));
    return;
  }
  console.log(`${values.out}  ${meta.size}  ${meta.sha256}`);
}

function remove(args: string[]): void {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: flags });
  const id = positionals[0];
  if (!id) throw new StapleError("validation", "file rm needs an id. " + USAGE);
  const removed = open(values).removeFile(id, author());
  if (values.json) {
    console.log(JSON.stringify(removed));
    return;
  }
  console.log(`removed ${removed.id}`);
}

function adopt(args: string[]): void {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { ...flags, revision: { type: "string" } },
  });
  const [ref, key] = positionals;
  if (!ref) throw new StapleError("validation", "file adopt needs a ticket. " + USAGE);
  const revision = values.revision === undefined ? undefined : Number(values.revision);
  if (revision !== undefined && (!Number.isInteger(revision) || revision < 1)) {
    throw new StapleError("validation", "--revision is a revision number.");
  }
  if (revision !== undefined && !key) throw new StapleError("validation", "--revision needs a document key.");
  const store = open(values);
  if (key) {
    const result = store.adoptDocumentFile(ref, key, { revision, author: author() });
    if (values.json) {
      console.log(JSON.stringify(result));
      return;
    }
    console.log(adoptedLine(result));
    return;
  }
  // Every evidence document on the ticket. A flagged one is reported, not converted.
  const adopted: Array<ReturnType<typeof store.adoptDocumentFile>> = [];
  const flagged: Array<{ key: string; status: string; problem: string | null }> = [];
  for (const doc of store.listDocuments(ref)) {
    const found = store.documentEvidence(ref, doc.key);
    if (!found) continue;
    if (found.evidence.status !== "verified") {
      flagged.push({ key: doc.key, status: found.evidence.status, problem: found.evidence.problem });
      continue;
    }
    adopted.push(store.adoptDocumentFile(ref, doc.key, { author: author() }));
  }
  if (values.json) {
    console.log(JSON.stringify({ adopted, flagged }));
    return;
  }
  if (adopted.length === 0 && flagged.length === 0) {
    console.log("(no base64 evidence documents)");
    return;
  }
  for (const result of adopted) console.log(adoptedLine(result));
  for (const doc of flagged) console.log(`flagged  ${doc.key}  ${doc.status}  ${doc.problem ?? ""}`);
}

function adoptedLine(result: { file: { id: string; mediaType: string; size: number; sha256: string; filename: string }; created: boolean; document: { key: string; revision: number } }): string {
  const { file, created, document } = result;
  return `${created ? "adopted" : "already"}  ${document.key}@${document.revision} -> ${file.id}  ${file.mediaType}  ${file.size}  ${file.sha256}  ${file.filename}`;
}
