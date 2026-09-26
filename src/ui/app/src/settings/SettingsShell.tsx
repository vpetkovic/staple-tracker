/**
 * THE SETTINGS SHEET — R6b (STA-177), made global. Presentation only.
 *
 * Left, the sections; right, the one that is selected. This file knows nothing about what a
 * section CONTAINS — it takes a render function — and nothing about the URL, the fetch or
 * the dialog it sits in, which is what lets a test render it to a string with an invented
 * section and assert the nav grew.
 *
 * ── TWO GROUPS, IN PLAIN WORDS ────────────────────────────────────────────────────────
 *
 * The nav is `categories` verbatim, grouped by the one fact each carries — its scope — under
 * two headings: "Across all workspaces" (Cloud, Hub registry, Usage & budget, This machine)
 * and "Per workspace" (Statuses, Kinds, Workflow, Cloud sync). Adding a category to
 * src/core/settings-registry.ts is still the whole of adding it here.
 *
 * A per-workspace section shows `workspacePicker` above its content: which workspace it is
 * editing, changeable in place. The sheet never closes to change it.
 *
 * ── ONE LAYOUT, TWO ARRANGEMENTS ──────────────────────────────────────────────────────
 *
 * Wide: both panes, always. Narrow (`stacked`, a phone): a full-screen sheet showing the
 * list of sections, then the section, with Back in the header — the navigation every phone
 * settings screen uses. Rows are 44px and carry a chevron; the header and the bottom edge
 * respect the safe areas. Both panes scroll independently inside a fixed-height frame, so
 * the header never leaves the screen.
 *
 * ── THE TITLE IS A SLOT, THE TEXT IS NOT ──────────────────────────────────────────────
 *
 * Inside the dialog the heading has to be Radix's `DialogTitle` (that is what labels the
 * dialog for assistive tech), and `DialogTitle` cannot render outside a dialog. So the
 * ELEMENT is a prop and the TEXT is the constant `SETTINGS_TITLE` — "Settings", which never
 * claims a workspace.
 */
