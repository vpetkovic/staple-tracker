/**
 * What a linked issue or pull request is, one hover, focus or tap away: the detail chips show
 * one link (`SingleLinkCard`), a task row's badge lists that row's links (`LinkListCard`).
 * The card never triggers the row or panel behind it (useHoverCard stops its events).
 */
import { useState, type ComponentProps, type ReactNode } from "react";
import { ExternalLink as ExternalLinkIcon } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { integrationWrite } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { ExternalLinkPreview } from "../../../../core/integrations/link-store";
import { containerLabel, linkTone, providerName, savedAge, shortKey, type LinkTone } from "./link-state";
import type { ExternalLink, SourceItem } from "./model";
import { LinkGlyph, LinkStatePill, ProviderMark } from "./parts";
import { useHoverCard } from "./useHoverCard";

export function LinkHoverCard({
  cardLabel,
  align = "start",
  card,
  className,
  children,
  ...button
}: Omit<ComponentProps<"button">, "ref" | "onClick" | "onFocus" | "onBlur" | "onKeyDown" | "onPointerDown" | "onPointerEnter" | "onPointerLeave"> & {
  /** The card's accessible name. */
  cardLabel: string;
  align?: "start" | "end";
  card: (close: () => void) => ReactNode;
}) {
  const { open, setOpen, triggerProps, contentProps } = useHoverCard();
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className={className} {...button} {...triggerProps}>
          {children}
        </button>
      </PopoverTrigger>
      <PopoverContent
        aria-label={cardLabel}
        align={align}
        collisionPadding={8}
        className="w-[340px] max-w-[calc(100vw-16px)] p-3"
        {...contentProps}
      >
        {card(() => setOpen(false))}
      </PopoverContent>
    </Popover>
  );
}

const ACTION =
  "focus-ring relative inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-label text-foreground hover:bg-[var(--surface-hover)] disabled:pointer-events-none disabled:opacity-50 pointer-coarse:h-11";

/** One link: where it lives, what it is called, its state, how old our copy is, and what to do with it. */
export function SingleLinkCard({
  link,
  workspace,
  issueId,
  refresh,
  onShowAll,
}: {
  link: ExternalLink;
  workspace: string;
  issueId: string;
  refresh: () => void;
  onShowAll: () => void;
}) {
  const item = link.resource;
  const age = savedAge(item);
  const provider = providerName(item.ref.providerId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const unlink = async () => {
    setBusy(true);
    setError(null);
    try {
      await integrationWrite({ action: "unlink", ref: issueId, resourceId: item.id }, workspace);
      refresh();
    } catch (caught) {
      setError(`Could not unlink: ${caught instanceof Error ? caught.message : String(caught)}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-2" data-link-card="single">
      <p className="m-0 flex min-w-0 items-center gap-1.5 text-label text-text-tertiary">
        <ProviderMark providerId={item.ref.providerId} />
        <span className="min-w-0 truncate">{containerLabel(item)}</span>
        <span aria-hidden>·</span>
        <span className="shrink-0 tabular-nums">{shortKey(item, [item])}</span>
      </p>
      <p className="m-0 line-clamp-3 text-body font-medium text-foreground wrap-anywhere">{item.title || item.key}</p>
      <p className="m-0 flex flex-wrap items-center gap-x-2 gap-y-1 text-label text-text-tertiary">
        <LinkStatePill item={item} />
        <span style={age?.stale ? { color: "var(--status-task-icon-todo)" } : undefined}>
          {age ? age.sentence : "Linked by URL, not read yet"}
        </span>
      </p>
      {error ? (
        <p role="alert" className="m-0 text-label text-[var(--plain-risk-fg)] wrap-anywhere">
          {error}
        </p>
      ) : null}
      <div className="-mx-3 border-t" />
      <div className="-mx-1.5 -mb-1 flex flex-wrap items-center gap-x-1">
        <a href={item.url} target="_blank" rel="noreferrer noopener" className={ACTION}>
          {item.ref.providerId === "github" ? "Open on GitHub" : `Open in ${provider}`}
          <ExternalLinkIcon aria-hidden className="size-3 text-text-tertiary" />
        </a>
        <button type="button" className={ACTION} onClick={onShowAll}>
          Show in External links
        </button>
        <button type="button" className={cn(ACTION, "ml-auto text-muted-foreground")} disabled={busy} onClick={() => void unlink()}>
          {busy ? "Unlinking…" : "Unlink"}
        </button>
      </div>
    </div>
  );
}

/**
 * A row summary's preview as a source item, for the shared key and tone rules. A preview from an
 * older server has no `status`; it reads as no state.
 */
function previewItem(item: ExternalLinkPreview, kind: "issue" | "pull_request"): SourceItem {
  const status = item.status ?? null;
  return {
    ref: { providerId: item.providerId, host: item.host, scopeId: "", containerId: item.containerId, id: item.id, kind },
    key: item.key,
    url: item.url,
    title: item.title,
    status,
  } as unknown as SourceItem;
}

export function previewTones(items: readonly ExternalLinkPreview[], kind: "issue" | "pull_request"): LinkTone[] {
  return items.map((item) => linkTone(previewItem(item, kind)));
}

export function countLabel(count: number, kind: "issue" | "pull_request"): string {
  const noun = kind === "issue" ? "linked issue" : "pull request";
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** A row's links of one kind: a line each, and the way to all of them. */
export function LinkListCard({
  kind,
  count,
  items,
  onShowAll,
}: {
  kind: "issue" | "pull_request";
  count: number;
  items: readonly ExternalLinkPreview[];
  onShowAll: () => void;
}) {
  const sources = items.map((item) => previewItem(item, kind));
  const tones = previewTones(items, kind);
  return (
    <div className="flex flex-col" data-link-card="list">
      <p className="m-0 mb-1 text-label font-medium text-foreground">{countLabel(count, kind)}</p>
      <ul className="m-0 -mx-1.5 list-none p-0">
        {sources.map((source, index) => (
          <li key={items[index]!.id}>
            <a
              data-link-row=""
              href={source.url}
              target="_blank"
              rel="noreferrer noopener"
              className="focus-ring flex h-7 min-w-0 items-center gap-2 rounded-md px-1.5 text-label text-foreground hover:bg-[var(--surface-hover)] pointer-coarse:h-11"
            >
              <LinkGlyph kind={kind} tone={tones[index]!} className="size-3.5" />
              <span className="min-w-0 flex-1 truncate">{items[index]!.title || source.key}</span>
              <span className="shrink-0 text-text-tertiary tabular-nums">{shortKey(source, sources)}</span>
            </a>
          </li>
        ))}
      </ul>
      <div className="-mx-3 mt-1 border-t" />
      <button
        type="button"
        className="focus-ring -mx-1.5 -mb-1 mt-1 flex h-7 items-center rounded-md px-1.5 text-left text-label text-muted-foreground hover:bg-[var(--surface-hover)] hover:text-foreground pointer-coarse:h-11"
        onClick={onShowAll}
      >
        Show all {count} in External links
      </button>
    </div>
  );
}
