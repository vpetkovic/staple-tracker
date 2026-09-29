---
title: Budget and estimates
description: Estimate work when you plan it, compare it with what it took, forecast what is left, and keep an eye on your provider usage limits.
---

# Budget and estimates

Use this page to answer two questions: *how long will this take?* and *will my
subscription last?* You estimate tickets when you plan them, staple measures the
agent work that actually went into them, and over time it learns how far off your
estimates run. On the budget side, it records your provider's usage limits on
this machine and warns when your pace eats into a reserve.

The examples continue the password reset epic (APP-1) from
[Plans become tickets](plans-to-tickets.md).

## 1. Estimate when you plan

Give each ticket an estimate as you file it, not when it is finished:

```bash
staple new "Reset form sets the new password" --parent APP-1 --blocked-by APP-2 --estimate 3h
```

Durations are `90s`, `30m`, `2h`, `3d`, or a number of seconds. Agents pass
`estimate_seconds` to `create_task`. To change an estimate later:

```bash
staple estimate APP-4 2h        # MCP set_estimate; --clear removes it
```

```text
◌  APP-4     backlog     Reset form sets the new password  est 3h -> 2h
```

## 2. Compare with what it took

Here an agent has finished APP-2:

```bash
staple show APP-2
```

```text
◇ APP-2 · Issue single-use reset tokens
status done (v2) · kind task · priority medium · @claude
attempts 1
  last #1 claude completed (done) · ran 5s · timing-floor (timing_floor)
time   est 2h · ran 5s
```

The estimate is compared with **agent work**: the time agents actually spent on
the ticket, from their checkout to their `done`, with pauses and orchestration
left out. Each figure carries a quality word. `exact` can be trusted;
`timing-floor` (under a minute, as here), `approximate` and `missing` are shown
but kept out of what staple learns from, and `reconstructed` (rebuilt from older
history) is used only when you ask for it. The **Time** tab of a ticket in the
[web UI](web-ui.md) shows the same comparison as a bar.

`staple timing quality` (MCP `timing_quality`) counts how many finished tickets
in the workspace have trustworthy figures.

## 3. Size an epic

```bash
staple compare APP-1            # MCP compare_plans
```

```text
APP-1 · Password reset (epic, backlog)
  labor 8h (descendants) · 4 of 4 units planned
  planned path 6h · APP-2 > APP-3 > APP-5
  remaining path 4h · APP-3 > APP-5
```

**Labor** is the total work planned. The **path** is the longest chain of
dependent work: with enough agents in parallel, the epic still takes at least that
long. The **remaining path** is that chain for the work not yet done. Name several
refs to compare plans side by side.

## 4. Learn how far off your estimates run

```bash
staple calibrate                # MCP calibration_cohorts
```

```text
1 eligible (done, own estimate) of 5 issues · minimum 5 samples per cohort
exact         0 samples (0.0% of 1) in 0 cohorts · not samples: timing-floor 1
items: no_samples
```

Calibration groups finished tickets by kind, priority and similar traits, and
reports how long each group really takes against its estimate: *bug fixes
usually take about a fifth of the estimate*. A group needs at least five finished,
estimated tickets with exact figures, so a new workspace reports `no_samples` like
this one. Keep estimating and it fills in.

The **Estimates** view in the web UI is the same report in plain sentences, one
card per group, with how confident each figure is.

## 5. Forecast what is left

```bash
staple forecast APP-1           # MCP forecast
```

```text
completion  4 units · 1 done · 0 awaiting review · 3 to forecast, 0 known · unknown APP-3, APP-4, APP-5
  labor     expected ≥unknown · no_forecast · plan 8h (descendants)
  confidence low · unknown_units, small_sample, no_samples
budget      this machine · reserve 20.0% (provisional default, until the admission policy defines one) · work ≥unknown, serial from now
  no account: source_unavailable
```

Once calibration has data, the forecast scales the remaining estimates by how
long similar work really took, and gives a range of hours of work rather than
one figure. The budget
line says what that work would cost against your provider limits on this
machine. The ticket's **Time** tab shows the same forecast.

## 6. Watch your provider budget

Staple can record how much of your Claude or Codex usage limits you have used, on
this machine only. The readings stay on this machine. It is off until you set it
up, and setup shows its plan first:

```bash
staple budget setup --claude-account work
```

```text
error(validation): Refusing to set up budget collection without --yes. Nothing was changed. The plan:
  + capture         Turn budget capture on (`telemetry.budgetCapture` in config.json).
  + claude_binding  Bind ~/.claude to work (anthropic).
  + statusline      ~/.claude/settings.json does not exist; it will be created with a status line that records readings and prints nothing.
  - codex_binding   No account for ~/.codex: pass --codex-account to collect from it.
  - watcher         No Codex account, so no watcher.
Re-run with --yes to apply it.
```

With `--yes`, setup turns capture on, names the account each harness spends from,
puts a small recording step in front of your Claude status line (your settings
file is backed up first), and, with `--codex-account`, installs a watcher that
reads Codex sessions every five minutes (on macOS; elsewhere it prints a cron
line to add). `staple budget unsetup --yes` puts all of
it back exactly. **Settings → Usage** in the web UI does the same with a
confirmation at each step.

Then read it:

```bash
staple budget                   # MCP get_budget
staple budget status            # what is collected, and anything that needs fixing
```

```text
reserve 20% (provisional default); pressure is provisional
no accounts (capture off; staple budget bind names one)
```

That is a machine with nothing set up yet. Once readings come in, each limit
shows what is left, when it resets, and whether your recent pace keeps
a reserve (20% until you choose another with `--reserve`). Nothing is sent
anywhere unless you also turn on live checks (`staple budget live on`), which ask
the provider for your current usage. The **Usage** view in
the web UI shows the same per limit, with a gauge and a plain verdict.
[Autopilot runs](runs.md) can stop themselves at a ceiling with
`run start --ceiling`.

## Next

- [Web UI tour](web-ui.md): the Estimates and Usage views, and the Time tab.
- [CLI reference](cli.md#estimates-vs-actuals): estimates and timing in full, and
  [provider budget](cli.md#provider-budget).
- [Configuration](configuration.md): budget capture settings.

Going deeper: [timing semantics](../design/timing-semantics.md) defines every time
number and how calibration and forecasts are computed.
