/**
 * The theme bootstrap, kept apart from the React theme module on purpose.
 *
 * This runs as a blocking <script> in <head>, from a server component, before
 * anything renders. It cannot live in a "use client" module because importing
 * one from a server component turns its exports into client references, and it
 * cannot run in React at all, because by then the page has already painted in
 * whichever theme the CSS defaulted to — a visible flash and a correction is
 * worse than either theme on its own.
 */

export const THEME_STORAGE_KEY = "spawn.theme";
export const DARK_QUERY = "(prefers-color-scheme: dark)";

/**
 * Mirrors applyTheme() in ./theme. Keep the two in step; a divergence shows up
 * as a flash on first paint rather than as an error, so it will not announce
 * itself.
 */
export const THEME_BOOTSTRAP_SCRIPT = `(function(){try{
var s=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});
var p=(s==="light"||s==="dark"||s==="system")?s:"system";
var r=p==="system"?(matchMedia(${JSON.stringify(DARK_QUERY)}).matches?"dark":"light"):p;
var e=document.documentElement;e.dataset.theme=r;e.style.colorScheme=r;
}catch(_){var e2=document.documentElement;e2.dataset.theme="dark";e2.style.colorScheme="dark";}})();`;
