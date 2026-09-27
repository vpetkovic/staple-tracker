/**
 * Shared detail primitives. Both the frame and every tab import from here, so the detail
 * reads as one design. Add to these; do not rename them.
 */
export { RelativeTime, useNow } from "./RelativeTime";
export { formatDuration, formatExact, formatRelative, type RelativeTimeOptions } from "./relative-time";
export { PersonChip, PersonDisc, type PersonKind } from "./PersonChip";
export { DetailCard, EmptyState, SectionHeading } from "./layout";
