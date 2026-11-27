/**
 * The workspace switcher — the name of what you are looking at, and one tap to look at
 * something else.
 *
 * ── THE TRIGGER SAYS THE NAME, NOTHING ELSE ───────────────────────────────────────────
 *
 * Every trigger says the selection and nothing beside it: "All workspaces", or the
 * workspace's name. The rail's head adds the scope's tile. A name too long for its box
 * truncates and the whole of it is the trigger's title; it never wraps the head or pushes
 * the chevrons out. What each workspace holds is said in the list, where each row has room.
 *
 * ── A LIST, NOT A MENU ────────────────────────────────────────────────────────────────
 *
 * Each row is one line, read at a glance: the workspace's tile, its name, and how much waits
 * on a person there (the Inbox's own count, so the list says where the waiting is; nothing at
 * 0; All workspaces carries the total). The task-number prefix is in the row's title and
 * still finds the row in the search box, which leads the list past
 * `SWITCHER_SEARCH_THRESHOLD` workspaces. The list is a cmdk listbox, so arrows, Home/End and
 * Enter work from the keyboard exactly as in the command palette. On a desk it drops from the
 * trigger with 36px rows; on a phone it is a bottom sheet with 48px rows, reached in one tap
 * from the top bar. Closing either hands the focus back to the trigger.
 *
 * Choosing a workspace keeps the page you are on (see `afterWorkspaceSwitch` in
 * lib/session-url.ts) and is remembered as the default answer to "which workspace?".
 */
import { Check, ChevronsUpDown } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useCompactHeader } from "@/components/filters/useCompactHeader";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAttentionRead } from "@/lib/attention";
import { currentWorkspace, isAllWorkspaces, isMachineView, scopeName, useSession } from "@/lib/session";
import { cn } from "@/lib/utils";
import { BottomSheet } from "./BottomSheet";
import { MARK_CLASS, useFocusOnClose } from "./nav-shared";
import {
  filterSwitcherRows,
  waitingByWorkspace,
  switcherRows,
  switcherSearches,
  switcherTriggerLabel,
} from "./switcher-model";
import { useBackToClose } from "@/lib/back-to-close";
import { sharedRow, useSharedWorkspaces } from "@/lib/shared-workspaces";

/**
 * A workspace's tile, 20px: its letter (the first of its prefix, else of its name), or the
 * app's mark (a half-filled circle) for All workspaces. The rail's head and every row of the
 * list wear the same one.
 */
