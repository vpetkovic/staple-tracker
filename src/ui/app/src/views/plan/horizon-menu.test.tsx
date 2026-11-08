/**
 * A horizon's column menu on the board: an action its state offers but holds back (Remove while
 * the horizon is queued) is disabled there, and says why in words, as the drawer does.
 */
import { DropdownMenu as Menu } from "radix-ui";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { horizonActionItems } from "@/detail/plain-actions";
import { HorizonMenuItem } from "./PlanBoards";

function menu(actions: Array<{ id: string; label: string; who: "anyone" | "person"; disabledReason?: string }>): string {
  const items = horizonActionItems("ws", { id: "h1", actions });
  return renderToStaticMarkup(
    <Menu.Root open>
      <Menu.Content forceMount>
        {items.map((item) => (
          <HorizonMenuItem key={item.id} item={item} identifier="LAR-3" onChoose={() => {}} />
        ))}
      </Menu.Content>
    </Menu.Root>,
  );
}

describe("a horizon's column menu", () => {
  it("disables a held-back Remove and shows the reason", () => {
    const html = menu([{ id: "remove", label: "Remove", who: "person", disabledReason: "It is in the queue; take it off first." }]);
    expect(html).toMatch(/data-plan-horizon-action="remove"[^>]*data-disabled=""|data-disabled=""[^>]*data-plan-horizon-action="remove"/);
    expect(html.replace(/<[^>]*>/g, " ")).toContain("It is in the queue; take it off first.");
  });

  it("leaves an action it can take enabled, with no reason", () => {
    const html = menu([{ id: "remove", label: "Remove", who: "person" }]);
    expect(html).not.toContain("data-disabled");
    expect(html).not.toContain("data-plan-horizon-held");
  });
});