import { useEffect, useLayoutEffect, useRef, type ElementType, type ReactNode } from "react";
import { ArrowLeft, ChevronRight, Maximize2, Minimize2, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { SettingCategoryView } from "@/lib/settings";
import { cn } from "@/lib/utils";
import {
  SCOPE_ORDER,
  appliesToText,
  recallScroll,
  rememberScroll,
  scopeHeading,
  scopeSummaryText,
  type ScopeSummary,
  type ScrollMemory,
  type ShellLayout,
  type ShellMode,
  type ShellPane,
} from "./settings-shell";

/** Exactly this, everywhere: the sheet is the computer's, never one workspace's. The dialog's accessible name. */
export const SETTINGS_TITLE = "Settings";

export interface SettingsShellProps {
  categories: readonly SettingCategoryView[];
  /** The selected category id, or null while the registry is empty. */
  active: string | null;
  layout: ShellLayout;
  /** Which pane a stacked shell shows. */
  pane: ShellPane;
  mode: ShellMode;
  scope: ScopeSummary;
  onSelect: (category: string) => void;
  /** Stacked only: content pane back to the nav. */
  onBack: () => void;
  onToggleMode: () => void;
  onClose: () => void;
  /** What the selected category shows. The shell never decides this. */
  renderCategory: (category: SettingCategoryView) => ReactNode;
  /** Shown in the content pane when there is no category yet (loading) or nothing selected. */
  fallback?: ReactNode;
  /** Shown above a per-workspace section's content: which workspace it edits, changeable in place. */
  workspacePicker?: ReactNode;
  /** `DialogTitle` inside the dialog; a plain heading anywhere else. */
  TitleTag?: ElementType;
  DescriptionTag?: ElementType;
}

export function SettingsShell({
  categories,
  active,
  layout,
  pane,
  mode,
  scope,
  onSelect,
  onBack,
  onToggleMode,
  onClose,
  renderCategory,
  fallback,
  workspacePicker,
  TitleTag = "h2",
  DescriptionTag = "p",
}: SettingsShellProps) {
  const stacked = layout === "stacked";
  const showNav = !stacked || pane === "nav";
  const showContent = !stacked || pane === "content";
  const current = categories.find((c) => c.id === active) ?? null;

  /**
   * SCROLL AND FOCUS SURVIVE A CATEGORY CHANGE.
   *
   * The content pane is one element that changes what it holds. Its offset is recorded
   * for the current category on every scroll — not read back on the way out, because a
   * pane that has just been `hidden` (the stacked layout's Back) reads 0 — and restored
   * whenever the pane shows a category (`useLayoutEffect`, before paint, so there is no
   * flash at the top). Focus is not touched by a selection at all: the nav button you
   * pressed keeps it, and the arrow keys keep working from where you are. The two places
   * focus IS moved are the two stacked transitions, where the pane you were in has just
   * disappeared.
   */
  const contentRef = useRef<HTMLDivElement>(null);
  const memory = useRef<ScrollMemory>(new Map());

  useLayoutEffect(() => {
    const pane = contentRef.current;
    if (pane && showContent) pane.scrollTop = recallScroll(memory.current, active);
  }, [active, showContent]);

  const headingRef = useRef<HTMLHeadingElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const focusActiveNav = () => {
    navRef.current
      ?.querySelector<HTMLButtonElement>(`[data-settings-category="${active ?? ""}"]`)
      ?.focus({ preventScroll: true });
  };
  useEffect(() => {
    if (!stacked) return;
    if (pane === "content") headingRef.current?.focus({ preventScroll: true });
    else focusActiveNav();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stacked, pane, active]);

  /**
   * A deep link opens the dialog BEFORE the registry has answered, so there is no nav
   * button for the dialog's own auto-focus to land on and Radix falls back to the first
   * header control. When the categories arrive, put focus where it would have started.
   */
  const populated = useRef(categories.length > 0);
  useEffect(() => {
    if (populated.current || categories.length === 0) return;
    populated.current = true;
    if (!stacked) focusActiveNav();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [categories.length, stacked]);

  // Save the offset of whatever is showing on the way out of the pane, too.
  const onContentScroll = () => {
    if (contentRef.current) rememberScroll(memory.current, active, contentRef.current.scrollTop);
  };

  return (
    <div
      data-settings-shell
      data-layout={layout}
      data-pane={pane}
      data-mode={mode}
      className="flex h-full min-h-0 flex-col"
    >
      <header
        className={cn(
          "flex shrink-0 items-start gap-2 border-b px-4 py-3",
          stacked && "items-center pt-[max(0.75rem,env(safe-area-inset-top))]",
        )}
      >
        {stacked && pane === "content" ? (
          <Button
            variant="ghost"
            size="icon"
            aria-label="Back to categories"
            title="Back to all settings"
            onClick={onBack}
            className="-ml-2 size-11"
          >
            <ArrowLeft className="size-5" />
          </Button>
        ) : null}
        <div className="min-w-0 flex-1">
          <TitleTag className={cn("leading-tight font-semibold", stacked ? "text-[20px] tracking-tight" : "text-lg")}>
            {SETTINGS_TITLE}
          </TitleTag>
          <DescriptionTag
            data-settings-scope
            className={cn("text-muted-foreground mt-1 text-xs", stacked && pane === "content" && "sr-only")}
          >
            {scopeSummaryText(scope)}
          </DescriptionTag>
        </div>
        {!stacked ? (
          <Button
            variant="ghost"
            size="icon"
            aria-label={mode === "full" ? "Exit full screen" : "Enter full screen"}
            title={mode === "full" ? "Exit full screen" : "Full screen"}
            aria-pressed={mode === "full"}
            onClick={onToggleMode}
          >
            {mode === "full" ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="icon"
          aria-label="Close settings"
          title="Close (Esc)"
          onClick={onClose}
          className={cn("-mr-2", stacked && "size-11")}
        >
          <XIcon className={stacked ? "size-5" : "size-4"} />
        </Button>
      </header>

      <div className="flex min-h-0 flex-1">
        <nav
          ref={navRef}
          aria-label="Settings categories"
          hidden={!showNav}
          className={cn(
            "staple-momentum min-h-0 shrink-0 overflow-y-auto py-2",
            stacked ? "w-full pb-[max(0.5rem,env(safe-area-inset-bottom))]" : "w-56 border-r",
          )}
        >
          {SCOPE_ORDER.map((scope) => {
            const group = categories.filter((c) => c.scope === scope);
            if (group.length === 0) return null;
            return (
              <div key={scope} data-settings-group={scope} className={cn("px-2 pb-2", stacked && "px-3 pb-4")}>
                <div
                  className={cn(
                    "text-muted-foreground px-2 pt-2 pb-1 font-medium",
                    stacked ? "text-[13px]" : "text-[11px] tracking-wide uppercase",
                  )}
                >
                  {scopeHeading(scope)}
                </div>
                <ul
                  className={cn(
                    "m-0 list-none p-0",
                    stacked && "divide-y overflow-hidden rounded-xl border bg-card",
                  )}
                >
                  {group.map((category) => {
                    const selected = category.id === active;
                    return (
                      <li key={category.id}>
                        <button
                          type="button"
                          data-settings-category={category.id}
                          aria-current={selected ? "page" : undefined}
                          onClick={() => onSelect(category.id)}
                          className={cn(
                            "hover:bg-accent focus-visible:ring-ring/50 flex w-full items-center text-left outline-none focus-visible:ring-2",
                            stacked
                              ? "min-h-12 gap-3 px-4 py-3 text-[16px] active:bg-accent"
                              : cn("rounded-md px-2 py-1.5 text-sm", selected ? "bg-accent font-medium" : ""),
                          )}
                        >
                          <span className="min-w-0 flex-1 truncate">{category.label}</span>
                          {stacked ? <ChevronRight aria-hidden className="size-4 shrink-0 text-text-tertiary" /> : null}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </nav>

        <div
          ref={contentRef}
          onScroll={onContentScroll}
          hidden={!showContent}
          data-settings-content
          // `overflow-x-auto` is deliberate: a row wider than a phone (the vocabulary
          // editors' fixed columns, until R6c reflows them) scrolls sideways inside this
          // pane rather than being cut off, so every control on it stays reachable.
          className={cn(
            "staple-momentum min-h-0 min-w-0 flex-1 overflow-x-auto overflow-y-auto px-4 py-3",
            stacked && "pb-[max(1rem,env(safe-area-inset-bottom))]",
          )}
        >
          {current ? (
            <section aria-labelledby={`settings-category-${current.id}`}>
              <div className="mb-3">
                <h3
                  id={`settings-category-${current.id}`}
                  ref={headingRef}
                  tabIndex={-1}
                  className={cn("font-semibold outline-none", stacked ? "text-[18px]" : "text-base")}
                >
                  {current.label}
                </h3>
                <p className="text-muted-foreground text-xs">
                  <span data-settings-category-scope className="text-foreground font-medium">
                    {appliesToText(current.scope, scope.workspace)}
                  </span>
                  {" — "}
                  {current.description}
                </p>
              </div>
              {current.scope === "workspace" && workspacePicker ? (
                <div data-settings-workspace-picker className="mb-4">
                  {workspacePicker}
                </div>
              ) : null}
              {renderCategory(current)}
            </section>
          ) : (
            fallback
          )}
        </div>
      </div>
    </div>
  );
}
