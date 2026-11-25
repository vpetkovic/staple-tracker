/**
 * Settings → Integrations, first half: the connections on this computer. One list, whatever
 * workspace is selected; every connection carries its status pill, a failing one opens its
 * fix under the row, a gh sign-in nobody connected yet is one click, and the add forms open
 * in the list only when asked for.
 *
 * Presentational over `useConnections` (passed in as `state`), so a test can render each
 * state from a value. Its own writes go straight to `integrationConfigure` and end in
 * `reload()`, which re-reads the list and checks what has no status yet.
 */
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Check, Copy, Loader2, MoreHorizontal, Plus, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { integrationConfigure } from "@/lib/api";
import { cn } from "@/lib/utils";
import { checkedAgo, oldestCheck, type ConnectionView } from "@/integrations/connection-status";
import { providerName } from "@/integrations/link-state";
import { ConnectionStatusPill, ProviderMark } from "@/integrations/parts";
import type { Connections } from "@/integrations/useConnections";
import type { DetectedConnection } from "../../../../../core/integrations/contracts";
import { ConfirmDialog } from "../form/ConfirmDialog";
import { InlineError, Section } from "../form/primitives";
import { azureOrganizationProblem, commandIn, CONNECTION_CHOICES, connectionMeta, linearIdProblem, offeredDetections } from "./integrations-model";

type Provider = "github" | "linear" | "azure_devops";
const message = (caught: unknown) => (caught instanceof Error ? caught.message : String(caught));

/** Icon buttons at the end of a row: 32px, 44px under a finger. */
const ICON_BUTTON = "size-8 rounded-lg text-text-tertiary hover:text-foreground pointer-coarse:size-11";
/** The row's text column starts after the 28px tile and the 12px gap. */
const TEXT_INDENT = "ml-10";

export function SectionHeading({ id, title, tag }: { id: string; title: string; tag: string }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <h4 id={id} className="text-sm font-semibold">
        {title}
      </h4>
      <span className="rounded-full bg-surface-sunken px-2 py-px text-caption whitespace-nowrap text-text-tertiary">{tag}</span>
    </div>
  );
}

/** The bordered list every part of this screen draws its rows in. */
export function ListFrame({ children, className, ...rest }: { children: ReactNode; className?: string; "aria-label"?: string; "aria-busy"?: boolean }) {
  return (
    <ul className={cn("m-0 list-none divide-y rounded-[10px] border p-0", className)} {...rest}>
      {children}
    </ul>
  );
}

export function ProviderTile({ providerId }: { providerId: string }) {
  return (
    <span aria-hidden className="mt-1 flex size-7 shrink-0 items-center justify-center rounded-md border bg-background">
      <ProviderMark providerId={providerId} className="size-4" />
    </span>
  );
}

/**
 * One row: tile, name over one meta line, and `trailing` (a pill or a button) beside the text
 * on a wide container and under it on a narrow one. `actions` stay at the row's top right.
 */
function Row({ providerId, title, meta, metaTitle, trailing, actions, below, ...data }: {
  providerId: string;
  title: string;
  meta: ReactNode;
  metaTitle?: string;
  trailing?: ReactNode;
  actions?: ReactNode;
  below?: ReactNode;
  [data: `data-${string}`]: string | boolean | undefined;
}) {
  return (
    <li className="px-3 py-2.5" {...data}>
      <div className="flex items-start gap-3">
        <ProviderTile providerId={providerId} />
        <div className="flex min-w-0 flex-1 flex-col items-start gap-1.5 @min-[30rem]:flex-row @min-[30rem]:items-center @min-[30rem]:gap-3">
          <div className="w-full min-w-0 @min-[30rem]:w-auto @min-[30rem]:flex-1">
            <p className="truncate text-body font-medium">{title}</p>
            <p className="truncate text-label text-muted-foreground" title={metaTitle}>
              {meta}
            </p>
          </div>
          {trailing}
        </div>
        {actions ? <div className="-mr-1 flex shrink-0 items-center gap-0.5 pt-0.5 pointer-coarse:pt-0">{actions}</div> : null}
      </div>
      {below}
    </li>
  );
}

