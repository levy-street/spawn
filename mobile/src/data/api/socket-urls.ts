import { authToken } from "@/data/api/auth-token";
import { ApiError } from "@/data/api/client";
import { getBaseUrl } from "@/data/api/config";

async function socketUrl(path: string, query: Record<string, string>): Promise<string> {
  const token = await authToken.get();
  if (token === null) throw new ApiError(401, "not_authenticated", "No access token");
  const url = new URL(`${await getBaseUrl()}${path}`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  for (const [key, value] of Object.entries({ ...query, token })) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

export function buildBrowserSocketUrl(sessionId: string): Promise<string> {
  return socketUrl("/ws/browser", { session_id: sessionId });
}

export function buildHostSocketUrl(hostId: string): Promise<string> {
  return socketUrl("/ws/host", { host_id: hostId });
}

export function buildAlertsSocketUrl(): Promise<string> {
  return socketUrl("/ws/alerts", {});
}
