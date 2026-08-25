import { createContext, useContext } from "react";

/**
 * Which surface an overlay paints its chrome on.
 *
 * A bottom drawer sits on the `popover` colour; a full-page dialog sits on the
 * page `background`. Anything drawn *inside* either — a pinned action footer,
 * say — has to match the surface it is on, and reading it from context is what
 * stops a drawer's foot from arriving in the page colour, which in dark mode was
 * a black band under a grey panel.
 */
export type OverlaySurface = "background" | "popover";

export const OverlaySurfaceContext = createContext<OverlaySurface>("background");

export function useOverlaySurface(): OverlaySurface {
  return useContext(OverlaySurfaceContext);
}
