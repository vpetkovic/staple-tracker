import { useEffect, useState, type ReactNode } from "react";
import { GitBranch, GitPullRequest, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { prStacks, prTreeRows, parentChoices } from "./pr-stacks";
import type { ExternalLink } from "./model";
export function PrStackView({
  links,
  busy,
  renderCard,
  onSave,
}: {
  links: ExternalLink[];
  busy: boolean;
  renderCard: (link: ExternalLink, editor: ReactNode) => ReactNode;
  onSave: (link: ExternalLink, parent: string | null, position: number) => Promise<void>;
}) {
  return (
    <div className="space-y-3">
      {prStacks(links).map((stack) => (
        <details key={stack.id} open className="rounded-lg border p-3">
          <summary className="focus-ring cursor-pointer text-sm font-medium wrap-anywhere">
            <GitBranch className="inline size-4 mr-1" aria-hidden />
            {stack.label}
            <span className="ml-2 text-xs text-muted-foreground">
              {stack.rows.length} PR{stack.rows.length === 1 ? "" : "s"}
            </span>
          </summary>
          <ul className="mt-3" aria-label={stack.label}>
            {prTreeRows(stack.rows).map(({ link, depth, parent, guides }) => (
              <li key={link.id} data-pr-depth={depth} className="relative min-w-0"
                style={{ paddingInlineStart: `${Math.min(depth, 3) * 16}px` }}>
                {guides.map((continues, level) => <span key={level} aria-hidden
                  className={`pointer-events-none absolute top-0 w-3 border-border ${continues ? "h-full border-l" : ""}`}
                  style={{ insetInlineStart: `${level * 16 + 3}px` }}>
                  {level === guides.length - 1 ? <span className="absolute top-0 h-5 w-3 rounded-bl border-b border-l border-border" /> : null}
                </span>)}
                <details className="group/pr min-w-0 py-1">
                  <summary className="focus-ring flex min-w-0 cursor-pointer list-none items-start gap-2 rounded-md px-2 py-2 hover:bg-accent [&::-webkit-details-marker]:hidden">
                    <ChevronRight aria-hidden className="mt-0.5 size-3.5 shrink-0 transition-transform group-open/pr:rotate-90" />
                    <GitPullRequest aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-xs text-muted-foreground wrap-anywhere">{link.resource.key}</span>
                      <span className="block text-sm font-medium wrap-anywhere">{link.resource.title ?? "Pull request"}</span>
                      {parent ? <span className="block text-xs text-muted-foreground wrap-anywhere">After {parent.resource.key}</span>
                        : link.parentResourceId ? <span className="block text-xs text-muted-foreground">Parent is not linked here</span> : null}
                    </span>
                    {link.resource.status ? <span className="shrink-0 rounded-full border px-2 py-0.5 text-xs">{link.resource.status.name}</span> : null}
                  </summary>
                  <div className="mt-1 min-w-0">
                    {renderCard(link, <PrParentEditor link={link} links={links} busy={busy}
                      onSave={(parent, position) => onSave(link, parent, position)} />)}
                  </div>
                </details>
              </li>
            ))}
          </ul>
        </details>
      ))}
    </div>
  );
}
function PrParentEditor({
  link,
  links,
  busy,
  onSave,
}: {
  link: ExternalLink;
  links: ExternalLink[];
  busy: boolean;
  onSave: (parent: string | null, position: number) => Promise<void>;
}) {
  const [parent, setParent] = useState(link.parentResourceId ?? "");
  const [position, setPosition] = useState(String(link.position));
  useEffect(() => {
    setParent(link.parentResourceId ?? "");
    setPosition(String(link.position));
  }, [link.parentResourceId, link.position]);
  const options = parentChoices(link, links);
  const unknown = parent && !options.some((l) => l.resource.id === parent);
  return (
    <details className="text-xs">
      <summary className="cursor-pointer text-muted-foreground">
        Edit local parent and order
      </summary>
      <form
        className="mt-2 space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          void onSave(parent || null, Number(position));
        }}
      >
        <p className="text-muted-foreground">
          This records the relationship in Staple. It does not change branches or PRs.
        </p>
        <label className="block space-y-1">
          <span>Parent PR</span>
          <select
            aria-label={`Parent for ${link.resource.key}`}
            className="block w-full min-w-0 rounded border bg-background p-2"
            disabled={busy}
            value={parent}
            onChange={(e) => setParent(e.target.value)}
          >
            <option value="">No recorded parent</option>
            {unknown ? <option value={parent}>Parent not linked here</option> : null}
            {options.map((l) => (
              <option key={l.id} value={l.resource.id}>
                {l.resource.key} · {l.resource.title ?? "PR reference"}
              </option>
            ))}
          </select>
        </label>
        <label className="block space-y-1">
          <span>Order (0 = not set)</span>
          <Input
            aria-label={`Order for ${link.resource.key}`}
            type="number"
            min={0}
            step={1}
            className="max-w-32"
            value={position}
            disabled={busy}
            onChange={(e) => setPosition(e.target.value)}
            required
          />
        </label>
        <Button type="submit" size="sm" variant="outline" disabled={busy}>
          Save relationship
        </Button>
      </form>
    </details>
  );
}
