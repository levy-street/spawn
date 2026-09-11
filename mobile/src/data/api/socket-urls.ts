import { getBaseUrl } from "@/data/api/config";

async function socketUrl(
  path: string,
  query: Record<string, string>,
  baseUrl?: string,
): Promise<string> {
  const url = new URL(`${baseUrl ?? (await getBaseUrl())}${path}`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

export function buildBrowserSocketUrl(sessionId: string, baseUrl?: string): Promise<string> {
  return socketUrl("/ws/browser", { session_id: sessionId }, baseUrl);
}

export function buildHostSocketUrl(hostId: string, baseUrl?: string): Promise<string> {
  return socketUrl("/ws/host", { host_id: hostId, rtc_version: "2" }, baseUrl);
}

export function buildAlertsSocketUrl(baseUrl?: string): Promise<string> {
  return socketUrl("/ws/alerts", {}, baseUrl);
}
