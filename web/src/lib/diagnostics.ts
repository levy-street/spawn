import type { TerminalHandle } from "@/components/terminal/Terminal";

/** Capture before/after terminal diagnostics around a forced refresh and
 *  save the bundle to the session's host (cwd/.spawn/attachments) for offline
 *  review. Shared by the session page header and workspace pane menus. */
export async function runDiagnosticRefresh(handle: TerminalHandle): Promise<void> {
  const bundle = await handle.refreshDiagnostics();
  const file = new File(
    [JSON.stringify(bundle, null, 2)],
    `terminal-diag-${new Date().toISOString().replaceAll(":", "-")}.json`,
    { type: "application/json" },
  );
  // Diagnostics remain endpoint-to-endpoint and never enter REST or WS.
  await handle.uploadFile(file, { destination: "attachments" });
}
