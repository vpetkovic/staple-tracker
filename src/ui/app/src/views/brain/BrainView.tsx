/**
 * The Brain row of the rail and the tab bar opens Settings → Brain (`App.tsx`, `goToView`), so
 * this page is only reached if something sets the view directly. It says where the brain lives
 * and opens it.
 */
import { useEffect } from "react";
import { Brain } from "lucide-react";
import { EmptyState } from "@/components/plain/States";
import { Button } from "@/components/ui/button";
import type { AuthError } from "@/lib/api";
import { openSettings } from "@/lib/shell-events";

export function BrainView(_props: { onAuthError: (error: AuthError) => void }) {
  useEffect(() => openSettings({ section: "brain" }), []);
  return (
    <div className="px-page py-8">
      <EmptyState icon={Brain} title="The brain lives in Settings" action={<Button onClick={() => openSettings({ section: "brain" })}>Open Brain settings</Button>}>
        Its overview, controls and tools are under Settings → Brain.
      </EmptyState>
    </div>
  );
}
