import { z } from "zod";
import { API_URL, ApiError } from "@/lib/api";
import { rememberConsentTime, type SignedSupportLogConsent } from "@/lib/support-log-consent";
import copy from "@/lib/support-log-copy.json";
import { CLIENT_INSTANCE_ID } from "./client-instance";

const date = z.iso.datetime({ offset: true });
const nullableDate = date.nullable();
const collection = z.object({
  id: z.guid(),
  host_id: z.guid().nullable(),
  host_name: z.string(),
  reason: z.string(),
  requested_at: date,
  completed_at: nullableDate,
  size_bytes: z.int().nonnegative().nullable(),
  expires_at: nullableDate,
  deleted_at: nullableDate,
});
const collectionState = z.discriminatedUnion("state", [
  collection.extend({
    state: z.enum(["requested", "dispatched", "failed", "expired", "cancelled"]),
  }),
  collection.extend({
    state: z.literal("declined"),
    decline_code: z.enum(["not_consented", "signer_untrusted", "rate_limited", "no_log", "failed"]),
  }),
  collection.extend({
    state: z.literal("collected"),
    completed_at: date,
    size_bytes: z.int().nonnegative(),
    expires_at: date,
  }),
  collection.extend({ state: z.literal("deleted"), completed_at: date, deleted_at: date }),
]);

const accountState = z
  .object({
    statement: z
      .object({
        enabled: z.boolean(),
        issued_at_ms: z.int().nonnegative(),
        signer_device_id: z.guid(),
        signer_device_name: z.string().nullable(),
      })
      .nullable(),
    sharing: z.enum(["on", "off", "off_signer_removed"]),
    next_issued_at_ms: z.union([
      z.number(),
      z.object({ code: z.enum(["timestamp_overflow", "future_timestamp"]) }),
    ]),
    hosts: z.array(
      z.object({
        id: z.guid(),
        name: z.string(),
        capable: z.boolean(),
        last_seen_at: nullableDate,
      }),
    ),
    collections: z.array(collectionState),
    retention_days: z.literal(7),
  })
  .refine((state) => state.sharing !== "on" || state.statement !== null);
export type SupportLogState = z.infer<typeof accountState>;

export async function readSupportLog(
  accountId: string,
  signal: AbortSignal,
): Promise<SupportLogState> {
  // Let a panel closed in the same turn cancel discovery before any network I/O.
  await Promise.resolve();
  signal.throwIfAborted();
  const response = await fetch(`${API_URL}/api/support-log`, {
    credentials: "include",
    cache: "no-store",
    signal,
  });
  if (response.status !== 200) throw new Error("Support log unavailable");
  const state = accountState.parse(await response.json());
  if (state.statement) rememberConsentTime(accountId, state.statement.issued_at_ms);
  return state;
}

export async function putSupportLog(statement: SignedSupportLogConsent, signal: AbortSignal) {
  const response = await fetch(`${API_URL}/api/support-log/consent`, {
    method: "PUT",
    credentials: "include",
    headers: { "Content-Type": "application/json", "X-Spawn-Client": CLIENT_INSTANCE_ID },
    body: JSON.stringify(statement),
    signal,
  });
  if (!response.ok) {
    const detail = response.status === 429 ? (await response.json()).detail : undefined;
    throw new ApiError(response.status, "support_log", "Could not save consent", detail);
  }
}

export function supportLogRefusal(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 409) return copy.stale;
    if (error.status === 403) return copy.removed;
    const wait = z.object({ retry_after_seconds: z.int().positive() }).safeParse(error.detail);
    if (error.status === 429 && wait.success)
      return copy.wait.replace("{seconds}", String(wait.data.retry_after_seconds));
  }
  return copy.failure;
}

export function collectionLine(row: SupportLogState["collections"][number]): string {
  const time = new Date(row.requested_at).toLocaleString();
  switch (row.state) {
    case "collected":
      return copy.kept
        .replace("{time}", new Date(row.completed_at).toLocaleString())
        .replace("{size}", `${row.size_bytes.toLocaleString()} B`)
        .replace("{date}", new Date(row.expires_at).toLocaleDateString());
    case "deleted":
      return copy.deleted
        .replace("{time}", new Date(row.completed_at).toLocaleString())
        .replace("{date}", new Date(row.deleted_at).toLocaleDateString());
    case "requested":
    case "dispatched":
      return copy.waiting.replace("{time}", time).replace("{machine}", () => row.host_name);
    case "declined":
      if (row.decline_code === "not_consented" || row.decline_code === "signer_untrusted") {
        const line = row.decline_code === "not_consented" ? copy.sharingOff : copy.notAccepted;
        return line.replace("{time}", time).replace("{machine}", () => row.host_name);
      }
  }
  return copy.notCollected.replace("{time}", time);
}
