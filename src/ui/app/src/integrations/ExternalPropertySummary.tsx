/**
 * A task's linked issues or pull requests in its properties: one chip per link with the
 * shortest key that is still unambiguous, at most four and then "+N more", and a `+` to link
 * another. On the phone (`compact`) it is one counted pill per kind beside the other chips.
 */
import { Plus } from "lucide-react";
import type { IssueDetail } from "@/lib/types";
import { openLinkExternal } from "@/lib/shell-events";
import { cn } from "@/lib/utils";
import { openDetailTab } from "@/detail/tabs/registry";
import { requestExternalSection } from "./external-section";
import { leadingTone, linkTone, shortKey, stateLabel } from "./link-state";
import { countLabel, LinkHoverCard, SingleLinkCard } from "./LinkHoverCard";
import { ItemGlyph, LinkGlyph } from "./parts";

const MAX_CHIPS = 4;

/** A 44px target on a finger, around a control drawn smaller (so it opts out of the base layer's 44px floor). */
const HIT = "relative pointer-coarse:min-h-0 pointer-coarse:before:absolute pointer-coarse:before:-inset-y-2.5 pointer-coarse:before:inset-x-0 pointer-coarse:before:content-['']";

export function ExternalPropertySummary({
  detail,
  kind,
  compact = false,
  refresh = () => {},
}: {
  detail: IssueDetail;
  kind: "issue" | "pull_request";
  compact?: boolean;
  refresh?: () => void;
}) {
  const links = (detail.externalLinks ?? []).filter((l) => l.resource.ref.kind === kind);
  const peers = links.map((l) => l.resource);
  const showAll = () => {
    requestExternalSection(kind);
    openDetailTab("external-links");
  };
  const addLabel = kind === "issue" ? "Link issue" : "Link pull request";
  const add = () => openLinkExternal({ workspace: detail.workspace, ref: detail.issue.id, kind });

  if (compact) {
    const PILL =
      "focus-ring inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-border bg-surface-raised px-3 text-[13px] font-medium text-foreground hover:bg-surface-hover pointer-coarse:h-11";
    const word = kind === "issue" ? "issue" : "pull request";
    return (
      <>
        {links.length ? (
          <button type="button" className={PILL} data-link-pill={kind} aria-label={`${countLabel(links.length, kind)}; show External links`} onClick={showAll}>
            <LinkGlyph kind={kind} tone={leadingTone(peers.map(linkTone))} className="size-3.5" />
            {`${links.length} ${word}${links.length === 1 ? "" : "s"}`}
          </button>
        ) : null}
        {links.length ? (
          <button
            type="button"
            className="focus-ring inline-flex size-9 shrink-0 items-center justify-center rounded-full border border-dashed border-border text-muted-foreground hover:bg-surface-hover hover:text-foreground pointer-coarse:size-11"
            aria-label={addLabel}
            onClick={add}
          >
            <Plus aria-hidden className="size-4" />
          </button>
        ) : (
          <button type="button" className={cn(PILL, "border-dashed bg-transparent font-normal text-muted-foreground")} onClick={add}>
            <Plus aria-hidden className="size-3.5" />
            {addLabel}
          </button>
        )}
      </>
    );
  }

  const shown = links.slice(0, MAX_CHIPS);
  const more = links.length - shown.length;
  return (
    <span className="flex min-w-0 max-w-full flex-wrap items-center gap-1.5 py-1 pointer-coarse:gap-y-5 pointer-coarse:py-2" data-link-chips={kind}>
      <span className="sr-only">{countLabel(links.length, kind)}</span>
      {links.length === 0 ? <span className="text-body text-text-tertiary">None</span> : null}
      {shown.map((link) => {
        const item = link.resource;
        const state = stateLabel(item);
        return (
          <LinkHoverCard
            key={link.id}
            data-link-chip={item.id}
            aria-label={[item.key, item.title, state].filter(Boolean).join(", ")}
            cardLabel={item.key}
            className={cn(
              "focus-ring inline-flex h-6 min-w-0 items-center gap-1 rounded-md border px-1.5 text-label tabular-nums text-foreground hover:bg-[var(--surface-hover)] data-[state=open]:bg-[var(--surface-selected)]",
              HIT,
            )}
            card={(close) => (
              <SingleLinkCard
                link={link}
                workspace={detail.workspace}
                issueId={detail.issue.id}
                refresh={refresh}
                onShowAll={() => {
                  close();
                  showAll();
                }}
              />
            )}
          >
            <ItemGlyph item={item} className="size-3.5" />
            <span data-link-key="">{shortKey(item, peers)}</span>
          </LinkHoverCard>
        );
      })}
      {more > 0 ? (
        <button
          type="button"
          className={cn("focus-ring inline-flex h-6 items-center rounded-md px-1 text-label text-muted-foreground hover:text-foreground hover:underline", HIT)}
          onClick={showAll}
        >
          +{more} more
        </button>
      ) : null}
      <button
        type="button"
        className={cn(
          "focus-ring inline-flex size-6 shrink-0 items-center justify-center rounded-md border border-dashed text-muted-foreground hover:bg-[var(--surface-hover)] hover:text-foreground",
          HIT,
          "pointer-coarse:before:-inset-x-2.5",
        )}
        aria-label={addLabel}
        onClick={add}
      >
        <Plus aria-hidden className="size-3.5" />
      </button>
    </span>
  );
}
