import type { IssueDetail } from "@/lib/types";

type BranchDiscoveryNotice = NonNullable<IssueDetail["pullRequestDiscovery"]>;

/** A message as a sentence: an adapter's message may stop without a full stop. */
const sentence = (text: string) => (/[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`);

/**
 * The quiet line under a ticket's branch when the poll's discovery found no pull request for it.
 * With a note (nothing mapped), the note alone: it already says no pull requests were looked
 * for. Otherwise that none was found, then each failure's message and the connection's action,
 * the words `staple branch --discover` prints, each ended as a sentence.
 */
export function BranchDiscoveryNote({ notice }: { notice: BranchDiscoveryNotice }) {
  const parts = notice.note
    ? [notice.note]
    : [
        "No pull requests found for this branch.",
        ...notice.failures.map((failure) => (failure.action ? `${sentence(failure.message)} ${failure.action}` : sentence(failure.message))),
      ];
  return (
    <span className="basis-full text-label text-text-tertiary wrap-anywhere" data-branch-discovery="">
      {parts.join(" ")}
    </span>
  );
}
