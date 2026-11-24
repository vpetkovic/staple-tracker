/**
 * The External links tab's list: one group per repository or team, one 40px row per link,
 * pull request stacks as indented rows with connector guides, and the link's detail opened
 * in place under its row. Rows are written through `onWrite`; a failure stays on the row.
 *
 * Layout follows the tab's container, not the window (the tab lives in a drawer): below
 * 520px a row takes two lines and its actions collapse to the ⋯ menu.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { ChevronRight, ExternalLink as ExternalLinkIcon, MoreHorizontal, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Markdown } from "@/lib/markdown";
import { cn } from "@/lib/utils";
import { ConfirmDialog } from "@/settings/form/ConfirmDialog";
import { InlineError } from "@/settings/form/primitives";
import type { ConnectionView } from "./connection-status";
import { containerLabel, providerName, savedAge, shortKey, stateLabel } from "./link-state";
import { countWords, isRefreshable, openLabel, stackIndent } from "./links-view";
import { groupLinks, type ExternalLink } from "./model";
import { ItemGlyph, LinkStatePill, ProviderMark } from "./parts";
import { parentChoices, prStacks, prTreeRows } from "./pr-stacks";

export type WriteLink = (command: Record<string, unknown>) => Promise<void>;

const AMBER = "text-[var(--status-task-icon-todo)]";
const SHARE_TITLE = "Links always sync. Sharing also sends this title, description and state to everyone in the workspace.";

/** Rows of one group in display order: issues first, then pull requests by stack. */
function groupRows(links: ExternalLink[]) {
  const issues = links
    .filter((l) => l.resource.ref.kind === "issue")
    .map((link) => ({ link, depth: 0, guides: [] as boolean[] }));
  const prs = prStacks(links).flatMap((stack) => prTreeRows(stack.rows));
  return [...issues, ...prs];
}

