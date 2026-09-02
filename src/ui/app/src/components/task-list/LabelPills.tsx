/**
 * Label pills — V5 (STA-97) §8.
 *
 * ── TWO SHAPE DECISIONS THAT ARE THE WHOLE DIFFERENCE BETWEEN "GEIST" AND "GENERIC DARK" ──
 *
 * 1. TRANSPARENT FILL, while the working pill is filled. The obvious technical argument for
 *    this is wrong and worth naming so nobody "fixes" it: `--surface-hover` is an alpha
 *    token, so a filled pill painted over a hovered row composites alpha-over-alpha and
 *    stays MORE contrasted than the row, not less. Nothing dissolves. The real reason is
 *    weight — two label pills plus a `+N` plus a PR badge is four filled objects competing
 *    with the one filled object that matters, the live working pill. Outline for static
 *    metadata, fill for the live thing.
 *
 * 2. SQUARED (`--radius-md`), while the working pill is a full capsule. Static metadata is
 *    rectilinear; the one live, organic thing on the row is a capsule. That makes the
 *    working pill identifiable by SILHOUETTE alone from across the list, and it is a
 *    repeatable rule rather than two arbitrary radii.
 *
 * The pill is monochrome except the dot, which goes through the same `--sc` + `.status-fill`
 * recipe the status chips use — so label dots and status chips track a light/dark change
 * together and neither can drift into its own colour system. Fully tinted pills at this
 * density turn the right side of the list into confetti.
 */
import { labelHue, splitLabels } from "./label-hue";

function Dot({ label }: { label: string }) {
  return (
    <span
      className="status-fill staple-label-dot"
      aria-hidden="true"
      style={{ "--sc": `var(--label-hue-${labelHue(label)})` } as React.CSSProperties}
    />
  );
}

/**
 * `max` is decided by the caller from the viewport, not by a media query in here, because
 * the `+N` count changes with it and CSS cannot recount. See `useLabelCapacity`.
 *
 * Which labels show is SOURCE ORDER — `labels[0]`, `labels[1]`. Not alphabetical and not by
 * hue: whoever typed them put the important one first, and re-sorting destroys information
 * the row has no way to recover.
 */
export function LabelPills({ labels, max }: { labels: string[]; max: number }) {
  if (labels.length === 0) return null;
  const { shown, hidden } = splitLabels(labels, max);

  // Below 1024px names stop fitting and the cluster degrades to bare dots. Colour still
  // carries a category at a glance; a truncated word carries nothing. Hover restores names.
  if (max === 0) {
    const dots = labels.slice(0, 4);
    const rest = labels.slice(4);
    return (
      <span className="staple-label-cluster" title={labels.join(", ")} data-testid="label-dots">
        {dots.map((label) => (
          <Dot key={label} label={label} />
        ))}
        {rest.length > 0 ? <span className="staple-label-more">+{rest.length}</span> : null}
      </span>
    );
  }

  return (
    <span className="staple-label-cluster">
      {shown.map((label) => (
        <span key={label} className="staple-label-pill" data-testid="label-pill" title={label}>
          <Dot label={label} />
          <span className="staple-label-name">{label}</span>
        </span>
      ))}
      {hidden.length > 0 ? (
        <span
          className="staple-label-pill staple-label-overflow"
          data-testid="label-overflow"
          title={hidden.join(", ")}
        >
          +{hidden.length}
        </span>
      ) : null}
    </span>
  );
}
