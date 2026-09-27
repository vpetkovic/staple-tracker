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
 * Wide: both panes, always, the way a desktop app's preferences window is laid out. The LEFT
 * pane is a sidebar on the desk tint: the sheet's title and one sentence at its top, then the
 * sections, each an icon and a plain name (`settingsName`), the selected one filled. The
 * RIGHT pane is the section on the raised surface, set in a readable column: its name as a
 * heading, who it applies to as a small tag, what it is for in one sentence, then its
 * controls. Full screen and Close sit at the pane's top right. Narrow (`stacked`, a phone): a full-screen sheet showing the
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
import { ArrowLeft, ChevronRight, Folder, Globe, Maximize2, Minimize2, XIcon } from "lucide-react";
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
  settingsName,
  type ScopeSummary,
  type ScrollMemory,
  type ShellLayout,
  type ShellMode,
  type ShellPane,
} from "./settings-shell";
import { settingsIcon } from "./settings-icons";

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
  /**
   * On a phone the list opens with nothing focused — a focus ring on the first row of a
   * sheet you just tapped open reads as a selection nobody made. Focus follows the two
   * transitions instead: into the section's heading on the way in, back to the row you
   * came from on the way out.
   */
  const previousPane = useRef(pane);
  useEffect(() => {
    const was = previousPane.current;
    previousPane.current = pane;
    if (!stacked) return;
    if (pane === "content") headingRef.current?.focus({ preventScroll: true });
    else if (was === "content") focusActiveNav();
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

  const closeButton = (
    <Button
      variant="ghost"
      size="icon"
      aria-label="Close settings"
      title="Close (Esc)"
      onClick={onClose}
      className={cn("rounded-lg text-text-tertiary hover:text-foreground", stacked ? "-mr-2 size-11" : "")}
    >
      <XIcon className={stacked ? "size-5" : "size-4"} />
    </Button>
  );

  const nav = (
    <nav
      ref={navRef}
      aria-label="Settings categories"
      hidden={!showNav}
      className={cn(
        "staple-momentum min-h-0 shrink-0 overflow-y-auto",
        stacked
          ? "w-full py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]"
          : "flex w-64 flex-col border-r bg-surface-canvas pb-3",
      )}
    >
      {stacked ? null : (
        // The sheet's name heads the sidebar on a desk, the way a preferences window's does.
        <div className="px-5 pt-5 pb-3">
          <TitleTag className="text-heading leading-tight font-semibold">{SETTINGS_TITLE}</TitleTag>
          <DescriptionTag data-settings-scope className="mt-1 text-label text-muted-foreground">
            {scopeSummaryText(scope)}
          </DescriptionTag>
        </div>
      )}
      {SCOPE_ORDER.map((scope) => {
        const group = categories.filter((c) => c.scope === scope);
        if (group.length === 0) return null;
        return (
          <div key={scope} data-settings-group={scope} className={cn(stacked ? "px-3 pb-4" : "px-3 pt-2 pb-1")}>
            <div
              className={cn(
                "px-2 pt-2 pb-1 font-medium",
                stacked ? "text-[13px] text-muted-foreground" : "text-label text-text-tertiary",
              )}
            >
              {scopeHeading(scope)}
            </div>
            <ul
              className={cn(
                "m-0 flex list-none flex-col p-0",
                stacked ? "divide-y overflow-hidden rounded-xl border bg-card" : "gap-px",
              )}
            >
              {group.map((category) => {
                const selected = category.id === active;
                const Icon = settingsIcon(category.id);
                return (
                  <li key={category.id}>
                    <button
                      type="button"
                      data-settings-category={category.id}
                      aria-current={selected ? "page" : undefined}
                      onClick={() => onSelect(category.id)}
                      className={cn(
                        "flex w-full items-center text-left",
                        stacked
                          ? "min-h-12 gap-3 px-4 py-3 text-[16px] hover:bg-accent focus-ring-inset active:bg-accent"
                          : cn(
                              "h-9 gap-2.5 rounded-lg px-2.5 pointer-coarse:h-11 text-body text-sidebar-foreground/85 transition-colors focus-ring-inset",
                              "hover:bg-surface-hover hover:text-foreground [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-text-tertiary",
                              "aria-[current]:bg-surface-selected aria-[current]:font-medium aria-[current]:text-foreground aria-[current]:[&_svg]:text-foreground",
                            ),
                      )}
                    >
                      {stacked ? null : <Icon aria-hidden />}
                      <span className="min-w-0 flex-1 truncate">{settingsName(category)}</span>
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
  );

  const section = current ? (
    <section aria-labelledby={`settings-category-${current.id}`} className={cn(!stacked && "mx-auto max-w-[52rem]")}>
      <div className={stacked ? "mb-3" : "mb-6"}>
        <h3
          id={`settings-category-${current.id}`}
          ref={headingRef}
          tabIndex={-1}
          className={cn("font-semibold outline-none", stacked ? "text-[18px]" : "text-heading")}
        >
          {settingsName(current)}
        </h3>
        {stacked ? (
          <p className="text-muted-foreground text-xs">
            <span data-settings-category-scope className="text-foreground font-medium">
              {appliesToText(current.scope, scope.workspace)}
            </span>
            {" — "}
            {current.description}
          </p>
        ) : (
          <>
            <p className="mt-1.5 inline-flex items-center gap-1.5 rounded-full border bg-surface-sunken px-2.5 py-0.5 text-label text-text-secondary">
              {current.scope === "global" ? (
                <Globe aria-hidden className="size-3.5 text-text-tertiary" />
              ) : (
                <Folder aria-hidden className="size-3.5 text-text-tertiary" />
              )}
              <span data-settings-category-scope>{appliesToText(current.scope, scope.workspace)}</span>
            </p>
            <p className="mt-2 max-w-readable text-reading text-muted-foreground">{current.description}</p>
          </>
        )}
      </div>
      {current.scope === "workspace" && workspacePicker ? (
        <div data-settings-workspace-picker className={stacked ? "mb-4" : "mb-6"}>
          {workspacePicker}
        </div>
      ) : null}
      {renderCategory(current)}
    </section>
  ) : (
    fallback
  );

  if (!stacked) {
    return (
      <div data-settings-shell data-layout={layout} data-pane={pane} data-mode={mode} className="flex h-full min-h-0">
        {nav}
        <div className="relative flex min-w-0 flex-1 flex-col bg-surface-raised">
          <div className="absolute top-3 right-3 z-10 flex items-center gap-1" data-settings-actions>
            <Button
              variant="ghost"
              size="icon"
              aria-label={mode === "full" ? "Exit full screen" : "Enter full screen"}
              title={mode === "full" ? "Exit full screen" : "Full screen"}
              aria-pressed={mode === "full"}
              onClick={onToggleMode}
              className="rounded-lg text-text-tertiary hover:text-foreground"
            >
              {mode === "full" ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
            </Button>
            {closeButton}
          </div>
          <div
            ref={contentRef}
            onScroll={onContentScroll}
            data-settings-content
            className="staple-momentum min-h-0 min-w-0 flex-1 overflow-x-auto overflow-y-auto px-10 pt-7 pb-10"
          >
            {section}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      data-settings-shell
      data-layout={layout}
      data-pane={pane}
      data-mode={mode}
      className="flex h-full min-h-0 flex-col"
    >
      <header className="flex shrink-0 items-center gap-2 border-b px-4 py-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
        {pane === "content" ? (
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
          <TitleTag className="text-[20px] leading-tight font-semibold tracking-tight">{SETTINGS_TITLE}</TitleTag>
          <DescriptionTag
            data-settings-scope
            className={cn("text-muted-foreground mt-1 text-xs", pane === "content" && "sr-only")}
          >
            {scopeSummaryText(scope)}
          </DescriptionTag>
        </div>
        {closeButton}
      </header>

      <div className="flex min-h-0 flex-1">
        {nav}
        <div
          ref={contentRef}
          onScroll={onContentScroll}
          hidden={!showContent}
          data-settings-content
          // `overflow-x-auto` is deliberate: a row wider than a phone scrolls sideways inside
          // this pane rather than being cut off, so every control on it stays reachable.
          className="staple-momentum min-h-0 min-w-0 flex-1 overflow-x-auto overflow-y-auto px-4 py-3 pb-[max(1rem,env(safe-area-inset-bottom))]"
        >
          {section}
        </div>
      </div>
    </div>
  );
}
