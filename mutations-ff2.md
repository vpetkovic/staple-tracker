# Planning feature flag mutation checks

Source head: 7a8398c0a2b63955713f5a6b64cffdfca50635a4

Each case first reproduced a regression, then passed with the fix. All 25 bypass mutations were caught. Mutated source bytes were restored after every case; git diff and the index are clean. The goal-run bypass removes both the early guard and the shared write guard, which independently rejects the later run write.

| Item | Mutation | Result |
|---|---|---|
| 1 | OFF generic write target | Caught |
| 1 | OFF goal-mode run | Caught |
| 1 | OFF source membership move | Caught |
| 1 | Horizon kind identity | Caught |
| 2 | Synced settings poll revision | Caught |
| 3 | Concurrent defaults in both fold modes | Caught |
| 4 | Reserved kinds use record identity | Caught |
| 4 | Generic update parent refusal | Caught |
| 4 | MCP forwards explicit parent | Caught |
| 4 | HTTP forwards explicit parent | Caught |
| 4 | Idea pickup identity survives partial structure | Caught |
| 5 | design/plan.md trust model | Caught |
| 5 | design/configuration.md trust model | Caught |
| 5 | Person true refusal explains trust | Caught |
| 5 | Person false refusal explains trust | Caught |
| 6 | OFF goal run before writes then ON | Caught |
| tidy | Hidden Plan URL normalization | Caught |
| tidy | Generic idea detail refuses OFF | Caught |
| tidy | Retired HTTP enable route | Caught |
| tidy | MCP startup discovery points to current get_setting | Caught |
| reconciliation | Horizon identity on pre-plan schema | Caught |
| reconciliation | OFF queue prune protection | Caught |
| reconciliation | OFF nested detail presentation | Caught |
| reconciliation | OFF nested tree presentation | Caught |
| reconciliation | OFF explicit idea subtree | Caught |
