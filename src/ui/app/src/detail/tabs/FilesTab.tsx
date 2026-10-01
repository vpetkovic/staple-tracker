/**
 * Files on a ticket: evidence and supporting material, not the ticket's writing.
 *
 * A filter row names the kinds that are actually here. Images sit in one short
 * strip and open in a lightbox. Everything else is one full-width list. The
 * chosen file opens in its own side panel, beside the ticket, and the left
 * edge of that panel sets the width. SVG and HTML stay downloads. The bytes
 * come from `/api/file`.
 */
import { useEffect, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { Copy, Download, File, FileText, Image as ImageIcon, Paperclip, Video, X } from "lucide-react";
import { DismissableLayerBranch } from "@radix-ui/react-dismissable-layer";
import { Button } from "@/components/ui/button";
import { ApiError, fetchFile } from "@/lib/api";
import { Markdown } from "@/lib/markdown";
import type { IssueAttachment } from "@/lib/types";
import { EmptyState, PersonChip, RelativeTime, cn } from "../parts";
import {
  FILE_PANEL_MIN,
  clampFilePanelWidth,
  filePanelDock,
  loadFilePanelWidth,
  saveFilePanelWidth,
  type FilePanelDock,
} from "./file-panel";
import { FILE_GROUPS, evidenceLabel, fileGroupId, formatFileSize, isMarkdownFile, type FileGroupId } from "./files";
import type { TabProps } from "./registry";
import "./tabs.css";

const personKind = (name: string) => (/[-_]/.test(name) ? "agent" : "human");

type Filter = "all" | FileGroupId;

interface LoadedFile {
  url: string;
  text: string | null;
}

function useFileBytes(workspace: string, id: string): { loaded: LoadedFile | null; error: string | null } {
  const [loaded, setLoaded] = useState<LoadedFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const held = { url: null as string | null };
    setLoaded(null);
    setError(null);
    fetchFile({ ws: workspace, id })
      .then((file) => {
        if (cancelled) return;
        const type = file.contentType.split(";")[0]!.trim();
        held.url = URL.createObjectURL(new Blob([file.bytes], { type }));
        const text = type.startsWith("text/") ? new TextDecoder().decode(file.bytes) : null;
        setLoaded({ url: held.url, text });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof ApiError || err instanceof Error ? err.message : "This file could not be loaded.");
      });
    return () => {
      cancelled = true;
      if (held.url) URL.revokeObjectURL(held.url);
    };
  }, [workspace, id]);
  return { loaded, error };
}

function saveFile(url: string, filename: string): void {
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
}

function FileMeta({ file }: { file: IssueAttachment }) {
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-caption text-text-secondary">
      <span className="tabular-nums">{formatFileSize(file.size)}</span>
      {file.author ? (
        <>
          <span aria-hidden>·</span>
          <PersonChip name={file.author} kind={personKind(file.author)} />
        </>
      ) : null}
      <span aria-hidden>·</span>
      <RelativeTime iso={file.createdAt} />
    </span>
  );
}

function EvidenceBadge({ file }: { file: IssueAttachment }) {
  const label = evidenceLabel(file);
  if (!label) return null;
  return (
    <span data-evidence-label={label} className="rounded-md bg-surface-sunken px-1.5 py-0.5 text-caption font-medium text-text-secondary">
      {label === "before" ? "Before" : "After"}
    </span>
  );
}

function FileActions({
  filename,
  url,
}: {
  filename: string;
  url: string | null;
}) {
  return (
    <div className="flex shrink-0 items-center gap-1">
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="max-md:h-10"
        disabled={url === null}
        aria-label={`Download ${filename}`}
        onClick={() => url && saveFile(url, filename)}
      >
        <Download aria-hidden />
        Download
      </Button>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="max-md:h-10"
        disabled={url === null}
        aria-label={`Open ${filename}`}
        onClick={() => url && window.open(url, "_blank")}
      >
        Open
      </Button>
    </div>
  );
}

function Missing({ message }: { message: string }) {
  return (
    <p data-file-missing="" className="text-reading text-text-secondary">
      {message}
    </p>
  );
}

function rowKind(id: FileGroupId): "video" | "pdf" | "text" | "other" {
  if (id === "videos") return "video";
  if (id === "pdfs") return "pdf";
  if (id === "text") return "text";
  return "other";
}

function RowIcon({ kind }: { kind: ReturnType<typeof rowKind> }) {
  const Icon = kind === "video" ? Video : kind === "other" ? File : FileText;
  return <Icon aria-hidden className="size-4 shrink-0 text-text-tertiary" />;
}

