import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "../../config/atomic.js";
import { stapleHome } from "../../config/home.js";
import { readStoredRepositoryId } from "../repo-identity.js";
import type { WorkspaceStore } from "../store.js";
import { StapleError } from "../types.js";

export const connectionSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/), providerId: z.literal("github"), mode: z.literal("cli"),
  host: z.string().regex(/^[a-z0-9][a-z0-9.-]*(?::[0-9]+)?$/i).max(255), account: z.string().regex(/^[A-Za-z0-9-]+$/).max(80),
}).strict();
export type ProviderConnection = z.infer<typeof connectionSchema>;

/** No tokens, CLI paths or machine bindings enter a replicated database. One atomic file per connection. */
export class IntegrationConnections {
  private readonly directory: string;
  constructor(store: WorkspaceStore, home = stapleHome()) {
    const identity = readStoredRepositoryId(store.db) ?? `workspace:${store.slug}`;
    this.directory = join(home,"integrations",createHash("sha256").update(identity).digest("hex"));
  }
  list(): ProviderConnection[] {
    if (!existsSync(this.directory)) return [];
    return readdirSync(this.directory).filter(f=>f.endsWith(".json")).sort().map(file=> {
      try { return connectionSchema.parse(JSON.parse(readFileSync(join(this.directory,file),"utf8"))); }
      catch { throw new StapleError("validation", "A machine-local integration connection is invalid. Repair it in Settings > Integrations."); }
    });
  }
  save(input: Omit<ProviderConnection,"id"> & {id?:string}): ProviderConnection {
    const parsed = connectionSchema.safeParse({...input,id:input.id ?? randomUUID()});
    if (!parsed.success) throw new StapleError("validation", "Use a valid GitHub host and account name; connection settings cannot contain credentials.");
    const connection = parsed.data;
    writeFileAtomic(join(this.directory,`${connection.id}.json`),JSON.stringify(connection)+"\n",{mode:0o600,dirMode:0o700});
    return connection;
  }
  remove(id: string): void {
    const held = this.list().find(c=>c.id===id);
    if (!held) throw new StapleError("not_found","Connection was not found on this machine");
    unlinkSync(join(this.directory,`${held.id}.json`));
  }
}
