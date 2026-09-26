/**
 * The workspace switcher — the name of what you are looking at, and one tap to look at
 * something else.
 *
 * ── THE TRIGGER SAYS THE WHOLE NAME ───────────────────────────────────────────────────
 *
 * It used to squeeze a count caption beside the name and truncate the name to make room,
 * so the most important words on the page read "All wo…". The trigger now says the full
 * selection and nothing else — "All workspaces", or the workspace's name, wrapping to a
 * second line before it would ever cut a name short. The counts moved into the list, where
 * each row has room for them.
 *
 * ── A LIST, NOT A MENU ────────────────────────────────────────────────────────────────
 *
 * Each row is the workspace's name with one plain caption under it (switcher-model.ts), and
 * past `SWITCHER_SEARCH_THRESHOLD` workspaces a search box leads the list. The list is a
 * cmdk listbox, so arrows, Home/End and Enter work from the keyboard exactly as in the
 * command palette. On a wide screen it drops from the trigger; on a phone it is a bottom
 * sheet with 48px rows, reached in one tap from the top bar.
 *
 * Choosing a workspace keeps the page you are on (see `afterWorkspaceSwitch` in
 * lib/session-url.ts) and is remembered as the default answer to "which workspace?".
 */
import { Check, ChevronsUpDown } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useCompactHeader } from "@/components/filters/useCompactHeader";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { isAllWorkspaces, useSession } from "@/lib/session";
import { isResolvedStatus } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { BottomSheet } from "./BottomSheet";
import {
  filterSwitcherRows,
  openCountsByWorkspace,
  switcherRows,
  switcherSearches,
  switcherTriggerLabel,
} from "./switcher-model";
import { useBackToClose } from "@/lib/back-to-close";

/** The brand mark the trigger wears as its avatar — the app's own name did not leave the page. */
function BrandMark({ large = false }: { large?: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex shrink-0 items-center justify-center rounded-[5px] bg-foreground leading-none text-background",
        large ? "size-6 text-[14px]" : "size-5 text-[12px]",
      )}
    >
      &#9680;
    </span>
  );
}

/** The list itself, shared by the popover and the sheet. */
function SwitcherList({ onChosen, phone }: { onChosen: () => void; phone: boolean }) {
  const session = useSession();
  const [query, setQuery] = useState("");
  // Counts only when the page holds every workspace's rows; see `switcherRows`.
  const counts = useMemo(
    () => (isAllWorkspaces(session) ? openCountsByWorkspace(session.issues.data ?? [], isResolvedStatus) : null),
    [session, session.issues.data],
  );
  const rows = switcherRows(session, counts);
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
        {shown.map((row) => (
          <CommandItem
            key={row.value || "__all__"}
            value={row.value || "__all__"}
            data-workspace-option={row.value}
            aria-current={row.current ? "true" : undefined}
            onSelect={() => {
              if (session.mode === "hub" && !row.current) session.setWs(row.value);
              onChosen();
            }}
            className={cn("items-start gap-3 rounded-lg px-2.5", phone ? "min-h-12 py-2.5" : "min-h-10 py-2")}
          >
            <span className="flex min-w-0 flex-1 flex-col">
              <span className={cn("font-medium break-words", phone ? "text-[16px]" : "text-[13px]")}>{row.name}</span>
              <span className={cn("text-text-tertiary", phone ? "text-[13px]" : "text-[12px]")}>{row.caption}</span>
            </span>
            {row.prefix ? (
              <span className={cn("mt-0.5 shrink-0 font-mono text-text-tertiary", phone ? "text-[12px]" : "text-[11px]")}>
                {row.prefix}
              </span>
            ) : null}
            <Check
              aria-hidden
              className={cn("mt-0.5 size-4 shrink-0", row.current ? "text-foreground opacity-100" : "opacity-0")}
            />
          </CommandItem>
        ))}
      </CommandList>
    </Command>
  );
}

export function WorkspaceSwitcher({ variant = "rail" }: { variant?: "rail" | "bar" }) {
  const session = useSession();
  const phone = useCompactHeader();
  const [open, setOpen] = useState(false);
  // Phone Back closes the sheet (and the desktop list) rather than leaving the page.
  useBackToClose(open, () => setOpen(false));
  const label = switcherTriggerLabel(session);
  const hub = session.mode === "hub";

  const trigger = (
    <button
      type="button"
      aria-label={`Workspace: ${label}. ${hub ? "Switch workspace" : "Workspace"}`}
      aria-haspopup="dialog"
      aria-expanded={open}
      title={hub ? `${label} — switch workspace` : label}
      data-workspace-switcher={variant}
      onClick={phone ? () => setOpen(true) : undefined}
      className={cn(
        "flex min-w-0 items-center gap-2 rounded-md text-left outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring",
        variant === "rail"
          ? "min-h-7 flex-1 px-1.5 py-1 hover:bg-surface-hover data-[state=open]:bg-surface-selected max-md:min-h-11"
          : "min-h-11 max-w-full rounded-full border bg-card px-3 py-1.5 shadow-xs active:bg-surface-hover",
      )}
    >
      {variant === "rail" ? <BrandMark /> : null}
      <span
        data-workspace-name
        className={cn(
          "min-w-0 flex-1 leading-tight font-semibold tracking-[var(--tracking-heading)] break-words",
          variant === "rail" ? "line-clamp-2 text-[13px]" : "line-clamp-1 text-[15px]",
        )}
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

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[288px] p-1"
        data-workspace-popover
        // The list focuses itself (above); Radix focusing the first tabbable would pre-empt it.
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <div className="px-2.5 pt-1.5 pb-1 text-[11px] font-medium tracking-[var(--tracking-eyebrow)] text-text-tertiary uppercase">
          {hub ? "Switch workspace" : "Workspace"}
        </div>
        <SwitcherList phone={false} onChosen={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}
