import type { IssueDetail } from "@/lib/types";

type BranchDiscoveryNotice = NonNullable<IssueDetail["pullRequestDiscovery"]>;

/** A message as a sentence: an adapter's message may stop without a full stop. */
const sentence = (text: string) => (/[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`);

/**
 * The quiet line under a ticket's branch when the poll's discovery found no pull request for it:
 * that none was found, then why (the run's note, or each failure's message) and the connection's
 * action, the same words `staple branch --discover` prints.
 */
export function BranchDiscoveryNote({ notice }: { notice: BranchDiscoveryNotice }) {
  const why = [
    ...(notice.note ? [notice.note] : []),
    ...notice.failures.map((failure) => (failure.action ? `${sentence(failure.message)} ${failure.action}` : sentence(failure.message))),
  ];
  return (
    <span className="basis-full text-label text-text-tertiary wrap-anywhere" data-branch-discovery="">
      {["No pull requests found for this branch.", ...why].join(" ")}
    </span>
  );
}
