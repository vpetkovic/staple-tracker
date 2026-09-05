/**
 * The workspace switcher at the top of the rail — Linear's shape: the name, a chevron,
 * a menu.
 *
 * It lists exactly what the session provides today. In hub mode that is "All workspaces"
 * plus every registered workspace, and choosing one is `setWs` — unchanged semantics. In
 * single-workspace mode there is nothing to switch, but the control is still the same
 * trigger with a one-item menu rather than a static label, so the top of the rail has one
 * shape whichever mode the server started in and a second workspace lands as a row, not
 * a redesign.
 *
 * The brand lives here. The header's brand mark used to lead the old tier 1; the
 * switcher wears it as its avatar and the menu's label says "staple", so the app's own
 * name did not leave the page when the header did.
 */
import { ChevronDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useSession } from "@/lib/session";

/** Sentinel for the "all workspaces" row — Radix forbids an empty item value. */
const ALL_WORKSPACES = "__all__";

export function WorkspaceSwitcher() {
  const session = useSession();
  const hub = session.mode === "hub";
  const first = session.workspaces[0];
  const current = hub ? session.workspaces.find((ws) => ws.slug === session.ws) : first;

  const name = hub ? (current?.slug ?? "All workspaces") : (first?.slug ?? "No workspace");
  const caption = hub
    ? current
      ? current.prefix
      : `${session.workspaces.length} workspace${session.workspaces.length === 1 ? "" : "s"}`
    : (first?.prefix ?? "");
  const value = hub ? (session.ws === "" ? ALL_WORKSPACES : session.ws) : (first?.slug ?? "");

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Workspace"
          title={hub ? "Switch workspace" : "Workspace"}
          data-workspace-switcher
          className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 text-left outline-none hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring data-[state=open]:bg-surface-active"
        >
          {/* The one place the accent is spent on brand rather than on focus. */}
          <span
            aria-hidden
            className="flex size-5 shrink-0 items-center justify-center rounded-[5px] bg-foreground text-[12px] leading-none text-background"
          >
            &#9680;
          </span>
          <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
            <span className="truncate text-[13px] font-semibold tracking-[var(--tracking-heading)]">
              {name}
            </span>
            {caption ? (
              <span className="shrink-0 font-mono text-[11px] text-text-tertiary">{caption}</span>
            ) : null}
          </span>
          <ChevronDown aria-hidden className="size-3.5 shrink-0 text-text-tertiary" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[216px]">
        <DropdownMenuLabel>staple · {hub ? "hub" : "workspace"}</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={value}
          onValueChange={(next) => {
            // Single-workspace mode has nothing to switch to; the row is a readout.
            if (!hub) return;
            session.setWs(next === ALL_WORKSPACES ? "" : next);
          }}
        >
          {hub ? <DropdownMenuRadioItem value={ALL_WORKSPACES}>All workspaces</DropdownMenuRadioItem> : null}
          {session.workspaces.map((ws) => (
            <DropdownMenuRadioItem key={ws.slug} value={ws.slug}>
              <span className="truncate">{ws.slug}</span>
              <DropdownMenuShortcut className="font-mono">{ws.prefix}</DropdownMenuShortcut>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
