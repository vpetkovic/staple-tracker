import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "../../config/atomic.js";
import { stapleHome } from "../../config/home.js";
import { StapleError } from "../types.js";
import { clickupConnectionSchema } from "./clickup-api.js";
import { linearConnectionSchema } from "./linear-api.js";

const githubConnectionSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/), providerId: z.literal("github"), mode: z.literal("cli"),
  host: z.string().regex(/^[a-z0-9][a-z0-9.-]*(?::[0-9]+)?$/i).max(255), account: z.string().regex(/^[A-Za-z0-9-]+$/).max(80),
}).strict();
export const connectionSchema = z.discriminatedUnion("providerId", [githubConnectionSchema, linearConnectionSchema, clickupConnectionSchema]);
export type ProviderConnection = z.infer<typeof connectionSchema>;
type ConnectionInput = (Omit<z.infer<typeof githubConnectionSchema>, "id"> | Omit<z.infer<typeof linearConnectionSchema>, "id"> | Omit<z.infer<typeof clickupConnectionSchema>, "id">) & { id?: string };
const ALIAS = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/) }).strict();
/** Directories #215–#226 wrote: one per workspace, named by a SHA-256 of its identity. */
const LEGACY_DIRECTORY = /^[0-9a-f]{64}$/;

/** Two bindings to the same account are the same connection, whatever their ids. */
function identity(c: ProviderConnection): string {
  return JSON.stringify(c.providerId === "linear"
    ? [c.providerId, c.host, c.account.toLowerCase(), c.scopeId, c.credentialEnv]
    : c.providerId === "clickup" ? [c.providerId, c.host, c.scopeId, c.credentialEnv]
    : [c.providerId, c.host.toLowerCase(), c.account.toLowerCase()]);
}

/**
 * Connections belong to the machine: gh authentication and API keys are machine state, so one
 * binding serves every workspace. No tokens, CLI paths or machine bindings enter a replicated
 * database. One atomic file per connection, and one per alias left behind by a migration.
 */
export class IntegrationConnections {
  readonly directory: string;
  private readonly aliases: string;
  private readonly root: string;
  constructor(home = stapleHome()) {
    this.root = join(home, "integrations");
    this.directory = join(this.root, "machine");
    this.aliases = join(this.directory, "aliases");
  }

  list(): ProviderConnection[] {
    this.migrate();
    return this.held();
  }

  /** A connection by its id or by an id a migration folded into it. */
  resolve(id: string): ProviderConnection | null {
    const connections = this.list();
    const direct = connections.find(c => c.id === id);
    if (direct) return direct;
    const target = this.alias(id);
    return target ? connections.find(c => c.id === target) ?? null : null;
  }

  save(input: ConnectionInput): ProviderConnection {
    const parsed = connectionSchema.safeParse({ ...input, id: input.id ?? randomUUID() });
    if (!parsed.success) throw new StapleError("validation", "Use valid provider connection settings; supply a credential environment variable name, never a secret value.");
    const connection = parsed.data;
    writeFileAtomic(join(this.directory, `${connection.id}.json`), JSON.stringify(connection) + "\n", { mode: 0o600, dirMode: 0o700 });
    // A connection now owns this id directly; an alias left by a migration must not outlive it.
    try { unlinkSync(join(this.aliases, `${connection.id}.json`)); } catch { /* none */ }
    return connection;
  }

  remove(id: string): void {
    const held = this.resolve(id);
    if (!held) throw new StapleError("not_found", "Connection was not found on this machine");
    unlinkSync(join(this.directory, `${held.id}.json`));
    if (existsSync(this.aliases)) {
      for (const file of readdirSync(this.aliases)) if (this.alias(file.replace(/\.json$/, "")) === held.id) unlinkSync(join(this.aliases, file));
    }
  }

  private held(): ProviderConnection[] {
    if (!existsSync(this.directory)) return [];
    return readdirSync(this.directory).filter(f => f.endsWith(".json")).sort().map(file => {
      try { return connectionSchema.parse(JSON.parse(readFileSync(join(this.directory, file), "utf8"))); }
      catch { throw new StapleError("validation", "A machine-local integration connection is invalid. Repair it in Settings > Integrations."); }
    });
  }

  private alias(id: string): string | null {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) return null;
    try { return ALIAS.parse(JSON.parse(readFileSync(join(this.aliases, `${id}.json`), "utf8"))).id; }
    catch { return null; }
  }

  /**
   * Fold the per-workspace connections of earlier releases into the machine list. A legacy file is
   * deleted only once the machine directory holds its account, as itself or as the connection an
   * alias points to, so a crash at any point loses nothing and a rerun finishes the job.
   *
   * Ids were unique per workspace, not per machine. When a legacy id is already held by a different
   * account, the newcomer keeps its account under a derived id (`<id>-<8 hex>`), and the plain id
   * stays with the connection that took it first (legacy directories are visited in name order).
   * Concurrent processes compute the same names and write identical files. Unreadable files stay.
   */
  private migrate(): void {
    if (!existsSync(this.root)) return;
    const legacy = readdirSync(this.root).filter(name => LEGACY_DIRECTORY.test(name)).sort();
    for (const name of legacy) {
      const dir = join(this.root, name);
      let files: string[];
      try { files = readdirSync(dir).filter(f => f.endsWith(".json")).sort(); }
      catch { continue; } // another process finished this directory after we listed it
      for (const file of files) {
        let connection: ProviderConnection;
        try { connection = connectionSchema.parse(JSON.parse(readFileSync(join(dir, file), "utf8"))); }
        catch { continue; }
        const same = this.held().find(c => identity(c) === identity(connection));
        if (!same) this.save({ ...connection, id: this.freeId(connection) });
        else if (same.id !== connection.id && !this.held().some(c => c.id === connection.id)) {
          writeFileAtomic(join(this.aliases, `${connection.id}.json`), JSON.stringify({ id: same.id }) + "\n", { mode: 0o600, dirMode: 0o700 });
        }
        try { unlinkSync(join(dir, file)); } catch { /* another process moved it first */ }
      }
      try { rmdirSync(dir); } catch { /* not empty: an unreadable file stays for a person to look at */ }
    }
  }

  /** The legacy id when nothing else holds it on this machine; otherwise one derived from the account. */
  private freeId(connection: ProviderConnection): string {
    const taken = (id: string) => this.held().some(c => c.id === id) || this.alias(id) !== null;
    if (!taken(connection.id)) return connection.id;
    const suffix = createHash("sha256").update(identity(connection)).digest("hex").slice(0, 8);
    return `${connection.id.slice(0, 71)}-${suffix}`;
  }
}
