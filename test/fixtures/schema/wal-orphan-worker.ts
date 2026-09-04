/**
 * Commits one row to a workspace's write-ahead log and exits WITHOUT closing.
 *
 *   tsx wal-orphan-worker.ts <db-path> <identifier>
 *
 * What a process that died mid-session leaves behind: `-wal` and `-shm`
 * sidecars beside the database, the `-wal` holding a committed frame that was
 * never checkpointed into the file. `docs/migration.md` warns that those
 * sidecars belong to the newer schema and must be moved aside with the file
 * before a snapshot is restored at its path; this is how the matrix test puts
 * them there deterministically rather than hoping a clean exit forgot to.
 *
 * Deliberately does not use `openDb`: the point is the file state, and a
 * dependency on the product's open path would make this worker a second
 * thing to debug when that path changes.
 */
import { DatabaseSync } from "node:sqlite";

const [path, identifier] = process.argv.slice(2);
const db = new DatabaseSync(path!);
db.exec("PRAGMA journal_mode=WAL");
// Whatever an earlier process left in the log goes into the file first, so the
// `-wal` left behind holds exactly this process's frame and nothing older.
db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
const now = "2026-03-01T00:00:00.000Z";
db.prepare(
  `INSERT INTO issues (id, identifier, title, normalized_title, status, status_version,
                       priority, depth, labels, origin_kind, created_at, updated_at)
   VALUES (?, ?, 'Committed to the WAL by a process that died', 'committed to the wal', 'todo', 0,
           'low', 0, '[]', 'manual', ?, ?)`,
).run(`iss-${identifier!.toLowerCase()}`, identifier!, now, now);
process.stdout.write("committed\n");
// No close(): the handle dies with the process, and the sidecars stay.
process.exit(0);
