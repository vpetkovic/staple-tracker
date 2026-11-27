import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "../types.js";

/**
 * Version 27: why an idea links a ticket (`design/plan.md`, "Links").
 *
 * One column on `plan_links`. A link is `delivery`, the work the idea stands for (every link
 * before this one was), or `exploration`: research or a proof of concept done while the idea is
 * still being worked out. Exploration is listed on the idea on its own and is nothing the idea is
 * measured by: it does not start the idea, count toward its progress, or join its horizon.
 *
 * ## On the wire
 *
 * The purpose rides the link's own field (`planLink.<issue id>`, `plan-links.ts`): an exploration
 * link's value carries `purpose: "exploration"`, and a delivery link's value is unchanged. One
 * field per idea and issue, so an issue is linked one way at a time, and two devices that link the
 * same issue two ways offline meet on one field, a conflict like linking and unlinking it.
 *
 * ## What it costs
 *
 * As with every migration, the number is the `schema` every operation carries: an upgraded device
 * stamps its operations 27 and an older client refuses them with `schema_ahead`, so no older build
 * reads an exploration link as delivery. Purely additive: every existing row is `delivery`.
 */
export const migration: Migration = {
  version: 27,
  name: "plan-link-purpose",
  up(db: DatabaseSync): void {
    db.exec(`ALTER TABLE plan_links ADD COLUMN purpose TEXT NOT NULL DEFAULT 'delivery' CHECK (purpose IN ('delivery', 'exploration'));`);
  },
};
