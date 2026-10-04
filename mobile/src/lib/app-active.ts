import { useSyncExternalStore } from "react";
import { AppState } from "react-native";

function subscribe(listener: () => void): () => void {
  const subscription = AppState.addEventListener("change", listener);
  return () => subscription.remove();
}

// "inactive" is iOS passing through — a pulled-down Control Centre, the app
// switcher on its way somewhere — and is still the app on screen.
function foregrounded(): boolean {
  return AppState.currentState !== "background";
}

/** Whether the app is on screen; false once the OS has sent it to the background. */
export function useAppActive(): boolean {
  return useSyncExternalStore(subscribe, foregrounded, foregrounded);
}
