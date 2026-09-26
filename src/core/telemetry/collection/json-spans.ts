/**
 * Where each value sits in a JSON text, so a settings file can be edited by replacing
 * one span and leaving every other byte (key order, indentation, escapes, trailing
 * newline) exactly as the owner wrote it.
 *
 * Strict JSON only: the caller runs `JSON.parse` first and refuses what it rejects, so
 * this scanner can assume well-formed input and only has to record offsets. For a key
 * that appears twice in one object, the LAST occurrence is the one `JSON.parse` keeps,
 * and {@link member} returns that one too.
 */

export interface JsonMember {
  readonly key: string;
  /** Offset of the key's opening quote. */
  readonly keyStart: number;
  readonly value: JsonNode;
}

export interface JsonNode {
  readonly kind: "object" | "array" | "string" | "number" | "literal";
  /** Offset of the value's first character. */
  readonly start: number;
  /** Offset one past the value's last character. */
  readonly end: number;
  /** Objects only, in source order. */
  readonly members?: readonly JsonMember[];
}

const WHITESPACE = new Set([" ", "\t", "\n", "\r"]);

class Scanner {
  pos = 0;
  constructor(readonly text: string) {}

  skipWhitespace(): void {
    while (this.pos < this.text.length && WHITESPACE.has(this.text[this.pos]!)) this.pos += 1;
  }

  value(): JsonNode {
    this.skipWhitespace();
    const start = this.pos;
    const ch = this.text[this.pos];
    if (ch === "{") return this.object();
    if (ch === "[") return this.array();
    if (ch === '"') {
      this.string();
      return { kind: "string", start, end: this.pos };
    }
    if (ch === "-" || (ch !== undefined && ch >= "0" && ch <= "9")) {
      while (this.pos < this.text.length && /[-+0-9.eE]/.test(this.text[this.pos]!)) this.pos += 1;
      return { kind: "number", start, end: this.pos };
    }
    for (const literal of ["true", "false", "null"]) {
      if (this.text.startsWith(literal, this.pos)) {
        this.pos += literal.length;
        return { kind: "literal", start, end: this.pos };
      }
    }
    throw new Error(`unexpected character at offset ${this.pos}`);
  }

  string(): string {
    const start = this.pos;
    this.pos += 1;
    while (this.pos < this.text.length) {
      const ch = this.text[this.pos]!;
      if (ch === "\\") this.pos += 2;
      else if (ch === '"') {
        this.pos += 1;
        return JSON.parse(this.text.slice(start, this.pos)) as string;
      } else this.pos += 1;
    }
    throw new Error("unterminated string");
  }

  object(): JsonNode {
    const start = this.pos;
    this.pos += 1;
    const members: JsonMember[] = [];
    this.skipWhitespace();
    if (this.text[this.pos] === "}") {
      this.pos += 1;
      return { kind: "object", start, end: this.pos, members };
    }
    for (;;) {
      this.skipWhitespace();
      const keyStart = this.pos;
      const key = this.string();
      this.skipWhitespace();
      this.pos += 1; // ':'
      const value = this.value();
      members.push({ key, keyStart, value });
      this.skipWhitespace();
      const next = this.text[this.pos];
      this.pos += 1;
      if (next === "}") return { kind: "object", start, end: this.pos, members };
    }
  }

  array(): JsonNode {
    const start = this.pos;
    this.pos += 1;
    this.skipWhitespace();
    if (this.text[this.pos] === "]") {
      this.pos += 1;
      return { kind: "array", start, end: this.pos };
    }
    for (;;) {
      this.value();
      this.skipWhitespace();
      const next = this.text[this.pos];
      this.pos += 1;
      if (next === "]") return { kind: "array", start, end: this.pos };
    }
  }
}

/** The span tree of a text `JSON.parse` has already accepted. */
export function scanJson(text: string): JsonNode {
  const scanner = new Scanner(text);
  return scanner.value();
}

/** The member `JSON.parse` would keep for this key: the last one. */
export function member(node: JsonNode, key: string): JsonMember | null {
  const members = node.members ?? [];
  for (let i = members.length - 1; i >= 0; i -= 1) if (members[i]!.key === key) return members[i]!;
  return null;
}

/** Replace `[start, end)` of `text`. */
export function splice(text: string, start: number, end: number, replacement: string): string {
  return text.slice(0, start) + replacement + text.slice(end);
}

/**
 * The span that removing one member of an object must delete so the object stays valid:
 * the member itself plus the comma that separated it from a neighbour (the preceding one
 * when there is one, else the following one), and the whitespace between them.
 */
export function memberRemovalSpan(text: string, object: JsonNode, target: JsonMember): { start: number; end: number } {
  const members = object.members ?? [];
  const index = members.indexOf(target);
  if (index > 0) {
    const previous = members[index - 1]!;
    return { start: previous.value.end, end: target.value.end };
  }
  if (members.length > 1) {
    return { start: target.keyStart, end: members[1]!.keyStart };
  }
  // The only member: empty the object back to what an empty object looked like.
  let start = object.start + 1;
  let end = object.end - 1;
  if (start > end) [start, end] = [end, start];
  return { start, end };
}

/** The indentation the object's members use, or two spaces when it has none to copy. */
export function memberIndent(text: string, object: JsonNode): string {
  const first = object.members?.[0];
  if (first === undefined) return "  ";
  const lineStart = text.lastIndexOf("\n", first.keyStart - 1);
  if (lineStart < 0) return "";
  return text.slice(lineStart + 1, first.keyStart);
}
