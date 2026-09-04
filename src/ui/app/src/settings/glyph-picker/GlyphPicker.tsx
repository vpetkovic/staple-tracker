/**
 * THE GLYPH PICKER — R5d (STA-184). One kind's appearance, chosen from three sources.
 *
 * Opens inline under a kind's row in the Kinds editor. Three tabs — the Lucide catalog,
 * an emoji or Unicode glyph, a custom SVG — and one preview, and every tab ends in the
 * same place: `onChoose(choice)`, a `{ source, value, label, fallback }` the Kinds draft
 * stores. Nothing here writes; Save on the section's ActionBar does, as one batch.
 *
 * ── THE CATALOG IS WINDOWED, AND ITS ICONS ARE A LAZY CHUNK ───────────────────────────
 *
 * `searchIcons` answers over 1,800 entries for an empty query. The grid holds a
 * viewport's worth of cells plus an overscan (`gridWindow`, in the model) and two
 * spacers stand in for the rest, so scrolling the whole catalog costs the DOM a few
 * dozen nodes at a time. The icon COMPONENTS arrive through `loadIconComponents` —
 * the `import()` that makes the module naming every icon its own chunk — and only
 * once the catalog tab is open, so a page that never opens the picker never fetches
 * them and the main bundle never contains them. Until they land, a cell is a blank
 * box with the icon's name; the search, the keyboard and the choice all work without
 * them.
 *
 * ── ONE LISTBOX, ONE ACTIVE OPTION ────────────────────────────────────────────────────
 *
 * The grid is a `listbox` that takes focus itself and names its active cell through
 * `aria-activedescendant`, which is what lets a windowed grid be keyboard-navigable at
 * all: the cell that has the "focus" need not be in the DOM until the arrow key that
 * reaches it scrolls it into the window. Arrows step a cell or a row, Home and End
 * jump, Enter or Space chooses, Escape closes. Every option is `role="option"` with
 * `aria-selected` and the icon's label as its accessible name.
 *
 * ── A CUSTOM SVG IS SANITISED SERVER-SIDE FIRST ───────────────────────────────────────
 *
 * The store accepts an `svg` value only as the sanitiser's canonical output, and the
 * sanitiser is core code the browser cannot import. So the raw document goes to
 * `POST /api/glyph/sanitize` (`sanitize`, injected so a test needs no fetch) and only
 * the canonical result becomes a choice — through the same `glyphChoiceProblem` gate
 * as everything else, which recognises exactly that shape. The raw text never enters
 * the draft.
 *
 * ── THE PREVIEW IS THE ROW'S RENDERER ─────────────────────────────────────────────────
 *
 * `GlyphPreview` draws the appearance the draft currently holds at the row's size and
 * the graph's, through `KindGlyph` (see that file for the one `lucide` exception).
 * The arrangement follows the dialog: beside the chooser when the dialog is two-pane
 * or full screen, below it when the dialog is stacked — the same `STACKED_QUERY`, so
 * the picker never disagrees with the shell about how wide the world is.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { LucideIcon } from "lucide-react";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  ICON_CATEGORIES,
  iconLabel,
  loadIconComponents,
  searchIcons,
  type IconCategory,
  type IconKey,
} from "@/lib/icon-catalog";
import { SVG_MAX_BYTES, type KindAppearance } from "@/lib/kind-appearance";
import { cn } from "@/lib/utils";
import { InlineError } from "../form/primitives";
import { STACKED_QUERY } from "../settings-shell";
import { GlyphPreview, PREVIEW_SIZES } from "./GlyphPreview";
import {
  choiceOf,
  emojiChoice,
  fallbackProblem,
  glyphChoiceProblem,
  gridColumns,
  gridWindow,
  labelProblem,
  lucideChoice,
  moveActive,
  pushRecent,
  readRecents,
  scrollTopFor,
  svgChoice,
  writeRecents,
  type GlyphChoice,
  type GlyphSource,
} from "./glyph-picker-model";

export type GlyphPickerLayout = "stacked" | "wide";

/** The server's sanitiser, as the picker calls it. `problem` is the store's sentence. */
export type SanitizeSvg = (input: {
  svg: string;
  label: string;
}) => Promise<{ ok: true; svg: string } | { ok: false; problem: string }>;

