/**
 * The header's chip: the task a link lands on, and the picker that changes it. The list is the
 * searchable select's own (its filtering, its rows), opened from the chip instead of from a
 * field-shaped trigger. On All workspaces with no workspace known it asks for one first. A
 * chosen task can be taken back off with the list's first row.
 */
import { useEffect, useState } from "react";
import { ChevronDown, CircleSlash } from "lucide-react";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { filterOptions, type SelectOption } from "@/components/ui/searchable-select";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { StatusIcon } from "@/components/task-list";
import { cn } from "@/lib/utils";
import type { Issue } from "@/lib/types";

export function TargetPicker({
  target,
  options,
  workspaceChoices,
  onWorkspace,
  onChoose,
}: {
  target: Pick<Issue, "identifier" | "title" | "status"> | null;
  options: readonly SelectOption[];
  workspaceChoices: string[] | null;
  onWorkspace: (ws: string) => void;
  /** The task's identifier, or "" for no task. */
  onChoose: (identifier: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [ws, setWs] = useState("");
  useEffect(() => {
    if (open) setQuery("");
  }, [open]);
  const asksWorkspace = workspaceChoices !== null;
  const matches = filterOptions(options, query);
  return (
    <Popover modal open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={target ? `Link to ${target.identifier} ${target.title}. Change task` : "Choose a task"}
          data-target-chip=""
          className={cn(
            "focus-ring inline-flex h-8 min-w-0 max-w-full items-center gap-1.5 rounded-md border px-2 text-body hover:bg-surface-hover data-[state=open]:bg-surface-hover pointer-coarse:h-11",
            !target && "border-dashed text-muted-foreground",
          )}
        >
          {target ? (
            <>
              <StatusIcon status={target.status} className="size-3.5 shrink-0" />
              <span className="shrink-0 font-medium">{target.identifier}</span>
              <span className="truncate text-muted-foreground" title={target.title}>{target.title}</span>
            </>
          ) : (
            <span className="truncate">Choose a task</span>
          )}
          <ChevronDown aria-hidden className="size-3.5 shrink-0 text-text-tertiary" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={4} className="w-[min(26rem,calc(100vw-2rem))] p-0" data-target-list="">
        {asksWorkspace ? (
          <div className="border-b p-2">
            <Select
              value={ws}
              onValueChange={(value) => {
                setWs(value);
                onWorkspace(value);
              }}
            >
              <SelectTrigger aria-label="Workspace" className="w-full pointer-coarse:h-11">
                <SelectValue placeholder="Choose a workspace first" />
              </SelectTrigger>
              <SelectContent>
                {workspaceChoices.map((slug) => (
                  <SelectItem key={slug} value={slug} className="pointer-coarse:min-h-11">
                    {slug}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}
        {!asksWorkspace || ws ? (
          <Command shouldFilter={false}>
            <CommandInput value={query} onValueChange={setQuery} placeholder="Search tasks…" />
            <CommandList className="max-h-[min(20rem,50dvh)]">
              {matches.length === 0 ? <CommandEmpty>No task matches</CommandEmpty> : null}
              {/* The way back to no task: the dialog can then browse, or create a task from an issue. */}
              {target && !query.trim() ? (
                <CommandGroup>
                  <CommandItem
                    value="__no_task__"
                    onSelect={() => {
                      onChoose("");
                      setOpen(false);
                    }}
                    className="pointer-coarse:min-h-11"
                  >
                    <CircleSlash aria-hidden className="size-3.5 shrink-0 text-text-tertiary" />
                    <span className="shrink-0 font-medium">No task</span>
                    <span className="flex-1 truncate text-text-tertiary">Create a task from a result instead</span>
                  </CommandItem>
                </CommandGroup>
              ) : null}
              <CommandGroup>
                {matches.map((option) => (
                  <CommandItem
                    key={option.value}
                    value={option.value}
                    onSelect={() => {
                      onChoose(option.value);
                      setOpen(false);
                    }}
                    className="pointer-coarse:min-h-11"
                  >
                    {option.status ? <StatusIcon status={option.status} className="size-3.5 shrink-0" /> : null}
                    <span className="shrink-0 font-medium">{option.label}</span>
                    <span className="flex-1 truncate text-text-tertiary">{option.hint}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
