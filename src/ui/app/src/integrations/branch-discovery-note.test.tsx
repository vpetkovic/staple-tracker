/**
 * Why a ticket's branch has no pull request, under the branch in the detail: on the drawer and
 * on the phone sheet (where the Pull requests row is folded away), with the run's note or each
 * failure's message and the connection's action. Nothing is drawn when the server sends none.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SessionContext } from "@/lib/session";
import type { IssueDetail } from "@/lib/types";
import { fakeSession } from "@/views/fake-session";
import { detail } from "@/detail/detail-fixture";
import type { DetailPresentation } from "@/detail/drawer";
import { DetailContent } from "@/detail/IssueDetailPanel";
import { useIssueActions } from "@/detail/IssueActions";

const noop = () => {};

function Content({ d, presentation }: { d: IssueDetail; presentation: DetailPresentation }) {
  const controller = useIssueActions(noop);
  return (
    <DetailContent
      detail={d}
      presentation={presentation}
      expanded={presentation === "full"}
      mode="workspace"
      controller={controller}
      refresh={noop}
      onAuthError={noop}
      requestOpen={false}
      onRequestApproval={noop}
      onCloseRequest={noop}
      onReview={noop}
    />
  );
}

const render = (d: IssueDetail, presentation: DetailPresentation = "drawer") =>
  renderToStaticMarkup(
    <SessionContext.Provider value={fakeSession()}>
      <Content d={d} presentation={presentation} />
    </SessionContext.Provider>,
  );

const branch = { name: "feat/notice", base: null, source: "field" as const, setBy: "ada", setAt: "2026-11-25T10:00:00.000Z" };
/** The text of the branch's discovery line, or null when none is drawn. */
const line = (html: string) => html.match(/<span[^>]*data-branch-discovery=""[^>]*>([^<]*)<\/span>/)?.[1]?.replaceAll("&#x27;", "'") ?? null;

describe("the line under a branch with no pull request", () => {
  it("says gh is signed out and how to sign in, on the drawer and on the phone", () => {
    const d = detail({
      branch,
      pullRequestDiscovery: {
        note: null,
        failures: [{ message: "Sign in to GitHub CLI on this machine for the configured host", action: "Run gh auth login --hostname github.com on the computer running Staple." }],
      },
    });
    const expected = "No pull requests found for this branch. Sign in to GitHub CLI on this machine for the configured host. Run gh auth login --hostname github.com on the computer running Staple.";
    expect(line(render(d))).toBe(expected);
    expect(line(render(d, "sheet"))).toBe(expected);
  });

  it("says only the note when nothing is mapped (it already says none was looked for), names a forbidden repository's action, and says only none was found otherwise", () => {
    const note = "No GitHub repository is mapped to this workspace, so no pull requests were looked for. Map one in Settings > Integrations.";
    expect(line(render(detail({ branch, pullRequestDiscovery: { note, failures: [] } })))).toBe(note.replace(">", "&gt;"));
    const forbidden = detail({
      branch,
      pullRequestDiscovery: { note: null, failures: [{ message: "GitHub denied access; check repository permissions and organization SSO", action: "Check this account's repository access and organization SSO authorization." }] },
    });
    expect(line(render(forbidden))).toBe(
      "No pull requests found for this branch. GitHub denied access; check repository permissions and organization SSO. Check this account's repository access and organization SSO authorization.",
    );
    expect(line(render(detail({ branch, pullRequestDiscovery: { note: null, failures: [{ message: "Something broke.", action: null }] } })))).toBe(
      "No pull requests found for this branch. Something broke.",
    );
    expect(line(render(detail({ branch, pullRequestDiscovery: { note: null, failures: [] } })))).toBe("No pull requests found for this branch.");
  });

  it("draws nothing when the server sends no reason", () => {
    expect(render(detail({ branch }))).not.toContain("data-branch-discovery");
  });
});
