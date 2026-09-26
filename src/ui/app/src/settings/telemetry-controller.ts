/**
 * The "Usage & budget" section's state and handlers, apart from React.
 *
 * `TelemetrySection` is a thin hook over this: it subscribes to the controller and renders
 * `TelemetryPanel` from its state with its handlers. Keeping the wiring here, not in the
 * component, is what lets a test with no DOM drive the REAL handlers against the real
 * server (`telemetry-e2e.test.tsx`): the same code the page runs, fed by the same API
 * functions, with only the transport pointed at the test server.
 *
 * One action at a time; the status is re-read after every action, refused or not. A page
 * open from another device (`remote`) makes no write at all: its buttons are disabled and a
 * handler reached anyway says why instead of sending a request that would be refused.
 */
import { describeRefusal } from "@/lib/refusal";
import type {
  BindInput,
  BindingHomeInput,
  BindingSourceFlag,
  BudgetConfigView,
  CollectResult,
  CollectionOutcome,
  CollectionPlanResponse,
  CollectionSetupOptions,
  CollectionStatus,
  KnownBinding,
  PlanConsentTicket,
} from "@/lib/telemetry-types";
import { confirmPlan, reasonOf, showPlan, type ShownPlan } from "./telemetry-flow";
import {
  CROSS_ORIGIN_MESSAGE,
  EMPTY_BINDING_DRAFT,
  SOURCE_WORDS,
  appliedText,
  bindInputOf,
  bindingDir,
  bindingHomeInput,
  draftOf,
  plainRefusal,
  setupDefaults,
  setupOptionsOf,
  withSource,
  type BindingDraft,
  type PlainRefusal,
} from "./telemetry-settings";

export type TelemetryBusy = null | "refresh" | "plan" | "confirm" | "capture" | "bind" | "unbind" | "collect";

/** The outcome line under the section's actions. `cross_origin` is its own tone: nothing about the change was wrong. */
export interface TelemetryNotice {
  tone: "ok" | "error" | "cross_origin";
  text: string;
  lines?: string[];
  details?: string;
}

export interface SetupDraft {
  claudeAccount: string;
  codexAccount: string;
  statusline: boolean;
  watcher: boolean;
}

export interface BindingEditor {
  /** Null: adding a new link. Otherwise the binding being edited. */
  editing: KnownBinding | null;
  draft: BindingDraft;
  error: PlainRefusal | null;
}

export interface TelemetryState {
  status: CollectionStatus | null;
  loadError: string | null;
  busy: TelemetryBusy;
  notice: TelemetryNotice | null;
  /** The page is open from another device, so no write is attempted. */
  remote: boolean;
  setupForm: SetupDraft | null;
  plan: ShownPlan | null;
  planWhy: string | null;
  captureConfirm: boolean;
  editor: BindingEditor | null;
  removing: KnownBinding | null;
  lastCollect: CollectResult | null;
}

export interface TelemetryHandlers {
  onRefresh(): Promise<void>;
  onOpenSetup(): void;
  onSetupDraft(draft: SetupDraft): void;
  onPlan(action: "setup" | "unsetup"): Promise<void>;
  onConfirmPlan(): Promise<void>;
  onCancelPlan(): void;
  onCaptureAsk(): void;
  onCaptureConfirm(): Promise<void>;
  onCaptureCancel(): void;
  onCollect(): Promise<void>;
  onEditorOpen(binding: KnownBinding | null): void;
  onEditorDraft(draft: BindingDraft): void;
  /** What the link reads changed: the provider goes back to that source's default. */
  onEditorSource(source: BindingSourceFlag): void;
  onEditorSave(): Promise<void>;
  onEditorCancel(): void;
  onRemoveAsk(binding: KnownBinding): void;
  onRemoveConfirm(): Promise<void>;
  onRemoveCancel(): void;
}