export function ConnectionsSection({ state, ws, onDirtyChange, now: fixedNow }: {
  state: Connections;
  ws?: string;
  onDirtyChange: (dirty: boolean) => void;
  /** Pins the clock for a test; otherwise the strip re-reads it every 10 s. */
  now?: number;
}) {
  const { connections, loaded, checking, cachedOnly, error, refresh, reload } = state;
  const offered = offeredDetections(state.detected ?? []);
  const [form, setForm] = useState<Provider | null>(null);
  const now = useClock(fixedNow);
  const closeForm = () => {
    setForm(null);
    onDirtyChange(false);
  };

  const failed = loaded && error !== null && connections.length === 0;
  const empty = loaded && !failed && connections.length === 0 && offered.length === 0;
  const hasLinear = connections.some((c) => c.providerId === "linear");
  const ago = checkedAgo(oldestCheck(connections), now);

  const formRow = (provider: Provider) => (
    <li key={`form-${provider}`} className="px-3 py-3" data-connection-form={provider}>
      <ConnectionForm
        provider={provider}
        ws={ws}
        onCancel={closeForm}
        onDirtyChange={onDirtyChange}
        onSaved={async () => {
          closeForm();
          await reload();
        }}
      />
    </li>
  );

  const strip =
    connections.length > 0 && !cachedOnly ? (
      <div className="flex items-center gap-2" data-connections-strip>
        <span className="text-label whitespace-nowrap text-muted-foreground" aria-live="polite">
          {checking === "all" ? "Checking…" : ago ? `Checked ${ago}` : null}
        </span>
        <Button variant="outline" size="sm" title="Checks itself every 2 minutes while this page is open" onClick={() => void refresh()} className="pointer-coarse:h-11">
          <RefreshCw aria-hidden className={cn("size-3.5", checking === "all" && "animate-spin")} />
          Check now
        </Button>
      </div>
    ) : null;

  let body: ReactNode;
  if (!loaded) {
    body = (
      <ListFrame aria-busy>
        {[0, 1].map((i) => (
          <li key={i} data-connection-skeleton className="flex items-center gap-3 px-3 py-2.5">
            <Skeleton className="size-7 shrink-0" />
            <div className="min-w-0 flex-1 space-y-1.5">
              <Skeleton className="h-3.5 w-24" />
              <Skeleton className="h-3 w-48 max-w-full" />
            </div>
            <Skeleton className="h-5 w-20 rounded-full" />
          </li>
        ))}
      </ListFrame>
    );
  } else if (cachedOnly) {
    body = (
      <p data-connections-cached-only className="rounded-[10px] border px-3 py-3 text-body text-muted-foreground">
        Connections are managed on the computer that runs Staple. This page can only show saved copies.
      </p>
    );
  } else if (failed) {
    body = (
      <Section error={error}>
        <Button variant="outline" size="sm" onClick={() => void reload()} className="pointer-coarse:h-11">
          Try again
        </Button>
      </Section>
    );
  } else {
    body = (
      <>
        {error ? <InlineError>{error}</InlineError> : null}
        <ListFrame aria-label="Connections on this computer">
          {connections.map((c) => (
            <ConnectionRow key={c.id} connection={c} checking={checking} now={now} ws={ws} refresh={refresh} reload={reload} />
          ))}
          {offered.map((d) => (
            <DetectedRow key={`${d.host}/${d.login}`} detected={d} ws={ws} reload={reload} />
          ))}
          {empty ? (
            form === "github" ? (
              formRow("github")
            ) : (
              <Row
                data-connection-setup="github"
                providerId="github"
                title="GitHub"
                meta={
                  <>
                    Sign in with <span className="font-medium text-foreground">gh auth login</span> on this computer, or add an account by hand
                  </>
                }
                trailing={
                  <Button variant="outline" size="sm" onClick={() => setForm("github")} className="shrink-0 pointer-coarse:h-11">
                    Add account
                  </Button>
                }
              />
            )
          ) : null}
          {!hasLinear ? (
            form === "linear" ? (
              formRow("linear")
            ) : (
              <Row
                data-connection-setup="linear"
                providerId="linear"
                title="Linear"
                meta="Needs a read-only personal API key in this computer's environment"
                metaTitle="Needs a read-only personal API key in this computer's environment"
                trailing={
                  <Button variant="outline" size="sm" onClick={() => setForm("linear")} className="shrink-0 pointer-coarse:h-11">
                    Set up
                  </Button>
                }
              />
            )
          ) : null}
          {form === "github" && !empty ? formRow("github") : null}
          {form === "linear" && hasLinear ? formRow("linear") : null}
          {form === "azure_devops" ? formRow("azure_devops") : null}
        </ListFrame>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="-ml-1 text-muted-foreground hover:text-foreground pointer-coarse:h-11">
              <Plus aria-hidden className="size-3.5" />
              Add connection
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-64">
            {CONNECTION_CHOICES.map((choice) => (
              <DropdownMenuItem
                key={choice.providerId}
                disabled={!choice.available}
                onSelect={() => setForm(choice.providerId as Provider)}
                // A planned provider is dimmed by its words, not by fading the whole row: "Soon" stays readable.
                className="pointer-coarse:min-h-11 data-[disabled]:text-text-tertiary data-[disabled]:opacity-100"
              >
                <ProviderMark providerId={choice.providerId} />
                {choice.label}
                {choice.available ? null : (
                  <span className="ml-auto rounded-full border px-1.5 text-caption leading-4 font-medium text-muted-foreground">Soon</span>
                )}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        {empty ? <p className="text-label text-muted-foreground">Links already in your workspaces keep working from their saved copies. A connection adds search and refresh.</p> : null}
      </>
    );
  }

  return (
    <section aria-labelledby="integrations-connections" className="space-y-3" data-integrations-connections>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <SectionHeading id="integrations-connections" title="Connections" tag="This computer" />
        {strip}
      </div>
      {body}
    </section>
  );
}

/** Now, re-read every 10 s so "Checked 40 s ago" keeps counting. Requests nothing. */
function useClock(fixed: number | undefined): number {
  const [now, setNow] = useState(() => fixed ?? Date.now());
  useEffect(() => {
    if (fixed !== undefined) return;
    const timer = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(timer);
  }, [fixed]);
  return fixed ?? now;
}

function ConnectionRow({ connection: c, checking, now, ws, refresh, reload }: {
  connection: ConnectionView;
  checking: string | null;
  now: number;
  ws?: string;
  refresh: Connections["refresh"];
  reload: Connections["reload"];
}) {
  const name = providerName(c.providerId);
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState<"remove" | "switch" | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const spinning = checking === c.id || checking === "all";
  const meta = connectionMeta(c);
  const health = c.health;
  const login = health?.identity?.login;

  async function act(kind: "remove" | "switch", run: () => Promise<unknown>) {
    setPending(kind);
    setRowError(null);
    try {
      await run();
      await reload();
    } catch (caught) {
      setRowError(message(caught));
    } finally {
      setPending(null);
    }
  }

  const fix =
    health && health.state !== "ready" ? (
      <div data-connection-fix className={cn(TEXT_INDENT, "mt-2 space-y-1.5 rounded-lg bg-surface-sunken px-3 py-2.5")}>
        {health.message ? <p className="text-body font-medium wrap-anywhere">{health.message}</p> : null}
        {health.action ? <p className="text-label text-muted-foreground wrap-anywhere">{health.action}</p> : null}
        <FixCommand command={commandIn(health.action)} />
        {health.state === "account_mismatch" && c.providerId === "github" && login ? (
          <Button
            variant="outline"
            size="sm"
            disabled={pending === "switch"}
            className="mt-1 pointer-coarse:h-11"
            onClick={() => void act("switch", () => integrationConfigure({ action: "configure", connectionId: c.id, host: c.host, account: login }, ws))}
          >
            {pending === "switch" ? <Loader2 aria-hidden className="size-3.5 animate-spin" /> : null}
            Use {login} instead
          </Button>
        ) : null}
        {rowError ? <InlineError>{rowError}</InlineError> : null}
      </div>
    ) : rowError ? (
      <div className={cn(TEXT_INDENT, "mt-1.5")}>
        <InlineError>{rowError}</InlineError>
      </div>
    ) : null;

  return (
    <Row
      data-connection-row={c.providerId}
      providerId={c.providerId}
      title={name}
      meta={meta}
      metaTitle={meta}
      trailing={<ConnectionStatusPill health={health} now={now} />}
      actions={
        <>
          <Button variant="ghost" size="icon" aria-label={`Check ${name} connection`} title={`Check ${name} connection`} onClick={() => void refresh(c.id)} className={ICON_BUTTON}>
            <RefreshCw aria-hidden className={cn("size-4", spinning && "animate-spin")} />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label={`More for ${name} connection`} className={ICON_BUTTON}>
                <MoreHorizontal aria-hidden className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => void refresh(c.id)} className="pointer-coarse:min-h-11">
                <RefreshCw aria-hidden />
                Check now
              </DropdownMenuItem>
              <DropdownMenuItem variant="destructive" onSelect={() => setConfirming(true)} className="pointer-coarse:min-h-11">
                Remove…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <ConfirmDialog
            open={confirming}
            title={`Remove this ${name} connection?`}
            description="Links stay on their tasks with their saved copies. Search and refresh for this account stop on this computer."
            confirmLabel="Remove"
            destructive
            busy={pending === "remove"}
            onCancel={() => setConfirming(false)}
            onConfirm={() => {
              setConfirming(false);
              void act("remove", () => integrationConfigure({ action: "remove", connectionId: c.id }, ws));
            }}
          />
        </>
      }
      below={fix}
    />
  );
}

/** The command inside a fix, in a chip with Copy. No clipboard over plain HTTP: then it selects the text. */
function FixCommand({ command }: { command: string | null }) {
  const chip = useRef<HTMLElement>(null);
  const [done, setDone] = useState<"copied" | "selected" | null>(null);
  useEffect(() => {
    if (!done) return;
    const timer = setTimeout(() => setDone(null), 2000);
    return () => clearTimeout(timer);
  }, [done]);
  if (!command) return null;
  const select = () => {
    try {
      const range = document.createRange();
      range.selectNodeContents(chip.current!);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      setDone("selected");
    } catch {
      // Nothing to fall back to; the command is still on screen to copy by hand.
    }
  };
  const copy = async () => {
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(command);
        setDone("copied");
        return;
      }
    } catch {
      // Refused (no permission, insecure context): select it instead.
    }
    select();
  };
  return (
    <div className="flex min-w-0 items-center gap-1 pt-0.5">
      <code ref={chip} className="min-w-0 rounded-md border bg-background px-2 py-1 font-sans text-label wrap-anywhere select-all">
        {command}
      </code>
      <Button variant="ghost" size="icon" aria-label="Copy command" title={done === "selected" ? "Selected. Press Ctrl+C or ⌘C to copy" : "Copy command"} onClick={() => void copy()} className={ICON_BUTTON}>
        {done === "copied" ? <Check aria-hidden className="size-4" /> : <Copy aria-hidden className="size-4" />}
      </Button>
      <span role="status" className="sr-only">
        {done === "copied" ? "Copied" : done === "selected" ? "Command selected. Press Ctrl+C or ⌘C to copy." : ""}
      </span>
    </div>
  );
}

