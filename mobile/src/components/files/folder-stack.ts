/**
 * The host files route pushes a screen per folder, so going up a breadcrumb
 * can usually go back instead: the folder is already on the stack, just under
 * this one. These read the navigator's state for that; they never write it.
 */
export interface StackRouteLike {
  name: string;
  params?: object | undefined;
}

function stringParam(params: object | undefined, key: string): string | undefined {
  if (!params || !(key in params)) return undefined;
  const value = (params as Record<string, unknown>)[key];
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return undefined;
}

/** A host files screen for `hostId`, whatever the navigator nests it under. */
export function isHostFilesRoute(route: StackRouteLike | undefined, hostId: string): boolean {
  return (
    route !== undefined &&
    (route.name === "files" || route.name.endsWith("/files")) &&
    stringParam(route.params, "id") === hostId
  );
}

/**
 * How many screens back the nearest screen showing a matching folder is, or 0
 * when there is none. Only the unbroken run of this host's folders directly
 * under the current screen counts: going back past a terminal or another
 * host to reach a folder would undo more than the breadcrumb said.
 */
export function screensBackToFolder(
  routes: readonly StackRouteLike[],
  index: number,
  hostId: string,
  matches: (path: string | undefined) => boolean,
): number {
  for (let candidate = index - 1; candidate >= 0; candidate -= 1) {
    const route = routes[candidate];
    if (!isHostFilesRoute(route, hostId)) return 0;
    if (matches(stringParam(route?.params, "path"))) return index - candidate;
  }
  return 0;
}
