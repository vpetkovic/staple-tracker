/**
 * WORKSPACE SETTINGS — the status set and the kind vocabulary, editable — O7b (STA-141).
 *
 * ── WHY A DIALOG AND NOT A VIEW ───────────────────────────────────────────────────────
 *
 * `lib/session.ts` VIEWS is `["tree", "graph"]` and the tuple is load-bearing: the header
 * tabs, the palette's "Go to …" commands and App's switch are all derived from it, so a
 * third member would put "settings" in the tab row beside the two things the app is FOR.
 * Settings is not a place you look at work from; it is a thing you do to the workspace and
 * then leave. That is a dialog, mounted above the shell beside the palette and the create
 * form, reached the same two ways every other shell verb is — a visible control and the
 * command palette.
 *
 * ── ONE WRITE PATH ────────────────────────────────────────────────────────────────────
 *
 * `apply` is the only function in this file that talks to the server, and both tabs share
 * it. It POSTs one ordered batch, publishes the WHOLE returned envelope to lib/settings.ts,
 * and bumps the session's data version so the tree and the graph refetch — because a
 * removal with a migrate-to has just rewritten the status of every issue that carried it,
 * and a list still showing the old one is a list that is wrong rather than merely stale.
 *
 * That is the "re-derives from served settings without a reload" criterion in three lines:
 * nothing here merges, nothing patches a list in place, and every surface that renders a
 * status reads through the accessors rather than holding its own copy.
 *
 * ── REFUSALS ARE THE STORE'S SENTENCE ─────────────────────────────────────────────────
 *
 * Nothing in this dialog decides whether an edit is ALLOWED. The store refuses a duplicate
 * id, a removal that still has rows and no target, and the removal of the last status in a
 * category it writes into — and each refusal arrives as its own sentence through
 * `describeRefusal` and renders in `GuardRefusal`, exactly as every other writing surface
 * in the app does it. The one thing checked locally is the id CHARACTER SET, and only so
 * the form can say it before the round trip; the store still checks it independently.
 */
import { useCallback, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ApiError, putSettings } from "@/lib/api";
import { describeRefusal, type Refusal } from "@/lib/refusal";
import { publishWorkspaceSettings, useWorkspaceSettings } from "@/lib/settings";
import { useSession } from "@/lib/session";
import type { VocabularyOp } from "@/lib/types";
import { ErrorState, LoadingState } from "@/views/ViewChrome";
import { VocabularyList } from "./VocabularyList";
import { kindRows, statusRows } from "./settings-ops";

export function SettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const session = useSession();
  // `ws || undefined` — "" means "all workspaces" on the session and there is no such
  // thing as an all-workspaces vocabulary; the server then resolves its default handle,
  // which in single-workspace mode is the only one there is.
  const resource = useWorkspaceSettings({ ws: session.ws || undefined, version: session.version });
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [busy, setBusy] = useState(false);

  const applyTo = useCallback(
    async (target: "statuses" | "kinds", ops: VocabularyOp[]): Promise<boolean> => {
      setBusy(true);
      setRefusal(null);
      try {
        const next = await putSettings(target, ops, { ws: session.ws || undefined });
        publishWorkspaceSettings(next);
        // A migrate-to removal rewrote issue rows. Everything on screen has to refetch,
        // and the fingerprint poll would get there within 1.5s anyway — this only makes
        // the list agree with the dialog in the same frame the dialog updates.
        session.refresh();
        return true;
      } catch (error) {
        // AuthError is re-broadcast by lib/api and swaps in the token screen; anything
        // else is the store refusing, and the user reads what it said.
        if (error instanceof ApiError) setRefusal(describeRefusal(error));
        else if (error instanceof Error) setRefusal(describeRefusal({ message: error.message }));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [session],
  );

  const settings = resource.settings;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-settings-dialog className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Workspace settings</DialogTitle>
          <DialogDescription>
            The status set and the kind vocabulary are this workspace's, not staple's.
            Behaviour follows the category; order sorts within it. Every edit applies
            immediately — there is no save button.
          </DialogDescription>
        </DialogHeader>

        {resource.error ? (
          <ErrorState error={resource.error} />
        ) : resource.loading && settings.workspace === "" ? (
          <LoadingState rows={5} />
        ) : (
          <Tabs defaultValue="statuses">
            <TabsList>
              <TabsTrigger value="statuses">Statuses</TabsTrigger>
              <TabsTrigger value="kinds">Kinds</TabsTrigger>
            </TabsList>

            <TabsContent value="statuses" className="mt-3 max-h-[60vh] overflow-y-auto pr-1">
              <VocabularyList
                target="statuses"
                rows={statusRows(settings.statuses)}
                usage={settings.usage.statuses}
                categories={settings.categories}
                requiredCategories={settings.requiredCategories}
                apply={(ops) => applyTo("statuses", ops)}
                refusal={refusal}
                busy={busy}
              />
            </TabsContent>

            <TabsContent value="kinds" className="mt-3 max-h-[60vh] overflow-y-auto pr-1">
              <VocabularyList
                target="kinds"
                rows={kindRows(settings.kinds)}
                usage={settings.usage.kinds}
                apply={(ops) => applyTo("kinds", ops)}
                refusal={refusal}
                busy={busy}
              />
            </TabsContent>
          </Tabs>
        )}
      </DialogContent>
    </Dialog>
  );
}
