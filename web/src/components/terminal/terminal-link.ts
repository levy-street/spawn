interface TerminalLinkWindow {
  opener: unknown;
  location: { href: string };
}

type OpenBlankWindow = () => TerminalLinkWindow | null;

function openBlankWindow(): TerminalLinkWindow | null {
  return window.open();
}

/** Opens terminal-authored links without exposing the current page as an opener. */
export function openTerminalLink(
  url: string,
  openWindow: OpenBlankWindow = openBlankWindow,
): void {
  try {
    const protocol = new URL(url).protocol;
    if (protocol !== "https:" && protocol !== "http:") return;
  } catch {
    return;
  }

  const openedWindow = openWindow();
  if (!openedWindow) return;
  try {
    openedWindow.opener = null;
  } catch {
    // Some embedded browsers expose a read-only opener; navigation is still safe
    // in the regular browser path where the property was cleared successfully.
  }
  openedWindow.location.href = url;
}
