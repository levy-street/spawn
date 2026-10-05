/**
 * Sizes and dates as the file browser shows them. Pure and DOM-free.
 */

export function formatSize(size: number | null | undefined): string {
  if (size == null) return "";
  if (size < 1024) return `${size} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = size / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * "Today at 14:03", "Yesterday at 09:12", or the date and time — the Date
 * modified column's words. `seconds` is the host's Unix time; the reader's
 * own clock and zone place it.
 */
export function formatModified(
  seconds: number | null | undefined,
  now: Date = new Date(),
  locale?: string,
): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return "";
  const when = new Date(seconds * 1000);
  const time = when.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
  if (sameDay(when, now)) return `Today at ${time}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(when, yesterday)) return `Yesterday at ${time}`;
  const date = when.toLocaleDateString(locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  return `${date} at ${time}`;
}

/** The full timestamp for a details pane or a tooltip. */
export function formatTimestamp(seconds: number | null | undefined, locale?: string): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return "";
  return new Date(seconds * 1000).toLocaleString(locale, {
    dateStyle: "full",
    timeStyle: "short",
  });
}

/**
 * The line under a name when the Details view has folded its columns away,
 * read as the phone's file row reads it: a file's size and when it changed,
 * a folder's date alone. Whatever the host did not say is left out.
 */
export function formatEntrySummary(
  entry: { is_dir?: boolean | null; size?: number | null; modified_at?: number | null },
  now: Date = new Date(),
  locale?: string,
): string {
  const modified = formatModified(entry.modified_at, now, locale);
  if (entry.is_dir === true) return modified;
  return [formatSize(entry.size), modified].filter(Boolean).join(" · ");
}