function ImageThumb({
  file,
  workspace,
  onOpen,
}: {
  file: IssueAttachment;
  workspace: string;
  onOpen: (id: string) => void;
}) {
  const { loaded, error } = useFileBytes(workspace, file.id);
  return (
    <li className="shrink-0" data-file={file.id} data-file-kind="image">
      <button
        type="button"
        aria-label={file.filename}
        title={file.caption || file.filename}
        onClick={() => loaded && onOpen(file.id)}
        disabled={!loaded}
        className="focus-ring relative block size-20 overflow-hidden rounded-lg border border-border bg-surface-sunken"
      >
        {loaded ? (
          <img src={loaded.url} alt="" className="absolute inset-0 size-full object-cover" />
        ) : (
          <ImageIcon aria-hidden className="absolute top-1/2 left-1/2 size-5 -translate-x-1/2 -translate-y-1/2 text-text-tertiary" />
        )}
        <span className="absolute bottom-1 left-1">
          <EvidenceBadge file={file} />
        </span>
      </button>
      {error ? <Missing message={error} /> : null}
    </li>
  );
}

function FileRow({
  file,
  selected,
  onSelect,
}: {
  file: IssueAttachment;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const kind = rowKind(fileGroupId(file.mediaType));
  return (
    <li className="min-w-0" data-file={file.id}>
      <button
        type="button"
        data-file-row=""
        data-file-kind={kind}
        aria-pressed={selected}
        data-selected={selected ? "" : undefined}
        onClick={() => onSelect(file.id)}
        className={cn(
          "focus-ring flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left max-md:min-h-10",
          selected ? "bg-surface-sunken" : "hover:bg-surface-sunken/70",
        )}
      >
        <RowIcon kind={kind} />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-body text-foreground" title={file.filename}>
              {file.filename}
            </span>
            <EvidenceBadge file={file} />
          </span>
          <FileMeta file={file} />
        </span>
      </button>
    </li>
  );
}

function CopyButton({ text }: { text: string | null }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      className="max-md:h-10"
      disabled={text === null}
      aria-live="polite"
      onClick={() => {
        if (text === null) return;
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      <Copy aria-hidden />
      {copied ? "Copied" : "Copy"}
    </Button>
  );
}

function readDock(): FilePanelDock {
  if (typeof window === "undefined") return filePanelDock(0, 0);
  const task = document.querySelector("[data-detail-overlay]");
  const left = task ? task.getBoundingClientRect().left : window.innerWidth;
  return filePanelDock(left, window.innerWidth);
}

function useTaskDock(): FilePanelDock {
  const [dock, setDock] = useState(readDock);
  useEffect(() => {
    const read = () => setDock(readDock());
    read();
    window.addEventListener("resize", read);
    const task = document.querySelector("[data-detail-overlay]");
    const observer = task ? new ResizeObserver(read) : null;
    if (task && observer) observer.observe(task);
    return () => {
      window.removeEventListener("resize", read);
      observer?.disconnect();
    };
  }, []);
  return dock;
}

function storage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

function ResizeHandle({
  width,
  available,
  onWidth,
}: {
  width: number;
  available: number;
  onWidth: (next: number, done: boolean) => void;
}) {
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startWidth = width;
    const next = (clientX: number) => clampFilePanelWidth(startWidth + (startX - clientX), available);
    const move = (ev: PointerEvent) => onWidth(next(ev.clientX), false);
    const up = (ev: PointerEvent) => {
      if (handle.hasPointerCapture(ev.pointerId)) handle.releasePointerCapture(ev.pointerId);
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      onWidth(next(ev.clientX), true);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  };
  const nudge = (delta: number) => onWidth(clampFilePanelWidth(width + delta, available), true);
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize file panel"
      aria-valuemin={FILE_PANEL_MIN}
      aria-valuemax={Math.round(available)}
      aria-valuenow={Math.round(width)}
      tabIndex={0}
      data-file-panel-resize=""
      title="Drag to resize"
      onPointerDown={onPointerDown}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 80 : 24;
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          nudge(step);
        } else if (event.key === "ArrowRight") {
          event.preventDefault();
          nudge(-step);
        }
      }}
      className="absolute top-0 bottom-0 -left-1.5 z-10 w-3 cursor-col-resize touch-none"
    >
      <span aria-hidden className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-text-tertiary/40" />
      <span aria-hidden className="absolute top-1/2 left-1/2 h-8 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-text-tertiary" />
    </div>
  );
}

