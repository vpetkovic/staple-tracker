# Plan review mutation checks

86/86 valid mutations killed; source restored after every mutation.

| Rule | Changed file | Failing test | Result |
|---|---|---|---|
| Ideas holds own-state thinking only | src/ui/app/src/views/plan/plan-model.ts | the Ideas lens is thinking only holds raw and exploring records, a sub-idea under started work included; shaping hands a record to Horizons | killed |
| Horizons holds delivery only | src/ui/app/src/views/plan/plan-model.ts | the Ideas lens is thinking only never shows one record in both lenses | killed |
| an Ideas card shows thinking, a Horizons card delivery | src/ui/app/src/views/plan/PlanBoards.tsx | the Ideas lens is thinking only renders no delivery card on the board | killed |
| a shipped card is marked shipped | src/ui/app/src/views/plan/PlanBoards.tsx | the Horizons lens is delivery marks a shipped card done, with its date, and no progress bar or late chip | killed |
| a shipped card is muted | src/ui/app/src/views/plan/PlanBoards.tsx | the Horizons lens is delivery marks a shipped card done, with its date, and no progress bar or late chip | killed |
| a horizon header counts its shipped records | src/ui/app/src/views/plan/PlanBoards.tsx | the Horizons lens is delivery heads a horizon with its progress, ✓ n shipped, late and not started, all as the server counts them, and Queue and its run setting | killed |
| a queued horizon's Queue is held back | src/ui/app/src/views/plan/PlanBoards.tsx | the Horizons lens is delivery shows a queued horizon's Queue held back, and offers neither button where the state does not | killed |
| a done horizon folds | src/ui/app/src/views/plan/PlanBoards.tsx | the Horizons lens is delivery folds only a horizon the server reads as done, never one whose cards merely all shipped | killed |
| a horizon counts its shipped records | src/core/plan-store.ts | a horizon's delivery counts its shipped records and its landed members | killed |
| a horizon's progress is its landed members | src/core/plan-store.ts | a horizon's delivery counts its shipped records and its landed members | killed |
| a queued horizon's Queue is held back (core) | src/core/plan-store.ts | a horizon's delivery offers its run setting in every state but shipped, Queue while it holds work, and holds Queue back once it is queued | killed |
| an active horizon offers Run to goal | src/core/plan-lifecycle-table.ts | a horizon's delivery offers its run setting in every state but shipped, Queue while it holds work, and holds Queue back once it is queued | killed |
| a record's completeness is on the payload | src/core/plan-store.ts | the records a record waits on are on the plan's payload, beside how much of each plan is written | killed |
| what a record waits on is on the payload | src/core/plan-store.ts | the records a record waits on are on the plan's payload, beside how much of each plan is written | killed |
| a key two records share names neither | src/core/plan-sections.ts | the records a record waits on never names a record by a key two records share, and never itself | killed |
| a record never waits on itself | src/core/plan-sections.ts | the records a record waits on never names a record by a key two records share, and never itself | killed |
| outside depends-on cells name dependencies | src/core/plan-sections.ts | the records a record waits on reads them from the Dependencies section and from depends-on cells naming something outside the breakdown | killed |
| an edge joins two rows on the chart only | src/ui/app/src/views/plan/plan-model.ts | dependencies on the timeline draws an edge only between two rows on the chart | killed |
| an arrow is red when the waiting record starts first | src/ui/app/src/views/plan/PlanTimeline.tsx | dependencies on the timeline draws an arrow from the end of the one waited on to the start of the one waiting, red when it starts first | killed |
| an arrow needs both rows laid out | src/ui/app/src/views/plan/PlanTimeline.tsx | dependencies on the timeline draws nothing for a row not laid out | killed |
| only a shipped bar is capped | src/ui/app/src/views/plan/PlanTimeline.tsx | shipped is one mark caps a shipped bar on the timeline, and only a shipped one | killed |
| a row's horizon comes from its own membership or an ancestor's | src/core/plan-store.ts | the horizon a task's work belongs to is its own membership, derived from the plan or put there, else its nearest ancestor's, and only a horizon's | killed |
| only a horizon is a row's horizon | src/core/plan-store.ts | the horizon a task's work belongs to is its own membership, derived from the plan or put there, else its nearest ancestor's, and only a horizon's | killed |
| the task list's rows carry their horizon | src/ui/server.ts | the task list reads each row's horizon gives every row of a scaffolded epic the epic's horizon, and a row on none nothing | killed |
| the chip names the row's horizon first | src/ui/app/src/components/task-list/row-cues.ts | the ◇ horizon chip names the row's horizon, ahead of the queue's milestone cue | killed |
| Group by Horizon follows the plan's order | src/ui/app/src/views/tree/tree-model.ts | Group by Horizon sections the list by horizon in the plan's order, then No horizon, an epic and its task together | killed |
| No horizon comes last | src/ui/app/src/views/tree/tree-model.ts | Group by Horizon sections the list by horizon in the plan's order, then No horizon, an epic and its task together | killed |
| No horizon matches rows on none | src/ui/app/src/lib/filters.ts | the horizon filter offers the horizons on the page in the plan's order, then No horizon, with counts | killed |
| the horizon filter is absent without horizons | src/ui/app/src/lib/filters.ts | the horizon filter is not offered on a page with no horizon | killed |
| a section reads as Markdown | src/ui/app/src/detail/tabs/PlanSections.tsx | the Plan tab reads the brief and the sections as formatted Markdown, with Edit only where the state offers edits | killed |
| the brief reads as Markdown | src/ui/app/src/detail/tabs/PlanTab.tsx | the Plan tab reads the brief and the sections as formatted Markdown, with Edit only where the state offers edits | killed |
| Edit only where the state offers edits | src/ui/app/src/detail/tabs/PlanSections.tsx | the Plan tab reads the brief and the sections as formatted Markdown, with Edit only where the state offers edits | killed |
| an empty section offers to write it only where edits are offered | src/ui/app/src/detail/tabs/PlanSections.tsx | the Plan tab reads the brief and the sections as formatted Markdown, with Edit only where the state offers edits | killed |
| the phase reads the record's own state | src/ui/app/src/detail/tabs/PlanTab.tsx | the Plan tab shows the lifecycle as phases, so a scheduled idea still reads as thinking, with its maturity | killed |
| Markdown reads quotes | src/ui/app/src/lib/markdown.tsx | plan text reads as formatted Markdown renders quotes, numbered lists, checklists, tables and emphasis | killed |
| Markdown reads numbered lists | src/ui/app/src/lib/markdown.tsx | plan text reads as formatted Markdown renders quotes, numbered lists, checklists, tables and emphasis | killed |
| Markdown reads checklists | src/ui/app/src/lib/markdown.tsx | plan text reads as formatted Markdown renders quotes, numbered lists, checklists, tables and emphasis | killed |
| Markdown reads tables | src/ui/app/src/lib/markdown.tsx | plan text reads as formatted Markdown renders quotes, numbered lists, checklists, tables and emphasis | killed |
| Markdown reads emphasis | src/ui/app/src/lib/markdown.tsx | plan text reads as formatted Markdown renders quotes, numbered lists, checklists, tables and emphasis | killed |
| emphasis needs a word boundary | src/ui/app/src/lib/markdown.tsx | plan text reads as formatted Markdown leaves a lone asterisk, and identifiers with underscores, alone | killed |
| milestone goal is person-only | src/core/milestone-store.ts | a horizon's run setting is the person's: a goal and how far agents take it, refused to an agent on every path | killed |
| compact chip renders on phone | src/ui/app/src/components/task-list/TaskRowLine.tsx | the ◇ horizon chip on a drawn row draws the compact chip on a 390px row, where the milestone mark is gone | killed |
| shaping hands off Ideas | src/ui/app/src/views/plan/plan-model.ts | the Ideas lens is thinking only holds raw and exploring records, a sub-idea under started work included; shaping hands a record to Horizons | killed |
| ready unscheduled hint | src/ui/app/src/views/plan/plan-model.ts | the Ideas lens is thinking only never shows one record in both lenses | killed |
| done comes from server progress | src/ui/app/src/views/plan/plan-model.ts | D review integration uses the same completed and approval-pending horizon state in all three views | killed |
| approval holds back shipped | src/ui/app/src/views/plan/plan-model.ts | D review integration uses the same completed and approval-pending horizon state in all three views | killed |
| timeline retains hand-added membership | src/ui/app/src/views/plan/plan-model.ts | D review integration uses the same completed and approval-pending horizon state in all three views | killed |
| board uses server risk | src/ui/app/src/views/plan/PlanBoards.tsx | D review integration uses the server's complete horizon counts and progress on board, drawer and timeline | killed |
| board uses server idea and member counts | src/ui/app/src/views/plan/PlanBoards.tsx | D review integration uses the server's complete horizon counts and progress on board, drawer and timeline | killed |
| phone tabs use server counts | src/ui/app/src/views/plan/PlanBoards.tsx | uses server counts and late warnings in the phone's horizon switcher | killed |
| phone tabs use server risk | src/ui/app/src/views/plan/PlanBoards.tsx | uses server counts and late warnings in the phone's horizon switcher | killed |
| done fold counts server members | src/ui/app/src/views/plan/PlanBoards.tsx | D review integration uses the same completed and approval-pending horizon state in all three views | killed |
| incomplete reads C payload | src/ui/app/src/views/plan/PlanBoards.tsx | D review integration reads incomplete-plan reasons directly from C's payload, without inferring them from an action | killed |
| card does not repeat explore | src/ui/app/src/views/plan/PlanBoards.tsx | a card's menu offers an exploring idea Mark shaped on the Ideas board, which has no shaped column to drop on | killed |
| drawer uses server progress | src/ui/app/src/detail/PlanActions.tsx | D review integration uses the server's complete horizon counts and progress on board, drawer and timeline | killed |
| drawer uses server done | src/ui/app/src/detail/PlanActions.tsx | D review integration uses the same completed and approval-pending horizon state in all three views | killed |
| drawer counts server ideas | src/ui/app/src/detail/PlanActions.tsx | D review integration uses the server's complete horizon counts and progress on board, drawer and timeline | killed |
| drawer keeps approval visible | src/ui/app/src/detail/PlanActions.tsx | D review integration uses the same completed and approval-pending horizon state in all three views | killed |
| timeline uses server risk | src/ui/app/src/views/plan/PlanTimeline.tsx | D review integration uses the server's complete horizon counts and progress on board, drawer and timeline | killed |
| timeline uses server counts | src/ui/app/src/views/plan/PlanTimeline.tsx | D review integration uses the server's complete horizon counts and progress on board, drawer and timeline | killed |
| timeline uses server shipped | src/ui/app/src/views/plan/PlanTimeline.tsx | D review integration uses the same completed and approval-pending horizon state in all three views | killed |
| timeline uses server progress | src/ui/app/src/views/plan/PlanTimeline.tsx | D review integration uses the server's complete horizon counts and progress on board, drawer and timeline | killed |
| horizon maps to itself | src/core/plan-store.ts | a horizon is its own horizon, and the task list leaves it out maps a horizon to itself, so it never falls under No horizon | killed |
| horizon rows omitted by HTTP | src/ui/server.ts | the task list reads each row's horizon leaves the horizons themselves out of the rows, empty ones included, and keeps a plain milestone | killed |
| agent cannot set run mode | src/core/plan-store.ts | a horizon's run setting is the person's: a goal and how far agents take it, refused to an agent on every path | killed |
| run mode validation | src/core/plan-store.ts | a horizon's run setting is the person's: a goal and how far agents take it, refused to an agent on every path | killed |
| horizon instruction reaches pickup | src/core/instructions.ts | a horizon's run setting on every surface is set by the person on the page and the CLI, read by an agent with every ticket of the horizon, and honoured by a goal run | killed |
| goal text reaches agents | src/core/instructions.ts | a horizon's run setting on every surface is set by the person on the page and the CLI, read by an agent with every ticket of the horizon, and honoured by a goal run | killed |
| goal run requires goal setting | src/core/run-store.ts | D review integration requires an explicit goal setting before a horizon can start a goal run | killed |
| unset does not authorize goal run | src/core/run-store.ts | D review integration requires an explicit goal setting before a horizon can start a goal run | killed |
| server exposes approval gate | src/core/plan-store.ts | D review integration retains a goal run's approval gate after stopping, while work mode finishes without a goal gate | killed |
| explicit references stop at prose | src/core/plan-sections.ts | a dependency is an explicit reference never reads prose words with digits as references | killed |
| reference keys require capitals | src/core/plan-sections.ts | a dependency is an explicit reference never reads prose words with digits as references | killed |
| cross-plan row keys resolve | src/core/plan-sections.ts | a dependency is an explicit reference reads a line that leads with a record's key or ticket number, a title's own leading keys, and another plan's row key | killed |
| group horizon skips re-placement | src/ui/app/src/views/tree/milestone-placement.ts | a horizon's own row, should one reach the list is never re-placed under its milestone on the Horizon axis, so nothing is drawn twice | killed |
| phone chip own slot | src/ui/app/src/components/task-list/row-layout.ts | the ◇ horizon chip on a phone keeps its own slot below 480px, where the milestone mark is dropped | killed |
| setting form selects current mode | src/ui/app/src/views/plan/RunSetting.tsx | the Horizons lens is delivery edits the horizon's run setting, how far agents take it and its goal, and starts nothing | killed |
| extra: server idea count | src/core/plan-store.ts | a horizon's header reads the server counts the open work its cards do not show: a hand-added member and an exploring record past its start | killed |
| extra: server member count | src/core/plan-store.ts | a horizon's header reads the server counts the open work its cards do not show: a hand-added member and an exploring record past its start | killed |
| extra: server late count | src/core/plan-store.ts | a horizon's header reads the server counts a late started record on the server | killed |
| extra: server not-started count | src/core/plan-store.ts | a horizon's header reads the server counts the open work its cards do not show: a hand-added member and an exploring record past its start | killed |
| extra: run mode view | src/core/plan-store.ts | a horizon's run setting is the person's: a goal and how far agents take it, refused to an agent on every path | killed |
| extra: goal view | src/core/plan-store.ts | a horizon's run setting is the person's: a goal and how far agents take it, refused to an agent on every path | killed |
| extra: synced run mode | src/core/cloud/apply.ts | a horizon's run setting across devices carries the person's mode and goal through the tail and a fresh snapshot | killed |
| phone chip full name on tap | browser interaction | the phone horizon chip opens the full horizon name on tap at 390px in light | killed |
| setting save persists without queueing or launching | browser interaction | the phone horizon chip saves the person's goal and mode from the horizon drawer without starting a run | killed |
