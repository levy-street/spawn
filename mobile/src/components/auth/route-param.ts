export function singleRouteParam(value: string | string[] | undefined): string | undefined {
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate === undefined || candidate.length === 0 ? undefined : candidate;
}