function FilePanel({
  file,
  workspace,
  onClose,
}: {
  file: IssueAttachment;
  workspace: string;
  onClose: () => void;
}) {
  const dock = useTaskDock();
  const [width, setWidth] = useState(() => loadFilePanelWidth(storage()));
  const shown = dock.sheet ? dock.available : clampFilePanelWidth(width, dock.available);
  const { loaded, error } = useFileBytes(workspace, file.id);
  const kind = rowKind(fileGroupId(file.mediaType));
  const markdown = isMarkdownFile(file.filename);
  const text = loaded?.text ?? null;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // An open picture takes Escape first. Otherwise this panel closes and the ticket stays.
      if (document.querySelector("[data-file-lightbox]")) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  const setWidthTo = (next: number, done: boolean) => {
    setWidth(next);
    if (done) saveFilePanelWidth(storage(), next);
  };
  return createPortal(
    // Portaled to body, like the picture lightbox: the open ticket sets
    // pointer-events: none on body and closes on a press outside its panel.
    <DismissableLayerBranch
      role="dialog"
      aria-label={file.filename}
      data-file-panel=""
      data-file-panel-width={shown}
      className={cn(
        "fixed z-[60] flex flex-col bg-card text-foreground shadow-xl outline-none",
        dock.sheet ? "inset-0" : "top-0 bottom-0 border-l",
      )}
      style={dock.sheet ? { pointerEvents: "auto" } : { pointerEvents: "auto", right: dock.right, width: shown }}
    >
      {dock.sheet ? null : <ResizeHandle width={shown} available={dock.available} onWidth={setWidthTo} />}
      <div className="flex min-w-0 items-start gap-2 border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-body font-medium text-foreground" title={file.filename}>
            {file.filename}
          </p>
          {file.caption ? <p className="truncate text-caption text-text-secondary">{file.caption}</p> : null}
          <FileMeta file={file} />
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {kind === "text" ? <CopyButton text={text} /> : null}
          <FileActions filename={file.filename} url={loaded?.url ?? null} />
          <Button type="button" size="sm" variant="ghost" className="max-md:h-10" onClick={onClose} aria-label="Close file">
            <X aria-hidden />
          </Button>
        </div>
      </div>
      <div data-file-viewer="" data-file-kind={kind} className="flex min-h-0 flex-1 flex-col overflow-auto p-4">
        {error ? (
          <Missing message={error} />
        ) : kind === "video" ? (
          <video controls preload="metadata" src={loaded?.url} className="max-h-full w-full rounded-lg border border-border bg-surface-sunken">
            {file.filename}
          </video>
        ) : kind === "pdf" ? (
          <iframe title={file.filename} src={loaded?.url} className="min-h-96 w-full flex-1 rounded-lg border border-border bg-surface-raised" />
        ) : kind === "text" && text !== null && markdown ? (
          <div className="tab-prose text-reading">
            <Markdown text={text} />
          </div>
        ) : kind === "text" ? (
          <pre className="max-h-full overflow-auto rounded-lg border border-border bg-surface-sunken p-3 font-mono text-label text-foreground max-md:whitespace-pre-wrap max-md:[overflow-wrap:anywhere]">
            {text ?? ""}
          </pre>
        ) : (
          <p className="text-reading text-text-secondary">This file downloads. It is not shown in the page.</p>
        )}
      </div>
    </DismissableLayerBranch>,
    // Inside the ticket dialog when it is open, so focus can stay on this panel.
    document.querySelector("[data-detail-overlay]") ?? document.body,
  );
}

function Lightbox({
  images,
  index,
  workspace,
  onIndex,
  onClose,
}: {
  images: IssueAttachment[];
  index: number;
  workspace: string;
  onIndex: (index: number) => void;
  onClose: () => void;
}) {
  const file = images[index]!;
  const { loaded, error } = useFileBytes(workspace, file.id);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        // Capture runs before the detail dialog, which would otherwise close the ticket.
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key === "ArrowLeft" && index > 0) onIndex(index - 1);
      if (event.key === "ArrowRight" && index < images.length - 1) onIndex(index + 1);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [images.length, index, onClose, onIndex]);
  const label = evidenceLabel(file);
  return createPortal(
    // The open ticket sets pointer-events: none on body and closes on a press outside
    // its panel. This layer is portaled to body, so it takes events back and stays inside
    // that dismiss scope.
    <DismissableLayerBranch
      role="dialog"
      aria-modal="true"
      aria-label={file.filename}
      data-file-lightbox=""
      className="fixed inset-0 z-[70] flex flex-col bg-background/95"
      style={{ pointerEvents: "auto" }}
    >
      <div className="flex items-center gap-2 px-3 py-2 md:px-5">
        <p className="min-w-0 flex-1 truncate text-body font-medium text-foreground">
          {label ? <span className="mr-2 text-text-secondary">{label === "before" ? "Before" : "After"}</span> : null}
          {file.filename}
        </p>
        <span className="shrink-0 text-caption text-text-secondary tabular-nums">
          {index + 1} / {images.length}
        </span>
        <FileActions filename={file.filename} url={loaded?.url ?? null} />
        <Button type="button" size="sm" variant="ghost" className="max-md:h-10" onClick={onClose} aria-label="Close">
          <X aria-hidden />
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center gap-2 px-2 pb-4 md:px-5">
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="max-md:h-10"
          disabled={index === 0}
          onClick={() => onIndex(index - 1)}
        >
          Previous
        </Button>
        <div className="flex min-w-0 flex-1 flex-col items-center gap-2">
          {error ? (
            <Missing message={error} />
          ) : loaded ? (
            <img src={loaded.url} alt={file.caption || file.filename} className="max-h-[75vh] max-w-full object-contain" />
          ) : null}
          {file.caption ? <p className="max-w-[48ch] text-center text-reading text-text-secondary">{file.caption}</p> : null}
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="max-md:h-10"
          disabled={index >= images.length - 1}
          onClick={() => onIndex(index + 1)}
        >
          Next
        </Button>
      </div>
    </DismissableLayerBranch>,
    document.body,
  );
}

