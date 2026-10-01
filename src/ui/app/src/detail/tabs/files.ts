/**
 * How a ticket's files are grouped for the Files tab.
 *
 * The groups are a fixed order. A type with no viewer of its own (SVG, HTML,
 * anything unrecognised) is Other, which is a download. Empty groups are left
 * out so a ticket with one screenshot does not show four blank headings.
 */
import type { IssueAttachment } from "@/lib/types";

export const FILE_GROUPS = [
  { id: "images", label: "Images" },
  { id: "videos", label: "Videos" },
  { id: "documents", label: "Documents" },
  { id: "text", label: "Text and logs" },
  { id: "other", label: "Other" },
] as const;

export type FileGroupId = (typeof FILE_GROUPS)[number]["id"];

const GROUP_TYPES: Record<Exclude<FileGroupId, "other">, readonly string[]> = {
  images: ["image/png", "image/jpeg", "image/gif", "image/webp"],
  videos: ["video/mp4", "video/webm"],
  documents: ["application/pdf"],
  text: ["text/plain", "text/markdown"],
};

export function fileGroupId(mediaType: string): FileGroupId {
  for (const group of FILE_GROUPS) {
    if (group.id === "other") continue;
    if (GROUP_TYPES[group.id].includes(mediaType)) return group.id;
  }
  return "other";
}

export interface FileGroup<T> {
  id: FileGroupId;
  label: string;
  files: T[];
}

export function groupFiles<T extends { mediaType: string }>(files: readonly T[]): FileGroup<T>[] {
  const buckets = new Map<FileGroupId, T[]>();
  for (const file of files) {
    const id = fileGroupId(file.mediaType);
    const list = buckets.get(id);
    if (list) list.push(file);
    else buckets.set(id, [file]);
  }
  return FILE_GROUPS.flatMap((group) => {
    const list = buckets.get(group.id);
    return list && list.length > 0 ? [{ id: group.id, label: group.label, files: list }] : [];
  });
}

/** A before/after pair is a caption or a filename, not a separate field. */
export function evidenceLabel(file: Pick<IssueAttachment, "filename" | "caption">): "before" | "after" | null {
  const hay = `${file.caption ?? ""} ${file.filename}`.toLowerCase();
  const afterAt = hay.search(/\bafter\b/);
  const beforeAt = hay.search(/\bbefore\b/);
  if (afterAt === -1 && beforeAt === -1) return null;
  if (beforeAt === -1) return "after";
  if (afterAt === -1) return "before";
  return beforeAt <= afterAt ? "before" : "after";
}

export function isMarkdownFile(filename: string): boolean {
  return /\.(md|markdown)$/i.test(filename);
}

export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 bytes";
  if (bytes < 1024) return `${bytes} ${bytes === 1 ? "byte" : "bytes"}`;
  if (bytes < 1024 * 1024) {
    const kib = bytes / 1024;
    const rounded = kib < 10 && Math.round(kib) !== kib ? kib.toFixed(1) : String(Math.round(kib));
    return `${rounded} KiB`;
  }
  const mib = bytes / (1024 * 1024);
  const rounded = mib < 10 ? mib.toFixed(1) : String(Math.round(mib));
  return `${rounded} MiB`;
}
