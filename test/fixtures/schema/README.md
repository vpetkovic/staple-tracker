# Schema upgrade fixtures

Real database files in old formats, walked forward by
`test/migrations-fixtures.test.ts`, `test/migrations-downgrade-guard.test.ts`,
and `test/migrations-concurrency.test.ts`.

| file | shape |
|---|---|
| `workspace-v1.sqlite` | workspace before comment idempotency, stamped `'1'`, with real issues, relations, comments, documents, and events |
| `workspace-v1-unstamped.sqlite` | same schema, `schema_version` row absent — "tables exist, nobody ever stamped them" |
| `workspace-v2.sqlite` | post-idempotency shape, stamped `'2'`, one comment carrying an idempotency key |
| `workspace-v3.sqlite` | the retired prototype checkout's shape, stamped `'3'` — `test/install-schema-matrix.test.ts` walks it to the latest version through the packed runtime |
| `workspace-v5.sqlite` | pre-approval-gates shape, stamped `'5'` — what some installed builds still write; the pre-upgrade snapshot tests walk it forward |
| `workspace-v6.sqlite` | the approval-gates shape, stamped `'6'` — a build that understands 3 or 5 must refuse it |
| `workspace-v99.sqlite` | v2 schema stamped `'99'` — the downgrade guard's target |
| `hub-v1.sqlite` | the hub exactly as it existed before A4: registry, links, events, and **no `meta` table at all** |
| `hub-v99.sqlite` | hub stamped `'99'` |

## Why files and not builders

A test that reconstructs "what v1 looked like" from today's source drifts with
today's source. When someone edits the schema, the reconstruction quietly
follows, and the test stops being evidence about the databases already sitting
on people's disks. These files were written by running a *prefix* of the
migration list and then left alone.

Tests copy a fixture to a temp directory before opening it. Never migrate one
in place — the first run would upgrade the checked-in file and every run after
that would be testing an already-current database while still calling it "v1".

## Current is generated; every file here is older

There is deliberately no fixture for "the current schema". A checked-in file is
only current until the next migration lands, and then every test that read it as
current starts failing for no reason anyone cares about. So a test that needs a
workspace at this build's latest version calls `writeCurrentWorkspace(path)` or
`withCurrentWorkspace(fn)` from `generate.ts`, which walks the whole migration
list and stamps `WORKSPACE_LATEST_VERSION`. The files in this directory are only
ever OLDER shapes, and a test that uses one expects it to be behind by
`(fixture version, latest]` — arithmetic, never a literal. Adding a migration
therefore changes nothing in this directory and nothing in the suites that read
it.

## Why `.sqlite` and not `.db`

The prototype `.gitignore` carries a blanket `*.db` rule (plus `-wal`/`-shm`).
A fixture named `workspace-v1.db` would be silently untracked, and a
checked-in fixture that is not actually checked in is worse than no fixture at
all. The extension is the only difference; SQLite does not care, and
`support.ts` renames the copy back to `.db` so the code under test sees a
normal path.

They are written with `journal_mode=delete`, so each is one self-contained file
with no sidecars to commit or forget.

## Regenerating

```
npx tsx test/fixtures/schema/generate.ts                      # every fixture
npx tsx test/fixtures/schema/generate.ts workspace-v3.sqlite  # only the named ones
```

Name the files when adding a fixture: the SQLite library stamps its own
version into the header, so a full regeneration under a newer Node rewrites
files whose whole value is that they were left alone.

Regenerate only when you have deliberately changed what an *old* database
looked like — which should be never. Adding a new migration does not change
these files; it changes how far forward they walk.
