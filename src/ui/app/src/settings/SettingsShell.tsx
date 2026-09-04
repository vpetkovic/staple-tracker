/**
 * THE "WORK WORKSPACE SETTINGS" SHELL — R6b (STA-177). Presentation only.
 *
 * Left, the categories the registry serves; right, the one that is selected. This file
 * knows nothing about what a category CONTAINS — it takes a render function — and
 * nothing about the URL, the fetch or the dialog it sits in, which is what lets a test
 * render it to a string with an invented category and assert the nav grew.
 *
 * ── NO CATEGORY IS NAMED HERE ─────────────────────────────────────────────────────────
 *
 * The nav is `categories` verbatim, in the order the registry sorted them, grouped by
 * the one fact the registry attaches to every category — its scope. Adding a category
 * to src/core/settings-registry.ts is therefore the whole of adding it to this nav.
 * The two scope headings are the only fixed strings, and they are headings for a
 * distinction (workspace versus this machine) that the epic exists to make visible.
 *
 * ── ONE LAYOUT, TWO ARRANGEMENTS ──────────────────────────────────────────────────────
 *
 * Wide: both panes, always. Narrow (`stacked`): one pane at a time, with the Back
 * button in the header as the reliable way out of a category — a swipe, a scrim tap or
 * "you can scroll up to find the list" are not reliable, and a form that is
 * `overflow: hidden` on a phone is a form with a button you cannot press. Both panes
 * scroll independently inside a fixed-height frame, so the header with the title, the
 * scope line and the controls never leaves the screen in either arrangement.
 *
 * ── THE TITLE IS A SLOT, THE TEXT IS NOT ──────────────────────────────────────────────
 *
 * Inside the dialog the heading has to be Radix's `DialogTitle` (that is what labels
 * the dialog for assistive tech), and `DialogTitle` cannot render outside a dialog. So
 * the ELEMENT is a prop and the TEXT is the constant `SETTINGS_TITLE`, which is the
 * half the acceptance criterion is about.
 */
import { useEffect, useLayoutEffect, useRef, type ElementType, type ReactNode } from "react";
import { ArrowLeft, Maximize2, Minimize2, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { SettingCategoryView, SettingScope } from "@/lib/settings";
import { cn } from "@/lib/utils";
import {
  recallScroll,
  rememberScroll,
  scopeLabel,
  scopeSummaryText,
  type ScopeSummary,
  type ScrollMemory,
  type ShellLayout,
  type ShellMode,
  type ShellPane,
} from "./settings-shell";

/** Exactly this. The epic's first acceptance criterion, and the dialog's accessible name. */
export const SETTINGS_TITLE = "Work Workspace Settings";

const SCOPES: readonly SettingScope[] = ["workspace", "global"];

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
      <header className="flex shrink-0 items-start gap-2 border-b px-4 py-3">
        {stacked && pane === "content" ? (
          <Button
            variant="ghost"
            size="icon"
            aria-label="Back to categories"
            title="Back to categories"
            onClick={onBack}
            className="-ml-2"
          >
            <ArrowLeft className="size-4" />
          </Button>
        ) : null}
        <div className="min-w-0 flex-1">
          <TitleTag className="text-lg leading-tight font-semibold">{SETTINGS_TITLE}</TitleTag>
          <DescriptionTag data-settings-scope className="text-muted-foreground mt-1 text-xs">
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
          className="-mr-2"
        >
          <XIcon className="size-4" />
        </Button>
      </header>

      <div className="flex min-h-0 flex-1">
        <nav
          ref={navRef}
          aria-label="Settings categories"
          hidden={!showNav}
          className={cn(
            "min-h-0 shrink-0 overflow-y-auto py-2",
            stacked ? "w-full" : "w-56 border-r",
          )}
        >
          {SCOPES.map((scope) => {
            const group = categories.filter((c) => c.scope === scope);
            if (group.length === 0) return null;
            return (
              <div key={scope} className="px-2 pb-2">
                <div className="text-muted-foreground px-2 pt-2 pb-1 text-[11px] font-medium tracking-wide uppercase">
                  {scopeLabel(scope)}
                </div>
                <ul className="m-0 list-none p-0">
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
                            "hover:bg-accent focus-visible:ring-ring/50 flex w-full items-center rounded-md px-2 py-1.5 text-left text-sm outline-none focus-visible:ring-2",
                            selected ? "bg-accent font-medium" : "",
                          )}
                        >
                          <span className="min-w-0 flex-1 truncate">{category.label}</span>
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
          className="min-h-0 min-w-0 flex-1 overflow-x-auto overflow-y-auto px-4 py-3"
        >
          {current ? (
            <section aria-labelledby={`settings-category-${current.id}`}>
              <div className="mb-3">
                <h3
                  id={`settings-category-${current.id}`}
                  ref={headingRef}
                  tabIndex={-1}
                  className="text-base font-semibold outline-none"
                >
                  {current.label}
                </h3>
                <p className="text-muted-foreground text-xs">
                  <span data-settings-category-scope className="text-foreground font-medium">
                    {scopeLabel(current.scope)} scope
                  </span>
                  {" — "}
                  {current.description}
                </p>
              </div>
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
