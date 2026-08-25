import { z } from "zod";

const nullableString = z
  .string()
  .nullish()
  .transform((value) => value ?? null);
const nullableBoolean = z
  .boolean()
  .nullish()
  .transform((value) => value ?? null);

const ReleaseTargetSchema = z.object({
  spawnd_sha256: nullableString,
  spawn_worker_sha256: nullableString,
});

const ReleaseDaemonSchema = z.object({
  version: nullableString,
  commit: nullableString,
  tree: nullableString,
  targets: z
    .record(z.string(), ReleaseTargetSchema)
    .nullish()
    .transform((value) => value ?? {}),
});

/** Public deployment identities. Missing/null fields are deliberate: an old
 * server or a development checkout must stay quiet rather than advertise an
 * update it cannot prove. */
export const ReleaseSchema = z.object({
  server: z
    .object({
      commit: nullableString,
      dirty: nullableBoolean,
    })
    .nullish()
    .transform((value) => value ?? { commit: null, dirty: null }),
  web: z
    .object({ build_id: nullableString })
    .nullish()
    .transform((value) => value ?? { build_id: null }),
  daemon: ReleaseDaemonSchema.nullish().transform((value) => value ?? null),
  mobile: z
    .object({
      tree: nullableString,
      runtime_version: nullableString,
    })
    .nullish()
    .transform((value) => value ?? { tree: null, runtime_version: null }),
  protocols: z
    .object({
      daemon: nullableString,
      browser: nullableString,
      alerts: nullableString,
    })
    .nullish()
    .transform((value) => value ?? { daemon: null, browser: null, alerts: null }),
});

export type ReleaseInfo = z.infer<typeof ReleaseSchema>;

/** The release route is public. A raw same-origin fetch avoids coupling this
 * tab-wide check to authenticated API behaviour on /login. */
export async function fetchRelease(): Promise<ReleaseInfo> {
  const response = await fetch("/api/release", {
    method: "GET",
    cache: "no-store",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`release check failed (${response.status})`);
  return ReleaseSchema.parse(await response.json());
}

export function clientBuildId(): string | null {
  return process.env.NEXT_PUBLIC_SPAWN_BUILD_ID?.trim() || null;
}

/** Pure comparison kept separate from fetching so unknown/dev identities can
 * never accidentally become a reload prompt. */
export function webIsStale({
  clientBuildId,
  serverBuildId,
}: {
  clientBuildId: string | null | undefined;
  serverBuildId: string | null | undefined;
}): boolean {
  const client = clientBuildId?.trim();
  const server = serverBuildId?.trim();
  if (!client || !server || client === "spawn") return false;
  return client !== server;
}
