/// <reference lib="dom" />
/**
 * A minimal MCP Apps host page, for rendering staple's views in a test browser.
 *
 * Built on the reference host side of `@modelcontextprotocol/ext-apps` (`AppBridge` over
 * `PostMessageTransport`), and nothing host-specific: it renders the view the way any MCP
 * Apps host does, in a sandboxed `srcdoc` frame with an opaque origin, and gives it a host
 * context (theme, standard style variables, container width). Tool calls and resource reads
 * from the view are proxied to the real `staple mcp` the test started, through functions the
 * test exposes on `window`. Messages the view posts and links it asks to open are recorded,
 * not sent or opened anywhere.
 *
 * `test/fixtures/mcp-apps-harness.ts` bundles this file into the page with esbuild.
 */
import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { CallToolRequest, CallToolResult, ReadResourceRequest, ReadResourceResult, Tool } from "@modelcontextprotocol/sdk/types.js";

type Theme = "light" | "dark";

/** A neutral palette in the standard MCP Apps variable names, so views are tested with host styles. */
const PALETTES: Record<Theme, Record<string, string>> = {
  light: {
    "--color-background-primary": "#ffffff",
    "--color-background-secondary": "#f6f6f7",
    "--color-background-tertiary": "#ececee",
    "--color-text-primary": "#18181b",
    "--color-text-secondary": "#52525b",
    "--color-border-primary": "#e4e4e7",
    "--color-border-secondary": "#d4d4d8",
    "--color-ring-primary": "#2563eb",
    "--font-sans": "system-ui, -apple-system, Segoe UI, sans-serif",
    "--font-mono": "ui-monospace, SFMono-Regular, Menlo, monospace",
    "--border-radius-md": "10px",
  },
  dark: {
    "--color-background-primary": "#0b0b0c",
    "--color-background-secondary": "#161618",
    "--color-background-tertiary": "#232326",
    "--color-text-primary": "#fafafa",
    "--color-text-secondary": "#a1a1aa",
    "--color-border-primary": "#2e2e33",
    "--color-border-secondary": "#3f3f46",
    "--color-ring-primary": "#60a5fa",
    "--font-sans": "system-ui, -apple-system, Segoe UI, sans-serif",
    "--font-mono": "ui-monospace, SFMono-Regular, Menlo, monospace",
    "--border-radius-md": "10px",
  },
};

export interface HostStart {
  html: string;
  theme: Theme;
  width: number;
  tool: Tool;
  toolInput: Record<string, unknown>;
  toolResult: CallToolResult;
}

declare global {
  interface Window {
    /** Exposed by the test: proxies to the real server. */
    hostCallTool(params: CallToolRequest["params"]): Promise<CallToolResult>;
    hostReadResource(params: ReadResourceRequest["params"]): Promise<ReadResourceResult>;
    startHost(start: HostStart): Promise<void>;
    setHostTheme(theme: Theme): Promise<void>;
    hostRecord: { messages: unknown[]; toolCalls: string[]; sizes: number[]; links: string[] };
  }
}

let bridge: AppBridge | undefined;
// Read off the method: the package's own type exports do not resolve under NodeNext.
let context: Parameters<AppBridge["setHostContext"]>[0] = {};
window.hostRecord = { messages: [], toolCalls: [], sizes: [], links: [] };

function paintHost(theme: Theme): void {
  document.documentElement.style.colorScheme = theme;
  document.body.style.background = PALETTES[theme]["--color-background-primary"]!;
}

window.startHost = async ({ html, theme, width, tool, toolInput, toolResult }) => {
  paintHost(theme);
  const holder = document.getElementById("frame-host")!;
  holder.style.width = `${width}px`;
  const frame = document.createElement("iframe");
  frame.id = "app-frame";
  frame.title = "MCP App";
  frame.setAttribute("sandbox", "allow-scripts allow-forms");
  frame.style.cssText = `display:block;width:100%;height:0;border:0;background:transparent;color-scheme:${theme}`;
  holder.appendChild(frame);

  context = {
    theme,
    styles: { variables: PALETTES[theme] },
    displayMode: "inline",
    availableDisplayModes: ["inline"],
    containerDimensions: { width, maxHeight: 2000 },
    platform: "web",
    locale: "en-US",
    timeZone: "UTC",
    toolInfo: { tool },
  };
  const created = new AppBridge(
    null,
    { name: "test-host", version: "0.0.0" },
    { serverTools: {}, serverResources: {}, message: { text: {} }, openLinks: {}, logging: {} },
    { hostContext: context },
  );
  created.oncalltool = async (params) => {
    window.hostRecord.toolCalls.push(params.name);
    return window.hostCallTool(params);
  };
  created.onreadresource = async (params) => window.hostReadResource(params);
  created.onmessage = async (params) => {
    window.hostRecord.messages.push(params);
    return {};
  };
  created.onopenlink = async ({ url }) => {
    window.hostRecord.links.push(url);
    return {};
  };
  created.onsizechange = ({ height }) => {
    if (typeof height === "number" && height > 0) {
      window.hostRecord.sizes.push(height);
      frame.style.height = `${Math.ceil(height)}px`;
    }
  };
  // The view gets its input and result once it has initialized. Not awaited: a view that
  // never initializes must still leave a page the test can measure and fail.
  created.oninitialized = async () => {
    await created.sendToolInput({ arguments: toolInput });
    await created.sendToolResult(toolResult);
  };
  await created.connect(new PostMessageTransport(frame.contentWindow!, frame.contentWindow!));
  bridge = created;
  frame.srcdoc = html;
};

window.setHostTheme = async (theme) => {
  paintHost(theme);
  context = { ...context, theme, styles: { variables: PALETTES[theme] } };
  bridge!.setHostContext(context);
};
