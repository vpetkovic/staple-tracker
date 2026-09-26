/**
 * The card every plain-language block is built from (docs/web-ui.md, "Plain-language cards"):
 * a small title, an optional status pill, ONE headline figure, the answer sentence, an optional
 * visual, a "What does this mean?" help, and a "Show details" disclosure that keeps every
 * technical figure on the page for power users and agents.
 *
 * Reusable by any analytics block (the forecast, the budget limits, estimate accuracy, and the
 * budget pressure panel): layout only, no data, no calculation.
 *
 * Accessibility: the help is a real button (aria-expanded / aria-controls) whose text is in the
 * DOM either way; the details disclosure is a native <details>, keyboard-operable with no script.
 * Both controls are at least 24px tall with a visible focus ring; the chevron's turn is the only
 * motion and it is off under prefers-reduced-motion.
 */
import { ChevronDown, CircleHelp } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

const FOCUS = "outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-card";

export function PlainCard({
  title,
  pill,
  figure,
  headline,
  headlineTestId,
  help,
  details,
  detailsTestId,
  className,
  children,
  ...rest
}: {
  title: string;
  pill?: ReactNode;
  /** The one headline number (or word) of the card. */
  figure?: ReactNode;
  /** The plain-language answer sentence. */
  headline: ReactNode;
  headlineTestId?: string;
  /** "What does this mean?" in two or three short sentences. */
  help?: ReactNode;
  /** The technical figures, unchanged, behind "Show details". */
  details?: ReactNode;
  detailsTestId?: string;
  className?: string;
  children?: ReactNode;
} & Omit<React.ComponentProps<"section">, "title">) {
  return (
    <section
      data-slot="plain-card"
      aria-label={title}
      className={cn("flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-4 text-card-foreground", className)}
      {...rest}
    >
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <h4 className="min-w-0 flex-1 text-[12px] font-medium text-muted-foreground">{title}</h4>
        {pill}
      </header>
      <div className="space-y-1">
        {figure !== undefined && figure !== null && figure !== false ? (
          <p className="text-[26px] leading-tight font-semibold tracking-tight" data-figure>
            {figure}
          </p>
        ) : null}
        <p className="text-[14px] leading-relaxed text-pretty" data-testid={headlineTestId}>
          {headline}
        </p>
      </div>
      {children}
      {help || details ? (
        <div className="mt-auto flex flex-wrap items-center gap-x-5 gap-y-2 pt-1">
          {help ? <HelpToggle>{help}</HelpToggle> : null}
          {details ? <ShowDetails testId={detailsTestId}>{details}</ShowDetails> : null}
        </div>
      ) : null}
    </section>
  );
}

/**
 * "What does this mean?": a button that opens a short explanation inline. Inline rather than a
 * tooltip so it works the same on a touch screen, and the text is in the markup (hidden until
 * opened) so it is never lost.
 */
export function HelpToggle({ children, label = "What does this mean?" }: { children: ReactNode; label?: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className="contents">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((value) => !value)}
        className={cn("inline-flex min-h-6 items-center gap-1.5 rounded-md text-[12px] text-muted-foreground hover:text-foreground [@media(pointer:coarse)]:min-h-11", FOCUS)}
      >
        <CircleHelp aria-hidden className="size-3.5" />
        {label}
      </button>
      <p id={id} data-testid="plain-help" hidden={!open} className="order-last basis-full rounded-lg bg-muted/60 px-3 py-2 text-[13px] leading-relaxed text-foreground">
        {children}
      </p>
    </div>
  );
}

/** "Show details": a native disclosure, closed by default, holding the technical figures unchanged. */
export function ShowDetails({ children, testId, label = "Show details" }: { children: ReactNode; testId?: string; label?: string }) {
  return (
    <details className="group open:basis-full" data-testid={testId} data-details>
      <summary
        className={cn(
          "inline-flex min-h-6 cursor-pointer list-none items-center gap-1 rounded-md text-[12px] text-muted-foreground select-none hover:text-foreground [&::-webkit-details-marker]:hidden [@media(pointer:coarse)]:min-h-11",
          FOCUS,
        )}
      >
        <ChevronDown aria-hidden className="size-3.5 group-open:rotate-180 motion-safe:transition-transform" />
        <span className="group-open:hidden">{label}</span>
        <span className="hidden group-open:inline">Hide details</span>
      </summary>
      <div className="mt-2 space-y-2 border-t pt-2">{children}</div>
    </details>
  );
}