/** The calls the section makes: `lib/api.ts` in the page. */
export interface TelemetryApi {
  status(): Promise<CollectionStatus>;
  plan(action: "setup" | "unsetup", options: CollectionSetupOptions): Promise<CollectionPlanResponse>;
  apply(action: "setup" | "unsetup", consent: PlanConsentTicket): Promise<CollectionOutcome>;
  collect(): Promise<CollectResult>;
  capture(enabled: boolean): Promise<BudgetConfigView>;
  bind(input: BindInput): Promise<BudgetConfigView>;
  unbind(input: BindingHomeInput): Promise<BudgetConfigView>;
}

export interface TelemetryController {
  get(): TelemetryState;
  subscribe(listener: () => void): () => void;
  reload(): Promise<void>;
  handlers: TelemetryHandlers;
  dispose(): void;
}

/** A refusal in the section's words: the cross-origin sentence, a binding reason in plain words, or the server's. */
export function refusalOf(error: unknown): PlainRefusal & { crossOrigin: boolean } {
  const described = describeRefusal(error);
  const words = plainRefusal({ message: described.message, reason: reasonOf(error), serverMessage: described.serverMessage });
  return { ...words, crossOrigin: reasonOf(error) === "cross_origin" };
}

function noticeOf(error: unknown): TelemetryNotice {
  const refusal = refusalOf(error);
  return { tone: refusal.crossOrigin ? "cross_origin" : "error", text: refusal.text, ...(refusal.detail ? { details: refusal.detail } : {}) };
}

const REMOTE_NOTICE: TelemetryNotice = { tone: "cross_origin", text: CROSS_ORIGIN_MESSAGE };

