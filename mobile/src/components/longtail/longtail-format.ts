export function formatLongtailDate(value: string | null): string {
  if (value === null) return "Unknown";
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return "Unknown";
  return parsed.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}
