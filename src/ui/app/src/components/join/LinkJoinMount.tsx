/**
 * Joining from a share link: `?join=<link>` on any page of the app, the address the sync
 * service's landing page opens ("Open in Staple").
 *
 * Opens the join dialog in link mode: who invited you to what, the service, this device's
 * name, and that a shared workspace syncs automatically. Reading the address makes no
 * request; the dialog's preview is answered from local files; and the workspace the link
 * names is created on this computer only when the person presses "Request to join".
 *
 * After joining, the page moves to that workspace, under the owner's name for it. That needs
 * the hub view (`staple open --hub`), which lists every workspace on the computer. A page
 * serving one workspace says where to find it instead.
 */
import { useEffect, useState } from "react";
import { replaceUrl } from "@/lib/back-to-close";
import { JoinDialog } from "./JoinDialog";

/** The search parameter the landing page uses. */
export const JOIN_PARAM = "join";

/**
 * The link in an address, with the workspace name it carries, or null. Only a URL whose path
 * is `/join/<id>` counts; the server reads the link strictly again before anything happens.
 */
export function joinLinkFromSearch(search: string): { link: string; name: string } | null {
  const raw = new URLSearchParams(search).get(JOIN_PARAM);
  if (raw === null || raw.trim() === "") return null;
  try {
    const url = new URL(raw.trim());
    if (!/^\/join\/[^/]+\/?$/.test(url.pathname)) return null;
    return { link: url.toString(), name: url.searchParams.get("n")?.trim() || "the shared workspace" };
  } catch {
    return null;
  }
}

/** The address with `?join=` taken out, every other parameter kept. */
export function withoutJoin(href: string): string {
  const url = new URL(href);
  url.searchParams.delete(JOIN_PARAM);
  return url.pathname + (url.search ? url.search : "") + url.hash;
}

/** Where a joined workspace is opened: the hub view, on that workspace. */
export function workspaceHref(name: string): string {
  return `/?ws=${encodeURIComponent(name)}`;
}

export function LinkJoinMount({ hubMode }: { hubMode: boolean }) {
  const [request, setRequest] = useState<{ link: string; name: string } | null>(() =>
    typeof location === "undefined" ? null : joinLinkFromSearch(location.search),
  );
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (request === null && typeof location !== "undefined" && new URLSearchParams(location.search).has(JOIN_PARAM)) {
      replaceUrl(withoutJoin(location.href));
    }
  }, [request]);

  if (request === null) {
    return notice ? (
      <div role="status" data-link-join-notice className="fixed right-4 bottom-4 z-50 max-w-sm rounded-lg border bg-popover p-3 text-[13px] shadow-lg">
        {notice}
      </div>
    ) : null;
  }
  return (
    <JoinDialog
      open
      slug={request.name}
      link={request.link}
      onClose={() => setRequest(null)}
      onJoined={(result) => {
        if (!hubMode && result.workspace) {
          setNotice(
            `Joined ${result.workspace}. This page shows one workspace; open every workspace on this computer with ` +
              "`staple open --hub` to see it.",
          );
        }
      }}
      onOpenWorkspace={hubMode ? (workspace) => location.assign(workspaceHref(workspace)) : undefined}
    />
  );
}
