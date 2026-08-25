import { normalizeServerUrl } from "@/data/api/config";

/**
 * Whether a spawnd server answers at all. Asked before a URL is adopted, so a
 * typo fails here — against the thing just typed — rather than at sign-in.
 */
export async function testServerConnection(
  baseUrl: string,
  request: typeof fetch = globalThis.fetch,
): Promise<void> {
  const normalized = normalizeServerUrl(baseUrl);
  const response = await request(`${normalized}/healthz`, {
    credentials: "omit",
    headers: { Accept: "application/json" },
    method: "GET",
  });
  if (!response.ok) {
    const status = [response.status, response.statusText].filter(Boolean).join(" ");
    throw new Error(`Server responded with ${status || "an error"}`);
  }
}
