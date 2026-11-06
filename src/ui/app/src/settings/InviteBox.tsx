/**
 * "Invite someone" in Settings → Members: a link a teammate opens to join this workspace, and
 * three ways to copy it.
 *
 * Generating the link is local: this computer builds it from its own connection and member
 * list, and contacts no service. The link carries no secret; a member still approves the code
 * the teammate's device shows. Any member may invite. Only the owner can admit a new person,
 * and the approval card says so when it matters.
 *
 * ## Copying over plain http
 *
 * The page is often opened over the tailnet at `http://…`, where browsers withhold
 * `navigator.clipboard`. Then the button falls back to showing the text in a read-only field,
 * selected, so a person copies it with one keystroke instead of finding that nothing happened.
 */
import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createShareOffer } from "@/lib/api";
import type { CloudShareOffer } from "@/lib/types";
import { Section } from "./form/primitives";

export type CopyTarget = "link" | "command" | "message";

/** What the clipboard API offers, when it does. Injected in tests. */
export interface ClipboardLike {
  writeText(text: string): Promise<void>;
}

/**
 * Copy `text`, or say it could not: "copied" when the clipboard took it, "fallback" when the
 * page must show it selected instead (no clipboard API, not a secure context, or refused).
 */
export async function copyText(text: string, clipboard: ClipboardLike | null | undefined, secure = true): Promise<"copied" | "fallback"> {
  if (!clipboard || !secure) return "fallback";
  try {
    await clipboard.writeText(text);
    return "copied";
  } catch {
    return "fallback";
  }
}

export const AUTO_SYNC_NOTE =
  "Once someone joins, every device in this workspace syncs automatically, yours included. That is what keeps " +
  "a shared workspace the same on every machine.";

export interface InviteState {
  name: string;
  offer: CloudShareOffer | null;
  busy: boolean;
  error: string | null;
  /** The target whose button last copied, for its "Copied" state. */
  copied: CopyTarget | null;
  /** The target that could not be copied, shown selected in a field instead. */
  fallback: CopyTarget | null;
}

export const IDLE_INVITE: InviteState = { name: "", offer: null, busy: false, error: null, copied: null, fallback: null };

export interface InviteActions {
  onName: (name: string) => void;
  onGenerate: () => void;
  onCopy: (target: CopyTarget) => void;
}

const COPY_LABEL: Record<CopyTarget, string> = { link: "Copy link", command: "Copy command", message: "Copy message" };

export function textFor(offer: CloudShareOffer, target: CopyTarget): string {
  return target === "link" ? offer.link : target === "command" ? offer.command : offer.message;
}

function FallbackField({ value, multiline }: { value: string; multiline: boolean }) {
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, [value]);
  const shared = {
    ref,
    readOnly: true,
    value,
    "data-copy-fallback": "",
    "aria-label": "Copy this text",
    onFocus: (event: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => event.currentTarget.select(),
  };
  return (
    <div className="space-y-1">
      {multiline ? (
        <textarea {...shared} rows={6} className="w-full rounded-md border bg-surface-sunken p-2 font-mono text-[12px]" />
      ) : (
        <Input {...shared} className="font-mono text-[12px]" />
      )}
      <p className="text-[12px] text-muted-foreground">
        This page cannot reach the clipboard here, so the text is selected: press ⌘C or Ctrl+C.
      </p>
    </div>
  );
}

export function InviteBoxView({ state, actions, slug }: { state: InviteState; actions: InviteActions; slug: string }) {
  const { offer } = state;
  return (
    <Section
      title="Invite someone"
      description={`Send a teammate a link to join ${slug}. It holds no secret: when they open it, their device shows a code, and a member approves it.`}
      error={state.error}
    >
      <div data-invite-box className="space-y-3 rounded-lg border bg-surface-raised p-3">
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            actions.onGenerate();
          }}
        >
          <label className="grid min-w-0 flex-1 gap-1 text-[12px] text-muted-foreground">
            Their name (optional)
            <Input
              data-invite-name
              value={state.name}
              placeholder="e.g. marko"
              maxLength={64}
              onChange={(event) => actions.onName(event.target.value)}
              className="h-control-sm text-[13px] text-foreground"
            />
          </label>
          <Button type="submit" size="sm" disabled={state.busy} data-invite-generate>
            {state.busy ? "Generating…" : offer ? "Generate again" : "Generate link"}
          </Button>
        </form>

        {offer ? (
          <div data-invite-offer className="space-y-2">
            <Input readOnly value={offer.link} aria-label="Invite link" data-invite-link className="font-mono text-[12px]" onFocus={(e) => e.currentTarget.select()} />
            <div className="flex flex-wrap gap-2">
              {(["link", "command", "message"] as const).map((target) => (
                <Button
                  key={target}
                  type="button"
                  size="sm"
                  variant={target === "link" ? "default" : "outline"}
                  onClick={() => actions.onCopy(target)}
                  data-copy={target}
                  data-copied={state.copied === target ? "" : undefined}
                >
                  {state.copied === target ? <Check aria-hidden /> : <Copy aria-hidden />}
                  {state.copied === target ? "Copied" : COPY_LABEL[target]}
                </Button>
              ))}
            </div>
            {state.fallback ? <FallbackField value={textFor(offer, state.fallback)} multiline={state.fallback === "message"} /> : null}
            {offer.invitedAs ? (
              <p className="text-[12px] text-muted-foreground">
                The link suggests the name <span className="font-medium text-foreground">{offer.invitedAs}</span>. You can
                change it when you approve.
              </p>
            ) : null}
          </div>
        ) : null}

        <p data-invite-auto-note className="text-[12px] text-muted-foreground">
          {AUTO_SYNC_NOTE}
        </p>
      </div>
    </Section>
  );
}

/** The controller: generate on request, copy with a visible result. */
export function InviteBox({ slug, clipboard }: { slug: string; clipboard?: ClipboardLike | null }) {
  const [state, setState] = useState<InviteState>(IDLE_INVITE);
  const reset = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (reset.current) clearTimeout(reset.current);
  }, []);
  const actions: InviteActions = {
    onName: (name) => setState((current) => ({ ...current, name })),
    onGenerate: () => {
      setState((current) => ({ ...current, busy: true, error: null, copied: null, fallback: null }));
      createShareOffer({ slug, invitedAs: state.name.trim() || undefined }).then(
        (offer) => setState((current) => ({ ...current, busy: false, offer })),
        (error: unknown) =>
          setState((current) => ({ ...current, busy: false, error: error instanceof Error ? error.message : String(error) })),
      );
    },
    onCopy: (target) => {
      if (!state.offer) return;
      const board = clipboard === undefined ? (typeof navigator === "undefined" ? null : (navigator.clipboard ?? null)) : clipboard;
      const secure = typeof window === "undefined" ? true : window.isSecureContext !== false;
      void copyText(textFor(state.offer, target), board, secure).then((result) => {
        setState((current) =>
          result === "copied"
            ? { ...current, copied: target, fallback: null }
            : { ...current, copied: null, fallback: target },
        );
        if (result === "copied") {
          if (reset.current) clearTimeout(reset.current);
          reset.current = setTimeout(() => setState((current) => ({ ...current, copied: null })), 2000);
        }
      });
    },
  };
  return <InviteBoxView state={state} actions={actions} slug={slug} />;
}
