import { useEffect, useRef, useState } from "react";
import { CircleDot, GitPullRequest } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useOptionalSession } from "@/lib/session";
import { openTabOnArrival, openDetailTab } from "@/detail/tabs/registry";
import type { ExternalRowSummary } from "../../../../core/integrations/link-store";

export function ExternalLinkBadges({
  summary,
  workspace,
  issueId,
  issueRef,
}: {
  summary?: ExternalRowSummary;
  workspace: string;
  issueId: string;
  issueRef?: string;
}) {
  if (!summary) return null;
  return (
    <span className="inline-flex shrink-0 items-center gap-1" data-external-link-badges>
      <QuickList
        group={summary.issues}
        kind="issues"
        workspace={workspace}
        issueId={issueId}
        issueRef={issueRef}
      />
      <QuickList
        group={summary.pullRequests}
        kind="pull requests"
        workspace={workspace}
        issueId={issueId}
        issueRef={issueRef}
      />
    </span>
  );
}
function QuickList({
  group,
  kind,
  workspace,
  issueId,
  issueRef,
}: {
  group: ExternalRowSummary["issues"];
  kind: "issues" | "pull requests";
  workspace: string;
  issueId: string;
  issueRef?: string;
}) {
  const [open, setOpen] = useState(false);
  const session = useOptionalSession();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const content = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  if (!group.count) return null;
  const label = `${group.count} linked ${kind}`;
  const enter = () => {
    clearTimeout(timer.current);
    setOpen(true);
  };
  const leave = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (
        !content.current?.contains(document.activeElement) &&
        document.activeElement !== trigger.current
      )
        setOpen(false);
    }, 180);
  };
  const Icon = kind === "issues" ? CircleDot : GitPullRequest;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          ref={trigger}
          type="button"
          aria-label={label}
          className="focus-ring inline-flex h-7 items-center gap-1 rounded px-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground pointer-coarse:min-h-9"
          onPointerEnter={(e) => {
            if (e.pointerType === "mouse") enter();
          }}
          onPointerLeave={leave}
          onFocus={enter}
          onBlur={leave}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            enter();
          }}
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "ArrowDown") {
              e.preventDefault();
              enter();
              requestAnimationFrame(() =>
                content.current?.querySelector<HTMLAnchorElement>("a")?.focus(),
              );
            }
          }}
        >
          <Icon className="size-3.5" aria-hidden />
          <span>{group.count}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        ref={content}
        aria-label={`Linked ${kind}`}
        align="end"
        className="w-80 max-w-[calc(100vw-1rem)] p-3"
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
        onPointerEnter={() => clearTimeout(timer.current)}
        onPointerLeave={leave}
        onFocusCapture={() => clearTimeout(timer.current)}
        onBlurCapture={leave}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <p className="text-sm font-medium mb-2">{label}</p>
        <ul className="space-y-2 max-h-64 overflow-y-auto">
          {group.items.map((item) => (
            <li key={item.id} className="text-xs min-w-0">
              <span className="block text-muted-foreground truncate">
                {item.providerId} · {item.host} · repository {item.containerId}
              </span>
              <a
                href={item.url}
                target="_blank"
                rel="noreferrer"
                className="block wrap-anywhere hover:underline focus:underline"
              >
                {item.key}
                {item.title ? ` · ${item.title}` : ""}
              </a>
            </li>
          ))}
        </ul>
        {group.count > group.items.length ? (
          <p className="mt-2 text-xs text-muted-foreground">
            +{group.count - group.items.length} more
          </p>
        ) : null}
        <button
          type="button"
          className="mt-3 text-xs underline"
          onClick={() => {
            setOpen(false);
            if (
              session?.selection?.workspace === workspace &&
              (session.selection.id === issueId || session.selection.ref === issueId)
            )
              openDetailTab("external-links");
            else {
              openTabOnArrival(issueRef ?? issueId, "external-links");
              session?.open(workspace, issueId);
            }
          }}
        >
          View all in External links
        </button>
      </PopoverContent>
    </Popover>
  );
}
