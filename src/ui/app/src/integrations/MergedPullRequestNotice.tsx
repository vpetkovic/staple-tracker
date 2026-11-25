/**
 * A merged pull request offers Mark done, and only offers it.
 *
 * The integrations link store knows when a ticket's pull request merged (`integrations
 * discover`, on the page's poll). Merging is not finishing: a ticket can hold several pull
 * requests, a stacked one can merge first, and review or evidence may still be owed. So the
 * ticket's status never moves on its own; the detail says the pull request merged and puts
 * the ordinary Mark done write one click away, the same write the primary action makes.
 *
 * Shown in both layouts, under the status line where the autopilot notice sits, while the
 * ticket is not finished, not cancelled and not waiting behind a review gate.
 */
import { Button } from "@/components/ui/button";
import type { IssueDetail } from "@/lib/types";
import { cn } from "@/lib/utils";
import { contextOf, type IssueActionsController } from "@/detail/IssueActions";
import { doneItem, type ActionContext } from "@/detail/plain-actions";
import type { ExternalLink } from "../../../../core/integrations/link-store";
import { LinkGlyph } from "./parts";

/** The merged pull requests a ticket offers Mark done for; empty when it offers nothing. */
export function mergedOffer(detail: Pick<IssueDetail, "externalLinks">, ctx: ActionContext): { merged: ExternalLink[]; done: NonNullable<ReturnType<typeof doneItem>> } | null {
  const category = ctx.categoryOf(ctx.issue.status);
  if (ctx.parked || category === "done" || category === "cancelled" || category === "gated") return null;
  const merged = (detail.externalLinks ?? []).filter(
    (link) => link.resource.ref.kind === "pull_request" && link.resource.ref.providerId === "github" && link.resource.status?.id === "merged",
  );
  const done = doneItem(ctx);
  return merged.length && done?.call ? { merged, done } : null;
}

export function MergedPullRequestNotice({
  detail,
  controller,
  className,
}: {
  detail: IssueDetail;
  controller: IssueActionsController;
  className?: string;
}) {
  const offer = mergedOffer(detail, contextOf(detail, controller));
  if (!offer) return null;
  const keys = offer.merged.map((link) => link.resource.key.slice(link.resource.key.lastIndexOf("#")));
  const sentence = offer.merged.length === 1 ? `Pull request ${keys[0]} merged.` : `Pull requests ${keys.join(", ")} merged.`;
  return (
    <p data-merged-offer="" className={cn("m-0 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-body text-text-secondary", className)}>
      <LinkGlyph kind="pull_request" tone="merged" className="size-3.5" />
      <span className="min-w-0">{sentence} If the work is finished, mark it done.</span>
      <Button
        variant="outline"
        size="sm"
        data-merged-done=""
        disabled={controller.busy}
        onClick={() => void controller.run(offer.done.call!)}
        className="pointer-coarse:min-h-11"
      >
        {offer.done.label}
      </Button>
    </p>
  );
}
