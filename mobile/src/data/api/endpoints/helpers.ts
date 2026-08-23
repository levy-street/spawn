export function pathPart(value: string): string {
  return encodeURIComponent(value);
}

export function queryString(
  values: Record<string, string | number | boolean | null | undefined>,
): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null) query.set(key, String(value));
  }
  const encoded = query.toString();
  return encoded ? `?${encoded}` : "";
}

export function jsonBody(value: unknown): string {
  return JSON.stringify(value);
}
