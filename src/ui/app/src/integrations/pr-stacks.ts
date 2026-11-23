import type { ExternalLink } from "./model";
export interface PrStackRow {
  link: ExternalLink;
  depth: number;
  parent: ExternalLink | null;
}
export interface PrStack {
  id: string;
  label: string;
  rows: PrStackRow[];
}
/** Call within a provider/repository group. Display order never establishes a parent. */
export function prStacks(links: ExternalLink[]): PrStack[] {
  const prs = links.filter((l) => l.resource.ref.kind === "pull_request");
  const byId = new Map(prs.map((l) => [l.resource.id, l]));
  const children = new Map<string, ExternalLink[]>();
  const compare = (a: ExternalLink, b: ExternalLink) =>
    a.position - b.position || a.resource.key.localeCompare(b.resource.key);
  for (const link of prs)
    if (link.parentResourceId && byId.has(link.parentResourceId)) {
      const list = children.get(link.parentResourceId) ?? [];
      list.push(link);
      children.set(link.parentResourceId, list);
    }
  for (const list of children.values()) list.sort(compare);
  const seen = new Set<string>();
  const stacks: PrStack[] = [];
  const standalone: PrStackRow[] = [];
  const roots = prs
    .filter((l) => !l.parentResourceId || !byId.has(l.parentResourceId))
    .sort(compare);
  function walk(root: ExternalLink, label: string) {
    const rows: PrStackRow[] = [];
    const pending = [{ link: root, depth: 0, parent: null as ExternalLink | null }];
    while (pending.length) {
      const next = pending.pop()!;
      const id = next.link.resource.id;
      if (seen.has(id)) continue;
      seen.add(id);
      rows.push(next);
      for (const child of [...(children.get(id) ?? [])].reverse())
        pending.push({ link: child, depth: next.depth + 1, parent: next.link });
    }
    stacks.push({ id: root.resource.id, label, rows });
  }
  for (const root of roots) {
    if (root.parentResourceId) walk(root, "Parent not linked to this ticket");
    else if (children.has(root.resource.id)) walk(root, `Stack · ${root.resource.key}`);
    else {
      seen.add(root.resource.id);
      standalone.push({ link: root, depth: 0, parent: null });
    }
  }
  if (standalone.length)
    stacks.push({ id: "standalone", label: "PRs without a recorded parent", rows: standalone });
  // Invalid/mixed-version data must remain inspectable without hanging or disappearing.
  for (const link of prs)
    if (!seen.has(link.resource.id)) walk(link, "Hierarchy unavailable · review parent choices");
  return stacks;
}
export function parentChoices(link: ExternalLink, group: ExternalLink[]): ExternalLink[] {
  const descendants = new Set([link.resource.id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of group)
      if (
        row.parentResourceId &&
        descendants.has(row.parentResourceId) &&
        !descendants.has(row.resource.id)
      ) {
        descendants.add(row.resource.id);
        changed = true;
      }
  }
  return group.filter(
    (row) => row.resource.ref.kind === "pull_request" && !descendants.has(row.resource.id),
  );
}