export interface GlyphPickerProps {
  kind: { id: string; label: string };
  /** What the kind wears under the draft — what the preview and the selected option show. */
  appearance: KindAppearance;
  /** No entry in the draft map: "Reset to default" has nothing to do. */
  isDefault: boolean;
  disabled?: boolean;
  onChoose: (choice: GlyphChoice) => void;
  onReset: () => void;
  onClose: () => void;
  sanitize: SanitizeSvg;
  /** Defaults to the dialog's own stacked query; a test names it. */
  layout?: GlyphPickerLayout;
  /** The tab to open on. Defaults to the current appearance's source, or the catalog. */
  initialSource?: GlyphSource;
  /** Where recents live. Defaults to `localStorage`; a test passes its own or null. */
  storage?: Pick<Storage, "getItem" | "setItem"> | null;
}

const SOURCES: readonly { id: GlyphSource; label: string }[] = [
  { id: "lucide", label: "Catalog" },
  { id: "emoji", label: "Emoji" },
  { id: "svg", label: "Custom SVG" },
];
const SOURCE_NAME: Record<KindAppearance["source"], string> = {
  lucide: "catalog icon",
  emoji: "emoji",
  svg: "custom SVG",
  none: "built-in mark",
};
const ALL_CATEGORIES = "__all__";
/** One cell, including its gap, in px. The grid's row height and its column unit. */
const CELL = 44;
const VIEWPORT = 240;
/** The icon size inside a cell: StatusIcon's 16, so a cell reads at the list's weight. */
const CELL_ICON = 16;

