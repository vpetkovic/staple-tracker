/**
 * A document an agent wrote as base64 evidence, shown as the file it holds.
 *
 * The server has already decoded the body and checked it against the SHA-256
 * and the media type it claims (`core/legacy-evidence.ts`). A verified one is
 * shown with a viewer for its type and a download. Anything else is flagged
 * with what is wrong and never shown as an image. Either way the raw text is
 * one disclosure away, because it is still the document.
 */
import { useEffect, useState } from "react";
import { AlertTriangle, Download, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ApiError, fetchDocumentFile } from "@/lib/api";
import type { DocumentEvidence } from "@/lib/types";
import { fileGroupId, formatFileSize } from "./files";

export function EvidenceDocument({
  workspace,
  issueRef,
  docKey,
  revision,
  evidence,
  name,
  body,
}: {
  workspace: string;
  issueRef: string;
  docKey: string;
  revision: number;
  evidence: DocumentEvidence;
  name: string;
  body: string;
}) {
  const verified = evidence.status === "verified" && evidence.mediaType !== null;
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!verified) return;
    let cancelled = false;
    let held: string | null = null;
    setUrl(null);
    setError(null);
    fetchDocumentFile({ ws: workspace, ref: issueRef, key: docKey, revision })
      .then((file) => {
        if (cancelled) return;
        held = URL.createObjectURL(new Blob([file.bytes], { type: file.contentType.split(";")[0]!.trim() }));
        setUrl(held);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof ApiError || err instanceof Error ? err.message : "This file could not be loaded.");
      });
    return () => {
      cancelled = true;
      if (held) URL.revokeObjectURL(held);
    };
  }, [verified, workspace, issueRef, docKey, revision]);

  const kind = evidence.mediaType ? fileGroupId(evidence.mediaType) : "other";

  const download = () => {
    if (!url) return;
    const link = document.createElement("a");
    link.href = url;
    link.download = evidence.filename;
    document.body.append(link);
    link.click();
    link.remove();
  };

  return (
    <div data-evidence-document={evidence.status} className="space-y-3">
      {verified ? (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-surface-sunken px-3.5 py-2.5 text-body">
          <ShieldCheck aria-hidden className="size-4 shrink-0 text-text-secondary" />
          <span className="min-w-0 flex-1 text-pretty">
            Evidence file stored in this document as base64. SHA-256 verified.
            <span className="block truncate font-mono text-label text-text-secondary" title={evidence.sha256 ?? ""}>
              {evidence.mediaType} · {formatFileSize(evidence.size ?? 0)} · {evidence.sha256}
            </span>
          </span>
          <Button size="sm" variant="outline" className="max-sm:h-10" disabled={!url} onClick={download}>
            <Download aria-hidden className="size-3.5" />
            Download
          </Button>
        </div>
      ) : (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-xl border border-[var(--status-task-blocked)]/40 bg-[var(--status-task-blocked)]/10 px-3.5 py-2.5 text-body"
        >
          <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span className="min-w-0 flex-1 text-pretty [overflow-wrap:anywhere]">
            Not verified. This document says it holds a {evidence.declaredMediaType} file, but the check failed. {evidence.problem}
          </span>
        </div>
      )}

      {verified && error ? <p className="text-body text-text-secondary">{error}</p> : null}
      {verified && url ? (
        kind === "images" ? (
          <img src={url} alt={name} className="mx-auto max-h-[75vh] max-w-full rounded-lg border border-border object-contain" />
        ) : kind === "videos" ? (
          <video controls preload="metadata" src={url} className="w-full rounded-lg border border-border bg-surface-sunken">
            {evidence.filename}
          </video>
        ) : kind === "pdfs" ? (
          <iframe title={name} src={url} className="min-h-[70vh] w-full rounded-lg border border-border bg-surface-raised" />
        ) : null
      ) : null}

      <details className="rounded-lg border border-border">
        <summary className="focus-ring cursor-pointer rounded-lg px-3 py-2 text-label text-text-secondary">
          Raw document text ({formatFileSize(new TextEncoder().encode(body).byteLength)})
        </summary>
        <pre className="max-h-80 overflow-auto whitespace-pre-wrap px-3 pb-3 font-mono text-label text-text-secondary [overflow-wrap:anywhere]">
          {body}
        </pre>
      </details>
    </div>
  );
}
