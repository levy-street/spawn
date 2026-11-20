type OpenIsolatedWindow = (url: string) => void;

// `noopener` severs the new page's handle on this one in the same call that
// names the URL. The older two-step — open a blank window, clear its opener,
// then point it at the URL — never reached the link in the desktop app: its
// webview hands every new window to the system browser and refuses it, so the
// shell was given `about:blank` and `window.open` came back null.
function openIsolatedWindow(url: string): void {
  window.open(url, "_blank", "noopener,noreferrer");
}

/** Opens terminal-authored links without exposing the current page as an opener. */
export function openTerminalLink(
  url: string,
  openWindow: OpenIsolatedWindow = openIsolatedWindow,
): void {
  try {
    const protocol = new URL(url).protocol;
    if (protocol !== "https:" && protocol !== "http:") return;
  } catch {
    return;
  }
  openWindow(url);
}
