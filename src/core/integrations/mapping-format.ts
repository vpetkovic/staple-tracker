import { z } from "zod";

/**
 * The stored shape of a workspace's mapping: the `integrations.mapping` setting, a JSON list.
 * Names and URLs are stored so another machine, with no connection, can still show what a
 * workspace is mapped to. Which machine connection serves a target is decided at read time.
 */
export const MAPPING_LIMIT = 64;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const host = /^[a-z0-9][a-z0-9.-]*(?::[0-9]+)?$/;

export const storedTargetSchema = z.discriminatedUnion("providerId", [
  z.object({
    providerId: z.literal("github"), host: z.string().regex(host).max(255), scopeId: z.literal("host"),
    kind: z.literal("repository"), containerId: z.string().regex(/^[1-9][0-9]{0,18}$/),
    name: z.string().min(1).max(512).nullable(), url: z.string().url().max(2048).nullable(),
  }).strict(),
  z.object({
    providerId: z.literal("linear"), host: z.literal("linear.app"), scopeId: z.string().regex(uuid),
    kind: z.enum(["team", "project"]), containerId: z.string().regex(uuid),
    name: z.string().min(1).max(512).nullable(), url: z.string().url().max(2048).nullable(),
  }).strict(),
  z.object({
    providerId: z.literal("clickup"), host: z.literal("app.clickup.com"), scopeId: z.string().regex(/^[1-9][0-9]{0,19}$/),
    kind: z.enum(["space", "list"]), containerId: z.string().regex(/^[1-9][0-9]{0,19}$/),
    name: z.string().min(1).max(512).nullable(), url: z.string().url().max(2048).nullable(),
  }).strict(),
]);
export type StoredTarget = z.infer<typeof storedTargetSchema>;

/** The stable identity of a target; also the entry format of the legacy `integrations.repositories`. */
export function targetKey(t: Pick<StoredTarget, "providerId" | "host" | "scopeId" | "kind" | "containerId">): string {
  if (t.providerId === "github") return `${t.host}/${t.containerId}`;
  if (t.providerId === "clickup") return `app.clickup.com/${t.scopeId}/${t.kind}/${t.containerId}`;
  return t.kind === "project" ? `linear.app/${t.scopeId}/project/${t.containerId}` : `linear.app/${t.scopeId}/${t.containerId}`;
}

export function parseMapping(value: string): StoredTarget[] {
  if (!value.trim()) return [];
  const parsed = z.array(storedTargetSchema).max(MAPPING_LIMIT).parse(JSON.parse(value));
  const keys = parsed.map(targetKey);
  if (new Set(keys).size !== keys.length) throw new Error("duplicate");
  return parsed;
}

/** Settings validation hook: why a stored mapping is unacceptable, or null. */
export function mappingProblem(value: string): string | null {
  try { parseMapping(value); return null; }
  catch { return `a JSON list of at most ${MAPPING_LIMIT} distinct mapped repositories, teams or projects`; }
}

/** Entries of the legacy comma-separated setting, without names. */
export function parseLegacyMapping(value: string): StoredTarget[] {
  return value.split(",").map(entry => entry.trim()).filter(Boolean).flatMap((entry): StoredTarget[] => {
    const linear = /^linear\.app\/([0-9a-f-]{36})\/([0-9a-f-]{36})$/i.exec(entry);
    if (linear) return [{ providerId: "linear", host: "linear.app", scopeId: linear[1]!.toLowerCase(), kind: "team", containerId: linear[2]!.toLowerCase(), name: null, url: null }];
    const github = /^([a-z0-9][a-z0-9.:-]*)\/([1-9][0-9]*)$/i.exec(entry);
    if (github) return [{ providerId: "github", host: github[1]!.toLowerCase(), scopeId: "host", kind: "repository", containerId: github[2]!, name: null, url: null }];
    return [];
  });
}
