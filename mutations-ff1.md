# Experimental planning mutation checks

Source head: e0de55c7e43213db4cb709c8439c265bb46ffab6

Each behavioral regression failed with an assertion in the named focused test. All source bytes were restored after each case; both working-tree and staged diffs were empty afterward.

| Gate | Test | Mutation result |
|---|---|---|
| Default is off | `planning-feature.test.ts` · defaults off | Caught |
| Person controls set | `planning-feature.test.ts` · defaults off | Caught |
| Person controls reset | `planning-feature.test.ts` · defaults off | Caught |
| One setting initializes planning | `planning-feature.test.ts` · defaults off | Caught |
| Effective flag gates planning | `planning-feature.test.ts` · refuses plan writes | Caught |
| Plan writes refuse off | `planning-feature.test.ts` · refuses plan writes | Caught |
| Idea pickup guard persists off | `planning-feature.test.ts` · refuses plan writes | Caught |
| Task list excludes retained ideas | `planning-feature.test.ts` · refuses plan writes | Caught |
| Off on keeps plan bytes | `planning-feature.test.ts` · restores every stored | Caught |
| CLI reads refuse off | `planning-feature-surfaces.test.ts` · CLI, MCP and HTTP | Caught |
| MCP wrapper refuses off | `planning-feature-surfaces.test.ts` · CLI, MCP and HTTP | Caught |
| MCP descriptions report experimental | `planning-feature-surfaces.test.ts` · CLI, MCP and HTTP | Caught |
| HTTP plan reads refuse off | `planning-feature-surfaces.test.ts` · CLI, MCP and HTTP | Caught |
| HTTP old enable route refuses off | `planning-feature-surfaces.test.ts` · CLI, MCP and HTTP | Caught |
| Tasks horizon chip field absent | `planning-feature-surfaces.test.ts` · OFF omits plan detail | Caught |
| Drawer plan fields absent | `planning-feature-surfaces.test.ts` · OFF omits plan detail | Caught |
| Phone Plan navigation absent | `planning-feature-ui.test.tsx` · OFF removes Plan navigation | Caught |
| Desktop Plan navigation absent | `planning-feature-ui.test.tsx` · OFF removes Plan navigation | Caught |
| Direct Plan view absent | `planning-feature-ui.test.tsx` · OFF removes Plan navigation | Caught |
| Palette Plan navigation absent | `planning-feature-ui.test.tsx` · OFF removes palette | Caught |
| Palette lifecycle actions absent | `planning-feature-ui.test.tsx` · OFF removes palette | Caught |
| Tasks Horizon filter absent | `planning-feature-ui.test.tsx` · OFF removes the Horizon filter | Caught |
| Tasks Horizon axis absent | `planning-feature-ui.test.tsx` · OFF removes the Horizon grouping | Caught |
| Next context and brief instructions absent | `planning-feature.test.ts` · horizon-run instructions are absent | Caught |
| Continue instructions absent | `planning-feature.test.ts` · continue_run omits | Caught |
| Flag sync changes another device | `planning-feature-sync.test.ts` · device A → B → off → on | Caught |
| Direct idea HTTP reads refuse off | `planning-feature-surfaces.test.ts` · CLI, MCP and HTTP | Caught |
| About reports the effective flag | `planning-feature-surfaces.test.ts` · CLI, MCP and HTTP | Caught |
| Bootstrap reports the effective flag | `planning-feature-surfaces.test.ts` · CLI, MCP and HTTP | Caught |
| Settings toggle is experimental | `planning-feature-ui.test.tsx` · Settings labels | Caught |

Thirty behavioral mutations were caught. The first task-list trial left a redundant guard active; the final trial removed the explicit-kind OFF guard and failed the retained-idea assertion. The direct idea HTTP route has both route and domain checks; removing only the route check preserved the refusal, and removing both produced the expected failing assertion. The direct Plan render fixture was corrected so that its mutation fails on visible markup rather than unavailable browser globals.

The off → on round trip compares full rows from issues, documents, plan_links, plan_rows, plan_members and milestone_members byte for byte, then compares the complete plan view. It includes a shaped idea, breakdown section, linked task, horizon and run setting.
