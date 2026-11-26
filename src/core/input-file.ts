/**
 * Reads a file the user named (`doc --put <file>`, `file attach <path>`, `--instructions <file>`,
 * `idea import <file>`, MCP `attach_file`'s `path`).
 *
 * A raw `readFileSync` let ENOENT, EISDIR and EACCES escape as unclassified errors: the CLI
 * printed a Node stack trace and exited 1. Here a blank path and a path that exists but cannot
 * be read are `validation` (exit 2), and a path with nothing at it is `not_found` (exit 3). The
 * message names the flag and the path as given. Internal paths (settings files, the UI token,
 * built views) do not come through here.
 */
import { readFileSync } from "node:fs";
import { StapleError } from "./types.js";

export function readInputFile(path: string, label: string): Buffer;
export function readInputFile(path: string, label: string, encoding: "utf8"): string;
export function readInputFile(path: string, label: string, encoding?: "utf8"): Buffer | string {
  if (!path.trim()) throw new StapleError("validation", `${label} needs a file path; it was given an empty one.`);
  try {
    return encoding ? readFileSync(path, encoding) : readFileSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // ENOTDIR: a file sits where the path needs a directory, so nothing is at the path either.
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw new StapleError("not_found", `${label} ${path}: no such file.`, { path });
    }
    const reason =
      code === "EISDIR" ? "it is a directory, not a file"
      : code === "EACCES" || code === "EPERM" ? "permission denied"
      : (error as Error).message;
    throw new StapleError("validation", `${label} ${path}: cannot read it, ${reason}.`, { path });
  }
}