function WorkspaceTile({ workspace }: { workspace: { slug: string; prefix: string } | null }) {
  const letter = workspace ? (workspace.prefix || workspace.slug).slice(0, 1).toUpperCase() : null;
  return (
    <span
      aria-hidden
      data-scope-tile
      className={cn(
        "flex size-5 shrink-0 items-center justify-center rounded-md bg-foreground leading-none text-background",
        letter ? "text-[11px] font-semibold" : "text-[12px]",
      )}
    >
      {letter ?? <>&#9680;</>}
    </span>
  );
}

/** The tile of the scope the page is on. */
function ScopeTile() {
  const session = useSession();
  return <WorkspaceTile workspace={isAllWorkspaces(session) ? null : currentWorkspace(session)} />;
}

/** The list itself, shared by the popover and the sheet. */
export function SwitcherList({ onChosen, phone }: { onChosen: () => void; phone: boolean }) {
  const session = useSession();
  const [query, setQuery] = useState("");
  const rows = switcherRows(session);
  // What waits on a person in each workspace: the Inbox's read, which is always every workspace's.
  const attention = useAttentionRead().data;
  const waiting = useMemo(() => waitingByWorkspace(attention?.rows ?? []), [attention]);
  const waitingIn = (value: string) => (value === "" ? (attention?.rows.length ?? 0) : (waiting.get(value) ?? 0));
  const sharedRows = useSharedWorkspaces();
  const prefixes = useMemo(
    () => new Map(session.workspaces.map((workspace) => [workspace.slug, workspace.prefix])),
    [session.workspaces],
  );
  const shown = filterSwitcherRows(rows, query, prefixes);
  const searches = switcherSearches(session);

  /**
   * THE KEYBOARD WORKS AT EVERY SIZE. With a search box, cmdk hears the arrows through it.
   * Without one (six workspaces or fewer) nothing inside the list had focus, so the arrows
   * went nowhere; the list itself now takes focus on a desk, starting on the workspace you
   * are on, and Up/Down (wrapping), Home/End, Enter and Escape work exactly as in the
   * command palette. A phone opens it as a sheet and focuses nothing.
   */
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (phone) return;
    // The search box when there is one, otherwise the list.
    const target = listRef.current?.querySelector<HTMLElement>("[cmdk-input]") ?? listRef.current;
    target?.focus({ preventScroll: true });
  }, [phone, searches]);
  const current = rows.find((row) => row.current);

  return (
    <Command
      ref={listRef}
      shouldFilter={false}
      loop
      defaultValue={current ? current.value || "__all__" : undefined}
      tabIndex={!phone && !searches ? -1 : undefined}
      aria-label="Workspaces"
      data-workspace-list
      className="bg-transparent outline-none"
    >
      {searches ? (
        <CommandInput
          value={query}
          onValueChange={setQuery}
          placeholder="Find a workspace"
          aria-label="Find a workspace"
          data-workspace-search
          className={phone ? "h-11 text-[16px]" : undefined}
        />
      ) : null}
      <CommandList className={cn("p-1", phone ? "max-h-none" : "max-h-[min(24rem,60dvh)]")}>
        <CommandEmpty>No workspace matches “{query}”.</CommandEmpty>
        {shown.map((row) => {
          const count = waitingIn(row.value);
          return (
            <CommandItem
              key={row.value || "__all__"}
              value={row.value || "__all__"}
              data-workspace-option={row.value}
              aria-current={row.current ? "true" : undefined}
              title={row.prefix ? `${row.name} · task numbers start with ${row.prefix}` : undefined}
              onSelect={() => {
                if (session.mode === "hub" && !row.current) session.setWs(row.value);
                onChosen();
              }}
              className={cn("gap-2.5 rounded-lg px-2", phone ? "h-12" : "h-9")}
            >
              <WorkspaceTile workspace={row.value ? { slug: row.value, prefix: row.prefix } : null} />
              <span className={cn("min-w-0 flex-1 truncate font-medium", phone ? "text-[16px]" : "text-body")}>
                {row.name}
                {sharedRow(sharedRows, row.value) ? (
                  <span
                    data-switcher-shared={row.value}
                    title="Shared with other members; syncs automatically"
                    className="ml-1.5 inline-flex items-center gap-0.5 rounded-full bg-surface-sunken px-1.5 align-middle text-[11px] font-normal text-text-secondary"
                  >
                    ⇄ shared
                  </span>
                ) : null}
              </span>
              {count > 0 ? (
                <span data-workspace-waiting={count} aria-label={`${count} waiting`} className={MARK_CLASS}>
                  {count}
                </span>
              ) : null}
              <Check aria-hidden className={cn("size-4 shrink-0", row.current ? "text-foreground opacity-100" : "opacity-0")} />
            </CommandItem>
          );
        })}
      </CommandList>
    </Command>
  );
}

/**
 * `head`: the desk rail's head, the scope as the rail's first control (the tile, the name and
 * the chevrons; `compact` is the narrow rail's tile alone, its name in a tooltip). With one
 * workspace there is nothing to switch to, and the head is the name as words, not a menu of
 * one. `bar`: the phone top bar's pill. `crumb`: the desk top bar's scope, "All workspaces ›",
 * which opens the same list.
 */
