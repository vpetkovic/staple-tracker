/**
 * The small shared pieces every integration surface draws with: the state glyph, the state
 * pill, the provider mark and the connection status pill. Colour is never the only signal:
 * each glyph has its own shape per state and each pill carries its word.
 *
 * Hues are the app's existing status tokens, nothing new: `.status-chip` with `--sc`
 * (geist-tokens.css) for pills, `--status-task-icon-*` for glyphs.
 */
import { CircleCheck, CircleDot, GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ConnectionHealthSnapshot } from "../../../../core/integrations/contracts";
import { connectionStatus, type StatusTone } from "./connection-status";
import { linkTone, stateLabel, type LinkTone } from "./link-state";
import type { SourceItem } from "./model";

const TONE_STATUS: Record<LinkTone, string> = {
  open: "done",
  done: "done",
  merged: "in_review",
  active: "in_progress",
  closed: "cancelled",
  draft: "backlog",
  neutral: "backlog",
};

function glyphFor(kind: "issue" | "pull_request", tone: LinkTone): LucideIcon {
  if (kind === "issue") return tone === "closed" || tone === "done" ? CircleCheck : CircleDot;
  if (tone === "merged") return GitMerge;
  if (tone === "closed") return GitPullRequestClosed;
  if (tone === "draft") return GitPullRequestDraft;
  return GitPullRequest;
}

/** The issue or pull request icon, shaped and coloured by state. Decorative: pair it with text. */
export function LinkGlyph({ kind, tone, className }: { kind: "issue" | "pull_request"; tone: LinkTone; className?: string }) {
  const Icon = glyphFor(kind, tone);
  const coloured = tone !== "closed" && tone !== "draft" && tone !== "neutral";
  return (
    <Icon
      aria-hidden
      data-link-tone={tone}
      className={cn("size-4 shrink-0", !coloured && "text-text-tertiary", className)}
      style={coloured ? { color: `var(--status-task-icon-${TONE_STATUS[tone]})` } : undefined}
    />
  );
}

/** The glyph for a source item, when the caller has the item rather than a tone. */
export function ItemGlyph({ item, className }: { item: SourceItem; className?: string }) {
  return <LinkGlyph kind={item.ref.kind} tone={linkTone(item)} className={className} />;
}

const PILL = "status-chip inline-flex h-5 shrink-0 items-center gap-1 rounded-full border px-2 text-caption leading-none font-medium whitespace-nowrap";

/** The provider's own state word in the state's hue. Renders nothing when no state was read. */
export function LinkStatePill({ item, className }: { item: SourceItem; className?: string }) {
  const label = stateLabel(item);
  if (!label) return null;
  const tone = linkTone(item);
  return (
    <span data-link-state={tone} className={cn(PILL, className)} style={{ "--sc": `var(--status-task-${TONE_STATUS[tone]})` } as React.CSSProperties}>
      {label}
    </span>
  );
}

const STATUS_HUE: Record<StatusTone, string> = { ok: "done", warn: "todo", bad: "blocked", idle: "backlog" };

/** "Connected", "Sign-in needed", "Rate limited · 4 min": a dot, a word, the tone. */
export function ConnectionStatusPill({ health, now, className }: { health: ConnectionHealthSnapshot | null; now?: number; className?: string }) {
  const status = connectionStatus(health, now);
  return (
    <span
      role="status"
      data-connection-state={health?.state ?? "unknown"}
      className={cn(PILL, className)}
      style={{ "--sc": `var(--status-task-${STATUS_HUE[status.tone]})` } as React.CSSProperties}
    >
      <span aria-hidden className="size-1.5 rounded-full bg-current" />
      {status.label}
    </span>
  );
}

/** A 6px dot in a connection's tone, for places with no room for the word (the word goes in `title`). */
export function ConnectionDot({ health, className }: { health: ConnectionHealthSnapshot | null; className?: string }) {
  const status = connectionStatus(health);
  return (
    <span
      aria-hidden
      title={status.label}
      className={cn("inline-block size-1.5 shrink-0 rounded-full", className)}
      style={{ backgroundColor: `var(--status-task-${STATUS_HUE[status.tone]})` }}
    />
  );
}

