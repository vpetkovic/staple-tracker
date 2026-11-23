import { useEffect, useState } from "react";
import { onLinkExternal, type LinkExternalRequest } from "@/lib/shell-events";
import { useSession } from "@/lib/session";
import { useBackToClose } from "@/lib/back-to-close";
import { LinkExternalPicker } from "./LinkExternalPicker";
export function LinkExternalMount() {
  const session = useSession();
  const [request, setRequest] = useState<LinkExternalRequest | null>(null);
  useEffect(() => onLinkExternal(setRequest), []);
  useBackToClose(request !== null, () => setRequest(null));
  if (!request) return null;
  return (
    <LinkExternalPicker
      initialWorkspace={
        request.workspace ||
        session.ws ||
        (session.workspaces.length === 1 ? session.workspaces[0]!.slug : "")
      }
      initialRef={request.ref}
      onClose={() => setRequest(null)}
    />
  );
}
