/** Stable identity: a promoted epic is the original idea, so link by id in both cases. */
export function ideaPlanHref(workspace: string, id: string): string {
  return `?${new URLSearchParams({ ws: workspace, view: "plan", issue: id })}`;
}

export function PlannedIdeaLinks({ workspace, ideas }: { workspace: string; ideas: readonly { id: string; title: string }[] }) {
  if (ideas.length === 0) return null;
  return <section aria-label="Planned ideas" data-planned-ideas className="mt-3">
    <h3 className="mb-1 text-label font-medium">Planned ideas</h3>
    <ul className="m-0 list-none p-0">
      {ideas.map(idea => <li key={idea.id}><a href={ideaPlanHref(workspace, idea.id)} className="focus-ring flex min-h-11 items-center gap-2 rounded px-2 text-label text-text-secondary hover:bg-surface-hover" data-open-plan-idea={idea.id}><span aria-hidden>◇</span>{idea.title}<span aria-hidden className="ml-auto">↗</span></a></li>)}
    </ul>
  </section>;
}
