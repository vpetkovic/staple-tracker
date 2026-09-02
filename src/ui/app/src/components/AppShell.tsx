/**
 * The chrome: brand, mode line, view tabs, workspace switcher, assignee filter, theme
 * toggle. Everything that is true of the page regardless of which view is showing.
 */
import { Moon, Sun } from "lucide-react";
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
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { VIEWS, useSession, type ViewName } from "@/lib/session";
import { cn } from "@/lib/utils";

const THEME_KEY = "staple:theme";
/** Sentinel for the "all workspaces" option — Radix Select forbids an empty value. */
const ALL_WORKSPACES = "__all__";

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

export function AppShell({ children }: { children: ReactNode }) {
  const session = useSession();
  const first = session.workspaces[0];
  const modeLine =
    session.mode === "hub"
      ? `hub · ${session.workspaces.length} workspace${session.workspaces.length === 1 ? "" : "s"}`
      : first
        ? `${first.slug} (${first.prefix})`
        : "no workspace";

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      <header className="sticky top-0 z-20 flex shrink-0 flex-wrap items-center gap-3 border-b bg-card px-4 py-2">
        <span className="flex items-baseline gap-1.5 font-semibold tracking-[0.02em]">
          <span aria-hidden className="text-[var(--status-task-in_progress)]">
            &#9680;
          </span>
          staple
        </span>
        <span className="font-mono text-[11px] tracking-[var(--tracking-label)] text-muted-foreground uppercase">
          {modeLine}
        </span>

        <Tabs value={session.view} onValueChange={(v) => session.setView(v as ViewName)}>
          <TabsList>
            {VIEWS.map((view) => (
              <TabsTrigger key={view} value={view} className="capitalize">
                {view}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>

        <div className="ml-auto flex items-center gap-2">
          {session.mode === "hub" ? (
            <Select
              value={session.ws === "" ? ALL_WORKSPACES : session.ws}
              onValueChange={(value) => session.setWs(value === ALL_WORKSPACES ? "" : value)}
            >
              <SelectTrigger size="sm" className="w-[11rem]" aria-label="Workspace filter">
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
          ) : null}
          <Input
            // Keyed so a filter set elsewhere (command palette) re-seeds the box;
            // an uncontrolled input would keep stale text and commit it on blur.
            key={session.assignee}
            defaultValue={session.assignee}
            placeholder="assignee filter"
            aria-label="Assignee filter"
            className="h-8 w-[10rem]"
            // Commit on blur/Enter, not per keystroke: every change refetches the view.
            onBlur={(e) => session.setAssignee(e.currentTarget.value.trim())}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
            }}
          />
          <ThemeToggle />
        </div>
      </header>

      <main className={cn("min-h-0 flex-1 overflow-hidden")}>{children}</main>
    </div>
  );
}
