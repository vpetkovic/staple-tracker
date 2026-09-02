/**
 * The chrome. Everything true of the page regardless of which view is showing.
 *
 * V2 (STA-87) REBUILT THE STRUCTURE. V1 restyled this header without moving anything,
 * because the shape was this ticket's to decide. Here is the decision.
 *
 * ── One row became two, and that is the whole idea ────────────────────────────────────
 *
 * The old header put brand, mode, four view tabs, a workspace select, an assignee box
 * and a theme toggle on ONE line with `flex-wrap`. Six unrelated jobs at one altitude:
 * "which app am I in", "which view", and "which subset of the data" all read as siblings,
 * so none of them read as anything. At a narrow width it wrapped into two rows chosen by
 * the layout engine rather than by meaning.
 *
 * Now the split is by what the control changes, which is the split Vercel's own dashboard
 * uses and the reason its header survives having a lot in it:
 *
 *   Tier 1 (48px) — IDENTITY AND GLOBAL ACTIONS. Who you are looking at (brand, then the
 *     workspace as a breadcrumb segment) and the things that are true everywhere (new
 *     task, search, theme). Nothing here changes what the view below shows.
 *   Tier 2 (44px) — WHAT THE VIEW IS. The view tabs on the left, and on the right the
 *     controls that narrow the data. Everything on this row scopes the thing underneath
 *     it, which is why it sits directly on top of it with no border between.
 *
 * That second row is also the seam V4 (STA-89) needs: a real filter system lands on the
 * right of tier 2 beside — or in place of — the assignee box, and it will not have to
 * negotiate for space with the brand.
 *
 * ── The workspace switcher is now the breadcrumb ──────────────────────────────────────
 *
 * It used to be a bare select floating at the far right, while a separate mono line next
 * to the brand said "hub · 2 workspaces". Those were one fact said twice, forty rem apart.
 * The select now sits where it belongs — immediately after the brand, behind Vercel's
 * slanted slash — and says the same thing by being what it is. In single-workspace mode
 * there is nothing to switch, so it degrades to static text rather than a one-item menu.
 *
 * ── Why the tabs are a nav and not the Tabs primitive ─────────────────────────────────
 *
 * These switch what the whole page is, and they control no `TabsContent` — App.tsx swaps
 * the view. Radix Tabs would have meant fighting V1's pill styling on a primitive the
 * detail drawer also uses, to end up with `role="tab"` that lies about the relationship.
 * A nav with `aria-current` is what this actually is.
 *
 * ── No sidebar ───────────────────────────────────────────────────────────────────────
 *
 * Per VP. With two views there is nothing a rail would hold that the tab row does not,
 * and 240px of permanent left margin is 240px the list does not get. If a nav rail comes
 * back it replaces tier 2, not tier 1.
 */
import { Moon, Search, Sun, UserRound } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { openCommandPalette, openCreateIssue } from "@/lib/shell-events";
import { VIEWS, useSession } from "@/lib/session";
import { cn } from "@/lib/utils";

const THEME_KEY = "staple:theme";
/** Sentinel for the "all workspaces" option — Radix Select forbids an empty value. */
const ALL_WORKSPACES = "__all__";

/** Vercel's breadcrumb divider: a hairline leaned over, not a slash glyph. */
function Divider() {
  return <span aria-hidden className="h-4 w-px shrink-0 rotate-[18deg] bg-border" />;
}

function ThemeToggle() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    try {
      localStorage.setItem(THEME_KEY, dark ? "dark" : "light");
    } catch {
      /* private mode: the choice lasts for this page load */
    }
  }, [dark]);
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={dark ? "Switch to light theme" : "Switch to dark theme"}
      onClick={() => setDark((d) => !d)}
    >
      {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </Button>
  );
}

/**
 * The palette had no visible affordance at all — it was cmd-K or nothing, which means it
 * did not exist for anyone who had not read the source. This is the smallest honest fix:
 * it shows the shortcut rather than replacing it.
 */
function CommandTrigger() {
  return (
    <Button
      variant="ghost"
      size="sm"
      aria-label="Open the command palette"
      title="Search and commands (cmd K)"
      onClick={openCommandPalette}
      className="text-text-tertiary hover:text-foreground"
    >
      <Search className="size-3.5" aria-hidden />
      <kbd className="pointer-events-none font-sans text-[11px] tracking-[var(--tracking-label)]">
        &#8984;K
      </kbd>
    </Button>
  );
}

