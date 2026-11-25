/**
 * Link an issue or pull request to a task: a command-style dialog. One field searches every
 * mapped source in the app's scope as you type (a pasted link is resolved instead), results
 * group by source with a preview beside them, and Enter links the selected result to the task
 * in the header. The dialog stays open after a link so several can be linked in a row.
 *
 * This file owns state and requests; `link-dialog/LinkDialogView.tsx` draws it and
 * `link-dialog/logic.ts` holds the decisions.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { getIssues, integrationRead, integrationWrite } from "@/lib/api";
import { describeRefusal } from "@/lib/refusal";
import { newRequestKey } from "@/lib/request-key";
import { isAllWorkspaces, useSession } from "@/lib/session";
import { openSettings } from "@/lib/shell-events";
import type { Issue, IssueRow } from "@/lib/types";
import { useConnections } from "./useConnections";
import {
  resourceKey,
  sourceInput,
  type ExternalLink,
  type MatchPreview,
  type MixedResults,
  type RemoteHit,
  type SearchFailure,
  type SearchHit,
  type SearchScope,
} from "./model";
import { loadKindFilter, saveKindFilter, type KindFilter } from "./link-dialog/last-kind";
import {
  answerFor,
  connectionFor,
  createLatest,
  groupResults,
  keepSelection,
  moveSelection,
  outsideScopeTarget,
  queryKind,
  scopeFromMapping,
  searchKinds,
  type ItemKind,
  type MappingAnswer,
} from "./link-dialog/logic";
import { LinkDialogView, type CreateState, type LinkDialogActions, type LinkDialogState } from "./link-dialog/LinkDialogView";

type Kind = "issue" | "pull_request";

export function LinkExternalPicker({
  initialWorkspace,
  initialRef,
  initialKind,
  onClose,
}: {
  initialWorkspace: string;
  initialRef?: string;
  initialKind?: Kind;
  onClose: () => void;
}) {
  // The body answers Escape first: on the narrow layout it backs out of the preview page.
  const escape = useRef<(() => boolean) | null>(null);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        onOpenAutoFocus={(e) => {
          // The search field, not the first control (the task chip).
          e.preventDefault();
          document.querySelector<HTMLInputElement>("[data-link-external] input[role=combobox]")?.focus();
        }}
        onEscapeKeyDown={(e) => {
          if (escape.current?.()) e.preventDefault();
        }}
        className={
          "flex flex-col gap-0 overflow-hidden p-0 max-w-none sm:max-w-none " +
          "md:h-[min(600px,90dvh)] md:w-[min(900px,calc(100vw-32px))] md:rounded-[14px] " +
          "max-md:top-0 max-md:left-0 max-md:h-dvh max-md:w-full max-md:translate-x-0 max-md:translate-y-0 max-md:rounded-none max-md:border-0 " +
          "max-md:pt-[env(safe-area-inset-top)] max-md:pb-[env(safe-area-inset-bottom)]"
        }
        data-link-external=""
      >
        <DialogTitle className="sr-only">Link an issue or pull request</DialogTitle>
        <PickerBody
          initialWorkspace={initialWorkspace}
          initialRef={initialRef}
          initialKind={initialKind}
          onClose={onClose}
          escape={escape}
        />
      </DialogContent>
    </Dialog>
  );
}

const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** One failure per connection and state, across both kinds' answers. */
function mergeFailures(answers: MixedResults[]): SearchFailure[] {
  const out: SearchFailure[] = [];
  for (const f of answers.flatMap((a) => a.failures ?? [])) {
    const seen = out.find((o) => o.connectionId === f.connectionId && o.state === f.state);
    if (seen) seen.targetKeys = [...new Set([...seen.targetKeys, ...f.targetKeys])];
    else out.push({ ...f, targetKeys: [...f.targetKeys] });
  }
  return out;
}

type Answer =
  /** `asked` is what the answer answers (logic.ts `answerFor`): a list that no longer matches the field cannot be linked from. */
  | { mode: "search"; asked: string; pages: Partial<Record<ItemKind, MixedResults[]>> }
  | { mode: "paste"; asked: string; preview: MatchPreview | null };