/** Same query as the dialog, so the picker stacks exactly when the shell does. */
function useLayout(override?: GlyphPickerLayout): GlyphPickerLayout {
  const [stacked, setStacked] = useState(
    () => typeof window !== "undefined" && !!window.matchMedia && window.matchMedia(STACKED_QUERY).matches,
  );
  useEffect(() => {
    if (override || typeof window === "undefined" || !window.matchMedia) return;
    const query = window.matchMedia(STACKED_QUERY);
    const onChange = () => setStacked(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, [override]);
  return override ?? (stacked ? "stacked" : "wide");
}

function defaultStorage(): Pick<Storage, "getItem" | "setItem"> | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function GlyphPicker({
  kind,
  appearance,
  isDefault,
  disabled = false,
  onChoose,
  onReset,
  onClose,
  sanitize,
  layout: layoutOverride,
  initialSource,
  storage: storageOverride,
}: GlyphPickerProps) {
  const layout = useLayout(layoutOverride);
  const storage = storageOverride === undefined ? defaultStorage() : storageOverride;
  const [source, setSource] = useState<GlyphSource>(
    initialSource ?? (appearance.source === "none" ? "lucide" : appearance.source),
  );
  const [recents, setRecents] = useState<GlyphChoice[]>(() => readRecents(storage));

  // The two text fields every choice carries. Held as text so a half-typed value is
  // shown as typed; applied to the draft only when they pass the mirror of core's bounds.
  const [label, setLabel] = useState(appearance.label);
  const [fallback, setFallback] = useState(appearance.fallback);
  const labelError = labelProblem(label);
  const fallbackError = fallbackProblem(fallback);
  const current = useMemo(
    () => ({ label: label.trim() === "" ? kind.label : label.trim(), fallback }),
    [fallback, kind.label, label],
  );

  const [problem, setProblem] = useState<string | null>(null);
  const choose = useCallback(
    (choice: GlyphChoice) => {
      const refused = glyphChoiceProblem(choice);
      setProblem(refused);
      if (refused || disabled) return;
      onChoose(choice);
      const next = pushRecent(recents, choice);
      setRecents(next);
      writeRecents(storage, next);
    },
    [disabled, onChoose, recents, storage],
  );
  /** A label or fallback edit re-chooses the current glyph with the new text. */
  const commitText = useCallback(() => {
    const choice = choiceOf(appearance);
    if (!choice || labelError || fallbackError) return;
    if (choice.label === current.label && choice.fallback === current.fallback) return;
    choose({ ...choice, label: current.label, fallback: current.fallback });
  }, [appearance, choose, current, fallbackError, labelError]);

  // ---------------------------------------------------------------- the catalog

  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<IconCategory | undefined>(undefined);
  const results = useMemo(() => searchIcons(query, { category }), [category, query]);
  const [active, setActive] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [columns, setColumns] = useState(8);
  const [icons, setIcons] = useState<Readonly<Record<IconKey, LucideIcon>> | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setActive(0);
  }, [results]);

  useEffect(() => {
    if (source !== "lucide" || icons !== null) return;
    let alive = true;
    void loadIconComponents().then((loaded) => {
      if (alive) setIcons(loaded);
    });
    return () => {
      alive = false;
    };
  }, [icons, source]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const measure = () => {
      const width = gridRef.current?.clientWidth;
      if (width) setColumns(gridColumns(width, CELL));
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [source, layout]);

  const visible = gridWindow({ count: results.length, columns, rowHeight: CELL, scrollTop, viewportHeight: VIEWPORT });
  const optionId = (key: string) => `glyph-option-${kind.id}-${key}`;

  const onGridKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = moveActive({ index: active, key: event.key, columns, count: results.length });
    if (next !== null) {
      event.preventDefault();
      setActive(next);
      const top = scrollTopFor({ index: next, columns, rowHeight: CELL, scrollTop, viewportHeight: VIEWPORT });
      if (top !== scrollTop && gridRef.current) {
        gridRef.current.scrollTop = top;
        setScrollTop(top);
      }
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const entry = results[active];
      if (entry) choose(lucideChoice(entry, current));
    } else if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  };

  // ---------------------------------------------------------------- emoji and svg

  const [emoji, setEmoji] = useState(appearance.source === "emoji" ? appearance.value : "");
  const [svg, setSvg] = useState("");
  const [svgProblem, setSvgProblem] = useState<string | null>(null);
  const [sanitising, setSanitising] = useState(false);

  const sanitiseAndUse = async () => {
    setSanitising(true);
    setSvgProblem(null);
    const result = await sanitize({ svg, label: current.label });
    setSanitising(false);
    if (!result.ok) {
      setSvgProblem(result.problem);
      return;
    }
    choose(svgChoice(result.svg, current));
  };

  const isSelected = (choice: Pick<GlyphChoice, "source" | "value">) =>
    appearance.source === choice.source && appearance.value === choice.value;

  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const index = SOURCES.findIndex((tab) => tab.id === source);
    const next = event.key === "ArrowRight" ? index + 1 : event.key === "ArrowLeft" ? index - 1 : -1;
    const tab = SOURCES[next];
    if (!tab) return;
    event.preventDefault();
    setSource(tab.id);
    (event.currentTarget.parentElement?.children[next] as HTMLElement | undefined)?.focus();
  };

  return (
    <div
      role="group"
      aria-label={`Glyph for ${kind.label}`}
      data-glyph-picker={kind.id}
      data-layout={layout}
      className={cn(
        "rounded-md border border-dashed p-2",
        layout === "wide" ? "grid grid-cols-[minmax(0,1fr)_minmax(0,14rem)] gap-3" : "flex flex-col gap-3",
      )}
    >
      <div className="min-w-0 space-y-2">
        {recents.length > 0 ? (
          <div
            role="listbox"
            aria-label="Recent glyphs"
            data-glyph-recents
            className="flex flex-wrap items-center gap-1"
          >
            {recents.map((recent) => {
              const name = recent.source === "lucide" ? iconLabel(recent.value) : recent.value;
              return (
                <div
                  key={`${recent.source}:${recent.value}`}
                  role="option"
                  tabIndex={0}
                  aria-selected={isSelected(recent)}
                  aria-label={name}
                  title={name}
                  className="flex size-8 cursor-pointer items-center justify-center rounded-md border aria-selected:bg-accent"
                  onClick={() => choose({ ...recent, ...current })}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      choose({ ...recent, ...current });
                    }
                  }}
                >
                  <GlyphPreview
                    kind={kind.id}
                    appearance={{ ...recent, ...current }}
                    size={PREVIEW_SIZES.graph}
                  />
                </div>
              );
            })}
          </div>
        ) : null}

        <div role="tablist" aria-label="Glyph source" className="flex items-center gap-1">
          {SOURCES.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              id={`glyph-tab-${kind.id}-${tab.id}`}
              aria-selected={source === tab.id}
              aria-controls={`glyph-panel-${kind.id}-${tab.id}`}
              tabIndex={source === tab.id ? 0 : -1}
              disabled={disabled}
              onClick={() => setSource(tab.id)}
              onKeyDown={onTabKeyDown}
              className={cn(
                "rounded-md border px-2 py-1 text-[12px]",
                source === tab.id ? "bg-accent font-medium" : "text-muted-foreground",
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div
          role="tabpanel"
          id={`glyph-panel-${kind.id}-${source}`}
          aria-labelledby={`glyph-tab-${kind.id}-${source}`}
          className="space-y-2"
        >
          {source === "lucide" ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  type="search"
                  value={query}
                  aria-label="Search icons"
                  placeholder="Search names, aliases…"
                  disabled={disabled}
                  onChange={(event) => setQuery(event.target.value)}
                  className="h-7 min-w-0 flex-1 text-[13px]"
                />
                <Select
                  value={category ?? ALL_CATEGORIES}
                  disabled={disabled}
                  onValueChange={(value) => setCategory(value === ALL_CATEGORIES ? undefined : (value as IconCategory))}
                >
                  <SelectTrigger size="sm" aria-label="Icon category" className="w-[9rem] shrink-0 text-[12px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL_CATEGORIES}>All categories</SelectItem>
                    {ICON_CATEGORIES.map((id) => (
                      <SelectItem key={id} value={id}>
                        {id}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <span aria-live="polite" data-glyph-count className="text-[11px] text-text-tertiary">
                  {results.length} {results.length === 1 ? "icon" : "icons"}
                </span>
              </div>
              <div
                ref={gridRef}
                role="listbox"
                aria-label="Icon catalog"
                aria-activedescendant={results[active] ? optionId(results[active].key) : undefined}
                tabIndex={0}
                data-glyph-grid
                data-columns={columns}
                onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
                onKeyDown={onGridKeyDown}
                style={{ height: VIEWPORT }}
                className="overflow-y-auto rounded-md border outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                <div style={{ height: visible.topPad }} aria-hidden="true" />
                <div className="grid gap-1 p-0.5" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
                  {results.slice(visible.start, visible.end).map((entry, offset) => {
                    const index = visible.start + offset;
                    const Icon = icons?.[entry.key];
                    return (
                      <div
                        key={entry.key}
                        id={optionId(entry.key)}
                        role="option"
                        aria-selected={isSelected({ source: "lucide", value: entry.key })}
                        aria-label={entry.label}
                        title={entry.label}
                        data-glyph-option={entry.key}
                        data-active={index === active ? "" : undefined}
                        onClick={() => {
                          setActive(index);
                          choose(lucideChoice(entry, current));
                        }}
                        className="flex h-10 cursor-pointer items-center justify-center rounded-md border border-transparent hover:border-border aria-selected:bg-accent data-active:ring-2 data-active:ring-ring/50"
                      >
                        {Icon ? (
                          <Icon size={CELL_ICON} aria-hidden="true" focusable="false" />
                        ) : (
                          <span aria-hidden="true" className="size-4 rounded-sm bg-muted" />
                        )}
                      </div>
                    );
                  })}
                </div>
                <div style={{ height: visible.bottomPad }} aria-hidden="true" />
              </div>
            </>
          ) : null}

          {source === "emoji" ? (
            <div className="space-y-1">
              <Input
                value={emoji}
                aria-label="Emoji or Unicode glyph"
                placeholder="e.g. 🐞 or →"
                disabled={disabled}
                onChange={(event) => {
                  const value = event.target.value;
                  setEmoji(value);
                  if (value !== "") choose(emojiChoice(value, current));
                }}
                className="h-7 w-40 text-[16px]"
              />
              <p className="text-[12px] leading-relaxed text-muted-foreground">
                One or two visible characters — a joined family or a flag counts as one. Drawn as text on
                every surface, so it is safe by construction.
              </p>
            </div>
          ) : null}

          {source === "svg" ? (
            <div className="space-y-1">
              <Textarea
                value={svg}
                aria-label="Custom SVG document"
                placeholder="<svg viewBox=&quot;0 0 16 16&quot;>…</svg>"
                disabled={disabled || sanitising}
                onChange={(event) => setSvg(event.target.value)}
                className="min-h-24 font-mono text-[12px]"
              />
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={disabled || sanitising || svg.trim() === ""}
                  aria-busy={sanitising}
                  onClick={() => void sanitiseAndUse()}
                >
                  {sanitising ? "Sanitising…" : "Sanitise and use"}
                </Button>
                <span className="text-[12px] leading-relaxed text-muted-foreground">
                  Up to {SVG_MAX_BYTES / 1024} KiB of shapes; the server strips editor noise, refuses anything that
                  can run or fetch, and only its canonical output is stored.
                </span>
              </div>
              {svgProblem ? <InlineError>{svgProblem}</InlineError> : null}
            </div>
          ) : null}

          {problem ? <InlineError>{problem}</InlineError> : null}
        </div>
      </div>

      <aside data-glyph-preview className="min-w-0 space-y-2 rounded-md border px-2 py-2" aria-label="Preview">
        <p className="text-[11px] tracking-[var(--tracking-eyebrow)] text-text-tertiary uppercase">Preview</p>
        <div className="flex items-center gap-4 text-[11px] text-text-tertiary">
          <span className="inline-flex items-center gap-1.5" data-preview-size="row">
            <GlyphPreview kind={kind.id} appearance={appearance} size={PREVIEW_SIZES.row} className="text-foreground" />
            list row
          </span>
          <span className="inline-flex items-center gap-1.5" data-preview-size="graph">
            <GlyphPreview kind={kind.id} appearance={appearance} size={PREVIEW_SIZES.graph} className="text-foreground" />
            graph node
          </span>
        </div>
        <p className="text-[12px] leading-snug" data-preview-caption>
          <span className="font-medium">{appearance.label}</span>
          <span className="text-muted-foreground">
            {" "}
            · {SOURCE_NAME[appearance.source]}
            {appearance.source === "lucide" ? ` ${appearance.value}` : ""} · terminal{" "}
            <code className="font-mono">{appearance.fallback}</code>
          </span>
        </p>
        <div className="space-y-1">
          <Input
            value={label}
            aria-label={`Accessible name for ${kind.label}`}
            placeholder={kind.label}
            disabled={disabled}
            aria-invalid={labelError ? true : undefined}
            onChange={(event) => setLabel(event.target.value)}
            onBlur={commitText}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commitText();
              }
            }}
            className="h-7 text-[12px]"
          />
          {labelError ? <InlineError>{labelError}</InlineError> : null}
          <Input
            value={fallback}
            aria-label={`Terminal fallback for ${kind.label}`}
            disabled={disabled}
            aria-invalid={fallbackError ? true : undefined}
            onChange={(event) => setFallback(event.target.value)}
            onBlur={commitText}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commitText();
              }
            }}
            className="h-7 w-20 font-mono text-[12px]"
          />
          {fallbackError ? <InlineError>{fallbackError}</InlineError> : null}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={disabled || isDefault}
            onClick={onReset}
            title="Back to the built-in mark (saved when you save)"
          >
            <RotateCcw className="size-3.5" aria-hidden />
            Reset to default
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={onClose}>
            Done
          </Button>
        </div>
      </aside>
    </div>
  );
}
