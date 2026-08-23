import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { type RefObject, useCallback, useEffect, useMemo, useRef } from "react";
import { Keyboard } from "react-native";

import { createKeyboardFitGate } from "@/components/terminal-ui/keyboard-fit-gate";
import type { TerminalSurfaceHandle } from "@/terminal/TerminalSurface";
import type { TransportState } from "@/terminal/transport/types";

export function useTerminalKeepAwake(
  sessionId: string,
  focused: boolean,
  connectionState: TransportState,
): void {
  useEffect(() => {
    const tag = `spawn-terminal-${sessionId}`;
    if (!focused || connectionState !== "ready") return undefined;
    void activateKeepAwakeAsync(tag).catch(() => undefined);
    return () => {
      void deactivateKeepAwake(tag).catch(() => undefined);
    };
  }, [connectionState, focused, sessionId]);
}

export function useTerminalFontSizeGate(
  surfaceRef: RefObject<TerminalSurfaceHandle | null>,
  value: number,
  quietMs: number,
  commit: (value: number) => void,
): (value: number) => void {
  const pendingValue = useRef(value);
  pendingValue.current = value;
  const gate = useMemo(
    () =>
      createKeyboardFitGate(() => surfaceRef.current?.setFontSize(pendingValue.current), quietMs),
    [quietMs, surfaceRef],
  );

  useEffect(() => {
    const begin = (): void => gate.beginTransition();
    const end = (): void => gate.endTransition();
    const subscriptions = [
      Keyboard.addListener("keyboardWillShow", begin),
      Keyboard.addListener("keyboardWillHide", begin),
      Keyboard.addListener("keyboardDidShow", end),
      Keyboard.addListener("keyboardDidHide", end),
    ];
    return () => {
      for (const subscription of subscriptions) subscription.remove();
      gate.dispose();
    };
  }, [gate]);

  return useCallback(
    (next: number) => {
      pendingValue.current = next;
      commit(next);
      gate.requestFit();
    },
    [commit, gate],
  );
}
