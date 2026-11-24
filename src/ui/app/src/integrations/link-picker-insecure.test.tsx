/**
 * The tailnet UI is served over plain HTTP, which browsers treat as an insecure context:
 * `crypto.randomUUID` is undefined there while `crypto.getRandomValues` still works.
 * The picker used to call `crypto.randomUUID()` while rendering, so opening it threw,
 * and with no error boundary React unmounted the whole page.
 */
import { afterEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionContext, type StapleSession } from "@/lib/session";
import { PickerBody } from "./LinkExternalPicker";
import { newRequestKey } from "@/lib/request-key";

const session = { open: () => {}, refresh: () => {}, workspaces: [], ws: "staple" } as unknown as StapleSession;

function withoutRandomUuid() {
  Object.defineProperty(globalThis.crypto, "randomUUID", { value: undefined, configurable: true });
}
afterEach(() => {
  delete (globalThis.crypto as { randomUUID?: unknown }).randomUUID;
});

describe("link picker in an insecure context", () => {
  it("renders when crypto.randomUUID is unavailable", () => {
    withoutRandomUuid();
    expect(typeof globalThis.crypto.randomUUID).toBe("undefined");
    const html = renderToStaticMarkup(
      <SessionContext value={session}>
        <PickerBody ws="staple" onClose={() => {}} />
      </SessionContext>,
    );
    expect(html).toContain("Issue URL or search");
  });

  it("still produces distinct version 4 request keys without crypto.randomUUID", () => {
    withoutRandomUuid();
    const a = newRequestKey(), b = newRequestKey();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a).not.toBe(b);
  });
});
