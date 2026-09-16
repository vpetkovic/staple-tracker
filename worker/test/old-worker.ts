/**
 * Rows exactly as the Worker before the fold checkpoint wrote them.
 *
 * That Worker folded the whole log inside the request and stored the fold INSIDE the backup
 * row: `state` = `{ label, entities }`, where `entities` is every folded entity minus its
 * provenance (`forBackup`). Every backup that exists on a deployed database today has that
 * shape, and migration 0006 gives each the `content = 'inline'` default. The new Worker has
 * to restore them, list them and delete them with no step in between; these write them the
 * way the old `captureBackup` did so the tests can hold it to that.
 */
import { protocolForEntities } from "../src/envelope.js";
import { forBackup } from "../src/fold.js";
import { oracleFoldLog } from "./fold-oracle.js";

export async function oldCaptureBackup(
  db: D1Database,
  repoId: string,
  options: { backupId: string; deviceId: string; kind?: "manual" | "pre-restore"; label?: string | null },
): Promise<{ backupId: string; entityCount: number; cutoffSeq: number; epoch: number }> {
  const repo = (await db.prepare(`SELECT epoch, last_seq FROM repos WHERE repo_id = ?1`).bind(repoId).first<{
    epoch: number;
    last_seq: number;
  }>())!;
  const folded = await oracleFoldLog({ DB: db }, repoId, repo.epoch, repo.last_seq);
  await db
    .prepare(
      `INSERT INTO backups
         (repo_id, backup_id, epoch, cutoff_seq, entity_count, op_count, schema_version,
          protocol, kind, created_at, created_by_device, state)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
    )
    .bind(
      repoId,
      options.backupId,
      repo.epoch,
      repo.last_seq,
      folded.entities.length,
      folded.opCount,
      folded.schemaVersion,
      protocolForEntities(folded.entities),
      options.kind ?? "manual",
      Date.now(),
      options.deviceId,
      JSON.stringify({ label: options.label ?? null, entities: folded.entities.map(forBackup) }),
    )
    .run();
  return { backupId: options.backupId, entityCount: folded.entities.length, cutoffSeq: repo.last_seq, epoch: repo.epoch };
}
