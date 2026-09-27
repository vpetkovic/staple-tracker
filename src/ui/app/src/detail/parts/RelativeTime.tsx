/**
 * A date as a person reads it, with the exact time in the tooltip.
 *
 * Renders a real `<time>`: `dateTime` carries the machine value, `title` the exact local
 * time, and the text the relative reading from `formatRelative`. It re-reads the clock
 * once a minute while mounted, so "Just now" does not stay "Just now" in a tab left open.
 */
import { useEffect, useState } from "react";
import { cn } from "./cn";
import { formatExact, formatRelative } from "./relative-time";

const TICK_MS = 60_000;

/** The current time, refreshed every minute while a component that asks for it is mounted. */
export function useNow(intervalMs: number = TICK_MS): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

export function RelativeTime({
  iso,
  now,
  timeZone,
  fallback = null,
  className,
}: {
  iso: string | null | undefined;
  /** Injected in tests; the live clock otherwise. */
  now?: Date;
  timeZone?: string;
  /** What to render when there is no date. Nothing, by default. */
  fallback?: React.ReactNode;
  className?: string;
}) {
  const live = useNow();
  const text = formatRelative(iso, { now: now ?? live, timeZone });
  if (!text || !iso) return <>{fallback}</>;
  return (
    <time dateTime={iso} title={formatExact(iso, { timeZone }) ?? undefined} className={cn("whitespace-nowrap", className)}>
      {text}
    </time>
  );
}