interface Problem {
  /** The result it is about; null for a pasted link that did not resolve. */
  key: string | null;
  message: string;
  outside: ReturnType<typeof outsideScopeTarget>;
}

export function PickerBody({
  initialWorkspace,
  initialRef,
  initialKind,
  onClose,
  escape,
}: {
  initialWorkspace: string;
  initialRef?: string;
  initialKind?: Kind;
  onClose: () => void;
  escape?: RefObject<(() => boolean) | null>;
}) {
  const session = useSession();
  const all = isAllWorkspaces(session);
  const [targetWs, setTargetWs] = useState(initialWorkspace);
  const [targetRef, setTargetRef] = useState(initialRef ?? "");
  // On All workspaces the scope is every workspace; the target's workspace (when known) only
  // decides which store answers for saved copies.
  const searchWs = (all ? targetWs : initialWorkspace || session.ws) || undefined;
  const scopeArgs = all ? { allWorkspaces: true } : {};

  const [text, setText] = useState("");
  const [kind, setKind] = useState<KindFilter>(() => initialKind ?? loadKindFilter());
  const [containerKey, setContainerKey] = useState<string | null>(null);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [mappingScope, setMappingScope] = useState<SearchScope | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [page, setPage] = useState<"results" | "preview">("results");
  const [fetchedRows, setFetchedRows] = useState<IssueRow[] | null>(null);
  const [targetLinks, setTargetLinks] = useState<Map<string, string> | null>(null);
  const [linking, setLinking] = useState<string | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [create, setCreate] = useState<CreateState | null>(null);
  const [sessionLinks, setSessionLinks] = useState<ReadonlySet<string>>(new Set());
  const [mappingVersion, setMappingVersion] = useState(0);
  const connections = useConnections(searchWs);
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const latest = useRef(createLatest()).current;
  const firstSearch = useRef(true);
  const createKeys = useRef(new Map<string, string>());
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // ---- the target task
  useEffect(() => {
    if (!targetWs) return;
    let active = true;
    setFetchedRows(null);
    getIssues({ ws: targetWs })
      .then((rows) => active && setFetchedRows(rows))
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [targetWs]);
  const rows = fetchedRows ?? (session.issues.data ?? []).filter((r) => r.workspace === targetWs);
  const target = targetRef ? rows.find((r) => r.issue.id === targetRef || r.issue.identifier === targetRef)?.issue ?? null : null;
  const targetId = target?.id ?? null;

  useEffect(() => {
    setTargetLinks(null);
    if (!targetId || !targetWs) return;
    let active = true;
    integrationRead<ExternalLink[]>({ action: "list", ref: targetId }, targetWs)
      .then((links) => active && setTargetLinks(new Map(links.map((l) => [resourceKey(l.resource), l.resource.id]))))
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [targetId, targetWs]);

  // ---- scope before the first answer
  useEffect(() => {
    let active = true;
    integrationRead<MappingAnswer>({ action: "mapping", allWorkspaces: true }, searchWs)
      .then((m) => active && setMappingScope(scopeFromMapping(m, searchWs ?? "", all)))
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [searchWs, all, mappingVersion]);

  const answers = answer?.mode === "search" ? Object.values(answer.pages).flatMap((p) => p ?? []) : [];
  const scope = answers[0]?.scope ?? mappingScope;
  const targets = scope?.targets ?? [];
  const targetsRef = useRef(targets);
  targetsRef.current = targets;

  // ---- search as you type
  useEffect(() => {
    const n = latest.next();
    const asked = answerFor(text, kind, containerKey);
    const delay = firstSearch.current ? 0 : 250;
    firstSearch.current = false;
    setSearching(true);
    const timer = setTimeout(async () => {
      const query = text.trim();
      try {
        if (queryKind(query) === "preview") {
          try {
            const preview = await integrationRead<MatchPreview>({ action: "preview", url: query, connectionId: urlConnection(query), ...scopeArgs }, searchWs);
            if (!latest.isLatest(n)) return;
            setAnswer({ mode: "paste", asked, preview });
            setSearchError(null);
            setProblem(null);
          } catch (error) {
            if (!latest.isLatest(n)) return;
            setAnswer({ mode: "paste", asked, preview: null });
            setSearchError(null);
            setProblem({ key: null, message: describeRefusal(error).message, outside: outsideScopeTarget(error) });
          }
          return;
        }
        const kinds = searchKinds(kind, containerKey, targetsRef.current);
        const pages = await Promise.all(
          kinds.map((k) =>
            integrationRead<MixedResults>({ action: "search", text: query, kind: k, containerKey: containerKey ?? undefined, ...scopeArgs }, searchWs)
              .then((a) => [k, [a]] as const),
          ),
        );
        if (!latest.isLatest(n)) return;
        setAnswer({ mode: "search", asked, pages: Object.fromEntries(pages) });
        setSearchError(null);
      } catch (error) {
        if (!latest.isLatest(n)) return;
        setSearchError(describeRefusal(error).message);
        setAnswer({ mode: "search", asked, pages: {} });
      } finally {
        if (latest.isLatest(n) && alive.current) setSearching(false);
      }
    }, delay);
    return () => clearTimeout(timer);
    // scopeArgs follows `all`; targets are read through the ref so a new answer does not search again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, kind, containerKey, searchWs, all]);

  const more = useCallback(async () => {
    // Paging an answer the field has moved on from would cancel the pending search and send its cursor with the new text.
    if (answer?.mode !== "search" || answer.asked !== answerFor(text, kind, containerKey)) return;
    const asked = answer.asked;
    const n = latest.next();
    setSearching(true);
    try {
      const next = await Promise.all(
        (Object.entries(answer.pages) as Array<[ItemKind, MixedResults[]]>).map(async ([k, list]) => {
          const cursor = list[list.length - 1]?.nextCursor;
          if (!cursor) return [k, list] as const;
          const page = await integrationRead<MixedResults>(
            { action: "search", text: text.trim(), kind: k, containerKey: containerKey ?? undefined, cursor, ...scopeArgs },
            searchWs,
          );
          return [k, [...list, page]] as const;
        }),
      );
      if (latest.isLatest(n)) setAnswer({ mode: "search", asked, pages: Object.fromEntries(next) });
    } catch (error) {
      if (latest.isLatest(n)) setSearchError(describeRefusal(error).message);
    } finally {
      if (latest.isLatest(n) && alive.current) setSearching(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [answer, text, kind, containerKey, searchWs, all]);

  // ---- results and selection
  const groups = useMemo(() => {
    if (!answer) return null;
    if (answer.mode === "paste") {
      if (!answer.preview) return [];
      const { item, associations } = answer.preview;
      return groupResults([{ cached: [{ item, associations }], remote: [] }], targets);
    }
    // Nothing mapped: the empty state, not saved copies (the keyboard must not reach them either).
    return scope?.mode === "none" ? [] : groupResults(answers, targets);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [answer, targets, scope?.mode]);
  const hits = groups?.flatMap((g) => g.hits) ?? [];
  const keys = hits.map((h) => resourceKey(h.item));
  const selected = keepSelection(keys, chosen);
  const hitFor = (key: string) => hits.find((h) => resourceKey(h.item) === key) ?? null;
  const linkedHere = useMemo(() => {
    const set = new Set<string>();
    for (const h of hits) {
      const key = resourceKey(h.item);
      if (targetLinks ? targetLinks.has(key) : !!targetId && h.associations.some((a) => a.id === targetId)) set.add(key);
    }
    return set;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups, targetLinks, targetId]);
  const undoable = useMemo(() => new Set([...linkedHere].filter((k) => targetLinks?.has(k))), [linkedHere, targetLinks]);

  /** The list on screen answers an older query: nothing may be linked, created or paged from it. */
  const stale = !!answer && answer.asked !== answerFor(text, kind, containerKey);
  /** Every read and write names its connection, so two accounts on one host never leave the server guessing. */
  const input = (hit: SearchHit) =>
    sourceInput(hit.item, connectionFor(hit.item.ref, (hit as Partial<RemoteHit>).targetKey, targets, connections.connections));
  function urlConnection(url: string): string | undefined {
    try {
      const parsed = new URL(url);
      // Azure DevOps puts the organization first in the path; it picks between organizations on one host.
      const organization = parsed.host === "dev.azure.com" ? parsed.pathname.split("/")[1] || undefined : undefined;
      return connectionFor({ host: parsed.host, organization }, undefined, targetsRef.current, connections.connections);
    } catch {
      return undefined;
    }
  }

  const focusField = () => requestAnimationFrame(() => inputRef.current?.focus());

  // ---- writes
  const writeWs = targetWs || searchWs;
  async function link(key: string, close = false) {
    const hit = hitFor(key);
    if (!hit || !target || !targetWs || linking || stale) return;
    if (linkedHere.has(key)) {
      if (close) onClose();
      return;
    }
    setLinking(key);
    setProblem(null);
    try {
      const made = await integrationWrite<ExternalLink>(
        { action: "link", ...input(hit), ref: target.id, confirmed: true, ...scopeArgs },
        targetWs,
      );
      if (!alive.current) return;
      setTargetLinks((held) => new Map(held ?? []).set(key, made.resource.id));
      setSessionLinks((held) => new Set(held).add(key));
      session.refresh();
      if (close) onClose();
      else focusField();
    } catch (error) {
      if (alive.current) setProblem({ key, message: describeRefusal(error).message, outside: outsideScopeTarget(error) });
    } finally {
      if (alive.current) setLinking(null);
    }
  }

  async function undo(key: string) {
    const resourceId = targetLinks?.get(key);
    if (!resourceId || !target || !targetWs) return;
    setProblem(null);
    try {
      await integrationWrite({ action: "unlink", ref: target.id, resourceId }, targetWs);
      if (!alive.current) return;
      setTargetLinks((held) => {
        const next = new Map(held ?? []);
        next.delete(key);
        return next;
      });
      setSessionLinks((held) => {
        const next = new Set(held);
        next.delete(key);
        return next;
      });
      session.refresh();
      focusField();
    } catch (error) {
      if (alive.current) setProblem({ key, message: describeRefusal(error).message, outside: null });
    }
  }

  async function createFrom(key: string, additional: boolean) {
    const hit = hitFor(key);
    if (!hit || !writeWs || stale) return;
    let requestKey = createKeys.current.get(key);
    if (!requestKey) createKeys.current.set(key, (requestKey = newRequestKey()));
    setProblem(null);
    try {
      if (!additional) {
        setCreate({ key, phase: "checking", candidates: [], truncated: false });
        const check = await integrationRead<MatchPreview>({ action: "preview", ...input(hit), ...scopeArgs }, writeWs);
        if (!alive.current) return;
        if (check.candidates.length || check.truncated) {
          setCreate({ key, phase: "candidates", candidates: check.candidates, truncated: check.truncated });
          return;
        }
      }
      setCreate({ key, phase: "creating", candidates: [], truncated: false });
      const made = await integrationWrite<{ issue: Issue }>(
        { action: "create", ...input(hit), requestKey, additionalWork: additional, ...scopeArgs },
        writeWs,
      );
      session.refresh();
      onClose();
      session.open(writeWs, made.issue.id);
    } catch (error) {
      if (!alive.current) return;
      setCreate(null);
      setProblem({ key, message: describeRefusal(error).message, outside: outsideScopeTarget(error) });
    }
  }

  async function mapAndLink() {
    const outside = problem?.outside;
    if (!outside?.connectionId || !target || !targetWs) return;
    const key = problem?.key ?? null;
    setProblem(null);
    try {
      await integrationWrite(
        { action: "map", connectionId: outside.connectionId, containerId: outside.containerId, containerKind: outside.kind },
        targetWs,
      );
      setMappingVersion((v) => v + 1);
      if (key) {
        await link(key);
        return;
      }
      // A pasted link that was outside: link it by its URL, then show it.
      const made = await integrationWrite<ExternalLink>(
        { action: "link", url: text.trim(), connectionId: outside.connectionId, ref: target.id, confirmed: true, ...scopeArgs },
        targetWs,
      );
      if (!alive.current) return;
      const linkedKey = resourceKey(made.resource);
      setTargetLinks((held) => new Map(held ?? []).set(linkedKey, made.resource.id));
      setSessionLinks((held) => new Set(held).add(linkedKey));
      setAnswer({ mode: "paste", asked: answerFor(text, kind, containerKey), preview: { item: made.resource, associations: [target], candidates: [], truncated: false } });
      session.refresh();
      focusField();
    } catch (error) {
      if (alive.current) setProblem({ key, message: describeRefusal(error).message, outside: null });
    }
  }

  // Escape on the narrow preview page goes back to the results instead of closing.
  useEffect(() => {
    if (!escape) return;
    escape.current = () => {
      const narrow = (rootRef.current?.clientWidth ?? 0) < 720;
      if (page === "preview" && narrow) {
        setPage("results");
        focusField();
        return true;
      }
      return false;
    };
    return () => {
      escape.current = null;
    };
  }, [escape, page]);

  const resetFor = () => {
    setProblem(null);
    setCreate(null);
  };

  const actions: LinkDialogActions = {
    onText: (value) => {
      setText(value);
      setPage("results");
      resetFor();
    },
    onKey: (e) => {
      if (e.nativeEvent.isComposing) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setChosen(moveSelection(keys, selected, e.key === "ArrowDown" ? 1 : -1));
        resetFor();
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (selected) void link(selected, e.metaKey || e.ctrlKey);
      }
    },
    onKind: (value) => {
      setKind(value);
      saveKindFilter(value);
      resetFor();
      focusField();
    },
    onContainer: (key) => {
      setContainerKey(key);
      resetFor();
      focusField();
    },
    onSelect: (key) => {
      if (key === selected) return;
      setChosen(key);
      resetFor();
    },
    onOpen: (key) => {
      if (key !== selected) resetFor();
      setChosen(key);
      setPage("preview");
      // Keep the keyboard where it is on the two-pane layout.
      if ((rootRef.current?.clientWidth ?? 0) >= 720) focusField();
    },
    onBack: () => {
      setPage("results");
      focusField();
    },
    onLink: (key) => void link(key),
    onUndo: (key) => void undo(key),
    onCreate: (key, additional) => void createFrom(key, additional),
    onCancelCreate: () => setCreate(null),
    onMap: () => void mapAndLink(),
    onMore: () => {
      void more();
      focusField();
    },
    onOpenTask: (issue) => {
      onClose();
      session.open(writeWs ?? session.ws, issue.id);
    },
    onSettings: () => {
      onClose();
      openSettings({ section: "integrations" });
    },
    onDone: onClose,
    onWorkspace: (ws) => {
      setTargetWs(ws);
      setTargetRef("");
    },
    onTarget: (identifier) => {
      setTargetRef(rows.find((r) => r.issue.identifier === identifier)?.issue.id ?? identifier);
      resetFor();
      focusField();
    },
  };

  const served = new Set(targets.map((t) => t.connectionId).filter(Boolean));
  const shownProblem = problem && (problem.key === null || problem.key === selected) ? problem : null;
  const lastPages = answer?.mode === "search" ? Object.values(answer.pages).map((list) => list?.[list.length - 1]) : [];

  const state: LinkDialogState = {
    workspace: targetWs || searchWs || "",
    target,
    targetOptions: rows.map((r) => ({ value: r.issue.identifier, label: r.issue.identifier, hint: r.issue.title, status: r.issue.status })),
    workspaceChoices: all && !initialWorkspace ? session.workspaces.map((w) => w.slug) : null,
    text,
    kind,
    scope,
    containerKey,
    connections: connections.connections.filter((c) => served.has(c.id)),
    failures: mergeFailures(answers),
    groups,
    pasted: answer?.mode === "paste",
    searching,
    searchError,
    hasMore: lastPages.some((p) => !!p?.nextCursor),
    selected,
    page,
    linkedHere,
    undoable,
    linking,
    previewError: shownProblem?.message ?? null,
    outside: shownProblem?.outside ?? null,
    create,
    linkedCount: sessionLinks.size,
    isMac: isMac(),
    stale,
    canCreate: !!writeWs,
  };

  return (
    <div ref={rootRef} className="flex min-h-0 flex-1 flex-col">
      <LinkDialogView state={state} actions={actions} inputRef={inputRef} />
    </div>
  );
}
