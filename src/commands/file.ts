/**
 * `staple file` — attach, list, export and remove a typed file on a ticket.
 *
 *   file attach <ref> <path> [--caption C] [--filename N]
 *   file ls <ref>
 *   file get <id> --out <path>
 *   file rm <id>
 *
 * `show --json` lists the same metadata and never the bytes. A file over the cap
 * exits 16. A file whose bytes did not travel exits 3 on get, naming that fact.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { parseArgs } from "node:util";
import { acknowledgeRenumbers } from "../core/identifier-moves.js";
import { StapleError } from "../core/types.js";
import { resolveWorkspace } from "../core/workspace.js";

const USAGE = "Use: attach <ref> <path>, ls <ref>, get <id> --out <path>, rm <id>";

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
