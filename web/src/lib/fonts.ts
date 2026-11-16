import localFont from "next/font/local";

/*
 * Both brand faces are vendored in src/fonts/ (latin subsets, OFL — the same
 * files the desktop app bundles) and loaded with next/font/local: the build
 * hashes them into its static media and emits their @font-face rules, with no
 * runtime font request and no build-time download. The build used to fetch
 * them from Google, and a response it could not parse failed the release.
 * Each face keeps its own family name (next/font/local would otherwise name
 * it after the export), so the CSS reads as it did when Google supplied it.
 */

/*
 * The brand's poster face: Rowdies in its light cut, for display type only.
 * The app chrome never sees it; body copy stays on the grimoire sans. Shared
 * so the landing and the auth surfaces pull one instance of the family, not
 * two. One weight, so the class sets font-weight 300 itself.
 */
export const poster = localFont({
  src: "../fonts/rowdies-300-latin.woff2",
  declarations: [{ prop: "font-family", value: "Rowdies" }],
  weight: "300",
  style: "normal",
  display: "swap",
});

/*
 * The grimoire body face: IBM Plex Sans. Exposed as a CSS variable, mounted
 * on <html> in the root layout, so the `.grimoire` skin's --font-grimoire
 * token (defined at :root) can resolve to it. The file is variable on its
 * weight axis; the face claims only 400–500, the only weights marketing copy
 * requests.
 */
export const grimoire = localFont({
  src: "../fonts/ibm-plex-sans-latin.woff2",
  declarations: [{ prop: "font-family", value: "IBM Plex Sans" }],
  weight: "400 500",
  style: "normal",
  display: "swap",
  variable: "--font-plex-sans",
});