function DetectedRow({ detected: d, ws, reload }: { detected: DetectedConnection; ws?: string; reload: Connections["reload"] }) {
  const [pending, setPending] = useState(false);
  const [rowError, setRowError] = useState<string | null>(null);
  const where = d.host === "github.com" ? "" : ` on ${d.host}`;
  return (
    <Row
      data-connection-detected
      providerId="github"
      title="GitHub"
      metaTitle={`GitHub CLI on this computer is signed in as ${d.login}${where}`}
      meta={
        <>
          GitHub CLI on this computer is signed in as <strong className="font-medium text-foreground">{d.login}</strong>
          {where}
        </>
      }
      trailing={
        <Button
          size="sm"
          disabled={pending}
          className="max-w-full shrink-0 pointer-coarse:h-11"
          onClick={async () => {
            setPending(true);
            setRowError(null);
            try {
              await integrationConfigure({ action: "configure", host: d.host, account: d.login }, ws);
              await reload();
            } catch (caught) {
              setRowError(message(caught));
              setPending(false);
            }
          }}
        >
          {pending ? <Loader2 aria-hidden className="size-3.5 animate-spin" /> : null}
          <span className="truncate">Connect as {d.login}</span>
        </Button>
      }
      below={rowError ? <div className={cn(TEXT_INDENT, "mt-1.5")}><InlineError>{rowError}</InlineError></div> : null}
    />
  );
}

