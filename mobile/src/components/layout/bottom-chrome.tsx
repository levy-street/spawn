import { createContext, type ReactNode, useContext } from "react";

/**
 * Whether persistent chrome below the scene — today the bottom nav bar — already
 * reserves and paints the device's bottom safe-area inset.
 *
 * Without this every screen adds that inset for itself, and on a screen sitting
 * above the nav bar it gets charged twice: once by the bar and once by the
 * content, leaving a band of dead space between the last row and the bar. The
 * bar is the one thing that knows it is there, so it is the one thing that owns
 * the inset, and screens ask before adding their own.
 */
const BottomChromeContext = createContext(false);

export function BottomChromeProvider({ children }: { children: ReactNode }): React.JSX.Element {
  return <BottomChromeContext.Provider value={true}>{children}</BottomChromeContext.Provider>;
}

export function useBottomChromeOwnsInset(): boolean {
  return useContext(BottomChromeContext);
}
