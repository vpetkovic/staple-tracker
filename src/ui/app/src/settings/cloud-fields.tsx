/**
 * The pieces every connect form on the cloud page shares: the draft, the four
 * fields, and the facts list a consent screen is drawn from.
 *
 * Split out of `CloudSection.tsx` when the hub's own connection (STA-289) became the
 * fourth form to need them — the current workspace, one row, the hub-wide fan-out,
 * and now the hub registry. A module both `CloudSection.tsx` and
 * `HubRegistryPanel.tsx` import, rather than the second importing the first, so the
 * two components do not form an import cycle.
 */
import type { ReactNode } from "react";
import { Input } from "@/components/ui/input";
import { Field, InlineError } from "./form/primitives";
import type { CloudFact } from "./cloud-settings";

/** A connect form's draft. Held by the section, rendered by the panel. */
export interface ConnectDraft {
  endpoint: string;
  enrollment: string;
  label: string;
  /** `staple cloud connect --credential-file`. Chosen before the preview, because the preview states the consequence. */
  credentialFile: boolean;
}

export const EMPTY_DRAFT: ConnectDraft = { endpoint: "", enrollment: "", label: "", credentialFile: false };

/**
 * The four fields a connect needs, wherever it is being offered.
 *
 * Factored out when the workspace list grew its own per-row connect — S17
 * (STA-278). Not for brevity: the fields' DESCRIPTIONS are part of what consent
 * is given to. "The next screen states which one it will be", said about the
 * credential store, is a promise, and a second copy of these fields would be a
 * second place for that promise to be worded slightly differently and to drift
 * out of step with what the preview actually says.
 *
 * `idPrefix` keeps the label/input association unique when two of these are on
 * the page — the current workspace's form and one row's — which is a real state
 * and not a hypothetical.
 */
export function ConnectFields({
  idPrefix,
  draft,
  problem,
  onDraft,
  enrollmentDescription,
}: {
  idPrefix: string;
  draft: ConnectDraft;
  problem: string | null;
  onDraft: (patch: Partial<ConnectDraft>) => void;
  /** What the secret is, where that differs from a workspace's. */
  enrollmentDescription?: string;
}) {
  return (
    <>
      <Field
        id={`${idPrefix}-endpoint`}
        label="Service endpoint"
        description="The https origin of the sync service. Shown back to you for confirmation before anything is sent."
      >
        {(aria) => (
          <Input
            {...aria}
            value={draft.endpoint}
            placeholder="https://…"
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => onDraft({ endpoint: event.target.value })}
          />
        )}
      </Field>
      <Field
        id={`${idPrefix}-enrollment`}
        label="Enrollment credential"
        description={
          enrollmentDescription ??
          "This repository's enrollment secret for the first machine, or an existing device token from a machine that is already connected."
        }
      >
        {(aria) => (
          <Input
            {...aria}
            type="password"
            value={draft.enrollment}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => onDraft({ enrollment: event.target.value })}
          />
        )}
      </Field>
      <Field
        id={`${idPrefix}-label`}
        label="Device label"
        description="Sent to the server so you can tell your machines apart. Defaults to this computer's hostname."
      >
        {(aria) => (
          <Input
            {...aria}
            value={draft.label}
            placeholder="this computer's hostname"
            onChange={(event) => onDraft({ label: event.target.value })}
          />
        )}
      </Field>
      <Field
        id={`${idPrefix}-credential-file`}
        label="Store the credential in a file"
        description="By default the secret goes into this machine's keychain. Tick this to put it in a 0600 file in your staple home instead — the same choice as `staple cloud connect --credential-file`. The next screen states which one it will be."
      >
        {(aria) => (
          <label className="flex h-7 items-center gap-2 text-[13px]">
            <input
              {...aria}
              type="checkbox"
              role="switch"
              aria-checked={draft.credentialFile}
              checked={draft.credentialFile}
              onChange={(event) => onDraft({ credentialFile: event.target.checked })}
              className="accent-primary size-4"
            />
            <span>{draft.credentialFile ? "A 0600 file" : "This machine's keychain"}</span>
          </label>
        )}
      </Field>
      {problem ? <InlineError>{problem}</InlineError> : null}
    </>
  );
}

/** One label/value pair, the shape `connectionFacts` and friends produce. */
export function Facts({ facts }: { facts: readonly CloudFact[] }): ReactNode {
  if (facts.length === 0) return null;
  return (
    <dl data-cloud-facts className="grid gap-x-4 gap-y-1 md:grid-cols-[minmax(0,12rem)_minmax(0,1fr)]">
      {facts.map((fact) => (
        <div key={fact.label} className="contents">
          <dt className="text-[12px] text-muted-foreground">{fact.label}</dt>
          <dd className="min-w-0 text-[12px] wrap-anywhere">{fact.value}</dd>
        </div>
      ))}
    </dl>
  );
}