const DEFAULT_ENV: Record<Exclude<Provider, "github">, string> = { linear: "STAPLE_LINEAR_API_KEY", azure_devops: "STAPLE_AZURE_DEVOPS_PAT" };

/**
 * An add form, as a row of the list. Save stays off until the required fields are filled; a
 * refusal shows the server's sentence under the form. Escape inside it cancels the form only,
 * never the Settings dialog around it.
 */
export function ConnectionForm({ provider, ws, onCancel, onSaved, onDirtyChange }: {
  provider: Provider;
  ws?: string;
  onCancel: () => void;
  onSaved: () => Promise<void>;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [host, setHost] = useState("github.com");
  const [account, setAccount] = useState("");
  const defaultEnv = provider === "github" ? "" : DEFAULT_ENV[provider];
  const [credentialEnv, setCredentialEnv] = useState(defaultEnv);
  const [organization, setOrganization] = useState("");
  const [user, setUser] = useState("");
  const [pending, setPending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const root = useRef<HTMLFormElement>(null);

  const dirty = provider === "github" ? account !== "" || host !== "github.com" : organization !== "" || user !== "" || credentialEnv !== defaultEnv;
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);

  // Radix closes the dialog on Escape from a capturing listener on the document, so the form
  // has to take the key one step earlier, on the window.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !root.current?.contains(event.target as Node)) return;
      event.stopPropagation();
      event.preventDefault();
      onCancel();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onCancel]);

  const idProblem = provider === "linear" ? linearIdProblem(organization, user) : provider === "azure_devops" ? azureOrganizationProblem(organization) : null;
  const complete =
    provider === "github"
      ? host.trim() !== "" && account.trim() !== ""
      : credentialEnv.trim() !== "" && organization.trim() !== "" && (provider === "azure_devops" || user.trim() !== "") && !idProblem;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!complete || pending) return;
    setPending(true);
    setFormError(null);
    try {
      await integrationConfigure(
        provider === "github"
          ? { action: "configure", host: host.trim(), account: account.trim() }
          : provider === "azure_devops"
            ? { action: "configure", providerId: "azure_devops", organization: organization.trim(), credentialEnv: credentialEnv.trim() }
            : { action: "configure", providerId: "linear", account: user.trim(), scopeId: organization.trim(), credentialEnv: credentialEnv.trim() },
        ws,
      );
      await onSaved();
    } catch (caught) {
      setFormError(message(caught));
      setPending(false);
    }
  };

  const id = `integration-${provider}`;
  return (
    <form ref={root} onSubmit={(event) => void submit(event)} className="space-y-3" aria-labelledby={`${id}-title`}>
      <div className="flex items-center gap-3">
        <ProviderTile providerId={provider} />
        <p id={`${id}-title`} className="mt-1 text-body font-medium">
          {provider === "github" ? "Add a GitHub account" : provider === "azure_devops" ? "Connect Azure DevOps" : "Connect Linear"}
        </p>
      </div>
      <div className={cn(TEXT_INDENT, "space-y-3 @max-[30rem]:ml-0")}>
        {provider === "github" ? (
          <div className="grid gap-3 @min-[30rem]:grid-cols-2">
            <FormField id={`${id}-host`} label="Host">
              <Input id={`${id}-host`} value={host} onChange={(e) => setHost(e.target.value)} autoComplete="off" className="pointer-coarse:h-11" />
            </FormField>
            <FormField id={`${id}-account`} label="Account">
              <Input id={`${id}-account`} value={account} onChange={(e) => setAccount(e.target.value)} placeholder="The account gh is signed in as" autoComplete="off" autoFocus className="pointer-coarse:h-11" />
            </FormField>
          </div>
        ) : provider === "azure_devops" ? (
          <>
            <div className="grid gap-3 @min-[30rem]:grid-cols-2">
              <FormField id={`${id}-org`} label="Organization">
                <Input id={`${id}-org`} value={organization} onChange={(e) => setOrganization(e.target.value)} placeholder="The name in dev.azure.com/<organization>" autoComplete="off" spellCheck={false} autoFocus aria-describedby={`${id}-org-help`} className="pointer-coarse:h-11" />
              </FormField>
              <FormField id={`${id}-env`} label="Token variable">
                <Input id={`${id}-env`} value={credentialEnv} onChange={(e) => setCredentialEnv(e.target.value)} autoComplete="off" spellCheck={false} aria-describedby={`${id}-org-help`} className="pointer-coarse:h-11" />
              </FormField>
            </div>
            {idProblem ? (
              <InlineError id={`${id}-org-help`}>{idProblem}</InlineError>
            ) : (
              <p id={`${id}-org-help`} className="text-label text-muted-foreground">
                The variable holds a personal access token with Work Items (Read) and Project and Team (Read), in the environment Staple runs in. Staple reads your user and organization from it when you save.
              </p>
            )}
          </>
        ) : (
          <>
            <FormField
              id={`${id}-env`}
              label="API key variable"
              help="The name of the environment variable that holds a read-only personal API key, in the environment Staple runs in. Restart Staple after setting it."
            >
              <Input id={`${id}-env`} value={credentialEnv} onChange={(e) => setCredentialEnv(e.target.value)} autoComplete="off" spellCheck={false} aria-describedby={`${id}-env-help`} className="pointer-coarse:h-11" />
            </FormField>
            <div className="space-y-1.5">
              <div className="grid gap-3 @min-[30rem]:grid-cols-2">
                <FormField id={`${id}-org`} label="Organization ID">
                  <Input id={`${id}-org`} value={organization} onChange={(e) => setOrganization(e.target.value)} autoComplete="off" spellCheck={false} autoFocus aria-describedby={`${id}-ids-help`} className="pointer-coarse:h-11" />
                </FormField>
                <FormField id={`${id}-user`} label="Your user ID">
                  <Input id={`${id}-user`} value={user} onChange={(e) => setUser(e.target.value)} autoComplete="off" spellCheck={false} aria-describedby={`${id}-ids-help`} className="pointer-coarse:h-11" />
                </FormField>
              </div>
              {idProblem ? (
                <InlineError id={`${id}-ids-help`}>{idProblem}</InlineError>
              ) : (
                <p id={`${id}-ids-help`} className="text-label text-muted-foreground">
                  Both are in Linear under Settings → API.
                </p>
              )}
            </div>
          </>
        )}
        {formError ? <InlineError>{formError}</InlineError> : null}
        <div className="flex items-center gap-2">
          <Button type="submit" size="sm" disabled={!complete || pending} className="pointer-coarse:h-11">
            {pending ? <Loader2 aria-hidden className="size-3.5 animate-spin" /> : null}
            Save
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={onCancel} className="pointer-coarse:h-11">
            Cancel
          </Button>
        </div>
      </div>
    </form>
  );
}

function FormField({ id, label, help, children }: { id: string; label: string; help?: string; children: ReactNode }) {
  return (
    <div className="min-w-0 space-y-1.5">
      <Label htmlFor={id} className="text-label font-medium">
        {label}
      </Label>
      {children}
      {help ? (
        <p id={`${id}-help`} className="text-label text-muted-foreground">
          {help}
        </p>
      ) : null}
    </div>
  );
}
