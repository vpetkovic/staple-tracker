/**
 * THE PHONE'S VIEW SWITCHER — a bottom tab bar.
 *
 * Why a tab bar and not a segmented control or a menu: the six views are the app's
 * top-level destinations, and a phone's bottom edge is where the thumb already is. A tab bar
 * keeps every view one tap away and always visible, says where you are without reading a
 * header, and is the pattern both iOS (UITabBar) and Android (Material navigation bar) teach
 * people for exactly this job. A segmented control would have to scroll sideways at six
 * items on a 360px screen (a hidden view is not one tap away); a menu makes every switch two
 * taps. Six tabs at 360px are 60px each — past the 44px minimum — with a short label under
 * each icon ("Accuracy" for Estimate accuracy; the full name is the accessible name).
 *
 * The bar sits on the home-indicator safe area and never covers content: it is a flex item
 * below `<main>`, not an overlay, so every view's own scroll container ends above it.
 */
import { VIEWS, VIEW_LABELS, VIEW_SHORT_LABELS, useSession } from "@/lib/session";
import { cn } from "@/lib/utils";
import { viewIcon } from "./nav-model";

export function ViewTabBar() {
  const session = useSession();
  return (
    <nav
      aria-label="Views"
      data-view-tabs
      className="flex shrink-0 border-t bg-card/95 pb-[env(safe-area-inset-bottom)] backdrop-blur supports-[backdrop-filter]:bg-card/85"
    >
      {VIEWS.map((view) => {
        const Icon = viewIcon(view);
        const current = session.view === view;
        return (
          <button
            key={view}
            type="button"
            data-view-tab={view}
            aria-current={current ? "page" : undefined}
            aria-label={VIEW_LABELS[view]}
            onClick={() => session.setView(view)}
            className={cn(
              "flex min-h-[3.25rem] min-w-0 flex-1 flex-col items-center justify-center gap-0.5 px-0.5 pt-1.5 pb-1 outline-none",
              "focus-visible:bg-surface-hover active:bg-surface-hover",
              current ? "text-foreground" : "text-text-tertiary",
            )}
          >
            <span
              aria-hidden
              className={cn(
                "flex h-7 w-12 items-center justify-center rounded-full transition-colors",
                current && "bg-surface-selected",
              )}
            >
              <Icon className="size-[1.2rem]" strokeWidth={current ? 2.25 : 1.75} />
            </span>
            <span className={cn("max-w-full truncate text-[10.5px] leading-tight", current && "font-semibold")}>
              {VIEW_SHORT_LABELS[view]}
            </span>
          </button>
        );
      })}
    </nav>
  );
}
