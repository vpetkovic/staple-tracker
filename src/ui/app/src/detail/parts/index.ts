/**
 * Shared detail primitives. Both the frame and every tab import from here, so the detail
 * reads as one design. Add to these; do not rename them.
 */
export { RelativeTime, useNow } from "./RelativeTime";
export { formatDuration, formatExact, formatRelative, formatStamp, type RelativeTimeOptions } from "./relative-time";
export { PersonChip, PersonDisc, actorLabel, isWebAppActor, type PersonKind } from "./PersonChip";
export { DetailCard, EmptyState, SectionHeading } from "./layout";
export { cn } from "./cn";
export { PERSON_KEY, personActor, readPersonName, rememberPersonName } from "./person";
