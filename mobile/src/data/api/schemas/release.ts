import { z } from "zod";

const nullableString = z.string().nullable().default(null);

const ReleaseTargetSchema = z.object({
  spawnd_sha256: z.string(),
  spawn_worker_sha256: z.string(),
});

export const ReleaseSchema = z.object({
  server: z
    .object({
      commit: nullableString,
      dirty: z.boolean().default(false),
    })
    .default({ commit: null, dirty: false }),
  web: z
    .object({
      build_id: nullableString,
    })
    .default({ build_id: null }),
  daemon: z
    .object({
      version: z.string(),
      commit: z.string(),
      tree: z.string(),
      targets: z.record(z.string(), ReleaseTargetSchema).default({}),
    })
    .nullable()
    .default(null),
  mobile: z
    .object({
      tree: nullableString,
      runtime_version: nullableString,
    })
    .default({ tree: null, runtime_version: null }),
  protocols: z
    .object({
      daemon: z.string().nullable().default(null),
      browser: z.string().nullable().default(null),
      alerts: z.string().nullable().default(null),
    })
    .default({ daemon: null, browser: null, alerts: null }),
});

export type Release = z.infer<typeof ReleaseSchema>;
