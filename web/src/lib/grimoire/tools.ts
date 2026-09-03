import type { RelatedLink } from "./types";

/**
 * The hand-built tool pages (app/claude-plan-calculator, app/tmux-cheatsheet):
 * static routes, not catalogue entries, but the hubs rack them and the
 * sitemap lists them, so their cards live here.
 */
export const TOOLS: (RelatedLink & { dateModified: string })[] = [
  {
    title: "Claude plan calculator",
    blurb: "Pro vs Max 5x vs Max 20x vs API, by hours of agent use per day",
    href: "/claude-plan-calculator",
    dateModified: "2026-09-03",
  },
  {
    title: "tmux cheatsheet",
    blurb: "sessions, windows, panes, and the fixes — searchable, every command verified",
    href: "/tmux-cheatsheet",
    dateModified: "2026-09-03",
  },
];
