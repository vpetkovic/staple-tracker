/**
 * A deliberately small markdown renderer for descriptions, comments, and documents.
 *
 * Handles what staple's own content actually uses: fenced code, headings, unordered
 * lists, inline code, bold, and links. No HTML passthrough — everything renders as
 * React elements, so there is no dangerouslySetInnerHTML anywhere in this app and no
 * sanitizer to get wrong.
 *
 * WAVE 2 (U2): if the document viewer needs tables or diffs, extend this rather than
 * adding a markdown dependency — the runtime bundle is a devDependency-built artifact
 * and every kilobyte here is a kilobyte the server has to hand out.
 */
import { Fragment, type ReactNode } from "react";

/** `code`, **bold**, and [text](https://…) — applied in that order, left to right. */
function inline(text: string, keyPrefix: string): ReactNode[] {
  const pattern = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\((https?:[^)\s]+)\)/g;
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
    } else if (match[3] !== undefined && match[4] !== undefined) {
      out.push(
        <a
          key={key}
          href={match[4]}
          target="_blank"
          rel="noreferrer noopener"
          className="text-primary underline underline-offset-2"
        >
          {match[3]}
        </a>,
      );
    }
    last = match.index + match[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text, className }: { text: string; className?: string }): ReactNode {
  const lines = String(text ?? "").split("\n");
  const blocks: ReactNode[] = [];
  let list: string[] = [];
  let code: string[] | null = null;
  let key = 0;

  const flushList = () => {
    if (list.length === 0) return;
    const items = list;
    list = [];
    blocks.push(
      <ul key={`ul-${key++}`} className="my-2 list-disc space-y-1 pl-5">
        {items.map((item, i) => (
          <li key={i}>{inline(item, `li-${key}-${i}`)}</li>
        ))}
      </ul>,
    );
  };

  for (const line of lines) {
    if (line.startsWith("```")) {
      if (code === null) {
        flushList();
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

    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet?.[1] !== undefined) {
      list.push(bullet[1]);
      continue;
    }
    flushList();

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
  flushList();
  if (code !== null) {
    blocks.push(
      <pre key={`pre-${key++}`} className="my-2 overflow-x-auto rounded-md border bg-muted/60 p-3 font-mono text-xs">
        <code>{code.join("\n")}</code>
      </pre>,
    );
  }

  return <div className={className}>{blocks.map((block, i) => <Fragment key={i}>{block}</Fragment>)}</div>;
}
