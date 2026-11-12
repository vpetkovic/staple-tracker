# Experimental planning workspace switch

Source head: e0de55c7e43213db4cb709c8439c265bb46ffab6

All screenshots and the recording use Larkspur, an invented storefront product. Desktop is 1280px; phone is 390px.

| View | Desktop OFF | Desktop ON | Phone OFF | Phone ON |
|---|---|---|---|---|
| settings | [PNG](https://raw.githubusercontent.com/vpetkovic/staple-tracker/evidence/plan-view/settings-desktop-off-ff1.png) | [PNG](https://raw.githubusercontent.com/vpetkovic/staple-tracker/evidence/plan-view/settings-desktop-on-ff1.png) | [PNG](https://raw.githubusercontent.com/vpetkovic/staple-tracker/evidence/plan-view/settings-phone-off-ff1.png) | [PNG](https://raw.githubusercontent.com/vpetkovic/staple-tracker/evidence/plan-view/settings-phone-on-ff1.png) |
| tasks | [PNG](https://raw.githubusercontent.com/vpetkovic/staple-tracker/evidence/plan-view/tasks-desktop-off-ff1.png) | [PNG](https://raw.githubusercontent.com/vpetkovic/staple-tracker/evidence/plan-view/tasks-desktop-on-ff1.png) | [PNG](https://raw.githubusercontent.com/vpetkovic/staple-tracker/evidence/plan-view/tasks-phone-off-ff1.png) | [PNG](https://raw.githubusercontent.com/vpetkovic/staple-tracker/evidence/plan-view/tasks-phone-on-ff1.png) |

## Plan enabled

[Desktop Plan](https://raw.githubusercontent.com/vpetkovic/staple-tracker/evidence/plan-view/plan-desktop-on-ff1.png) · [Phone Plan](https://raw.githubusercontent.com/vpetkovic/staple-tracker/evidence/plan-view/plan-phone-on-ff1.png)

[35-second OFF → ON recording](https://raw.githubusercontent.com/vpetkovic/staple-tracker/evidence/plan-view/toggle-off-on-ff1.mp4)

The person turns Planning (experimental) off in Settings. Plan navigation and task horizon cues disappear. Existing horizons appear as ordinary milestones. Turning it on restores the navigation, cues and retained plan.

## Contract

- One workspace setting, features.planning, defaults false and synchronizes between devices.
- Only a person can change it through Settings or CLI --person under humanName; an agent can read it.
- OFF refuses planning CLI, MCP and HTTP operations with one sentence. MCP descriptions identify the experimental gate.
- OFF omits drawer plan fields, task horizon fields, palette plan commands, Horizon filter/grouping and horizon-run instructions in pickup, continue and briefs.
- Disabling keeps ideas unnumbered and out of task listing, checkout and pickup. It deletes no planning data.
- The former enable path sets the same flag and initializes planning transactionally. There is one switch.

## Behavioral proof

The off → on test compares the full stored rows for ideas, horizons, documents, breakdowns, links and membership, then the complete plan view. A separate two-device test verifies ON → OFF → ON synchronization and preserved ideas.

[30/30 behavioral mutations caught](https://github.com/vpetkovic/staple-tracker/blob/evidence/plan-view/mutations-ff1.md). All mutated source bytes were restored; the working tree and index were clean.

## Gates

- Package build passed; all three TypeScript programs passed.
- Full suite: 8,121 passed, two skipped, one SQLite-lock concurrency failure in the driver test. The failing file then passed all 35 tests alone, with no source changes between runs.
- Focused feature coverage: 13 tests across four files passed in the full suite.
- MCP smoke: 149 assertions passed across 84 tools, including 33 read-only and 74 workspace-targetable tools.
- Clean-machine package drill: all 13 steps passed.
