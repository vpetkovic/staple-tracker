/**
 * The "+ Add" chip and what it opens: every repository, team and project the connections on
 * this computer can read, grouped by connection, filtered by the server as you type. Choosing
 * an item maps it to the row's workspace at once and keeps the picker open; choosing a checked
 * one unmaps it. cmdk gives the list its keys: arrows move, Enter toggles; Escape closes and
 * the popover hands focus back to the chip.
 */
import { useEffect, useRef, useState } from "react";
import { Check, Loader2, Plus } from "lucide-react";
import { Command, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { integrationRead, integrationWrite } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { ConnectionView } from "@/integrations/connection-status";
import { ConnectionStatusPill, ProviderMark } from "@/integrations/parts";
import type { ContainerKind } from "../../../../../core/integrations/contracts";
import { InlineError } from "../form/primitives";
import { pickerSections, type MappedTarget, type PickerPage } from "./integrations-model";

export function SourcePicker({ workspace, targets, connections, onChange }: {
  workspace: string;
  targets: MappedTarget[];
  connections: ConnectionView[];
  onChange: (targets: MappedTarget[]) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Add a source to ${workspace}`}
          className="relative inline-flex h-6 min-h-0 shrink-0 items-center gap-1 rounded-md border border-dashed px-2 text-label text-muted-foreground hover:border-border-strong hover:bg-surface-hover hover:text-foreground focus-ring aria-expanded:bg-surface-hover pointer-coarse:before:absolute pointer-coarse:before:-inset-x-1 pointer-coarse:before:-inset-y-2.5"
        >
          <Plus aria-hidden className="size-3" />
          Add
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        collisionPadding={8}
        className="flex w-[min(340px,calc(100vw-16px))] max-h-[min(26rem,var(--radix-popover-content-available-height))] flex-col overflow-hidden p-0"
      >
        <PickerBody workspace={workspace} targets={targets} connections={connections} onChange={onChange} />
      </PopoverContent>
    </Popover>
  );
}

type Slot = PickerPage & { loading: boolean; error: string | null };
const kindsOf = (providerId: string): ContainerKind[] => (providerId === "linear" ? ["team", "project"] : ["repository"]);
const groupName = (c: ConnectionView) =>
  c.providerId === "linear"
    ? (c.health?.identity?.organization ?? c.health?.identity?.login ?? "Linear")
    : c.host === "github.com" ? c.account : `${c.account} · ${c.host}`;

function PickerBody({ workspace, targets, connections, onChange }: {
  workspace: string;
  targets: MappedTarget[];
  connections: ConnectionView[];
  onChange: (targets: MappedTarget[]) => void;
}) {
  const [text, setText] = useState("");
  const [slots, setSlots] = useState<Record<string, Slot>>({});
  const [pending, setPending] = useState<string | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);
  /** Bumped per query; an answer for an older query is dropped. */
  const generation = useRef(0);
  const readable = connections.filter((c) => !c.health || c.health.state === "ready");
  const slotKey = (connectionId: string, kind: ContainerKind) => `${connectionId}:${kind}`;

  const load = (connection: ConnectionView, kind: ContainerKind, query: string, cursor: string | null, mine: number) => {
    const key = slotKey(connection.id, kind);
    setSlots((held) => ({ ...held, [key]: { items: cursor ? (held[key]?.items ?? []) : [], nextCursor: held[key]?.nextCursor ?? null, loading: true, error: null } }));
    integrationRead<PickerPage>({
      action: "containers",
      connectionId: connection.id,
      text: query || undefined,
      containerKind: kind === "project" ? "project" : undefined,
      cursor: cursor ?? undefined,
    })
      .then((page) => {
        if (generation.current !== mine) return;
        setSlots((held) => ({ ...held, [key]: { items: [...(cursor ? (held[key]?.items ?? []) : []), ...page.items], nextCursor: page.nextCursor, loading: false, error: null } }));
      })
      .catch((caught: unknown) => {
        if (generation.current !== mine) return;
        setSlots((held) => ({ ...held, [key]: { items: held[key]?.items ?? [], nextCursor: null, loading: false, error: caught instanceof Error ? caught.message : String(caught) } }));
      });
  };

  // The ids, not the objects: a status poll replaces the list without changing who can be read.
  const readableIds = readable.map((c) => c.id).join(",");
  useEffect(() => {
    const mine = ++generation.current;
    const timer = setTimeout(
      () => {
        for (const c of readable) for (const kind of kindsOf(c.providerId)) load(c, kind, text.trim(), null, mine);
      },
      text ? 250 : 0,
    );
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, readableIds]);

  const toggle = async (connection: ConnectionView, item: { id: string; key: string; kind: ContainerKind; mapped: boolean }) => {
    if (pending) return;
    setPending(item.key);
    setWriteError(null);
    try {
      const answer = await integrationWrite<{ targets: MappedTarget[] }>(
        item.mapped ? { action: "unmap", targetKey: item.key } : { action: "map", connectionId: connection.id, containerId: item.id, containerKind: item.kind },
        workspace,
      );
      onChange(answer.targets);
    } catch (caught) {
      setWriteError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPending(null);
    }
  };

  // cmdk highlights nothing when results arrive after it mounted; keep the first result
  // highlighted until the person moves, so Enter works straight after typing.
  const firstKey = readable.flatMap((c) => kindsOf(c.providerId).flatMap((kind) => slots[slotKey(c.id, kind)]?.items ?? []))[0]?.key ?? "";
  const [active, setActive] = useState("");
  useEffect(() => setActive(firstKey), [firstKey]);

  return (
    <Command shouldFilter={false} loop value={active} onValueChange={setActive} className="min-h-0 flex-1 rounded-lg">
      <CommandInput autoFocus value={text} onValueChange={setText} placeholder="Find a repository, team or project" className="pointer-coarse:h-11 pointer-coarse:text-base" />
      {writeError ? (
        <div className="border-b px-3 py-2">
          <InlineError>{writeError}</InlineError>
        </div>
      ) : null}
      <CommandList className="max-h-none min-h-0 flex-1 overscroll-contain">
        {connections.length === 0 ? (
          <p className="px-3 py-6 text-center text-label text-muted-foreground">Connect GitHub or Linear above to choose sources.</p>
        ) : null}
        {connections.map((connection) => {
          const ready = readable.includes(connection);
          const pages = Object.fromEntries(kindsOf(connection.providerId).flatMap((kind) => {
            const slot = slots[slotKey(connection.id, kind)];
            return slot ? [[kind, slot]] : [];
          })) as Partial<Record<ContainerKind, PickerPage>>;
          return (
            <div key={connection.id} data-picker-connection={connection.providerId} className="border-b last:border-b-0">
              <div className="flex items-center gap-2 px-3 pt-2.5 pb-1 text-label font-medium">
                <ProviderMark providerId={connection.providerId} />
                <span className="truncate">{groupName(connection)}</span>
              </div>
              {!ready ? (
                <div className="space-y-1.5 px-3 pb-3">
                  <ConnectionStatusPill health={connection.health} />
                  {connection.health?.message ? <p className="text-label text-muted-foreground">{connection.health.message}</p> : null}
                </div>
              ) : (
                pickerSections(connection.providerId, pages, targets).map((section) => {
                  const slot = slots[slotKey(connection.id, section.kind)]!;
                  return (
                    <CommandGroup key={section.kind} heading={section.label ?? undefined} className="px-1 pt-0 pb-1.5 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-text-tertiary">
                      {section.items.map((item) => (
                        <CommandItem
                          key={item.key}
                          value={item.key}
                          onSelect={() => void toggle(connection, item)}
                          className="h-8 gap-2 rounded-md px-2 text-body pointer-coarse:h-11"
                        >
                          <span className="min-w-0 flex-1 truncate" title={item.name}>
                            {item.name}
                          </span>
                          {pending === item.key ? (
                            <Loader2 aria-hidden className="size-4 animate-spin" />
                          ) : item.mapped ? (
                            <>
                              <Check aria-hidden className="size-4 text-foreground" />
                              <span className="sr-only">, chosen</span>
                            </>
                          ) : null}
                        </CommandItem>
                      ))}
                      {slot.loading ? (
                        <p className="flex items-center gap-2 px-2 py-1.5 text-label text-muted-foreground">
                          <Loader2 aria-hidden className="size-3.5 animate-spin" />
                          Loading…
                        </p>
                      ) : null}
                      {!slot.loading && !slot.error && section.items.length === 0 ? (
                        <p className="px-2 py-1.5 text-label text-text-tertiary">{text.trim() ? "No matches" : "Nothing here yet"}</p>
                      ) : null}
                      {slot.error ? (
                        <div className="px-2 py-1.5">
                          <InlineError>{slot.error}</InlineError>
                        </div>
                      ) : null}
                      {section.nextCursor && !slot.loading ? (
                        <CommandItem
                          value={`${connection.id}:${section.kind}:more`}
                          onSelect={() => load(connection, section.kind, text.trim(), section.nextCursor, generation.current)}
                          className={cn("h-8 rounded-md px-2 text-label text-muted-foreground pointer-coarse:h-11")}
                        >
                          Show more
                        </CommandItem>
                      ) : null}
                    </CommandGroup>
                  );
                })
              )}
            </div>
          );
        })}
      </CommandList>
    </Command>
  );
}
