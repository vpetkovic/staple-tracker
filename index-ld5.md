# Plan tabs, returning to work, and horizon links

Source head: 5cd82ca361aa91635541598564b956f85150b06f

All captures use Larkspur, an invented storefront product. Desktop is 1280px; phone is 390px.

| View | Desktop light | Desktop dark | Phone light | Phone dark |
|---|---|---|---|---|
| ideas | [PNG](https://raw.githubusercontent.com/vpetkovic/staple-tracker/evidence/plan-view/ideas-desktop-light-ld5.png) | [PNG](https://raw.githubusercontent.com/vpetkovic/staple-tracker/evidence/plan-view/ideas-desktop-dark-ld5.png) | [PNG](https://raw.githubusercontent.com/vpetkovic/staple-tracker/evidence/plan-view/ideas-phone-light-ld5.png) | [PNG](https://raw.githubusercontent.com/vpetkovic/staple-tracker/evidence/plan-view/ideas-phone-dark-ld5.png) |
| horizons | [PNG](https://raw.githubusercontent.com/vpetkovic/staple-tracker/evidence/plan-view/horizons-desktop-light-ld5.png) | [PNG](https://raw.githubusercontent.com/vpetkovic/staple-tracker/evidence/plan-view/horizons-desktop-dark-ld5.png) | [PNG](https://raw.githubusercontent.com/vpetkovic/staple-tracker/evidence/plan-view/horizons-phone-light-ld5.png) | [PNG](https://raw.githubusercontent.com/vpetkovic/staple-tracker/evidence/plan-view/horizons-phone-dark-ld5.png) |
| timeline | [PNG](https://raw.githubusercontent.com/vpetkovic/staple-tracker/evidence/plan-view/timeline-desktop-light-ld5.png) | [PNG](https://raw.githubusercontent.com/vpetkovic/staple-tracker/evidence/plan-view/timeline-desktop-dark-ld5.png) | [PNG](https://raw.githubusercontent.com/vpetkovic/staple-tracker/evidence/plan-view/timeline-phone-light-ld5.png) | [PNG](https://raw.githubusercontent.com/vpetkovic/staple-tracker/evidence/plan-view/timeline-phone-dark-ld5.png) |

## Phone horizon indicator

| Theme | Before | After |
|---|---|---|
| light | [PNG](https://raw.githubusercontent.com/vpetkovic/staple-tracker/evidence/plan-view/indicator-before-phone-light-ld5.png) | [PNG](https://raw.githubusercontent.com/vpetkovic/staple-tracker/evidence/plan-view/indicator-after-phone-light-ld5.png) |
| dark | [PNG](https://raw.githubusercontent.com/vpetkovic/staple-tracker/evidence/plan-view/indicator-before-phone-dark-ld5.png) | [PNG](https://raw.githubusercontent.com/vpetkovic/staple-tracker/evidence/plan-view/indicator-after-phone-dark-ld5.png) |

The phone row uses a small unfilled diamond in its secondary metadata, with no badge fill. Tap reveals the full horizon name. The desktop keeps the named chip.

## Milestone shortcuts

- [Planned ideas, desktop-light](https://raw.githubusercontent.com/vpetkovic/staple-tracker/evidence/plan-view/milestone-ideas-desktop-light-ld5.png)
- [Planned ideas, desktop-dark](https://raw.githubusercontent.com/vpetkovic/staple-tracker/evidence/plan-view/milestone-ideas-desktop-dark-ld5.png)
- [Planned ideas, phone-light](https://raw.githubusercontent.com/vpetkovic/staple-tracker/evidence/plan-view/milestone-ideas-phone-light-ld5.png)
- [Planned ideas, phone-dark](https://raw.githubusercontent.com/vpetkovic/staple-tracker/evidence/plan-view/milestone-ideas-phone-dark-ld5.png)

[Idea opened from a milestone](https://raw.githubusercontent.com/vpetkovic/staple-tracker/evidence/plan-view/idea-shortcut-phone-dark-ld5.png)
[18-second Plan restoration recording](https://raw.githubusercontent.com/vpetkovic/staple-tracker/evidence/plan-view/plan-restoration-phone-ld5.mp4)

The recording switches Horizons to Timeline, goes to Tasks, then returns to the remembered Timeline. Browser tests also pin open-record, filter, phone-column and scroll restoration.

## Horizon model

Unscheduled is no horizon. New plans seed Now and Next. The synchronized upgrade unschedules records from an undated Later and keeps its hand membership and queue on an ordinary milestone. Named horizons may remain undated; only dated horizons appear in Milestones.

## Verification

[12/12 mutation checks](https://github.com/vpetkovic/staple-tracker/blob/evidence/plan-view/mutations-ld5.md)

Local gates: package build and typecheck passed; 8,109 tests passed, two skipped across 470 passing files; MCP smoke passed 143 assertions across 84 tools; package drill passed all 13 steps.
