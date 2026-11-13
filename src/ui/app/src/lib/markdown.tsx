/**
 * A deliberately small markdown renderer for descriptions, comments, documents and plans.
 *
 * Handles what staple's own content actually uses: fenced code, headings, bulleted,
 * numbered and checklist items, quotes, pipe tables, inline code, bold, italics and links.
 * No HTML passthrough — everything renders as React elements, so there is no
 * dangerouslySetInnerHTML anywhere in this app and no sanitizer to get wrong.
 *
 * Extend this rather than adding a markdown dependency — the runtime bundle is a
 * devDependency-built artifact and every kilobyte here is a kilobyte the server has to hand out.
 */
import { Fragment, type ReactNode } from "react";

/** `code`, **bold**, *italic*, and [text](https://…) — applied left to right. */
function inline(text: string, keyPrefix: string): ReactNode[] {
  const pattern = /`([^`]+)`|\*\*([^*]+)\*\*|(?<![\w*])\*([^*\s](?:[^*]*[^*\s])?)\*(?![\w*])|\[([^\]]+)\]\((https?:[^)\s]+)\)/g;
  const out: ReactNode[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  let index = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) out.push(text.slice(last, match.index));
    const key = `${keyPrefix}-i${index++}`;
    if (match[1] !== undefined) {
      out.push(
        <code key={key} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">
          {match[1]}
        </code>,
      );
    } else if (match[2] !== undefined) {
      out.push(<strong key={key}>{match[2]}</strong>);
    } else if (match[3] !== undefined) {
      out.push(<em key={key}>{match[3]}</em>);
    } else if (match[4] !== undefined && match[5] !== undefined) {
      out.push(
        <a
          key={key}
          href={match[5]}
          target="_blank"
          rel="noreferrer noopener"
          className="text-primary underline underline-offset-2"
        >
          {match[4]}
        </a>,
      );
    }
    last = match.index + match[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** One list item: its text, and its check when it is a checklist line (`[ ]`, `[x]`, `[~]`). */
interface Item {
  text: string;
  check: "open" | "done" | "deferred" | null;
}

const CHECK_GLYPH = { open: "☐", done: "☑", deferred: "◌" } as const;
const CHECK_WORDS = { open: "open", done: "done", deferred: "deferred" } as const;

function item(raw: string): Item {
  const checked = /^\[( |x|X|~)\]\s+(.*)$/.exec(raw);
  if (!checked) return { text: raw, check: null };
  const mark = checked[1]!;
  return { text: checked[2]!, check: mark === " " ? "open" : mark === "~" ? "deferred" : "done" };
}

/** A table row's cells, the outer pipes dropped. */
function cells(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

export function Markdown({ text, className }: { text: string; className?: string }): ReactNode {
  const lines = String(text ?? "").split("\n");
  const blocks: ReactNode[] = [];
  let list: { ordered: boolean; items: Item[] } | null = null;
  let quote: string[] = [];
  let code: string[] | null = null;
  let key = 0;

  const flushList = () => {
    if (list === null) return;
    const { ordered, items } = list;
    list = null;
    const checklist = items.every((entry) => entry.check !== null);
    const body = items.map((entry, i) => (
      <li key={i} className={checklist ? "flex gap-1.5" : undefined} data-md-check={entry.check ?? undefined}>
        {entry.check ? (
          <span aria-label={CHECK_WORDS[entry.check]} className="shrink-0 text-text-tertiary">
            {CHECK_GLYPH[entry.check]}
          </span>
        ) : null}
        <span className={entry.check === "done" ? "text-text-secondary" : undefined}>{inline(entry.text, `li-${key}-${i}`)}</span>
      </li>
    ));
    blocks.push(
      ordered ? (
        <ol key={`ol-${key++}`} className="my-2 list-decimal space-y-1 pl-5">
          {body}
        </ol>
      ) : (
        <ul key={`ul-${key++}`} className={checklist ? "my-2 space-y-1 pl-0" : "my-2 list-disc space-y-1 pl-5"}>
          {body}
        </ul>
      ),
    );
  };
  const flushQuote = () => {
    if (quote.length === 0) return;
    const body = quote.join(" ");
    quote = [];
    blocks.push(
      <blockquote key={`q-${key++}`} className="my-2 border-l-2 pl-3 text-text-secondary">
        {inline(body, `q-${key}`)}
      </blockquote>,
    );
  };
  const flush = () => {
    flushList();
    flushQuote();
  };

  for (let at = 0; at < lines.length; at += 1) {
    const line = lines[at]!;
    if (line.startsWith("```")) {
      if (code === null) {
        flush();
        code = [];
      } else {
        blocks.push(
          <pre
            key={`pre-${key++}`}
            className="my-2 overflow-x-auto rounded-md border bg-muted/60 p-3 font-mono text-xs"
          >
            <code>{code.join("\n")}</code>
          </pre>,
        );
        code = null;
      }
      continue;
    }
    if (code !== null) {
      code.push(line);
      continue;
    }

    const quoted = /^\s*>\s?(.*)$/.exec(line);
    if (quoted?.[1] !== undefined) {
      flushList();
      quote.push(quoted[1]);
      continue;
    }
    flushQuote();

    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet?.[1] !== undefined || numbered?.[1] !== undefined) {
      const ordered = numbered?.[1] !== undefined;
      if (list !== null && list.ordered !== ordered) flushList();
      list ??= { ordered, items: [] };
      list.items.push(item((bullet?.[1] ?? numbered?.[1])!));
      continue;
    }
    flushList();

    // A pipe table: a header row, its rule, then rows until a line that is not one.
    if (line.trim().startsWith("|") && TABLE_RULE.test(lines[at + 1] ?? "")) {
      const head = cells(line);
      const rows: string[][] = [];
      at += 2;
      while (at < lines.length && lines[at]!.trim().startsWith("|")) rows.push(cells(lines[at++]!));
      at -= 1;
      const tableKey = key++;
      blocks.push(
        <div key={`t-${tableKey}`} className="my-2 overflow-x-auto">
          <table className="w-full border-collapse text-left text-[0.95em]">
            <thead>
              <tr>
                {head.map((cell, i) => (
                  <th key={i} className="border-b px-2 py-1 font-semibold">
                    {inline(cell, `th-${tableKey}-${i}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, r) => (
                <tr key={r} className="border-b last:border-b-0">
                  {head.map((_, c) => (
                    <td key={c} className="px-2 py-1 align-top">
                      {inline(row[c] ?? "", `td-${tableKey}-${r}-${c}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading?.[1] !== undefined && heading[2] !== undefined) {
      const level = heading[1].length;
      const size = level <= 1 ? "text-base" : level === 2 ? "text-sm" : "text-[13px]";
      blocks.push(
        <p key={`h-${key++}`} className={`mt-3 mb-1 font-semibold ${size}`}>
          {inline(heading[2], `h-${key}`)}
        </p>,
      );
      continue;
    }

    if (line.trim() === "") {
      blocks.push(<div key={`sp-${key++}`} className="h-2" />);
      continue;
    }
    blocks.push(
      <p key={`p-${key++}`} className="my-1">
        {inline(line, `p-${key}`)}
      </p>,
    );
  }
  flush();
  if (code !== null) {
    blocks.push(
      <pre key={`pre-${key++}`} className="my-2 overflow-x-auto rounded-md border bg-muted/60 p-3 font-mono text-xs">
        <code>{code.join("\n")}</code>
      </pre>,
    );
  }

  return <div className={className}>{blocks.map((block, i) => <Fragment key={i}>{block}</Fragment>)}</div>;
}