export function createTelemetryController(api: TelemetryApi, options: { remote: boolean }): TelemetryController {
  let state: TelemetryState = {
    status: null,
    loadError: null,
    busy: null,
    notice: null,
    remote: options.remote,
    setupForm: null,
    plan: null,
    planWhy: null,
    captureConfirm: false,
    editor: null,
    removing: null,
    lastCollect: null,
  };
  const listeners = new Set<() => void>();
  let disposed = false;
  const set = (patch: Partial<TelemetryState>): void => {
    if (disposed) return;
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };

  const reload = async (): Promise<void> => {
    try {
      set({ status: await api.status(), loadError: null });
    } catch (error) {
      set({ loadError: describeRefusal(error).message });
    }
  };

  const run = async (kind: Exclude<TelemetryBusy, null>, work: () => Promise<void>): Promise<void> => {
    if (state.busy !== null) return;
    set({ busy: kind });
    try {
      await work();
    } finally {
      await reload();
      set({ busy: null });
    }
  };

  /** Every write goes through here: from another device it is not attempted. */
  const write = async (kind: Exclude<TelemetryBusy, null>, work: () => Promise<void>): Promise<void> => {
    if (state.remote) {
      set({ notice: REMOTE_NOTICE });
      return;
    }
    await run(kind, work);
  };

  const handlers: TelemetryHandlers = {
    onRefresh: () => run("refresh", async () => {}),
    onOpenSetup: () => {
      if (state.status === null) return;
      set({ notice: null, setupForm: { ...setupDefaults(state.status), statusline: true, watcher: true } });
    },
    onSetupDraft: (draft) => set({ setupForm: draft }),
    onPlan: (action) =>
      write("plan", async () => {
        set({ notice: null, planWhy: null });
        try {
          const setupOptions = action === "setup" && state.setupForm !== null ? setupOptionsOf(state.setupForm) : {};
          set({ plan: await showPlan({ plan: api.plan, apply: api.apply }, action, setupOptions) });
        } catch (error) {
          set({ notice: noticeOf(error) });
        }
      }),
    onConfirmPlan: () =>
      write("confirm", async () => {
        const plan = state.plan;
        if (plan === null) return;
        let result;
        try {
          result = await confirmPlan({ plan: api.plan, apply: api.apply }, plan);
        } catch (error) {
          set({ notice: noticeOf(error) });
          return;
        }
        switch (result.kind) {
          case "applied": {
            const lines = appliedText(plan.action, result.outcome.applied, result.options);
            set({
              notice: {
                tone: "ok",
                text: plan.action === "setup" ? "Automatic collection is on. Done:" : "Automatic collection is off. Done:",
                lines: lines.length > 0 ? lines : ["Nothing needed changing."],
              },
              plan: null,
              planWhy: null,
              setupForm: null,
            });
            break;
          }
          case "replanned":
            set({ plan: result.shown, planWhy: result.why });
            break;
          case "incomplete":
            set({
              notice: {
                tone: "error",
                text: "Setup stopped partway through. What was already done is listed below; “Turn off automatic collection” undoes it.",
                lines: appliedText("setup", result.applied, plan.options),
                details: result.message,
              },
              plan: null,
              planWhy: null,
              setupForm: null,
            });
            break;
          case "refused":
            set({ notice: result.crossOrigin ? { tone: "cross_origin", text: CROSS_ORIGIN_MESSAGE, details: result.message } : { tone: "error", text: result.message } });
            break;
        }
      }),
    onCancelPlan: () => set({ plan: null, planWhy: null, setupForm: null }),
    onCaptureAsk: () => set({ notice: null, captureConfirm: true }),
    onCaptureCancel: () => set({ captureConfirm: false }),
    onCaptureConfirm: () =>
      write("capture", async () => {
        const enable = !(state.status?.budgetCapture ?? false);
        try {
          await api.capture(enable);
          set({ notice: { tone: "ok", text: enable ? "Usage tracking is on." : "Usage tracking is off. Readings already saved are kept." } });
        } catch (error) {
          set({ notice: noticeOf(error) });
        } finally {
          set({ captureConfirm: false });
        }
      }),
    onCollect: () =>
      write("collect", async () => {
        set({ notice: null });
        try {
          set({ lastCollect: await api.collect() });
        } catch (error) {
          set({ notice: noticeOf(error) });
        }
      }),
    onEditorOpen: (binding) =>
      set({ notice: null, removing: null, editor: { editing: binding, draft: binding === null ? EMPTY_BINDING_DRAFT : draftOf(binding), error: null } }),
    onEditorDraft: (draft) => set({ editor: state.editor === null ? null : { ...state.editor, draft, error: null } }),
    onEditorSource: (source) => set({ editor: state.editor === null ? null : { ...state.editor, draft: withSource(state.editor.draft, source), error: null } }),
    onEditorCancel: () => set({ editor: null }),
    onEditorSave: () =>
      write("bind", async () => {
        const editor = state.editor;
        if (editor === null) return;
        try {
          await api.bind(bindInputOf(editor.draft, editor.editing));
          set({ editor: null, notice: { tone: "ok", text: editor.editing === null ? "Account link added." : "Account link saved." } });
        } catch (error) {
          const refusal = refusalOf(error);
          if (refusal.crossOrigin) set({ notice: noticeOf(error) });
          else set({ editor: state.editor === null ? null : { ...state.editor, error: { text: refusal.text, detail: refusal.detail } } });
        }
      }),
    onRemoveAsk: (binding) => set({ notice: null, editor: null, removing: binding }),
    onRemoveCancel: () => set({ removing: null }),
    onRemoveConfirm: () =>
      write("unbind", async () => {
        const removing = state.removing;
        if (removing === null) return;
        try {
          await api.unbind(bindingHomeInput(SOURCE_WORDS[removing.source].flag, bindingDir(removing)));
          set({ notice: { tone: "ok", text: "Account link removed." } });
        } catch (error) {
          set({ notice: noticeOf(error) });
        } finally {
          set({ removing: null });
        }
      }),
  };

  return {
    get: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    reload,
    handlers,
    dispose: () => {
      disposed = true;
      listeners.clear();
    },
  };
}
