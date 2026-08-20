import { IBM_Plex_Sans, Rowdies } from "next/font/google";

/*
 * The brand's poster face: Rowdies in its light cut, for display type only.
 * next/font inlines it at build time — no runtime font request — and the app
 * chrome never sees it; body copy stays on the grimoire sans. Shared so the
 * landing and the auth surfaces pull one instance of the family, not two.
 */
export const poster = Rowdies({
  subsets: ["latin"],
  weight: "300",
  display: "swap",
});

/*
 * The grimoire body face: IBM Plex Sans, self-hosted the same way. Exposed as
 * a CSS variable, mounted on <html> in the root layout, so the `.grimoire`
 * skin's --font-grimoire token (defined at :root) can resolve to it. 400/500
 * are the only weights marketing copy requests.
 */
export const grimoire = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500"],
  display: "swap",
  variable: "--font-plex-sans",
});
