export interface KeyboardFitGate {
  beginTransition(): void;
  requestFit(): void;
  endTransition(): void;
  dispose(): void;
}

/** Coalesces resize-affecting work and never executes it during a keyboard transition. */
export function createKeyboardFitGate(performFit: () => void, quietMs: number): KeyboardFitGate {
  let transitioning = false;
  let pending = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clearTimer = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  const schedule = (): void => {
    if (transitioning || !pending) return;
    clearTimer();
    timer = setTimeout(() => {
      timer = null;
      if (transitioning || !pending) return;
      pending = false;
      performFit();
    }, quietMs);
  };

  return {
    beginTransition: () => {
      transitioning = true;
      clearTimer();
    },
    requestFit: () => {
      pending = true;
      schedule();
    },
    endTransition: () => {
      transitioning = false;
      schedule();
    },
    dispose: () => {
      pending = false;
      clearTimer();
    },
  };
}
