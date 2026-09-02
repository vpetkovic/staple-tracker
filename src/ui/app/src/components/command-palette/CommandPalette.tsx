/**
 * The cmd-K surface — owned by U7 (STA-19).
 *
 * Everything that could be subtly wrong (ranking, contextual ordering, recency, which
 * commands exist at all) lives in commands.ts as pure functions over plain data. What is
 * left here is a fetch, a render, and a switch statement, which is the point.
 *
 * The palette does NOT close after a write. A status change can be refused by a guard —
 * staple has no transition table — and closing on the refusal would throw the reason
 * away. It stays open, shows what the store said, and the fix is one more keystroke.
 *
 * ── R5 (STA-105): THE RESULTS ARE THE SAME ROW AS THE LIST ────────────────────────────
 *
 * Issue results used to be `"${identifier} ${title}"` in a truncating span with the status
 * as a right-aligned hint. That is a different language from the list two hundred pixels
 * behind it: the same task, found two ways, looked like two kinds of object. They now render
 * `TaskRowLine` in the `popup` preset, so a search result carries the same priority glyph,
 * the same status glyph and the same identifier register as the row it will take you to.
 *
 * `semantics="bare"` is the important part. cmdk's `CommandItem` is ALREADY the option: it
 * owns the role, the roving selection and the `data-selected` highlight. A row that also
 * declared `role="option"` would nest two options, and one that also took a tab stop would
 * double every arrow key. So the row renders as a line with no role, no tabindex and no
 * hover paint of its own, and the host keeps everything it already owned.
 */
import { useCallback, useMemo, useState } from "react";
import { GuardRefusal } from "@/components/GuardRefusal";
import { TaskRowLine, flatRow, resolveTaskListConfig } from "@/components/task-list";
// Explicit: the palette is mounted beside the views, not inside one, and must not
// depend on whichever view happens to be on screen having pulled this in.
import "@/components/task-list/task-list.css";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { action, getIssues } from "@/lib/api";
import { withDimension } from "@/lib/filters";
import { useSession } from "@/lib/session";
import { workspaceSettings } from "@/lib/settings";
import { openSettings } from "@/lib/shell-events";
import type { IssueStatus } from "@/lib/types";
import { useResource } from "@/lib/useStaple";
import { describeRefusal, type Refusal } from "@/lib/refusal";
import {
  buildCommands,
  filterCommands,
  issueCommand,
  orderCommands,
  rankIssues,
  rememberCommand,
  type CommandAction,
  type PaletteCommand,
  type PalettePage,
} from "./commands";

/**
 * Recents outlive the dialog (which unmounts on close) but not the tab. Module scope is
 * exactly that lifetime, and it keeps the mount from re-rendering the whole app on every
 * command run just to store an id.
 */
let recents: string[] = [];

const PAGE_PLACEHOLDER: Record<PalettePage, string> = {
  checkout: "agent name to check out as…",
  assignee: "assignee to filter by (empty clears)…",
};

