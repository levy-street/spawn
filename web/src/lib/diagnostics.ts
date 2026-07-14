import type { TerminalHandle } from "@/components/terminal/Terminal";
import { agents } from "@/lib/api";

/** Capture before/after terminal diagnostics around a forced refresh and
 *  save the bundle to the agent host (cwd/.spawn/attachments) for offline
 *  review. Shared by the agent page header and screen pane menus. */
export async function runDiagnosticRefresh(handle: TerminalHandle, agentId: string): Promise<void> {
  const bundle = await handle.refreshDiagnostics();
  const json = new TextEncoder().encode(JSON.stringify(bundle, null, 2));
  let binary = "";
  for (let i = 0; i < json.length; i += 0x8000) {
    binary += String.fromCharCode(...json.subarray(i, i + 0x8000));
  }
  await agents.upload(agentId, {
    name: `terminal-diag-${new Date().toISOString().replaceAll(":", "-")}.json`,
    mime_type: "application/json",
    bytes_b64: btoa(binary),
    // Diagnostics are for offline review — never paste the saved path into
    // the agent's prompt like image uploads do.
    paste: false,
  });
}
