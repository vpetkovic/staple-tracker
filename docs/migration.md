# Migrating a `.tasks` workspace

Repository state used to live at `.tasks/tasks.db`. It now lives at
`.staple/staple.db`. Legacy workspaces keep working — walk-up still finds them —
and moving one is a single explicit command:

```bash
staple migrate          # preview: prints the plan, changes nothing, exits 2
staple migrate --yes    # apply
```

`staple init` in a legacy repository **adopts** the existing database rather
than creating a new one beside it, and says so. Nothing migrates data
implicitly.

## Why this is more than a rename

The failure mode worth engineering against is not a lost file, it is a *forked*
one: two writable databases for the same workspace, each accumulating history
nobody reconciles. Everything below exists to make that impossible.

**A write barrier, held throughout.** The migration takes SQLite's write lock on
the source (`BEGIN IMMEDIATE`) before it copies anything and holds it until the
legacy file has been moved aside. If another process is writing — a `staple
open` server, an MCP server, another agent — it waits a bounded five seconds and
then refuses, having copied nothing.

**A WAL-safe snapshot.** The copy is `VACUUM INTO` from a second connection
while the barrier is held, so it reads *through* the write-ahead log. Work
another process committed and never checkpointed comes across. A migration that
copied the `.db` file and guessed about `-wal` / `-shm` sidecars would silently
drop it.

**Validation before cutover.** The snapshot gets `integrity_check`, a row-count
comparison against the still-locked source, a column-set comparison per table,
the ordered schema migrations every other open runs, and a slug/prefix identity
check. Only then is it renamed into place — atomically, with the directory
fsynced.

**A journal, and a rollback copy.** `.staple/migration.json` records the
migration id, source and target paths, the source's slug, prefix, schema version
and device+inode identity, the snapshot's SHA-256, the hub path before and
after, and every state transition with its timestamp. States are `planned`,
`locked`, `snapshotted`, `target_installed`, `hub_repaired`, `complete`,
`rollback_required`; each is fsynced *before* the change it describes. The
legacy database and its sidecars are moved to `.staple/rollback-<id>/`, never
deleted.

**Crash recovery, tested by crashing.** Re-running `staple migrate --yes` after
an interruption resumes from the journal. Recovery reads recorded facts only —
never modification times. The test suite SIGKILLs a real process at each of the
six reachable state boundaries and proves every issue survives:

| crashed at | on disk | `staple migrate --yes` does |
|---|---|---|
| `planned`, `locked` | legacy untouched, no target | discards temporaries, starts the copy again |
| `snapshotted` | snapshot present, legacy untouched | verifies the hash, resumes at install |
| `target_installed` | **both** databases present | verifies the target hash, retires the legacy file, repairs the hub |
| `hub_repaired` | migrated, legacy already retired | reopens, verifies identity, marks complete |
| `complete` | done | reports that it is already current |

Before `target_installed` the legacy workspace is still authoritative and every
ordinary command keeps working against it. At `target_installed` — the one
window where two canonical databases genuinely coexist — every command refuses
with exit 4 and names the resume command, rather than picking one.

**Ambiguity is refused, loudly.** Two different canonical databases in one
directory, with no journal explaining them, stops everything with exit 4 and
both absolute paths. Staple will not choose by modification time: whichever
history lost would vanish without a trace. If the target is missing or its hash
does not match after installation, the journal records `rollback_required` and
blocks mutation; the legacy copy is still there and still readable.

**One hub row.** The migrated workspace's own registration is repointed at the
new path, realpath-normalised (macOS stores the same file as both `/var/…` and
`/private/var/…`). Nothing else in the registry is touched, and a registry
conflict is a warning, not a failed migration — the data is already safe by then.