export function LinkGroups({
  links,
  groupOf,
  connections,
  onWrite,
  now,
}: {
  /** The links to show (already filtered). */
  links: ExternalLink[];
  /** Every link in the same group as this one, for short keys and parent choices. */
  groupOf: (link: ExternalLink) => ExternalLink[];
  connections: readonly ConnectionView[];
  onWrite: WriteLink;
  now: number;
}) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string, next: boolean) =>
    setOpen((held) => {
      const copy = new Set(held);
      if (next) copy.add(id);
      else copy.delete(id);
      return copy;
    });
  return (
    <div className="space-y-4">
      {groupLinks(links).map((group) => {
        const first = group.links[0]!.resource;
        const peers = groupOf(group.links[0]!);
        const rows = groupRows(group.links);
        return (
          <section key={group.key} className="min-w-0 space-y-1">
            <h3 className="flex h-7 min-w-0 items-center gap-2 text-label">
              <ProviderMark providerId={first.ref.providerId} className="text-muted-foreground" />
              <span className="min-w-0 truncate font-medium text-foreground">{containerLabel(first)}</span>
              {first.ref.providerId !== "github" ? (
                <span className="shrink-0 text-text-tertiary">{providerName(first.ref.providerId)}</span>
              ) : null}
              <span className="ml-auto shrink-0 pl-2 font-normal text-text-tertiary">{countWords(group.links)}</span>
            </h3>
            <ul className="overflow-hidden rounded-[10px] border bg-surface-raised [--step:12px] @min-[520px]:[--step:18px]">
              {rows.map((row, index) => (
                <LinkRow
                  key={row.link.id}
                  link={row.link}
                  peers={peers}
                  links={peers}
                  depth={row.depth}
                  guides={row.guides}
                  hasChildren={(rows[index + 1]?.depth ?? 0) > row.depth}
                  refreshable={isRefreshable(row.link, connections)}
                  open={open.has(row.link.id)}
                  onOpenChange={(next) => toggle(row.link.id, next)}
                  onWrite={onWrite}
                  now={now}
                />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

/** Three placeholder rows in the list frame while the first read is under way. */
export function LinkSkeleton() {
  return (
    <ul aria-hidden className="overflow-hidden rounded-[10px] border bg-surface-raised">
      {[62, 48, 55].map((width) => (
        <li key={width} className="flex h-10 items-center gap-2 border-t px-2 first:border-t-0">
          <span className="w-4" />
          <Skeleton className="ml-1.5 size-4 rounded-full" />
          <Skeleton className="h-3 rounded" style={{ width: `${width}%` }} />
        </li>
      ))}
    </ul>
  );
}

/*
 * Guide geometry. The chevrons hold one column; the tree is drawn from the glyphs. A glyph
 * sits at 30px + indent × step and its centre at 38px + indent × step, so the line under a
 * parent at indent n runs at x(n) and a child's elbow turns from x(n) into its own glyph.
 * --gy is the vertical centre of the row's first line.
 */
const x = (level: number) => `calc(38px + var(--step) * ${level})`;

export function LinkRow({
  link,
  peers,
  links,
  depth,
  guides,
  hasChildren,
  refreshable,
  open,
  onOpenChange,
  onWrite,
  now,
}: {
  link: ExternalLink;
  peers: readonly ExternalLink[];
  /** The links in this group: where "Stacked on" chooses from. */
  links: ExternalLink[];
  depth: number;
  guides: boolean[];
  hasChildren: boolean;
  refreshable: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onWrite: WriteLink;
  now: number;
}) {
  const r = link.resource;
  const detailId = useId();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const indent = stackIndent(depth);
  const key = shortKey(r, peers.map((p) => p.resource));
  const title = r.title ?? r.key;
  const age = savedAge(r, now);
  const open_ = openLabel(r.ref.providerId);
  const provider = providerName(r.ref.providerId);

  async function run(action: string, command: Record<string, unknown>) {
    setBusy(action);
    setError(null);
    try {
      await onWrite(command);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      onOpenChange(true);
    } finally {
      setBusy(null);
    }
  }
  const refresh = () => void run("refresh", { action: "refresh", resourceId: r.id });
  const share = (enabled: boolean) => void run("share", { action: "share", resourceId: r.id, enabled });
  const unlink = () => {
    setConfirming(false);
    void run("unlink", { action: "unlink", ref: link.issueId, resourceId: r.id });
  };

  const last = guides.length - 1;
  return (
    <li
      data-external-resource={r.id}
      {...(r.ref.kind === "pull_request" ? { "data-pr-depth": depth, "data-indent": indent } : {})}
      className="relative min-w-0 border-t first:border-t-0 [--gy:18px] @min-[520px]:[--gy:20px] @min-[520px]:pointer-coarse:[--gy:22px]"
    >
      {guides.map((continues, level) =>
        continues ? (
          <span key={level} aria-hidden className="pointer-events-none absolute -top-px bottom-0 w-px bg-border-strong" style={{ left: x(level) }} />
        ) : null,
      )}
      {depth > 0 ? (
        <span
          aria-hidden
          data-guide="elbow"
          className="pointer-events-none absolute -top-px rounded-bl-[5px] border-b border-l border-border-strong"
          style={{ left: x(last), height: "calc(var(--gy) + 1px)", width: "calc(var(--step) - 8px)" }}
        />
      ) : null}
      {hasChildren ? (
        <span
          aria-hidden
          className="pointer-events-none absolute bottom-0 w-px bg-border-strong"
          style={{ left: x(Math.min(depth, 2)), top: depth < 3 ? "calc(var(--gy) + 9px)" : "var(--gy)" }}
        />
      ) : null}
      <div
        data-open={open}
        className="group/row flex min-w-0 items-stretch hover:bg-surface-hover"
      >
        <button
          type="button"
          aria-expanded={open}
          aria-controls={detailId}
          onClick={() => onOpenChange(!open)}
          className="focus-ring-inset flex min-w-0 flex-1 flex-col justify-center py-2 pl-2 text-left @min-[520px]:h-10 @min-[520px]:pr-2 @min-[520px]:py-0 @min-[520px]:pointer-coarse:h-11"
        >
          <span className="flex h-5 min-w-0 items-center">
            <ChevronRight
              aria-hidden
              className={cn("size-3.5 w-4 shrink-0 text-text-tertiary transition-transform", open && "rotate-90")}
            />
            <span aria-hidden className="shrink-0" style={{ width: `calc(6px + var(--step) * ${indent})` }} />
            <ItemGlyph item={r} />
            <span title={title} className="ml-2 min-w-0 flex-1 truncate text-body">
              {title}
            </span>
            <span className="hidden max-w-32 shrink-0 truncate pl-2 text-label text-text-tertiary tabular-nums @min-[520px]:inline">
              {key}
            </span>
            <span className="hidden w-[88px] shrink-0 pl-3 @min-[520px]:flex">
              <LinkStatePill item={r} className="max-w-full overflow-hidden text-ellipsis" />
            </span>
            <span className="hidden w-14 shrink-0 text-right @min-[520px]:block">
              <Age age={age} />
            </span>
          </span>
          <span
            className="mt-0.5 flex h-4 min-w-0 items-center gap-1.5 text-label text-text-tertiary tabular-nums @min-[520px]:hidden"
            style={{ paddingLeft: `calc(46px + var(--step) * ${indent})` }}
          >
            <span className="min-w-0 truncate">{key}</span>
            {stateLabel(r) ? (
              <>
                <span aria-hidden>·</span>
                <LinkStatePill
                  item={r}
                  className="h-auto border-0! bg-transparent! px-0 text-label font-normal"
                />
              </>
            ) : null}
            <span aria-hidden>·</span>
            <Age age={age} />
          </span>
        </button>
        <span
          className="flex w-11 shrink-0 items-center justify-end @min-[520px]:pointer-fine:w-[88px] @min-[520px]:pointer-fine:gap-1 @min-[520px]:pointer-fine:pr-2"
        >
          {refreshable ? (
            <RowIcon label={`Refresh ${r.key}`} onClick={refresh} disabled={busy !== null}>
              <RefreshCw aria-hidden className={cn("size-3.5", busy === "refresh" && "animate-spin")} />
            </RowIcon>
          ) : null}
          <a
            href={r.url}
            target="_blank"
            rel="noreferrer"
            aria-label={`Open ${r.key} ${open_.slice("Open ".length)}`}
            title={open_}
            className={cn(ROW_ICON, REVEAL, "hidden @min-[520px]:pointer-fine:inline-flex")}
          >
            <ExternalLinkIcon aria-hidden className="size-3.5" />
          </a>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={`More actions for ${r.key}`}
                className={cn(
                  "focus-ring-inset inline-flex size-11 items-center justify-center rounded-md text-muted-foreground hover:bg-surface-hover hover:text-foreground",
                  "@min-[520px]:pointer-fine:size-6",
                  REVEAL,
                )}
              >
                <MoreHorizontal aria-hidden className="size-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-56">
              {refreshable ? (
                <DropdownMenuItem disabled={busy !== null} onSelect={refresh}>
                  <RefreshCw aria-hidden />
                  Refresh
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem asChild>
                <a href={r.url} target="_blank" rel="noreferrer">
                  <ExternalLinkIcon aria-hidden />
                  {open_}
                </a>
              </DropdownMenuItem>
              <DropdownMenuCheckboxItem
                checked={r.contextShared}
                disabled={busy !== null}
                onCheckedChange={(checked) => share(checked === true)}
                title={SHARE_TITLE}
              >
                Share saved copy with workspace
              </DropdownMenuCheckboxItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" disabled={busy !== null} onSelect={() => setConfirming(true)}>
                Unlink
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
      </div>
      {open ? (
        <div
          id={detailId}
          className="pr-3 pb-3"
          style={{ paddingLeft: `calc(54px + var(--step) * ${indent})` }}
        >
          {error ? (
            <div className="mb-2">
              <InlineError>{error}</InlineError>
            </div>
          ) : null}
          <div className="grid min-w-0 gap-x-6 gap-y-3 @min-[640px]:grid-cols-[minmax(0,1fr)_260px]">
            <Description link={link} />
            <dl className="min-w-0 space-y-1 text-label">
              {r.ref.kind === "pull_request" ? (
                <Fact label="Stacked on">
                  <StackedOn
                    link={link}
                    links={links}
                    peers={peers}
                    disabled={busy !== null}
                    onSave={(parentResourceId) =>
                      run("stack", {
                        action: "stack",
                        ref: link.issueId,
                        resourceId: r.id,
                        parentResourceId,
                        position: link.position,
                      })
                    }
                  />
                </Fact>
              ) : null}
              <Fact label="Share saved copy with workspace" title={SHARE_TITLE}>
                <Switch checked={r.contextShared} disabled={busy !== null} title={SHARE_TITLE} onChange={share} label="Share saved copy with workspace" />
              </Fact>
              <Fact label="Saved copy">
                {age ? (
                  <span className={cn(age.stale && AMBER)}>{age.sentence.replace(/^Saved copy from /, "")}</span>
                ) : (
                  <span className="text-text-tertiary">Not read yet</span>
                )}
              </Fact>
            </dl>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={busy !== null}
              className="text-destructive pointer-coarse:h-11 pointer-coarse:px-3"
              onClick={() => setConfirming(true)}
            >
              Unlink
            </Button>
            <Button asChild size="xs" variant="outline" className="pointer-coarse:h-11 pointer-coarse:px-3">
              <a href={r.url} target="_blank" rel="noreferrer">
                <ExternalLinkIcon aria-hidden />
                {open_}
              </a>
            </Button>
          </div>
        </div>
      ) : null}
      {confirming ? (
        <ConfirmDialog
          open
          title={`Unlink ${r.key}?`}
          description={`It stays on ${provider}. This task stops showing it here.`}
          confirmLabel="Unlink"
          destructive
          onConfirm={unlink}
          onCancel={() => setConfirming(false)}
        />
      ) : null}
    </li>
  );
}

/**
 * Hidden at rest where a fine pointer can hover; shown on row hover, on focus inside the row
 * and while the row is open. Always shown on touch and in the narrow layout.
 */
const REVEAL =
  "@min-[520px]:pointer-fine:opacity-0 @min-[520px]:pointer-fine:group-hover/row:opacity-100 @min-[520px]:pointer-fine:group-focus-within/row:opacity-100 @min-[520px]:pointer-fine:group-data-[open=true]/row:opacity-100";
const ROW_ICON =
  "focus-ring-inset size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-surface-hover hover:text-foreground disabled:pointer-events-none";

function RowIcon({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(ROW_ICON, REVEAL, "hidden @min-[520px]:pointer-fine:inline-flex")}
    >
      {children}
    </button>
  );
}

function Age({ age }: { age: ReturnType<typeof savedAge> }) {
  if (!age)
    return (
      <span data-saved-age="none" title="Not read yet" className="text-label text-text-tertiary">
        —
      </span>
    );
  return (
    <span
      data-saved-age={age.stale ? "stale" : "fresh"}
      title={age.sentence}
      className={cn("text-label tabular-nums", age.stale ? AMBER : "text-text-tertiary")}
    >
      {age.short}
    </span>
  );
}

function Fact({ label, title, children }: { label: string; title?: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-7 items-center justify-between gap-3 pointer-coarse:min-h-11">
      <dt title={title} className="min-w-0 text-muted-foreground">
        {label}
      </dt>
      <dd className="flex min-w-0 shrink-0 justify-end">{children}</dd>
    </div>
  );
}

function Description({ link }: { link: ExternalLink }) {
  const body = link.resource.body?.trim();
  const ref = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState(false);
  const [long, setLong] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || more) return;
    const measure = () => setLong(el.scrollHeight > el.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [body, more]);
  if (!link.resource.fetchedAt)
    return <p className="text-body text-text-tertiary">Not read yet. Refresh to load it.</p>;
  if (!body) return <p className="text-body text-text-tertiary">No description</p>;
  return (
    <div className="min-w-0">
      {/* The provider's markdown, read as markdown and held to about six lines until asked for. */}
      <div
        ref={ref}
        className={cn(
          "text-body wrap-anywhere text-muted-foreground [&_p]:m-0 [&_p+p]:mt-1.5 [&_p.font-semibold]:mt-2 [&_p.font-semibold]:text-body [&_p.font-semibold]:font-medium [&_p.font-semibold]:text-foreground [&_ul]:my-1 [&_ol]:my-1 [&>:first-child]:mt-0",
          !more && "max-h-[7.5rem] overflow-hidden",
          !more && long && "[mask-image:linear-gradient(to_bottom,black_60%,transparent)]",
        )}
      >
        <Markdown text={body} />
      </div>
      {long || more ? (
        <button
          type="button"
          onClick={() => setMore(!more)}
          className="focus-ring mt-1 rounded text-label text-foreground hover:underline pointer-coarse:min-h-11"
        >
          {more ? "Show less" : "Show more"}
        </button>
      ) : null}
    </div>
  );
}

const NOTHING = "none";

function StackedOn({
  link,
  links,
  peers,
  disabled,
  onSave,
}: {
  link: ExternalLink;
  links: ExternalLink[];
  peers: readonly ExternalLink[];
  disabled: boolean;
  onSave: (parentResourceId: string | null) => Promise<void>;
}) {
  const [value, setValue] = useState(link.parentResourceId ?? NOTHING);
  useEffect(() => setValue(link.parentResourceId ?? NOTHING), [link.parentResourceId]);
  const choices = parentChoices(link, links);
  const items = peers.map((p) => p.resource);
  const label = (l: ExternalLink) => `${shortKey(l.resource, items)} · ${l.resource.title ?? "Pull request"}`;
  const current = choices.find((l) => l.resource.id === value);
  const unknown = value !== NOTHING && !current;
  return (
    <Select
      value={value}
      disabled={disabled}
      onValueChange={(next) => {
        setValue(next);
        void onSave(next === NOTHING ? null : next);
      }}
    >
      <SelectTrigger
        size="sm"
        aria-label={`Stacked on, for ${link.resource.key}`}
        className="h-7 max-w-44 gap-1 px-2 text-label md:text-label pointer-coarse:h-11"
      >
        <SelectValue>
          <span className="truncate">{current ? label(current) : unknown ? "Parent not linked here" : "Nothing"}</span>
        </SelectValue>
      </SelectTrigger>
      <SelectContent position="popper" align="end" className="max-w-[min(22rem,calc(100vw-2rem))]">
        <SelectItem value={NOTHING}>Nothing</SelectItem>
        {unknown ? (
          <SelectItem value={value} disabled>
            Parent not linked here
          </SelectItem>
        ) : null}
        {choices.map((l) => (
          <SelectItem key={l.id} value={l.resource.id} className="*:[span]:last:min-w-0">
            <span className="truncate">{label(l)}</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** An on/off switch drawn as a track and thumb, for a choice that saves as soon as it flips. */
function Switch({
  checked,
  disabled,
  title,
  label,
  onChange,
}: {
  checked: boolean;
  disabled: boolean;
  title: string;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={title}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "focus-ring relative inline-flex h-4 min-h-0 w-7 shrink-0 items-center rounded-full transition-colors disabled:opacity-50",
        "pointer-coarse:before:absolute pointer-coarse:before:-inset-3.5 pointer-coarse:before:content-['']",
        checked ? "bg-primary" : "bg-border-strong",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "inline-block size-3 rounded-full bg-background shadow-sm transition-transform",
          checked ? "translate-x-3.5" : "translate-x-0.5",
        )}
      />
    </button>
  );
}
