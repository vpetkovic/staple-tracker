import { CircleDot, GitPullRequest, Plus } from "lucide-react";
import type { IssueDetail } from "@/lib/types";
import { openLinkExternal } from "@/lib/shell-events";
import { openDetailTab } from "@/detail/tabs/registry";
export function ExternalPropertySummary({
  detail,
  kind,
  compact = false,
}: {
  detail: IssueDetail;
  kind: "issue" | "pull_request";
  compact?: boolean;
}) {
  const links = (detail.externalLinks ?? []).filter((l) => l.resource.ref.kind === kind);
  const label = kind === "issue" ? "linked issues" : "pull requests";
  const Icon = kind === "issue" ? CircleDot : GitPullRequest;
  const providers = [...new Set(links.map((l) => l.resource.ref.providerId))];
  return (
    <span
      className={`inline-flex min-w-0 max-w-full items-center gap-1 ${compact ? "h-9 rounded-full border px-2 pointer-coarse:h-11" : ""}`}
    >
      <button
        type="button"
        className="focus-ring flex min-w-0 max-w-full items-center gap-1 text-xs hover:underline"
        aria-label={`${links.length} ${label}; show External links`}
        onClick={() => openDetailTab("external-links")}
      >
        <Icon aria-hidden className="size-3.5 shrink-0" />
        <span className="shrink-0">{links.length}</span>
        {compact ? (
          <span>{label}</span>
        ) : links.length ? (
          <span className="truncate" title={providers.join(", ")}>
            {providers.slice(0, 2).join(", ")} ·{" "}
            {links
              .slice(0, 2)
              .map((l) => l.resource.key)
              .join(", ")}
            {links.length > 2 ? ` +${links.length - 2}` : ""}
          </span>
        ) : (
          <span className="text-muted-foreground">None linked</span>
        )}
      </button>
      <button
        type="button"
        className="focus-ring flex size-7 shrink-0 items-center justify-center rounded hover:bg-accent pointer-coarse:size-9"
        aria-label={`Link ${kind === "issue" ? "issue" : "PR"}`}
        onClick={() => openLinkExternal({ workspace: detail.workspace, ref: detail.issue.id })}
      >
        <Plus className="size-3.5" aria-hidden />
      </button>
    </span>
  );
}
