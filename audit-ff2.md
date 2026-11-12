# Planning state and record protection

The flag controls presentation and feature access. Identity guards use idea kind or milestone kind plus a plan rank. They never use the flag or structural readiness to decide what a record is.

| Call site | Classification | Result |
|---|---|---|
| mcp.ts featureInstructions | Presentation / discovery | Keep; startup text directs agents to get_setting for current state |
| mcp.ts show_about | Presentation / discovery | Keep |
| ui/server.ts bootstrap | Presentation | Keep |
| ui/server.ts task horizon fields | Presentation | Keep |
| milestone-store.ts list | Presentation | Keep; OFF lists horizons as ordinary milestones |
| plan-store.ts enabled | Feature availability | Keep |
| plan-store.ts assertEnabled | Feature access gate | Keep; identity is established separately |
| store.ts generic idea creation | Feature-write gate | Determine idea kind first, then refuse OFF |
| store.ts issuesQuery | Presentation | OFF excludes ideas regardless of structural readiness |
| store.ts instructions | Presentation | Omit planning instructions OFF |
| store.ts context instructions | Presentation | Omit planning instructions OFF |
| store.ts context child/ancestor visibility | Presentation | Hide nested ideas OFF; direct idea context refuses |
| store.ts explicit tree visibility | Presentation | Hide nested ideas OFF; direct idea subtree refuses |
| run-store.ts takeInstructions | Presentation | Omit planning instructions OFF |
| store.ts planningOn definition | Effective feature availability | Flag plus structural readiness |

Protection calls removed from planningOn: generic horizon update, milestone update, HTTP milestone routing, queue enqueue, horizon goal-run guard. These recognize the record first; hidden-record writes refuse through assertEnabled. Membership moves validate both source and destination, and bulk queue prune validates every removed record. Reserved kinds cannot be removed while any idea or horizon exists. The remaining planningInitialized calls serve only effective availability and initialization.
