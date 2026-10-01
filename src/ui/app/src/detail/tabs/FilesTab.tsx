/**
 * Files on a ticket, grouped by the kind of viewer they get.
 *
 * Images open in a lightbox. Video plays in the row. A PDF is embedded. Text
 * and logs are readable, markdown when the name says so. Everything else is a
 * name, a size and a download. The bytes come from `/api/file`, which does not
 * serve SVG or HTML as a document.
 */
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Copy, Download, File, FileText, Image as ImageIcon, Paperclip, X } from "lucide-react";
import { DismissableLayerBranch } from "@radix-ui/react-dismissable-layer";
import { Button } from "@/components/ui/button";
import { ApiError, fetchFile } from "@/lib/api";
import { Markdown } from "@/lib/markdown";
import type { IssueAttachment } from "@/lib/types";
import { DetailCard, EmptyState, PersonChip, RelativeTime, SectionHeading } from "../parts";
import { evidenceLabel, fileGroupId, formatFileSize, groupFiles, isMarkdownFile, type FileGroupId } from "./files";
import type { TabProps } from "./registry";
import "./tabs.css";

const personKind = (name: string) => (/[-_]/.test(name) ? "agent" : "human");

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
    <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-caption text-text-secondary">
      <span className="tabular-nums">{formatFileSize(file.size)}</span>
      {file.author ? (
        <>
          <span aria-hidden>·</span>
          <PersonChip name={file.author} kind={personKind(file.author)} />
        </>
      ) : null}
      <span aria-hidden>·</span>
      <RelativeTime iso={file.createdAt} />
    </p>
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

function ImageTile({
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
    <li className="min-w-0" data-file={file.id} data-file-kind="image">
      <button
        type="button"
        onClick={() => loaded && onOpen(file.id)}
        disabled={!loaded}
        className="focus-ring flex w-full min-w-0 flex-col gap-1.5 rounded-lg text-left"
      >
        <span className="relative block aspect-square overflow-hidden rounded-lg border border-border bg-surface-sunken">
          {loaded ? (
            <img src={loaded.url} alt="" className="absolute inset-0 size-full object-cover" />
          ) : (
            <ImageIcon aria-hidden className="absolute top-1/2 left-1/2 size-5 -translate-x-1/2 -translate-y-1/2 text-text-tertiary" />
          )}
          <span className="absolute top-1.5 left-1.5">
            <EvidenceBadge file={file} />
          </span>
        </span>
        <span className="truncate text-label text-foreground" title={file.filename}>
          {file.filename}
        </span>
      </button>
      {file.caption ? <p className="mt-0.5 truncate text-caption text-text-secondary">{file.caption}</p> : null}
      <FileMeta file={file} />
      {error ? <Missing message={error} /> : null}
    </li>
  );
}

function VideoRow({ file, workspace }: { file: IssueAttachment; workspace: string }) {
  const { loaded, error } = useFileBytes(workspace, file.id);
  return (
    <li className="min-w-0" data-file={file.id} data-file-kind="video">
      <div className="mb-2 flex min-w-0 flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-body font-medium text-foreground" title={file.filename}>
            {file.filename}
          </p>
          <FileMeta file={file} />
        </div>
        <FileActions filename={file.filename} url={loaded?.url ?? null} />
      </div>
      {error ? (
        <Missing message={error} />
      ) : (
        <video controls preload="metadata" src={loaded?.url} className="max-h-80 w-full rounded-lg border border-border bg-surface-sunken">
          {file.filename}
        </video>
      )}
    </li>
  );
}

function PdfRow({ file, workspace }: { file: IssueAttachment; workspace: string }) {
  const { loaded, error } = useFileBytes(workspace, file.id);
  return (
    <li className="min-w-0" data-file={file.id} data-file-kind="pdf">
      <div className="mb-2 flex min-w-0 flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="flex min-w-0 items-center gap-1.5 text-body font-medium text-foreground">
            <FileText aria-hidden className="size-4 shrink-0 text-text-tertiary" />
            <span className="truncate" title={file.filename}>
              {file.filename}
            </span>
          </p>
          <FileMeta file={file} />
        </div>
        <FileActions filename={file.filename} url={loaded?.url ?? null} />
      </div>
      {error ? (
        <Missing message={error} />
      ) : (
        <iframe title={file.filename} src={loaded?.url} className="h-96 w-full rounded-lg border border-border bg-surface-raised" />
      )}
    </li>
  );
}