export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const session = useSession();
  const [query, setQuery] = useState("");
  const [page, setPage] = useState<PalettePage | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [busy, setBusy] = useState(false);

  // Deliberately unfiltered by session.assignee: "jump to issue" has to reach an issue
  // the current filter is hiding, or it is not a jump, it is a scroll.
  //
  // Auth failures are swallowed here rather than surfaced: the palette has no route to
  // App's onAuthError (its mount takes no props and App.tsx is not ours to edit), and
  // useDataVersion's poll hits the same 401 within 1.5s and swaps in the token screen.
  const load = useCallback(() => getIssues({ ws: session.ws }), [session.ws]);
  const issues = useResource(load, [session.ws, session.version], () => undefined);

  const rows = useMemo(() => issues.data ?? [], [issues.data]);
  const selected = session.selection;
  const selectedStatus = useMemo<IssueStatus | null>(() => {
    if (!selected) return null;
    return rows.find((row) => row.issue.identifier === selected.ref)?.issue.status ?? null;
  }, [rows, selected]);

  const commands = useMemo(
    () =>
      orderCommands(
        buildCommands({
          selection: selected,
          selectionStatus: selectedStatus,
          view: session.view,
          ws: session.ws,
          assignee: session.assignee,
          workspaces: session.workspaces,
          hub: session.mode === "hub",
          /*
           * O7b (STA-141). The workspace's own status list, so "Set status → …" offers
           * what this workspace actually has and calls each one what the workspace calls
           * it. Read through the plain accessor rather than the hook: the palette is
           * rebuilt on `session.version`, which ticks on the same fingerprint poll that
           * a vocabulary change moves, so a hook here would only add a second subscriber
           * to a value this memo already re-reads.
           */
          statuses: workspaceSettings().statuses,
          // W5 (STA-117): the filter commands count what they would select, so the
          // palette says "3 issues" before you commit to a board you cannot see yet.
          // The same rows the jump list already ranks — no second fetch.
          rows,
        }),
        recents,
        selected !== null,
      ),
    [
      rows,
      selected,
      selectedStatus,
      session.view,
      session.ws,
      session.assignee,
      session.workspaces,
      session.mode,
      session.version,
    ],
  );

  const visibleCommands = useMemo(() => filterCommands(commands, query), [commands, query]);

  /**
   * The ranked ROWS, not their labels. `issueCommand` still produces the id, the keywords and
   * the action — the ranking and the "what does enter do" question are unchanged and still
   * live in commands.ts — but the row itself is carried through so the result can be rendered
   * as a row rather than as a string describing one.
   */
  const visibleIssues = useMemo(
    () =>
      rankIssues(rows, query).map(({ row }) => ({
        row,
        command: issueCommand(row, session.mode === "hub"),
      })),
    [rows, query, session.mode],
  );

  /**
   * The popup preset: compact rows, the workspace pill ON (results are the one surface that
   * mixes workspaces with no heading to say so), and everything §14 drops least-diagnostic-
   * first — date, then label names, then the PR number — dropped. What survives is §14's
   * never-drop set: priority, identifier, status, assignee and the working pill.
   *
   * One clock reading for the whole list, so ten results cannot disagree about "3h".
   */
  const rowConfig = useMemo(
    () =>
      resolveTaskListConfig("popup", {
        // HUB MODE ONLY. The pill exists so a cross-workspace result is identifiable; in a
        // single-workspace app there is nothing to tell apart, and it would be ~70px of
        // identical grey text on every row. This is the same condition `issueCommand` already
        // used to decide whether to name the workspace in the old hint, so the palette keeps
        // one answer to "should we say which file this came from".
        columns: { workspace: session.mode === "hub" },
      }),
    [session.mode],
  );
  const now = useMemo(() => new Date(), [visibleIssues]);

  const close = useCallback(() => {
    setQuery("");
    setPage(null);
    setRefusal(null);
    onOpenChange(false);
  }, [onOpenChange]);

  /** Back out of a sub-page without losing the palette. */
  const leavePage = useCallback(() => {
    setPage(null);
    setQuery("");
    setRefusal(null);
  }, []);

  /** One write, one place that decides what a failure means. */
  const write = useCallback(
    async (target: { workspace: string; ref: string; actor?: string }, payload: Parameters<typeof action>[1]) => {
      setBusy(true);
      setRefusal(null);
      try {
        // Selection carries `workspace`; the API target field is `ws`.
        await action({ ws: target.workspace, ref: target.ref, ...(target.actor ? { actor: target.actor } : {}) }, payload);
        session.refresh();
        return true;
      } catch (error) {
        // The store's own sentence, verbatim. lib/refusal.ts is the single translation
        // from a rejected write into something renderable, and it is imported rather
        // than reimplemented because two copies of "show exactly what the store said"
        // is how one of them starts paraphrasing.
        setRefusal(describeRefusal(error));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [session],
  );

  const run = useCallback(
    async (command: PaletteCommand) => {
      recents = rememberCommand(recents, command.id);
      const next: CommandAction = command.action;
      switch (next.type) {
        case "open":
          session.open(next.workspace, next.ref);
          close();
          return;
        case "view":
          session.setView(next.view);
          close();
          return;
        case "workspace":
          session.setWs(next.ws);
          close();
          return;
        case "assignee":
          session.setAssignee(next.assignee);
          close();
          return;
        case "dimension":
          // W5 (STA-117). One line, because the action was shaped to be `withDimension`'s
          // arguments — lib/filters.ts stays the sole authority on what is visible and
          // this file learns nothing about what a "handoff" is.
          session.setFilters(withDimension(session.filters, next.dimension, next.values));
          close();
          return;
        case "settings":
          // The same shell verb the header gear dispatches — one dialog, two triggers.
          // Closing first: Radix marks the page inert while a dialog is open, and
          // leaving the palette up would trap focus between the two.
          close();
          openSettings();
          return;
        case "page":
          setPage(next.page);
          setQuery("");
          setRefusal(null);
          return;
        case "status": {
          if (!selected) return;
          if (await write(selected, { type: "status", status: next.status })) close();
          return;
        }
        case "release": {
          if (!selected) return;
          if (await write(selected, { type: "release" })) close();
          return;
        }
      }
    },
    [close, selected, session, write],
  );

  /** Submit the free-text page. The typed value IS the argument. */
  const submitPage = useCallback(async () => {
    const value = query.trim();
    if (page === "assignee") {
      session.setAssignee(value);
      close();
      return;
    }
    if (page === "checkout") {
      if (!selected || value === "") return;
      // The UI server reads `actor` as the checkout agent, so no new action type and no
      // change to lib/api.ts is needed to check out as someone.
      if (await write({ ...selected, actor: value }, { type: "checkout" })) close();
    }
  }, [close, page, query, selected, session, write]);

  return (
    // Dialog + Command composed here rather than via ui/command.tsx's CommandDialog,
    // which does not forward `shouldFilter`. The vendored primitives are meant to be
    // wrapped, not edited (see components/ui/README.md), and the ranking is the one
    // thing this palette cannot delegate.
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogHeader className="sr-only">
        <DialogTitle>Command palette</DialogTitle>
        <DialogDescription>
          Jump to an issue, change its status, check it out, or switch view.
        </DialogDescription>
      </DialogHeader>
      <DialogContent
        className="top-[18%] translate-y-0 overflow-hidden p-0"
        showCloseButton={false}
        aria-label="Command palette"
        // Radix listens for Escape on the document in the capture phase, so it fires
        // before the input's own onKeyDown can stopPropagation. This is the only hook
        // that runs early enough to make escape back out of a page instead of closing.
        onEscapeKeyDown={(event) => {
          if (page) {
            event.preventDefault();
            leavePage();
          }
        }}
      >
        <Command
          // Own the ranking: identifier-before-title, contextual-before-recent, and a
          // non-match that is dropped rather than sunk. cmdk's default scorer knows
          // none of that.
          shouldFilter={false}
          className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:tracking-[var(--tracking-eyebrow)] [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:text-muted-foreground"
        >
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder={page ? PAGE_PLACEHOLDER[page] : "jump to an issue, or type a command…"}
            onKeyDown={(event) => {
              if (page && event.key === "Backspace" && query === "") {
                event.preventDefault();
                leavePage();
                return;
              }
              if (page && event.key === "Escape") {
                // One escape backs out of the page; the next one closes the palette.
                // Losing a half-typed agent name AND the palette to one keypress is rude.
                event.preventDefault();
                event.stopPropagation();
                leavePage();
                return;
              }
              if (page && event.key === "Enter") {
                event.preventDefault();
                void submitPage();
              }
            }}
          />

          <CommandList data-palette-list>
            {page ? (
              <div className="px-3 py-4 text-sm">
                <div className="text-muted-foreground">
                  {page === "checkout"
                    ? `Check out ${selected?.ref ?? "—"} as the agent named above, then press enter.`
                    : "Type an assignee and press enter. Empty clears the filter."}
                </div>
                <div className="mt-2 text-[11px] text-muted-foreground">
                  backspace on an empty line goes back · esc goes back
                </div>
              </div>
            ) : (
              <>
                <CommandEmpty>nothing matches “{query}”</CommandEmpty>

                {visibleCommands.length > 0 ? (
                  <CommandGroup heading={selected ? `commands · ${selected.ref} selected` : "commands"}>
                    {visibleCommands.map((command) => (
                      <CommandItem
                        key={command.id}
                        value={command.id}
                        disabled={busy}
                        onSelect={() => void run(command)}
                      >
                        <span className="truncate">{command.label}</span>
                        {command.hint ? (
                          <CommandShortcut className="font-mono normal-case">{command.hint}</CommandShortcut>
                        ) : null}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                ) : null}

                {visibleIssues.length > 0 ? (
                  // `data-preset` so the stylesheet can reach these rows: they are `bare`,
                  // so unlike <TaskList> there is no list root of ours around them.
                  <CommandGroup heading="issues" data-preset="popup">
                    {visibleIssues.map(({ row, command }) => (
                      <CommandItem
                        key={command.id}
                        value={command.id}
                        onSelect={() => void run(command)}
                        // The row is full-bleed inside the item and owns its own geometry;
                        // the item keeps only its rounded corner and its selected background.
                        className="p-0 gap-0"
                      >
                        <TaskRowLine
                          row={flatRow(row)}
                          config={rowConfig}
                          semantics="bare"
                          now={now}
                        />
                      </CommandItem>
                    ))}
                  </CommandGroup>
                ) : null}

                {!selected ? (
                  <div className="px-3 pt-1 pb-3 text-[11px] text-muted-foreground">
                    open an issue to get status, checkout and release commands
                  </div>
                ) : null}
              </>
            )}
          </CommandList>

          {refusal ? (
            // The palette stays open on a refusal, and since V2 (STA-87) it renders the
            // refusal the same way every other surface does. The strip that used to be
            // here was hand-rolled and showed only a code and a sentence — it silently
            // dropped detail.blockers and the store's own retryable verdict, so the
            // palette told you a start was refused and made you go elsewhere to find out
            // which blockers, while the board two tabs over showed them as chips.
            <GuardRefusal
              refusal={refusal}
              onDismiss={() => setRefusal(null)}
              className="border-t border-[var(--status-task-blocked)]/40 bg-[var(--status-task-blocked)]/10 px-3 py-2.5"
            />
          ) : null}
        </Command>
      </DialogContent>
    </Dialog>
  );
}
