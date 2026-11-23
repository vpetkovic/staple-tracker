/** Reusable read contract for provider adapters backed by isolated, known source data. */
import { describe, expect, it } from "vitest";
import type { ExternalItem, IntegrationAdapter } from "../../src/core/integrations/contracts.js";
import { IntegrationReader } from "../../src/core/integrations/provider.js";

export interface IntegrationContractFixture {
  adapter: IntegrationAdapter;
  /** Search for "source" in this container must return these items across all pages. */
  items: ExternalItem[];
}

/**
 * Each test gets a fresh adapter/data set. The real gh adapter can use recorded
 * process responses, while HTTP adapters can use a local fake server. No live
 * account, authentication change or provider write belongs in this suite.
 */
export function integrationReadContract(name: string, create: () => IntegrationContractFixture): void {
  describe(`${name} adapter read contract`, () => {
    it("validates its connection and discovers the selected container", async () => {
      const { adapter, items } = create();
      const reader = new IntegrationReader(adapter);
      expect(await reader.validate()).toEqual({ state: "ready" });
      const containers = [];
      let cursor: string | undefined;
      const seen = new Set<string>();
      do {
        const page = await reader.listContainers(cursor);
        containers.push(...page.items);
        cursor = page.nextCursor ?? undefined;
        if (cursor !== undefined) {
          expect(seen.has(cursor), "container cursor must advance").toBe(false);
          seen.add(cursor);
        }
      } while (cursor !== undefined);
      expect(containers.map((container) => container.id)).toContain(items[0]!.ref.containerId);
    });

    it("preserves provider identity and native states across opaque search pages", async () => {
      const { adapter, items } = create();
      const reader = new IntegrationReader(adapter);
      const actual: ExternalItem[] = [];
      let cursor: string | undefined;
      const seen = new Set<string>();
      do {
        const page = await reader.search("issue", { text: "source", containerId: items[0]!.ref.containerId, cursor });
        actual.push(...page.items);
        cursor = page.nextCursor ?? undefined;
        if (cursor !== undefined) {
          expect(seen.has(cursor), "issue cursor must advance").toBe(false);
          seen.add(cursor);
        }
      } while (cursor !== undefined);
      expect(actual).toEqual(items);
    });

    it("resolves exact URLs and display keys to the same refreshable identity", async () => {
      const { adapter, items } = create();
      const reader = new IntegrationReader(adapter);
      const item = items[0]!;
      const fromUrl = await reader.resolve({ url: item.url });
      const fromKey = await reader.resolve({ key: item.key, containerId: item.ref.containerId });
      expect(fromUrl!.ref).toEqual(item.ref);
      expect(fromKey!.ref).toEqual(item.ref);
      expect(await reader.read(fromUrl!.ref)).toEqual(item);
    });
  });
}
