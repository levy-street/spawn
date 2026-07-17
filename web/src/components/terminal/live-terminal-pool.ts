export interface DestroyableLiveTerminalEntry {
  host: { remove: () => void };
  handleRef: { current: { disconnect: () => void } | null };
}

/** Hard teardown used for trust revocation; claimed entries are not exempt. */
export function destroyLiveTerminalEntries(entries: Iterable<DestroyableLiveTerminalEntry>): void {
  for (const entry of entries) {
    try {
      entry.handleRef.current?.disconnect();
    } catch {
      // A broken transport must not prevent the rest of the pool from closing.
    }
    entry.handleRef.current = null;
    try {
      entry.host.remove();
    } catch {
      // Keep closing later entries even if a host was already corrupted.
    }
  }
}
