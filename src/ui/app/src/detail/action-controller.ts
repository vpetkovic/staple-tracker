/**
 * The detail's write controller, as a plain module: no React, no DOM, no fetch of its own.
 *
 * The components are wired so that every tap hands ONE item's own descriptor to a function
 * built here (`statusEntries`, `overflowEntries`, `primaryEntry`, `gateHandlers`). Those
 * functions call `controller.run(call)`, and `run` is the only place that resolves the actor
 * and sends. The API functions, the prompt and the remembered names are injected, so the tests
 * drive the real wiring with fakes: tap item k and exactly item k's request goes out; approve
 * reaches the approve route; the name the prompt returned is the name on the request.
 */
import { gateCalls, toRequest, type ActorSource, type ApiRequest, type WriteCall } from "./plain-actions";

/** The two names this browser remembers, kept apart on purpose (see ActionContext). */
export interface Names {
  /** Who is working on it: the last Start work name. May be an agent. */
  worker: string | null;
  /** Who I am: the person using this browser. */
  person: string | null;
}

export interface ControllerDeps {
  post: {
    action: (target: Extract<ApiRequest, { fn: "action" }>["target"], payload: Extract<ApiRequest, { fn: "action" }>["payload"]) => Promise<unknown>;
    requestGate: (body: Extract<ApiRequest, { fn: "requestGate" }>["body"]) => Promise<unknown>;
    approveGate: (body: Extract<ApiRequest, { fn: "approveGate" }>["body"]) => Promise<unknown>;
    requestGateChanges: (body: Extract<ApiRequest, { fn: "requestGateChanges" }>["body"]) => Promise<unknown>;
  };
  /** Ask for a name (window.prompt in the page). Null when cancelled. */
  ask: (prompt: string, prefill: string) => string | null;
  names: () => Names;
  remember: (which: keyof Names, name: string) => void;
}

export type Outcome =
  | { kind: "sent" }
  /** Nothing was sent, and the sentence says why (a cancelled or empty name). */
  | { kind: "cancelled"; message: string }
  | { kind: "refused"; error: unknown };

/** The name a call is sent under, or the reason nothing will be sent. */
export function resolveActor(source: ActorSource, names: Names, ask: ControllerDeps["ask"]): { actor: string | null; remember?: keyof Names } | { cancelled: string } {
  switch (source.from) {
    case "worker":
      return { actor: names.worker };
    case "person":
      return { actor: names.person };
    case "worker-prompt": {
      const name = ask(source.prompt, names.worker ?? "")?.trim();
      return name ? { actor: name, remember: "worker" } : { cancelled: `Nothing was sent. ${source.need}` };
    }
    case "person-confirm": {
      // Pre-filled with the person's own name only, never with the working name.
      const name = ask(source.prompt, names.person ?? "")?.trim();
      return name ? { actor: name, remember: "person" } : { cancelled: `Nothing was sent. ${source.need}` };
    }
  }
}

export function send(post: ControllerDeps["post"], request: ApiRequest): Promise<unknown> {
  switch (request.fn) {
    case "action":
      return post.action(request.target, request.payload);
    case "requestGate":
      return post.requestGate(request.body);
    case "approveGate":
      return post.approveGate(request.body);
    case "requestGateChanges":
      return post.requestGateChanges(request.body);
  }
}

export interface ActionController {
  run: (call: WriteCall) => Promise<Outcome>;
}

export function createActionController(deps: ControllerDeps): ActionController {
  return {
    async run(call) {
      const resolved = resolveActor(call.actor, deps.names(), deps.ask);
      if ("cancelled" in resolved) return { kind: "cancelled", message: resolved.cancelled };
      if (resolved.remember && resolved.actor) deps.remember(resolved.remember, resolved.actor);
      try {
        await send(deps.post, toRequest(call, resolved.actor));
        return { kind: "sent" };
      } catch (error) {
        return { kind: "refused", error };
      }
    },
  };
}

// ─────────────────────────────────────────────────── the wiring the components use

/** What a component needs to run a call: the page's `run`, which reports to the panel. */
export type Run = (call: WriteCall) => Promise<boolean>;

/** Each item with its own `select`: the component renders `onSelect={entry.select}` and nothing else. */
export function statusEntries<T extends { call?: WriteCall }>(items: readonly T[], run: Run): Array<T & { select: () => void }> {
  return items.map((item) => ({ ...item, select: () => void (item.call ? run(item.call) : undefined) }));
}

/** The ⋯ items: a write runs its own call; the ones that open something call their opener. */
export function overflowEntries<T extends { id: string; call?: WriteCall }>(items: readonly T[], run: Run, open: { requestApproval: () => void }): Array<T & { select: () => void }> {
  return items.map((item) => ({
    ...item,
    select: () => {
      if (item.id === "request-approval") open.requestApproval();
      else if (item.call) void run(item.call);
    },
  }));
}

/** The primary button's click: review scrolls to the approval card; everything else runs its call. */
export function primaryEntry<T extends { id: string; call?: WriteCall }>(item: T, run: Run, onReview: () => void): T & { click: () => void } {
  return {
    ...item,
    click: () => {
      if (item.id === "review") onReview();
      else if (item.call) void run(item.call);
    },
  };
}

/** The approval card's and the request form's handlers, each sending its own gate call. */
export function gateHandlers(ctx: Parameters<typeof gateCalls.request>[0], run: Run) {
  return {
    approveAll: (comment?: string) => run(gateCalls.approveAll(ctx, comment)),
    approveSelected: (childIds: string[]) => run(gateCalls.approveSelected(ctx, childIds)),
    requestChanges: (comment: string) => run(gateCalls.requestChanges(ctx, comment)),
    requestApproval: (owner: string) => run(gateCalls.request(ctx, owner)),
  };
}
