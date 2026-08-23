/**
 * Which drawer comes back when the one over it goes away.
 *
 * Opening a drawer from inside another closes the first — the row that was
 * pressed dismisses its own drawer and raises the next in the same breath — and
 * that left nothing behind to come back to. Overlays register here as they
 * mount, in the order they appear, and the rule is one line:
 *
 * An overlay whose **owner** closed it while something else was opening over it
 * does not tear down. It waits underneath, and whatever is above decides. Closed
 * by the person — a scrim tap, a drag, a back gesture — puts the one below back,
 * because they only meant to leave the thing on top. Closed by its owner means
 * the action it was raised for is done, and the whole stack goes with it.
 *
 * `closing` is why a drawer already playing its exit is not something to wait
 * under: without it, navigation clearing every overlay at once would leave the
 * bottom one suspended under the ones on their way out.
 */
export type OverlayCloseReason = "user" | "owner";

export interface OverlayEntry {
  /** Waiting underneath something else rather than gone. */
  suspended: boolean;
  /** Playing its exit, so it is no longer something to wait under. */
  closing: boolean;
  restore(): void;
  teardown(): void;
}

const stack: OverlayEntry[] = [];

export function enterOverlay(entry: OverlayEntry): void {
  entry.suspended = false;
  entry.closing = false;
  if (!stack.includes(entry)) stack.push(entry);
}

export function leaveOverlay(entry: OverlayEntry): void {
  const index = stack.indexOf(entry);
  if (index >= 0) stack.splice(index, 1);
}

export function markOverlayClosing(entry: OverlayEntry): void {
  entry.closing = true;
}

/** Undo a suspension — the overlay is on its way back up. */
export function restoreOverlay(entry: OverlayEntry): void {
  if (!entry.suspended) return;
  entry.suspended = false;
  entry.restore();
}

/**
 * What a closing overlay does now that its exit has played: wait underneath
 * whatever opened over it, or finish leaving and hand the screen back.
 */
export function resolveOverlayClose(
  entry: OverlayEntry,
  reason: OverlayCloseReason,
): "suspend" | "teardown" {
  const index = stack.indexOf(entry);
  if (index < 0) return "teardown";

  const covered = stack.slice(index + 1).some((other) => !other.suspended && !other.closing);
  if (reason === "owner" && covered) {
    entry.suspended = true;
    entry.closing = false;
    return "suspend";
  }

  stack.splice(index, 1);
  releaseSuspended(reason);
  return "teardown";
}

/** Hand the screen to whatever was waiting under the overlay that just left. */
function releaseSuspended(reason: OverlayCloseReason): void {
  while (stack.length > 0) {
    const below = stack[stack.length - 1];
    if (!below?.suspended) return;
    if (reason === "user") {
      below.suspended = false;
      below.restore();
      return;
    }
    // The action is done: nothing underneath it is still worth answering.
    stack.pop();
    below.teardown();
  }
}

/** Test seam: the stack is module state, and suites must not inherit it. */
export function resetOverlayStack(): void {
  stack.length = 0;
}
