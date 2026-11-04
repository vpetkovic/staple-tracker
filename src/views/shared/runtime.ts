/**
 * The runtime every staple MCP Apps view shares.
 *
 * A view is one HTML file the host renders in a sandboxed frame inside the agent's thread. It
 * cannot reach the network: everything it shows arrives through the host, over the MCP Apps
 * bridge (`App` from `@modelcontextprotocol/ext-apps`). This module does the parts every view
 * needs, so a view only turns a tool result into DOM:
 *
 *   - connect to the host, and render the tool result the host forwards (and an error result
 *     as an error, never as a blank frame);
 *   - follow the host's theme, style variables and fonts, live, when they change;
 *   - call staple tools, post messages and open links through the host (it may ask the
 *     user first);
 *   - report the content size, so the host sizes the frame (`autoResize`);
 *   - mark `<body data-ready>` once a result has painted, which tests and captures wait for.
 */
import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
  type McpUiHostContext,
} from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** What a view can ask of the host it renders in. */
export interface ViewHost {
  /** The host's name, from the handshake (for example `claude-desktop`). */
  readonly hostName: string | undefined;
  /** The host context: theme, style variables, container size, locale. */
  readonly context: McpUiHostContext | undefined;
  /** The arguments the agent called the view's tool with. */
  readonly toolArguments: Record<string, unknown>;
  /** Call a staple tool through the host. A host may ask the user before a tool that writes. */
  callTool(name: string, args?: Record<string, unknown>): Promise<CallToolResult>;
  /** Post a user message into the thread. Resolves false when the host declines it. */
  sendMessage(text: string): Promise<boolean>;
  /** Ask the host to open a link (`ui/open-link`). Resolves false when the host declines it. */
  openLink(url: string): Promise<boolean>;
  /** Render a result the view fetched itself (say, after a button's tool call) as the current one. */
  show(result: CallToolResult): void;
  /**
   * Whether the host said, in the handshake, that it proxies a view's tool calls to the
   * server (`serverTools`). Undefined before the handshake has finished.
   */
  readonly canCallTools: boolean | undefined;
  /** Run `listener` when the host tears the view down (`ui/resource-teardown`). */
  onTeardown(listener: () => void): void;
}

export interface ViewOptions<T> {
  /** The view's name, as in `ui://staple/<name>`. */
  name: string;
  /** The element the view renders into. */
  root: HTMLElement;
  /** The view's data from a successful tool result, or null when the result is not this view's. */
  read(result: CallToolResult): T | null;
  /** Render the data. Called again for every result the view receives, and when the host context changes. */
  render(data: T, host: ViewHost): void;
}

/** The text blocks of a tool result, joined: what a host without MCP Apps would have shown. */
export function resultText(result: CallToolResult): string {
  return result.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n")
    .trim();
}

type Child = Node | string | null | undefined | false;

/**
 * Build an element. Text always goes in as text nodes, never as markup: ticket titles and
 * comments are user content, and a view must not turn them into HTML.
 */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: Record<string, string | undefined> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value !== undefined) element.setAttribute(name, value);
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    element.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return element;
}

function systemTheme(): "light" | "dark" {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** Apply the host's theme, style variables and fonts. Without a host theme, follow the system. */
function applyContext(context: McpUiHostContext | undefined): void {
  applyDocumentTheme(context?.theme ?? systemTheme());
  const variables = context?.styles?.variables;
  if (variables) applyHostStyleVariables(variables);
  const fonts = context?.styles?.css?.fonts;
  if (fonts) applyHostFonts(fonts);
}

function renderMessage(root: HTMLElement, kind: "loading" | "error", text: string): void {
  root.replaceChildren(h("p", { class: `view-message view-message-${kind}`, role: kind === "error" ? "alert" : "status" }, text));
}

/** Mark the view painted after the browser has laid out what was just rendered. */
function markReady(): void {
  requestAnimationFrame(() => {
    document.body.dataset.ready = "true";
  });
}

/** Connect a view to its host and render every tool result it is given. */
export function startView<T>(options: ViewOptions<T>): ViewHost {
  const app = new App({ name: `staple-${options.name}`, version: "1" }, {}, { autoResize: true });
  let toolArguments: Record<string, unknown> = {};
  const teardownListeners: Array<() => void> = [];

  const host: ViewHost = {
    get hostName() {
      return app.getHostVersion()?.name;
    },
    get context() {
      return app.getHostContext();
    },
    get toolArguments() {
      return toolArguments;
    },
    callTool: (name, args = {}) => app.callServerTool({ name, arguments: args }),
    sendMessage: async (text) => {
      const answer = await app.sendMessage({ role: "user", content: [{ type: "text", text }] });
      return answer.isError !== true;
    },
    openLink: async (url) => {
      const answer = await app.openLink({ url });
      return answer.isError !== true;
    },
    show: (result) => show(result),
    get canCallTools() {
      const capabilities = app.getHostCapabilities();
      return capabilities === undefined ? undefined : capabilities.serverTools !== undefined;
    },
    onTeardown: (listener) => {
      teardownListeners.push(listener);
    },
  };

  let shown: T | null = null;
  const show = (result: CallToolResult): void => {
    shown = result.isError ? null : options.read(result);
    if (shown !== null) options.render(shown, host);
    else if (result.isError) renderMessage(options.root, "error", resultText(result) || "The tool call failed.");
    else renderMessage(options.root, "error", resultText(result) || "This result has nothing to show.");
    markReady();
  };

  renderMessage(options.root, "loading", "Waiting for the tool result…");
  applyContext(undefined);
  // Handlers go on before connect: a host may send the result right after the handshake.
  app.ontoolinput = (params) => {
    toolArguments = params.arguments ?? {};
  };
  app.ontoolresult = show;
  app.onteardown = () => {
    for (const listener of teardownListeners) listener();
    return {};
  };
  app.onhostcontextchanged = () => {
    applyContext(app.getHostContext());
    if (shown !== null) options.render(shown, host);
  };
  app
    .connect()
    .then(() => applyContext(app.getHostContext()))
    .catch((error: unknown) => {
      renderMessage(options.root, "error", `Could not connect to the host: ${error instanceof Error ? error.message : String(error)}`);
    });
  return host;
}