function ViewTabs() {
  const session = useSession();
  return (
    // `-ml-3` cancels the button's px-1 and the label's px-2, so the tab text starts on
    // the same 16px gutter as the brand above it and the rows below it. Without it the
    // labels sat 12px inboard of both — the kind of misalignment nobody consciously sees
    // and nobody stops noticing.
    <nav aria-label="Views" className="-ml-3 flex h-full items-center gap-0.5">
      {VIEWS.map((view) => {
        const active = session.view === view;
        return (
          <button
            key={view}
            type="button"
            onClick={() => session.setView(view)}
            aria-current={active ? "page" : undefined}
            className="group relative flex h-full items-center px-1 outline-none"
          >
            <span
              className={cn(
                "rounded-md px-2 py-1 text-[13px] capitalize transition-colors",
                "group-hover:bg-surface-hover",
                "group-focus-visible:outline-2 group-focus-visible:outline-offset-1 group-focus-visible:outline-ring",
                active ? "font-medium text-foreground" : "text-muted-foreground",
              )}
            >
              {view}
            </span>
            {/* The underline sits on the header's own bottom border, which is why the
                tier has no border of its own and this element is 2px of foreground
                rather than a coloured accent — the accent in this language means focus. */}
            <span
              aria-hidden
              className={cn(
                "absolute inset-x-1 -bottom-px h-0.5 rounded-full bg-foreground transition-opacity",
                active ? "opacity-100" : "opacity-0",
              )}
            />
          </button>
        );
      })}
    </nav>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const session = useSession();
  const first = session.workspaces[0];

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      {/* One border for both tiers, at the bottom. Two bars separated by a rule would
          read as two pieces of chrome; they are one, split by altitude. */}
      <header className="shrink-0 border-b">
        {/* ── tier 1: identity and global actions ── */}
        <div className="flex h-12 items-center gap-2 px-4">
          <span className="flex shrink-0 items-baseline gap-1.5 text-[15px] font-semibold tracking-[var(--tracking-heading)]">
            {/* The one place the accent is spent on brand rather than on focus (V1). */}
            <span aria-hidden className="text-[var(--status-task-in_progress)]">
              &#9680;
            </span>
            staple
          </span>

          <Divider />

          {session.mode === "hub" ? (
            <Select
              value={session.ws === "" ? ALL_WORKSPACES : session.ws}
              onValueChange={(value) => session.setWs(value === ALL_WORKSPACES ? "" : value)}
            >
              {/* Stripped to a breadcrumb segment: no field surface, no shadow, no
                  border until you point at it. It is a place in a path that happens
                  to be changeable, not an input to be filled in. */}
              <SelectTrigger
                size="sm"
                aria-label="Workspace"
                className="w-auto max-w-[14rem] border-transparent bg-transparent px-2 text-[13px] shadow-none hover:border-transparent hover:bg-surface-hover"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_WORKSPACES}>all workspaces</SelectItem>
                {session.workspaces.map((ws) => (
                  <SelectItem key={ws.slug} value={ws.slug}>
                    {ws.slug}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <span className="truncate text-[13px]">
              {first ? first.slug : "no workspace"}
              {first ? (
                <span className="ml-1.5 font-mono text-[11px] text-text-tertiary">{first.prefix}</span>
              ) : null}
            </span>
          )}

          <div className="ml-auto flex shrink-0 items-center gap-1">
            <CommandTrigger />
            <ThemeToggle />
            <Button
              size="sm"
              onClick={openCreateIssue}
              title="New task (c)"
              className="ml-1"
            >
              New task
            </Button>
          </div>
        </div>

        {/* ── tier 2: what the view is, and how much of it ── */}
        <div className="flex h-11 items-center gap-3 px-4">
          <ViewTabs />
          {/* Ghost until you point at it. At full field contrast this box was the
              highest-contrast object on the row, which put the most visual weight on the
              control you touch least and outshouted the tabs the row exists for. The icon
              is what keeps it findable while it is quiet — a bare ghost input at the far
              right would just read as a stray word. */}
          <div className="relative ml-auto shrink-0">
            <UserRound
              aria-hidden
              className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-text-tertiary"
            />
            <Input
              // Keyed so a filter set elsewhere (command palette) re-seeds the box;
              // an uncontrolled input would keep stale text and commit it on blur.
              key={session.assignee}
              defaultValue={session.assignee}
              placeholder="assignee"
              aria-label="Assignee filter"
              className={cn(
                "h-8 w-[10rem] max-w-[40vw] pl-7 text-[13px]",
                "border-transparent bg-transparent shadow-none",
                "hover:border-input focus-visible:border-ring",
              )}
              // Commit on blur/Enter, not per keystroke: every change refetches the view.
              onBlur={(e) => session.setAssignee(e.currentTarget.value.trim())}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
              }}
            />
          </div>
        </div>
      </header>

      {/*
        `relative` so anything that wants to anchor to the content area rather than the
        viewport has something to anchor to. `overflow-hidden` and NOT `overflow-y-auto`:
        the shell no longer scrolls its child. Each view owns its own scroll container,
        which is what lets the tree put sticky group headers at the top of the list
        (V5/STA-97 §6) and lets the graph canvas fill the box instead of computing its
        height from the viewport minus a hard-coded guess at this header's size.
      */}
      <main className="relative min-h-0 flex-1 overflow-hidden">{children}</main>
    </div>
  );
}