export function FilesTab({ detail, workspace }: TabProps) {
  const files = detail.attachments ?? [];
  const [openId, setOpenId] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const imagesAll = files.filter((file) => fileGroupId(file.mediaType) === "images");
  const openIndex = imagesAll.findIndex((file) => file.id === openId);
  const selected = files.find((file) => file.id === selectedId && fileGroupId(file.mediaType) !== "images") ?? null;
  if (files.length === 0) {
    return (
      <div data-files="">
        <EmptyState icon={Paperclip}>No files on this ticket.</EmptyState>
      </div>
    );
  }
  const counts = new Map<FileGroupId, number>();
  for (const file of files) {
    const id = fileGroupId(file.mediaType);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const visible = filter === "all" ? files : files.filter((file) => fileGroupId(file.mediaType) === filter);
  const images = visible.filter((file) => fileGroupId(file.mediaType) === "images");
  const rest = visible.filter((file) => fileGroupId(file.mediaType) !== "images");
  return (
    <div data-files="" className="flex min-w-0 flex-col gap-4">
      <div role="group" aria-label="File kinds" className="flex flex-wrap gap-1.5">
        <FilterChip id="all" label="All" count={files.length} pressed={filter === "all"} onClick={() => setFilter("all")} />
        {FILE_GROUPS.flatMap((group) => {
          const count = counts.get(group.id) ?? 0;
          if (count === 0) return [];
          return [
            <FilterChip
              key={group.id}
              id={group.id}
              label={group.label}
              count={count}
              pressed={filter === group.id}
              onClick={() => setFilter(group.id)}
            />,
          ];
        })}
      </div>
      {images.length > 0 ? (
        <ul data-file-images="" className="flex min-w-0 gap-2 overflow-x-auto pb-1">
          {images.map((file) => (
            <ImageThumb key={file.id} file={file} workspace={workspace} onOpen={setOpenId} />
          ))}
        </ul>
      ) : null}
      {rest.length > 0 ? (
        <ul data-file-list="" className="flex min-w-0 flex-col">
          {rest.map((file) => (
            <FileRow
              key={file.id}
              file={file}
              selected={file.id === selected?.id}
              onSelect={(id) => setSelectedId((current) => (current === id ? null : id))}
            />
          ))}
        </ul>
      ) : null}
      {selected ? <FilePanel key={selected.id} file={selected} workspace={workspace} onClose={() => setSelectedId(null)} /> : null}
      {openIndex >= 0 ? (
        <Lightbox
          images={imagesAll}
          index={openIndex}
          workspace={workspace}
          onIndex={(index) => setOpenId(imagesAll[index]?.id ?? null)}
          onClose={() => setOpenId(null)}
        />
      ) : null}
    </div>
  );
}

function FilterChip({
  id,
  label,
  count,
  pressed,
  onClick,
}: {
  id: string;
  label: string;
  count: number;
  pressed: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-file-filter={id}
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        "text-body focus-ring inline-flex h-8 items-center gap-1.5 rounded-full border px-3 transition-colors duration-150 max-md:h-10",
        pressed
          ? "border-foreground/20 bg-surface-sunken text-foreground"
          : "border-border text-text-secondary hover:text-foreground",
      )}
    >
      {label}<span data-file-count="" className="text-caption tabular-nums text-text-tertiary">{count}</span>
    </button>
  );
}
