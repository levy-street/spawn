import { Bodoni_Moda } from "next/font/google";

/*
 * The brand's poster face: a high-contrast didone for display type only.
 * next/font inlines it at build time — no runtime font request — and the app
 * chrome never sees it; body copy stays on the grimoire serif. Shared so the
 * landing and the auth surfaces pull one instance of the family, not two.
 */
export const poster = Bodoni_Moda({
  subsets: ["latin"],
  style: ["normal", "italic"],
  display: "swap",
});