export function WorkspaceSwitcher({ variant, compact = false }: { variant: "head" | "bar" | "crumb"; compact?: boolean }) {
  const session = useSession();
  const phone = useCompactHeader();
  const [open, setOpen] = useState(false);
  // Phone Back closes the sheet (and the desktop list) rather than leaving the page.
  useBackToClose(open, () => setOpen(false));
  // When the phone's sheet closes, the pill takes the focus back (the popover's trigger takes its own).
  const pill = useRef<HTMLButtonElement>(null);
  useFocusOnClose(open, () => pill.current, phone);
  const label = switcherTriggerLabel(session);
  const hub = session.mode === "hub";

  if (variant === "head" && !hub) return <ScopeHead compact={compact} />;

  const trigger =
    variant === "crumb" ? (
      <button
        type="button"
        aria-label={`Workspace: ${label}. ${hub ? "Switch workspace" : "Workspace"}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={hub ? `${label} — switch workspace` : label}
        data-workspace-switcher="crumb"
        data-scope-name
        className="relative -ml-1.5 flex h-7 min-w-0 items-center gap-1 rounded-md px-1.5 pointer-coarse:min-h-0 pointer-coarse:before:absolute pointer-coarse:before:inset-x-0 pointer-coarse:before:-inset-y-2 pointer-coarse:before:content-[''] text-body text-text-secondary transition-colors hover:bg-surface-hover hover:text-foreground focus-ring data-[state=open]:bg-surface-selected"
      >
        <span className="truncate">{label}</span>
        <ChevronsUpDown aria-hidden className="size-3.5 shrink-0 text-text-tertiary" />
      </button>
    ) : variant === "head" ? (
      <button
        type="button"
        aria-label={`Workspace: ${label}. Switch workspace`}
        aria-haspopup="dialog"
        aria-expanded={open}
        // The narrow head's name is its tooltip; the full head's name truncates, so it is the title.
        title={compact ? undefined : label}
        data-workspace-switcher="head"
        className={cn(
          "flex h-9 items-center rounded-lg text-left transition-colors duration-(--motion-duration-fast) hover:bg-surface-hover focus-ring-inset data-[state=open]:bg-surface-hover",
          // The tile's centre sits on the row icons' centre line below it (see NavRail).
          compact ? "relative w-9 shrink-0 justify-center pointer-coarse:min-h-0 pointer-coarse:before:absolute pointer-coarse:before:-inset-1 pointer-coarse:before:content-['']" : "w-full min-w-0 gap-2 px-1.5",
        )}
      >
        <ScopeTile />
        {compact ? null : (
          <>
            <ScopeName />
            <ChevronsUpDown aria-hidden className="size-3.5 shrink-0 text-text-tertiary" />
          </>
        )}
      </button>
    ) : (
      <button
        type="button"
        aria-label={`Workspace: ${label}. ${hub ? "Switch workspace" : "Workspace"}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={hub ? `${label} — switch workspace` : label}
        ref={pill}
        data-workspace-switcher="bar"
        onClick={phone ? () => setOpen(true) : undefined}
        // A 32px pill, its 44px of touch an invisible area round it (7px: an absolute box is measured
        // from inside the 1px border). The bar draws no inflated controls.
        className="relative flex h-8 min-h-0 max-w-full min-w-0 items-center gap-1.5 rounded-full border bg-card px-3 text-left shadow-xs focus-ring active:bg-surface-hover before:absolute before:inset-x-0 before:-inset-y-[7px] before:content-['']"
      >
        <span
          data-workspace-name
          className="min-w-0 flex-1 truncate text-[15px] leading-tight font-semibold tracking-[var(--tracking-heading)]"
        >
          {label}
        </span>
        <ChevronsUpDown aria-hidden className="size-3.5 shrink-0 text-text-tertiary" />
      </button>
    );

  if (phone) {
    return (
      <>
        {trigger}
        <BottomSheet
          open={open}
          onOpenChange={setOpen}
          title="Switch workspace"
          description="Pick what the lists and pages show. Settings for every workspace stay in Settings."
          name="workspaces"
        >
          <SwitcherList phone onChosen={() => setOpen(false)} />
        </BottomSheet>
      </>
    );
  }

  // The narrow rail's head opens beside the rail; every other trigger drops below itself.
  const beside = variant === "head" && compact;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      {beside ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>{trigger}</PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="right">{label}</TooltipContent>
        </Tooltip>
      ) : (
        <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      )}
      <PopoverContent
        align="start"
        side={beside ? "right" : "bottom"}
        sideOffset={beside ? 8 : 4}
        className="w-[288px] p-1"
        data-workspace-popover
        // The list focuses itself (above); Radix focusing the first tabbable would pre-empt it.
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <div className="px-2.5 pt-1.5 pb-1 text-label font-medium text-text-tertiary">
          {hub ? "Switch workspace" : "Workspace"}
        </div>
        <SwitcherList phone={false} onChosen={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}

/** The scope's name in the head. On a view about this computer it steps back to the secondary tone. */
function ScopeName() {
  const session = useSession();
  const machine = isMachineView(session.view);
  return (
    <span
      data-workspace-name
      className={cn("min-w-0 flex-1 truncate text-body", machine ? "font-normal text-text-secondary" : "font-semibold text-foreground")}
    >
      {scopeName(session)}
    </span>
  );
}

/** The head of a single-workspace page: the workspace, named, with nothing to open. */
function ScopeHead({ compact }: { compact: boolean }) {
  const session = useSession();
  if (!compact) {
    return (
      <div data-workspace-switcher="head" title={scopeName(session)} className="flex h-9 w-full min-w-0 items-center gap-2 px-1.5">
        <ScopeTile />
        <ScopeName />
      </div>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div data-workspace-switcher="head" className="flex size-9 shrink-0 items-center justify-center">
          <ScopeTile />
          <span className="sr-only">{scopeName(session)}</span>
        </div>
      </TooltipTrigger>
      <TooltipContent side="right">{scopeName(session)}</TooltipContent>
    </Tooltip>
  );
}
