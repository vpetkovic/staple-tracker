# Schema upgrade fixtures

Real database files in old formats, walked forward by
`test/migrations-fixtures.test.ts`, `test/migrations-downgrade-guard.test.ts`,
and `test/migrations-concurrency.test.ts`.

| file | shape |
|---|---|
| `workspace-v1.sqlite` | workspace before comment idempotency, stamped `'1'`, with real issues, relations, comments, documents, and events |
| `workspace-v1-unstamped.sqlite` | same schema, `schema_version` row absent — "tables exist, nobody ever stamped them" |
| `workspace-v2.sqlite` | current shape, stamped `'2'`, one comment carrying an idempotency key |
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
npx tsx test/fixtures/schema/generate.ts
```

Regenerate only when you have deliberately changed what an *old* database
looked like — which should be never. Adding a new migration does not change
these files; it changes how far forward they walk.
