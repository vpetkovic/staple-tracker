# Experimental planning, review fixes

Source head: 7a8398c0a2b63955713f5a6b64cffdfca50635a4

All captures use Larkspur, an invented storefront product, from the final packaged build. Desktop is 1280px and phone is 390px. Private tracker previews are excluded.

| State | Desktop | Phone |
|---|---|---|
| Planning ON | [Plan PNG](https://raw.githubusercontent.com/vpetkovic/staple-tracker/evidence/plan-view/plan-desktop-on-ff2.png) | [Plan PNG](https://raw.githubusercontent.com/vpetkovic/staple-tracker/evidence/plan-view/plan-phone-on-ff2.png) |
| Synced planning OFF | [Tasks PNG](https://raw.githubusercontent.com/vpetkovic/staple-tracker/evidence/plan-view/tasks-desktop-off-ff2.png) | [Tasks PNG](https://raw.githubusercontent.com/vpetkovic/staple-tracker/evidence/plan-view/tasks-phone-off-ff2.png) |

[22-second synced OFF → ON recording](https://raw.githubusercontent.com/vpetkovic/staple-tracker/evidence/plan-view/sync-off-on-ff2.mp4)

An open Plan page receives a sync-shaped settings write: only the setting and settings revision change, with no local event or issue write. It refreshes, hides Plan and rewrites the URL to Tasks without its plan lens. Re-enabling restores Plan and retained records. No page errors or horizontal overflow occurred. One in-flight planning request correctly refused OFF with HTTP 409.

## Behavioral proof

- ON → OFF → hostile generic writes → ON preserves complete plan/issue/document/link/membership rows, the person's goal and run settings, and the complete plan view.
- Concurrent first enables converge to one Now and one Next with identical ids on two devices and a fresh third device, in both fold modes, even with different offline task counters. No protocol or Worker change.
- Generic horizon updates, dates/goals, membership moves, dependencies, queue/prune, kind migration and goal runs refuse while OFF. Ordinary milestone reads remain available.
- Ideas stay protected by kind before structural initialization. Hidden generic idea detail and nested idea reads refuse or omit them.
- Both design documents and flag refusals state the existing person trust model; no authentication mechanism changed.

[Complete planningOn classification](audit-ff2.md) · [25-case mutation table](mutations-ff2.md)

## Gates

- Package build and all three TypeScript programs pass.
- Final full suite: 8,122 passed, 32 skipped and three timing failures. The two affected files then passed separately: CLI review scenarios 2/2 and run hooks 31/31. Phone navigation, skipped during a concurrent bundle rebuild, then passed 30/30 separately. All 8,155 non-live tests passed across that run and the required isolated reruns; two live-sync tests remain intentionally skipped.
- Focused feature coverage: 46 tests, all pass. Deterministic contract/fixture reconciliation plus feature coverage: 178/178.
- MCP smoke: 149 assertions, 84 tools, 33 read-only and 74 workspace-targetable; all pass. Counts remain correctly pinned.
- Packaged clean-machine drill: 13/13 steps pass.
- Round-two mutations: 25/25 caught, all source bytes restored, clean working tree and index.

The PR remains a draft. CI and independent re-review are pending.