function TextRow({ file, workspace }: { file: IssueAttachment; workspace: string }) {
  const { loaded, error } = useFileBytes(workspace, file.id);
  const [copied, setCopied] = useState(false);
  const markdown = isMarkdownFile(file.filename);
  const text = loaded?.text ?? null;
  return (
    <li className="min-w-0" data-file={file.id} data-file-kind="text">
      <div className="mb-2 flex min-w-0 flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-body font-medium text-foreground" title={file.filename}>
            {file.filename}
          </p>
          <FileMeta file={file} />
        </div>
        <div className="flex shrink-0 items-center gap-1">
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
          <FileActions filename={file.filename} url={loaded?.url ?? null} />
        </div>
      </div>
      {error ? (
        <Missing message={error} />
      ) : text !== null && markdown ? (
        <div className="tab-prose text-reading">
          <Markdown text={text} />
        </div>
      ) : (
        <pre className="max-h-80 overflow-auto rounded-lg border border-border bg-surface-sunken p-3 font-mono text-label text-foreground max-md:whitespace-pre-wrap max-md:[overflow-wrap:anywhere]">
          {text ?? ""}
        </pre>
      )}
    </li>
  );
}

function OtherRow({ file, workspace }: { file: IssueAttachment; workspace: string }) {
  const { loaded, error } = useFileBytes(workspace, file.id);
  return (
    <li className="flex min-w-0 flex-wrap items-center gap-3 px-3 py-2.5" data-file={file.id} data-file-kind="other">
      <File aria-hidden className="size-4 shrink-0 text-text-tertiary" />
      <div className="min-w-0 flex-1">
        <p className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-body text-foreground" title={file.filename}>
            {file.filename}
          </span>
          <EvidenceBadge file={file} />
        </p>
        {file.caption ? <p className="truncate text-caption text-text-secondary">{file.caption}</p> : null}
        <FileMeta file={file} />
        {error ? <Missing message={error} /> : null}
      </div>
      <FileActions filename={file.filename} url={loaded?.url ?? null} />
    </li>
  );
}

function GroupBody({
  id,
  files,
  workspace,
  onOpenImage,
}: {
  id: FileGroupId;
  files: IssueAttachment[];
  workspace: string;
  onOpenImage: (id: string) => void;
}) {
  if (id === "images") {
    return (
      <ul className="grid grid-cols-2 gap-3 md:grid-cols-3">
        {files.map((file) => (
          <ImageTile key={file.id} file={file} workspace={workspace} onOpen={onOpenImage} />
        ))}
      </ul>
    );
  }
  if (id === "other") {
    return (
      <DetailCard padded={false}>
        <ul className="divide-y divide-border">
          {files.map((file) => (
            <OtherRow key={file.id} file={file} workspace={workspace} />
          ))}
        </ul>
      </DetailCard>
    );
  }
  const Row = id === "videos" ? VideoRow : id === "documents" ? PdfRow : TextRow;
  return (
    <ul className="flex flex-col gap-4">
      {files.map((file) => (
        <Row key={file.id} file={file} workspace={workspace} />
      ))}
    </ul>
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
      className="fixed inset-0 z-[60] flex flex-col bg-background/95"
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
  const images = files.filter((file) => fileGroupId(file.mediaType) === "images");
  const openIndex = images.findIndex((file) => file.id === openId);
  if (files.length === 0) {
    return (
      <div data-files="">
        <EmptyState icon={Paperclip}>No files on this ticket.</EmptyState>
      </div>
    );
  }
  const groups = groupFiles(files);
  return (
    <div data-files="" className="flex min-w-0 flex-col gap-6">
      {groups.map((group) => (
        <section key={group.id} data-file-group={group.id} className="min-w-0">
          <SectionHeading action={<span data-file-count="">{group.files.length}</span>}>{group.label}</SectionHeading>
          <GroupBody id={group.id} files={group.files} workspace={workspace} onOpenImage={setOpenId} />
        </section>
      ))}
      {openIndex >= 0 ? (
        <Lightbox
          images={images}
          index={openIndex}
          workspace={workspace}
          onIndex={(index) => setOpenId(images[index]?.id ?? null)}
          onClose={() => setOpenId(null)}
        />
      ) : null}
    </div>
  );
}
