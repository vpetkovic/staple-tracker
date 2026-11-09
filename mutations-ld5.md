# Plan preference and horizon mutation checks

Source head: 5cd82ca361aa91635541598564b956f85150b06f

Each deliberate regression caused the named focused test to fail. The source was restored after each case, and the UI was rebuilt after restoration.

| Rule | Focused test | Result |
|---|---|---|
| Default buckets | `test/plan-owner-tweaks.test.tsx`: enables Now | Caught |
| Legacy migration | `test/plan-owner-tweaks.test.tsx`: migrates undated Later | Caught |
| Journal safety | `test/plan-owner-tweaks.test.tsx`: defers a connected | Caught |
| Dated-only milestones | `test/plan-owner-tweaks.test.tsx`: lists dated horizons | Caught |
| Workspace memory | `test/plan-memory.test.ts`: per workspace | Caught |
| Refused storage | `test/plan-memory.test.ts`: fails safe | Caught |
| Stable idea links | `test/plan-owner-tweaks.test.tsx`: links every planned idea | Caught |
| Singular counts | `test/plan-owner-tweaks.test.tsx`: singular and plural | Caught |
| Shared strip styles | `test/plan-owner-tweaks.test.tsx`: shares the drawer | Caught |
| Shared Plan component | `test/ui-plan-owner-tweaks.test.ts`: restores Plan lens | Caught |
| Single-workspace URL | `test/ui-plan-owner-tweaks.test.ts`: without a workspace parameter | Caught |
| Phone indicator | `test/ui-horizon-chip.test.ts`: full horizon name | Caught |
