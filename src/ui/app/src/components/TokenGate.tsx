/**
 * What you see instead of a blank page when the API says no.
 *
 * staple's API is token-gated so that no other site you happen to have open can drive
 * your tracker over loopback. The consequence is that arriving at 127.0.0.1:4400
 * without the printed URL is a completely normal thing to do — a bookmark, a reload
 * after restarting the server, a typed address. That is a state to explain, not an
 * error to log.
 */
import { AlertTriangle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function TokenGate({ reason }: { reason?: string }) {
  const port = location.port || "4400";
  return (
    <div className="flex min-h-full items-start justify-center p-6 sm:p-10">
      <Card className="w-full max-w-xl">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <AlertTriangle className="size-4 text-[var(--status-task-blocked)]" aria-hidden />
            This page needs an access token
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-muted-foreground">
          <p>
            staple&rsquo;s API is gated so that no other site you visit can drive it over loopback.
            Open the URL <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">staple ui</code> printed
            in your terminal — it looks like{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
              http://127.0.0.1:{port}/?token=…
            </code>
          </p>
          <p>
            If you got here from an old bookmark, the token in it died with the process that issued
            it. Restart <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">staple ui</code> and use
            the new URL — a fresh process always means a fresh token.
          </p>
          {reason ? (
            <p className="rounded-md border border-[var(--status-task-blocked)]/40 bg-[var(--status-task-blocked)]/10 px-3 py-2 font-mono text-xs text-foreground">
              server said: {reason}
            </p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
