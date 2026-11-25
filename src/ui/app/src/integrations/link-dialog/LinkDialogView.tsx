/**
 * The link dialog's body, drawn from state it is handed: header (the target task), the
 * search field, the filter row, results and preview, footer. No requests here, so every
 * state renders in a test. `LinkExternalPicker.tsx` owns the state and the requests.
 *
 * Layout: the root is a size container. At 720px and wider results and preview sit side by
 * side; narrower, the preview is a second page with a back button in the header's place.
 */
import { useEffect, useId, type ReactNode, type RefObject } from "react";
import { ArrowLeft, Check, ChevronDown, ExternalLink, Loader2, Search, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { SelectOption } from "@/components/ui/searchable-select";
import { Markdown } from "@/lib/markdown";
import { cn } from "@/lib/utils";
import type { Issue } from "@/lib/types";
import type { ConnectionView } from "../connection-status";
import { providerName, shortKey } from "../link-state";
import { ConnectionDot, ItemGlyph, KindSegments, LINK_PROSE, LinkStatePill, ProviderMark } from "../parts";
import { resourceKey, type MappingTarget, type SearchFailure, type SearchHit, type SearchScope } from "../model";
import type { KindFilter } from "./last-kind";
import { failureLine, freshnessLine, linkTag, scopeLabel, scopeNote, sourceName, type ResultGroup } from "./logic";
import { TargetPicker } from "./TargetPicker";

export interface CreateState {
  key: string;
  phase: "checking" | "candidates" | "creating";
  candidates: Array<{ issue: Issue; reasons: string[] }>;
  truncated: boolean;
}

export interface LinkDialogState {
  /** The workspace the dialog speaks of: the target's, else the one searched. */
  workspace: string;
  target: Pick<Issue, "id" | "identifier" | "title" | "status"> | null;
  targetOptions: SelectOption[];
  /** Set on All workspaces with no workspace known: the picker asks for one first. */
  workspaceChoices: string[] | null;
  text: string;
  kind: KindFilter;
  /** The scope the server used, or before the first answer the one the mapping implies. */
  scope: SearchScope | null;
  containerKey: string | null;
  /** Connections that serve a target in scope. */
  connections: ConnectionView[];
  failures: SearchFailure[];
  /** Null until the first answer. */
  groups: ResultGroup[] | null;
  pasted: boolean;
  searching: boolean;
  searchError: string | null;
  hasMore: boolean;
  selected: string | null;
  page: "results" | "preview";
  linkedHere: ReadonlySet<string>;
  /** Keys whose link to the target can be undone (its resource id is known). */
  undoable: ReadonlySet<string>;
  linking: string | null;
  previewError: string | null;
  outside: MappingTarget | null;
  create: CreateState | null;
  linkedCount: number;
  isMac: boolean;
  /** The list on screen answers an older query than the field holds: it can be read, not acted on. */
  stale: boolean;
  /** There is a workspace to create a task in. */
  canCreate: boolean;
}

export interface LinkDialogActions {
  onText: (text: string) => void;
  onKey: (event: React.KeyboardEvent<HTMLInputElement>) => void;
  onKind: (kind: KindFilter) => void;
  onContainer: (key: string | null) => void;
  onSelect: (key: string) => void;
  onOpen: (key: string) => void;
  onBack: () => void;
  onLink: (key: string) => void;
  onUndo: (key: string) => void;
  onCreate: (key: string, additional: boolean) => void;
  onCancelCreate: () => void;
  onMap: () => void;
  onMore: () => void;
  onOpenTask: (issue: Issue) => void;
  onSettings: () => void;
  onDone: () => void;
  onWorkspace: (ws: string) => void;
  onTarget: (identifier: string) => void;
}

const EVERYTHING = "__everything__";
const KEY = "inline-flex h-5 min-w-5 items-center justify-center rounded-md border bg-surface-raised px-1 font-sans text-caption text-text-secondary";

const titleOf = (hit: SearchHit) => ("title" in hit.item && hit.item.title) || hit.item.key;

export function LinkDialogView({
  state,
  actions,
  inputRef,
}: {
  state: LinkDialogState;
  actions: LinkDialogActions;
  inputRef?: RefObject<HTMLInputElement | null>;
}) {
  const id = useId();
  const optionId = (key: string) => `${id}-o-${encodeURIComponent(key).replace(/%/g, "")}`;
  const listId = `${id}-list`;
  // With nothing mapped the empty state stands alone: saved copies that matched are not offered.
  const unmapped = state.scope?.mode === "none" && !state.pasted;
  const hits = unmapped ? [] : state.groups?.flatMap((g) => g.hits) ?? [];
  const selectedHit = hits.find((h) => resourceKey(h.item) === state.selected) ?? null;
  const selectedGroup = state.groups?.find((g) => g.hits.includes(selectedHit!)) ?? null;
  const onPreview = state.page === "preview";

  useEffect(() => {
    if (state.selected) document.getElementById(optionId(state.selected))?.scrollIntoView({ block: "nearest" });
    // optionId is derived from `id`, which is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.selected]);

  return (
    <div className="@container flex min-h-0 flex-1 flex-col" data-link-dialog="" data-page={state.page}>
      <header className="flex min-h-12 shrink-0 items-center gap-2 border-b px-3 md:px-4">
        {onPreview ? (
          <Button
            variant="ghost"
            size="sm"
            className={cn("-ml-1.5 pointer-coarse:h-11 max-md:h-11", "@min-[720px]:hidden")}
            onClick={actions.onBack}
          >
            <ArrowLeft aria-hidden />
            Results
          </Button>
        ) : null}
        <div className={cn("flex min-w-0 flex-1 items-center gap-2", onPreview && "hidden @min-[720px]:flex")}>
          <span className="shrink-0 text-label text-muted-foreground">Link to</span>
          <TargetPicker
            target={state.target}
            options={state.targetOptions}
            workspaceChoices={state.workspaceChoices}
            onWorkspace={actions.onWorkspace}
            onChoose={actions.onTarget}
          />
        </div>
      </header>

      <div className={cn("flex h-12 shrink-0 items-center gap-2.5 border-b px-4", onPreview && "hidden @min-[720px]:flex")}>
        <Search aria-hidden className="size-4 shrink-0 text-text-tertiary" />
        <input
          ref={inputRef}
          autoFocus
          type="text"
          role="combobox"
          aria-expanded
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={selectedHit ? optionId(state.selected!) : undefined}
          aria-label="Search issues and pull requests, or paste a link"
          placeholder="Search issues and pull requests, or paste a link"
          autoComplete="off"
          spellCheck={false}
          value={state.text}
          onChange={(e) => actions.onText(e.target.value)}
          onKeyDown={actions.onKey}
          className="h-full min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-text-tertiary max-md:text-base"
        />
        {state.searching ? (
          <Loader2 aria-label="Searching" role="status" className="size-4 shrink-0 animate-spin text-text-tertiary" />
        ) : null}
      </div>

      <div className={cn("flex shrink-0 items-center gap-2 border-b px-3 py-2 md:px-4", onPreview && "hidden @min-[720px]:flex")}>
        <KindSegments value={state.kind} onChange={actions.onKind} />
        <ScopeMenu state={state} actions={actions} />
        {state.connections.length ? (
          <div className="ml-auto hidden shrink-0 items-center gap-3 md:flex" data-connections="">
            {state.connections.map((c) => (
              <span key={c.id} className="inline-flex items-center gap-1.5 text-label text-muted-foreground">
                <ConnectionDot health={c.health} />
                {providerName(c.providerId)}
              </span>
            ))}
          </div>
        ) : null}
      </div>

      <div className="flex min-h-0 flex-1">
        <section
          aria-label="Results"
          className={cn("staple-momentum min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain", "@min-[720px]:flex-none @min-[720px]:basis-[55%]", onPreview && "hidden @min-[720px]:block")}
        >
          <Results state={state} actions={actions} listId={listId} optionId={optionId} />
        </section>
        <aside
          aria-label="Preview"
          className={cn("min-h-0 min-w-0 flex-1 flex-col", "@min-[720px]:border-l", onPreview ? "flex" : "hidden @min-[720px]:flex")}
        >
          {selectedHit ? <Preview state={state} actions={actions} hit={selectedHit} source={selectedGroup} /> : null}
        </aside>
      </div>

      <footer className="flex shrink-0 items-center gap-4 border-t px-4 py-2 max-md:py-3">
        <div className="hidden items-center gap-4 text-caption text-text-tertiary [@media(hover:hover)_and_(pointer:fine)]:md:flex" data-key-hints="">
          <span className="inline-flex items-center gap-1">
            <kbd className={KEY}>↑</kbd>
            <kbd className={KEY}>↓</kbd>
            move
          </span>
          <span className="inline-flex items-center gap-1">
            <kbd className={KEY}>↵</kbd>
            link
          </span>
          <span className="inline-flex items-center gap-1">
            <kbd className={KEY}>{state.isMac ? "⌘" : "Ctrl"}</kbd>
            <kbd className={KEY}>↵</kbd>
            link and close
          </span>
        </div>
        {state.linkedCount > 0 ? (
          <span role="status" className="ml-auto text-label text-muted-foreground max-md:hidden">
            {state.linkedCount} linked
          </span>
        ) : null}
        <Button
          variant="outline"
          size="sm"
          className={cn("max-md:h-11 max-md:w-full pointer-coarse:h-11", state.linkedCount === 0 && "md:ml-auto")}
          onClick={actions.onDone}
        >
          Done
        </Button>
      </footer>
    </div>
  );
}

function ScopeMenu({ state, actions }: { state: LinkDialogState; actions: LinkDialogActions }) {
  const scope = state.scope;
  const label = scope ? scopeLabel(scope, state.workspace) : "Searching…";
  const note = scope ? scopeNote(scope, state.workspace) : null;
  const narrowed = scope?.targets.find((t) => t.key === state.containerKey);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Search scope: ${narrowed ? sourceName(narrowed) : label}`}
          className="focus-ring inline-flex h-7 min-w-0 items-center gap-0 rounded-md px-2 text-label [&>svg]:mr-1.5 [&>svg:last-child]:mr-0 [&>svg:last-child]:ml-1.5 text-muted-foreground hover:bg-surface-hover hover:text-foreground data-[state=open]:bg-surface-hover pointer-coarse:h-11"
        >
          {narrowed ? <ProviderMark providerId={narrowed.providerId} /> : null}
          {narrowed ? (
            <span className="truncate">{sourceName(narrowed)}</span>
          ) : (
            // The count is the part worth keeping: a long workspace name truncates first.
            <>
              <span className="truncate">{label.split(" · ")[0]}</span>
              {label.includes(" · ") ? <span className="shrink-0 whitespace-pre">{` · ${label.split(" · ")[1]}`}</span> : null}
            </>
          )}
          <ChevronDown aria-hidden className="size-3.5 shrink-0 text-text-tertiary" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72 max-w-[calc(100vw-2rem)] pointer-coarse:[&_[role^=menuitem]]:min-h-11">
        {/* A sentence, not a heading: the menu label's capitals and tracking are undone. */}
        {note ? <DropdownMenuLabel className="text-label font-normal tracking-normal text-text-tertiary normal-case">{note}</DropdownMenuLabel> : null}
        {scope && scope.targets.length ? (
          <DropdownMenuRadioGroup
            value={state.containerKey ?? EVERYTHING}
            onValueChange={(value) => actions.onContainer(value === EVERYTHING ? null : value)}
          >
            <DropdownMenuRadioItem value={EVERYTHING}>Everything in scope</DropdownMenuRadioItem>
            {scope.targets.map((t) => (
              <DropdownMenuRadioItem key={t.key} value={t.key} className="min-w-0">
                <ProviderMark providerId={t.providerId} className="text-muted-foreground" />
                <span className="truncate" title={sourceName(t)}>{sourceName(t)}</span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        ) : null}
        {scope && scope.targets.length ? <DropdownMenuSeparator /> : null}
        <DropdownMenuItem onSelect={actions.onSettings}>Choose sources in Settings…</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Results({
  state,
  actions,
  listId,
  optionId,
}: {
  state: LinkDialogState;
  actions: LinkDialogActions;
  listId: string;
  optionId: (key: string) => string;
}) {
  const notices = state.failures.map((f) => (
    <div
      key={`${f.connectionId}:${f.state}`}
      role="status"
      className="flex items-start gap-2 border-b bg-[color-mix(in_oklab,var(--status-task-todo)_9%,transparent)] px-4 py-2 text-label"
    >
      <TriangleAlert aria-hidden className="mt-px size-3.5 shrink-0" style={{ color: "var(--status-task-icon-todo)" }} />
      <span className="min-w-0 flex-1">
        {failureLine(f, state.scope?.targets ?? [])}
        {f.action ? <span className="block text-muted-foreground">{f.action}</span> : null}
      </span>
      <button
        type="button"
        onClick={actions.onSettings}
        className="focus-ring -my-0.5 shrink-0 rounded px-1.5 font-medium hover:bg-surface-hover pointer-coarse:-my-3.5 pointer-coarse:min-h-11 pointer-coarse:min-w-11"
      >
        Fix
      </button>
    </div>
  ));

  if (state.scope?.mode === "none" && !state.pasted) {
    return (
      <>
        {notices}
        <div className="flex h-full flex-col items-center justify-center gap-2 px-6 py-10 text-center">
          <p className="text-body font-medium">Nothing is set up to search yet.</p>
          <p className="max-w-80 text-label text-muted-foreground">
            Choose which repositories, teams or projects each workspace searches. You can still paste a link.
          </p>
          <Button variant="outline" size="sm" className="mt-2 pointer-coarse:h-11" onClick={actions.onSettings}>
            Choose sources
          </Button>
        </div>
      </>
    );
  }

  const heading = state.pasted ? "Matched the pasted link" : state.text.trim() === "" ? "Recently updated" : null;
  return (
    <>
      {notices}
      {state.groups?.length === 0 && (state.outside || state.previewError) ? (
        <div className="p-4">
          <Problem state={state} actions={actions} />
        </div>
      ) : null}
      {state.searchError ? (
        <p role="alert" className="px-4 py-3 text-label text-destructive">
          {state.searchError}
        </p>
      ) : null}
      {state.groups === null ? (
        state.searchError ? null : (
          <div className="space-y-1 p-2" aria-hidden>
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="flex h-11 items-center gap-2.5 px-2.5">
                <Skeleton className="size-4 rounded-full" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-3 w-3/5" />
                  <Skeleton className="h-2.5 w-1/4" />
                </div>
              </div>
            ))}
          </div>
        )
      ) : state.groups.length === 0 ? (
        state.pasted || state.searchError ? null : (
          <div className="px-6 py-10 text-center">
            <p className="text-body">No issue or pull request matches “{state.text.trim()}”.</p>
            <p className="mt-1 text-label text-text-tertiary">Paste its URL to link it directly.</p>
          </div>
        )
      ) : (
        <div className="p-2">
          {heading ? <p className="px-2.5 pt-1 pb-1 text-label font-medium text-muted-foreground">{heading}</p> : null}
          <div role="listbox" id={listId} aria-label="Issues and pull requests" aria-busy={state.stale} className={cn(state.stale && "opacity-60")}>
            {state.groups.map((group) => (
              <div key={group.key} role="group" aria-labelledby={`${listId}-${group.key}`}>
                <div
                  id={`${listId}-${group.key}`}
                  className="flex h-7 items-center gap-1.5 px-2.5 text-label text-text-tertiary"
                >
                  <ProviderMark providerId={group.providerId} />
                  <span className="truncate" title={group.label}>{group.label}</span>
                </div>
                {group.hits.map((hit) => (
                  <Row key={resourceKey(hit.item)} hit={hit} peers={group.hits} state={state} actions={actions} id={optionId(resourceKey(hit.item))} />
                ))}
              </div>
            ))}
          </div>
          {state.hasMore ? (
            <Button variant="ghost" size="sm" className="mt-1 w-full text-muted-foreground pointer-coarse:h-11" disabled={state.searching || state.stale} onClick={actions.onMore}>
              Show more
            </Button>
          ) : null}
        </div>
      )}
    </>
  );
}

function Row({ hit, peers, state, actions, id }: { hit: SearchHit; peers: readonly SearchHit[]; state: LinkDialogState; actions: LinkDialogActions; id: string }) {
  const key = resourceKey(hit.item);
  const selected = key === state.selected;
  const title = titleOf(hit);
  const tag = linkTag(hit.associations, state.target?.id ?? null, state.linkedHere.has(key));
  let end: ReactNode = null;
  if (state.linking === key) end = <span className="text-label text-muted-foreground">Linking…</span>;
  else if (tag?.kind === "here")
    end = (
      <span className="inline-flex items-center gap-1 text-label text-muted-foreground">
        <Check aria-hidden className="size-3.5" style={{ color: "var(--status-task-icon-done)" }} />
        Linked here
      </span>
    );
  else if (tag) end = <span className="truncate text-label text-text-tertiary">{tag.label}</span>;
  else if (selected && state.target)
    end = (
      <button
        type="button"
        tabIndex={-1}
        disabled={state.stale}
        onClick={(e) => {
          e.stopPropagation();
          actions.onLink(key);
        }}
        className="relative inline-flex h-6 items-center gap-1.5 rounded-md border bg-surface-raised pr-1 pl-2 text-label font-medium hover:bg-surface-hover pointer-coarse:pr-2 pointer-coarse:before:absolute pointer-coarse:before:-inset-x-1 pointer-coarse:before:-inset-y-2.5 pointer-coarse:before:content-['']"
      >
        Link
        <kbd className={cn(KEY, "h-4 min-w-4 pointer-coarse:hidden")}>↵</kbd>
      </button>
    );
  return (
    <div
      id={id}
      role="option"
      aria-selected={selected}
      data-result={key}
      onMouseMove={() => {
        if (!selected) actions.onSelect(key);
      }}
      onClick={() => actions.onOpen(key)}
      className="flex h-11 cursor-default items-center gap-2.5 rounded-md px-2.5 hover:bg-surface-hover aria-selected:bg-surface-selected"
    >
      <ItemGlyph item={hit.item} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-body" title={title}>{title}</div>
        {/* Its group's heading already names the repository or team. */}
        <div className="truncate text-caption text-text-tertiary" title={hit.item.key}>{shortKey(hit.item, peers.map((peer) => peer.item))}</div>
      </div>
      {end ? <div className="flex max-w-[45%] shrink-0 items-center">{end}</div> : null}
    </div>
  );
}

function Preview({
  state,
  actions,
  hit,
  source,
}: {
  state: LinkDialogState;
  actions: LinkDialogActions;
  hit: SearchHit;
  source: ResultGroup | null;
}) {
  const key = resourceKey(hit.item);
  const item = hit.item;
  const body = "body" in item ? item.body?.trim() : "";
  const fresh = freshnessLine(item);
  const target = state.target;
  const here = state.linkedHere.has(key);
  const others = hit.associations.filter((a) => a.id !== target?.id);
  const create = state.create?.key === key ? state.create : null;
  const provider = providerName(item.ref.providerId);
  const busy = state.linking === key || create?.phase === "checking" || create?.phase === "creating";
  return (
    <>
      <div className="staple-momentum min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-5 py-4">
        <p className="flex min-w-0 items-center gap-1.5 text-label text-muted-foreground">
          <ProviderMark providerId={item.ref.providerId} />
          <span className="truncate" title={`${source?.label ?? provider} · ${item.key}`}>
            {source?.label ?? provider} · {shortKey(item, [])}
          </span>
        </p>
        <h3 className="line-clamp-3 text-title font-semibold wrap-anywhere">{titleOf(hit)}</h3>
        <div className="flex flex-wrap items-center gap-2">
          <LinkStatePill item={item} />
          <span className={cn("text-label", fresh.stale ? "" : "text-muted-foreground")} style={fresh.stale ? { color: "var(--status-task-icon-todo)" } : undefined}>
            {fresh.text}
          </span>
        </div>
        {"body" in item ? (
          body ? (
            <div className={cn(LINK_PROSE, "max-h-40 overflow-hidden [mask-image:linear-gradient(to_bottom,black_75%,transparent)]")}>
              <Markdown text={body} />
            </div>
          ) : (
            <p className="text-body text-text-tertiary">No description</p>
          )
        ) : null}
        {others.length ? (
          <div className="rounded-lg bg-surface-sunken p-3">
            <p className="mb-1 text-label font-medium text-muted-foreground">Also linked to</p>
            <ul>
              {others.map((issue) => (
                <li key={issue.id}>
                  <TaskButton issue={issue} onOpen={actions.onOpenTask} />
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <Problem state={state} actions={actions} />
      </div>
      {create?.phase === "candidates" ? (
        <div className="max-h-[50%] shrink-0 space-y-2 overflow-y-auto border-t px-5 py-3" role="group" aria-label="Possible duplicates">
          <p className="text-label font-medium">A task for this may already exist:</p>
          <ul>
            {create.candidates.map((c) => (
              <li key={c.issue.id}>
                <TaskButton issue={c.issue} onOpen={actions.onOpenTask} />
              </li>
            ))}
          </ul>
          {create.truncated ? <p className="text-label text-text-tertiary">There may be more.</p> : null}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" className="pointer-coarse:h-11" onClick={() => actions.onCreate(key, true)}>
              Create anyway
            </Button>
            <Button size="sm" variant="ghost" className="pointer-coarse:h-11" onClick={actions.onCancelCreate}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-t px-5 py-3">
          {here ? (
            <>
              <Button size="sm" variant="outline" disabled className="pointer-coarse:h-11 disabled:opacity-100">
                <Check aria-hidden style={{ color: "var(--status-task-icon-done)" }} />
                Linked to {target?.identifier}
              </Button>
              {state.undoable.has(key) ? (
                <Button size="sm" variant="ghost" className="pointer-coarse:h-11" onClick={() => actions.onUndo(key)}>
                  Undo
                </Button>
              ) : null}
            </>
          ) : (
            <Button size="sm" className="pointer-coarse:h-11" disabled={!target || busy || state.stale} onClick={() => actions.onLink(key)}>
              {!target ? "Choose a task first" : state.linking === key ? "Linking…" : `Link to ${target.identifier}`}
            </Button>
          )}
          {item.ref.kind === "issue" && !here && state.canCreate ? (
            <Button size="sm" variant="outline" className="pointer-coarse:h-11" disabled={busy || state.stale} onClick={() => actions.onCreate(key, false)}>
              {create?.phase === "creating" ? "Creating…" : "Create task from this"}
            </Button>
          ) : null}
          <Button asChild size="sm" variant="ghost" className="ml-auto text-muted-foreground pointer-coarse:h-11">
            <a href={item.url} target="_blank" rel="noreferrer">
              Open {item.ref.providerId === "github" ? "on" : "in"} {provider}
              <ExternalLink aria-hidden className="size-3.5" />
            </a>
          </Button>
        </div>
      )}
    </>
  );
}

function TaskButton({ issue, onOpen }: { issue: Issue; onOpen: (issue: Issue) => void }) {
  return (
    <button
      type="button"
      onClick={() => onOpen(issue)}
      className="focus-ring flex min-h-7 w-full min-w-0 items-center rounded px-1 text-left text-body hover:bg-surface-hover pointer-coarse:min-h-11"
    >
      <span className="truncate">
        <span className="font-medium">{issue.identifier}</span> · {issue.title}
      </span>
    </button>
  );
}

/** A refusal for the selected result (or the pasted link), and the offer to map an outside source. */
function Problem({ state, actions }: { state: LinkDialogState; actions: LinkDialogActions }) {
  if (state.outside) {
    const name = state.outside.name ?? state.outside.key;
    return (
      <div role="alert" className="space-y-2 rounded-lg border p-3">
        <p className="text-body">
          {name} isn't one of {state.workspace}'s sources.
        </p>
        {state.outside.connectionId ? (
          <Button size="sm" className="pointer-coarse:h-11" disabled={!state.target} onClick={actions.onMap}>
            {state.target ? "Add it and link" : "Choose a task first"}
          </Button>
        ) : null}
      </div>
    );
  }
  if (!state.previewError) return null;
  return (
    <p role="alert" className="text-label text-destructive wrap-anywhere">
      {state.previewError}
    </p>
  );
}