/**
 * The provider's mark at text size, in the current colour. GitHub's is its published mark;
 * any other provider gets a neutral lettered tile until it has one.
 */
export function ProviderMark({ providerId, className }: { providerId: string; className?: string }) {
  if (providerId === "github")
    return (
      <svg aria-hidden viewBox="0 0 16 16" fill="currentColor" data-provider="github" className={cn("size-3.5 shrink-0", className)}>
        <path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z" />
      </svg>
    );
  if (providerId === "linear")
    return (
      <svg aria-hidden viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" data-provider="linear" className={cn("size-3.5 shrink-0", className)}>
        <circle cx="8" cy="8" r="7" />
        <path d="M3.2 9.6 6.4 12.8M2.6 6.2l7.2 7.2M4.4 3.6l8 8" />
      </svg>
    );
  return (
    <span aria-hidden data-provider={providerId} className={cn("inline-flex size-3.5 shrink-0 items-center justify-center rounded-[3px] bg-surface-sunken text-[9px] font-semibold uppercase", className)}>
      {providerId.charAt(0)}
    </span>
  );
}

export type KindChoice = "all" | "issue" | "pull_request";
const KIND_CHOICES: Array<{ value: KindChoice; label: string; short?: string }> = [
  { value: "all", label: "All" },
  { value: "issue", label: "Issues" },
  { value: "pull_request", label: "Pull requests", short: "PRs" },
];

/**
 * All / Issues / Pull requests: the one filter the link dialog and the External links tab
 * share. As wide as its words and no taller than a button, so it reads as a filter beside the
 * actions and not as a second tab strip. In a container under 420px "Pull requests" is "PRs"
 * (the full words stay the control's name), which keeps the filter and its neighbours on one row.
 */
export function KindSegments({
  value,
  onChange,
  counts,
  className,
}: {
  value: KindChoice;
  onChange: (value: KindChoice) => void;
  counts?: Record<KindChoice, number>;
  className?: string;
}) {
  return (
    <div role="group" aria-label="Show" className={cn("inline-flex h-7 shrink-0 rounded-md border p-px pointer-coarse:h-11", className)}>
      {KIND_CHOICES.map((choice) => (
        <button
          key={choice.value}
          type="button"
          aria-pressed={value === choice.value}
          aria-label={counts ? `${choice.label}, ${counts[choice.value]}` : choice.label}
          onClick={() => onChange(choice.value)}
          // On touch the segment fills the 44px box less its border; the 2px either side are added back as hit area.
          className="focus-ring-inset relative inline-flex items-center gap-1.5 rounded-[5px] px-2 text-label whitespace-nowrap text-muted-foreground hover:text-foreground aria-pressed:bg-surface-selected aria-pressed:font-medium aria-pressed:text-foreground pointer-coarse:min-h-0 pointer-coarse:min-w-11 pointer-coarse:justify-center pointer-coarse:px-3 pointer-coarse:before:absolute pointer-coarse:before:inset-x-0 pointer-coarse:before:-inset-y-0.5 pointer-coarse:before:content-['']"
        >
          {choice.short ? (
            <>
              <span className="@max-[419px]:hidden">{choice.label}</span>
              <span className="hidden @max-[419px]:inline">{choice.short}</span>
            </>
          ) : (
            choice.label
          )}
          {counts ? <span className="font-normal text-text-tertiary tabular-nums">{counts[choice.value]}</span> : null}
        </button>
      ))}
    </div>
  );
}

/**
 * A provider's description, read as markdown but held to the surrounding body size: its
 * headings are a medium-weight line, not a new level of hierarchy.
 */
export const LINK_PROSE =
  "text-body wrap-anywhere text-muted-foreground [&_p]:m-0 [&_p+p]:mt-1.5 [&_p.font-semibold]:mt-2 [&_p.font-semibold]:text-body [&_p.font-semibold]:font-medium [&_p.font-semibold]:text-foreground [&_ul]:my-1 [&_ol]:my-1 [&>:first-child]:mt-0";
