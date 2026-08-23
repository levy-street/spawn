# R15 — Brand and iconography parity

## TL;DR

1. The canonical identity is a wet-ink trident plus a drawn `spawnd` wordmark; native launch PNGs derive from the right SVGs, but native has no reusable in-app component for either mark (`web/src/components/icons/BrandMark.tsx:4-62`; `docs/native/reports/P3-01.md:30-38`).
2. Native auth currently fabricates a cut-corner square and types `SPAWN` in SF Mono, so the most visible in-app lockup is not the web logo (`mobile/src/components/auth/auth-shell.tsx:54-70`; `mobile/src/components/auth/auth-shell.tsx:146-159`; `mobile/src/components/auth/auth-shell.tsx:226-231`).
3. The Pressroom palette is fixed—not theme-swapped—and its contrast rules are contractual: `hellfire` is for marks/lines, `ember` for small red text on black, and `plate` only for red grounds carrying black text (`web/src/app/globals.css:94-118`).
4. Native already transcribes all Pressroom and `.grimoire` values exactly, but AuthShell reads the ordinary light/dark theme instead, leaving the correct palette effectively unused there (`mobile/src/theme/colors.ts:102-152`; `mobile/src/components/auth/auth-shell.tsx:74-115`).
5. All five web agent/shell marks are inline 24×24 SVGs; native ported their basic geometry, but replaced every fixed brand plate and the Codex gradient with theme colors (`web/src/components/icons/AgentIcon.tsx:25-177`; `mobile/src/components/workspace-detail/agent-icon.tsx:31-115`).
6. Native renders the real AgentIcon only in workspace terminal rows; terminal headers, launch choices, host sessions, settings, Legion, and alerts use generic `Bot`/event icons, monograms, text, or nothing (`mobile/src/components/workspace-detail/terminal-row.tsx:115-123`; `mobile/src/components/terminal-ui/terminal-header.tsx:156-170`; `mobile/src/components/alerts/alert-presenter.tsx:34-44`).
7. Web does not use Apple/Linux/GPU vendor logos: host OS, architecture, and GPU are text; `Server`, semantic dots, trust shields, connection-stage icons, and capacity bars carry state (`web/src/app/hosts/[id]/page.tsx:358-374`; `web/src/lib/legion.ts:256-267`; `web/src/components/terminal/ConnectingOverlay.tsx:62-123`).
8. Native bundles and loads the correct IBM Plex Sans 400/500 and Rowdies 300 files; ordinary app styles intentionally remain system sans, while only branded prose/display roles should opt into Plex/Rowdies (`mobile/src/lib/providers.tsx:69-76`; `mobile/src/theme/typography.ts:3-12`; `web/src/lib/fonts.ts:3-26`).
9. Phase 0's image placeholders were replaced in P3; the remaining packaging defect is an opaque adaptive foreground identical to `icon.png`, plus a non-token light splash ground (`docs/native/plan/P0-01-scaffold.md:92-100`; `docs/native/reports/P3-01.md:30-38`; `mobile/app.json:20-42`).
10. The fix needs no dependency: use installed `react-native-svg` for marks, installed `expo-image` for the 16 KB altar art, current PNG config assets for launch surfaces, and the already-loaded fonts (`mobile/package.json:32-65`; `web/public/brand/ink/altar-ink.png:1`; `mobile/src/lib/providers.tsx:69-76`).

## 1. Source of truth and non-negotiable split

The web has two related but deliberately different visual systems:

- Product chrome is neutral and theme-aware. Its brand accent is `#e11e15` in light mode and `#ff453a` in dark mode, while focus rings stay neutral foreground (`web/src/app/globals.css:318-325`; `web/src/app/globals.css:400-402`).
- Public marketing and auth use `.grimoire`/`.pressroom`: a fixed dark screenprint surface using pure black, bone, ash, and red regardless of the app theme (`web/src/app/globals.css:125-141`; `web/src/components/onboarding/auth-shell.tsx:53-74`).
- The Pressroom is limited to stranger-facing pages; authenticated app chrome keeps its own voice (`web/src/components/brand/press.tsx:11-17`).

**RECOMMEND:** Preserve this split in native: fixed Pressroom styling for launch/auth/onboarding brand surfaces, theme-aware neutral styling for the signed-in shell, and fixed logo/agent colors in both.

The canonical user-facing name is `spawnd`: the web wordmark exposes `aria-label="spawnd"`, metadata says `applicationName: "spawnd"`, and the manifest uses `spawnd` for both `name` and `short_name` (`web/src/components/icons/BrandMark.tsx:51-62`; `web/src/app/layout.tsx:8-17`; `web/public/manifest.webmanifest:1-4`). Native instead declares display name `spawn`, labels its auth lockup `spawn`, types `SPAWN`, and shows `spawn` in About (`mobile/app.json:2-8`; `mobile/src/components/auth/auth-shell.tsx:54-70`; `mobile/src/components/longtail/about-screen.tsx:109-120`). Protocol names, URL scheme, and daemon binary identifiers separately use `spawn`/`spawnd` for technical reasons (`mobile/app.json:8-18`; `mobile/src/lib/linking.ts:1-4`; `mobile/src/data/api/endpoints/install.ts:1-14`).

**RECOMMEND:** Align display-facing app name, accessibility labels, About identity, and lockup to `spawnd`; do not rename URL schemes, storage keys, wire protocols, or daemon commands as a cosmetic brand change.

## 2. Complete web brand-source inventory

### 2.1 Brand and icon component modules

There are exactly four files under the requested component directories: one Pressroom composition module, two visual component modules, and one resolver test (`web/src/components/brand/press.tsx:1-20`; `web/src/components/icons/BrandMark.tsx:1-13`; `web/src/components/icons/AgentIcon.tsx:1-18`; `web/src/components/icons/AgentIcon.test.ts:1-45`).

| Source | Format / geometry | Represents | Use |
|---|---|---|---|
| `web/src/components/icons/BrandMark.tsx` | React wrappers, not inline SVG. `Trident` loads the 538×538 red SVG; `Wordmark` CSS-masks the 1753:370 SVG and fills it with `currentColor` (`web/src/components/icons/BrandMark.tsx:13-37`; `web/src/components/icons/BrandMark.tsx:48-62`). | Canonical spawnd glyph and wordmark; the comment calls both merged wet-ink droplets (`web/src/components/icons/BrandMark.tsx:4-11`; `web/src/components/icons/BrandMark.tsx:39-49`). | Marketing masthead, auth, desktop/sidebar chrome, mobile app header, empty states, and full-width closing posters (`web/src/components/brand/press.tsx:148-160`; `web/src/components/onboarding/auth-shell.tsx:146-159`; `web/src/components/nav/Sidebar.tsx:390-425`; `web/src/components/nav/AppShell.tsx:224-233`; `web/src/components/workspace/workspace-grid.tsx:1807`; `web/src/app/page.tsx:493-497`). |
| `web/src/components/icons/AgentIcon.tsx` | React component containing five inline SVGs, all `viewBox="0 0 24 24"`, plus an HTML-letter monogram fallback (`web/src/components/icons/AgentIcon.tsx:86-177`; `web/src/components/icons/AgentIcon.tsx:73-81`). | Claude Code, Codex, OpenCode, Aider, shell, or unknown-agent identity (`web/src/components/icons/AgentIcon.tsx:7-14`). | Session rows/panes, agent switcher/launcher, settings, files aside, Legion, host sessions, and alerts (`web/src/components/files/session-files-aside.tsx:20-29`; `web/src/components/workspace/agent-switcher.tsx:67-69`; `web/src/components/settings/AgentsPanel.tsx:208-219`; `web/src/components/legion/legion-parts.tsx:192-213`; `web/src/app/hosts/[id]/page.tsx:399-419`; `web/src/hooks/useSessionAlerts.tsx:158-180`). |
| `web/src/components/icons/AgentIcon.test.ts` | Test code; no asset (`web/src/components/icons/AgentIcon.test.ts:1-45`). | Locks kind precedence, path/env command parsing, five shells, unknown monogram, and empty-input shell fallback (`web/src/components/icons/AgentIcon.test.ts:4-45`). | Resolver regression coverage only (`web/src/components/icons/AgentIcon.test.ts:4-45`). |
| `web/src/components/brand/press.tsx` | React composition; no inline SVG. Imports `Trident`/`Wordmark` and Lucide `Check`/`Copy` (`web/src/components/brand/press.tsx:1-9`). | Public brand grammar: masthead, registration `+` marks, bone CTA slab, quiet underlined action, eyebrow, install chip, and colophon (`web/src/components/brand/press.tsx:22-60`; `web/src/components/brand/press.tsx:115-254`). | Landing, Security, Download, and public masthead/footer composition (`web/src/components/brand/press.tsx:11-20`; `web/src/app/page.tsx:210-212`; `web/src/app/security/page.tsx:278-279`; `web/src/app/download/page.tsx:108-110`). |

The `Trident` is always fixed `#E11E15`; its component comment explicitly says identity does not theme-swap and the color clears 3:1 against both light and dark grounds (`web/src/components/icons/BrandMark.tsx:4-11`). The wordmark must be paired with it in `hellfire`, not `brand-accent`, because dark-mode `brand-accent` becomes `ember` and would split the lockup into two reds (`web/src/components/icons/BrandMark.tsx:39-49`; `web/src/components/nav/Sidebar.tsx:407-425`).

**RECOMMEND:** Expose one native `BrandMark` module with `Trident`, `Wordmark`, and a composed `BrandLockup`; do not let call sites reconstruct or independently recolor the pair.

### 2.2 Public vector and app/PWA assets

| Asset | Format / dimensions | What it is | Runtime use |
|---|---|---|---|
| `web/public/brand/spawnd-icon.svg` | SVG, `width=538`, `height=538`, `viewBox="0 0 538 538"`; one complex path filled `#E11E15` on transparency (`web/public/brand/spawnd-icon.svg:1-7`). | Canonical red trident/ink-blob glyph. | Loaded only through `Trident`, then used in marketing, auth, sidebar/app chrome, and empty states (`web/src/components/icons/BrandMark.tsx:13-24`; `web/src/components/nav/Sidebar.tsx:390-405`; `web/src/app/app/page.tsx:188`; `web/src/components/workspace/workspace-grid.tsx:1807`). |
| `web/public/brand/spawnd-icon-black.svg` | SVG, 538×538, same viewBox and silhouette, black fill (`web/public/brand/spawnd-icon-black.svg:1-4`). | Decorative black trident stamp for red flood plates. | Low-opacity rotated stamp on landing, Security, and Download red plates (`web/src/app/page.tsx:87-104`; `web/src/app/security/page.tsx:77-88`; `web/src/app/download/page.tsx:222-233`). |
| `web/public/brand/spawnd-wordmark.svg` | SVG, `width=1753`, `height=370`, `viewBox="0 0 1753 370"`; six white letter paths inside a clip (`web/public/brand/spawnd-wordmark.svg:1-12`). | Drawn lowercase `spawnd` wordmark, not a font rendering. White is mask material, not the intended final display color. | Used as a CSS mask filled by `currentColor`; small lockups and full-width closing posters use the same source (`web/src/components/icons/BrandMark.tsx:28-62`; `web/src/app/page.tsx:493-497`; `web/src/app/security/page.tsx:272-275`). |
| `web/public/icon.svg` | SVG, 512×512/viewBox 512; `#E11E15` square ground plus black trident path (`web/public/icon.svg:1-4`). | Canonical square application icon master. | No direct web runtime reference; it is the recorded source used to rasterize the native app/adaptive icon (`docs/native/reports/P3-01.md:30-34`). |
| `web/public/favicon-48.png` | PNG, 48×48 RGBA (`web/public/favicon-48.png:1`, binary header). | Browser favicon rendition of the app icon. | Declared as the 48×48 icon in Next metadata (`web/src/app/layout.tsx:39-46`). |
| `web/public/icon-192.png` | PNG, 192×192 RGBA (`web/public/icon-192.png:1`, binary header). | PWA/Apple/notification app icon. | Next icon and Apple icon, `any maskable` manifest icon, service-worker precache, notification icon and badge (`web/src/app/layout.tsx:39-46`; `web/public/manifest.webmanifest:11-17`; `web/public/sw.js:7-8`; `web/src/lib/notify-channels.ts:208-216`). |
| `web/public/icon-512.png` | PNG, 512×512 RGBA (`web/public/icon-512.png:1`, binary header). | Large PWA app icon. | Next metadata and `any maskable` manifest icon; service-worker precache (`web/src/app/layout.tsx:39-44`; `web/public/manifest.webmanifest:18-23`; `web/public/sw.js:7-8`). |
| `web/public/og.jpg` | JPEG, physical 2400×1260 (`web/public/og.jpg:1`, binary header); metadata advertises it at 1200×630, the same ratio (`web/src/app/layout.tsx:18-32`). | Social card: red/black server hall, trident + `SPAWN D`, bone headline “A daemon on every host you own.”, and mono supporting line. | Open Graph and Twitter summary-large-image (`web/src/app/layout.tsx:18-32`). |

The PWA manifest gives the app a black `background_color` and `theme_color`, standalone display, and the two maskable PNGs (`web/public/manifest.webmanifest:1-25`). This reinforces that launch/identity surfaces belong to the black/red brand system, not an invented warm-grey surface.

### 2.3 Pressroom ink illustrations and motion

All six PNGs are red/black screenprint illustrations with transparency or a reduced colormap; five have paired MP4 motion plates (`web/src/app/page.tsx:150-190`; `web/src/app/page.tsx:308-363`).

| Asset | Format / dimensions | Represents | Use |
|---|---|---|---|
| `web/public/brand/ink/altar-ink.png` | PNG, 1915×821, 16 KB (`web/public/brand/ink/altar-ink.png:1`, binary header). | A tiny lone figure walking toward a vertical red portal/altar across a black field. | Landing closing poster, Security closing poster, and the full auth/onboarding backdrop (`web/src/app/page.tsx:450-467`; `web/src/app/security/page.tsx:226-243`; `web/src/components/onboarding/auth-shell.tsx:53-73`). |
| `web/public/brand/ink/hero-ink.png` | PNG, 1672×941, 40 KB (`web/public/brand/ink/hero-ink.png:1`, binary header). | Lone figure before monumental server racks. | Hero poster and reduced-motion fallback (`web/src/app/page.tsx:214-243`). |
| `web/public/brand/ink/hero-ink.mp4` | MP4, 1920×1088, 24 fps, 15.041667 s (`web/public/brand/ink/hero-ink.mp4:1`, container metadata). | Gently moving form of the server-hall hero. | Autoplay loop at 0.5 playback rate; hidden under reduced motion (`web/src/app/page.tsx:218-243`). |
| `web/public/brand/ink/pocket-ink.png` | PNG, 1122×1402, 140 KB (`web/public/brand/ink/pocket-ink.png:1`, binary header). | Hand holding a phone running a terminal. | Paper plate №1/poster for “The pocket terminal” (`web/src/app/page.tsx:308-321`). |
| `web/public/brand/ink/pocket-ink.mp4` | MP4, 1024×1366, 24 fps, 10.041667 s (`web/public/brand/ink/pocket-ink.mp4:1`, container metadata). | Scroll-scrubbed motion version of pocket art. | Paired with pocket PNG in `PaperPlate` (`web/src/app/page.tsx:308-321`). |
| `web/public/brand/ink/hosts-ink.png` | PNG, 1448×1086, 36 KB (`web/public/brand/ink/hosts-ink.png:1`, binary header). | Three monolithic hosts dialing to one point. | Paper plate №2 and Download hero (`web/src/app/page.tsx:335-347`; `web/src/app/download/page.tsx:112-122`). |
| `web/public/brand/ink/hosts-ink.mp4` | MP4, 1024×768, 24 fps, 10.041667 s (`web/public/brand/ink/hosts-ink.mp4:1`, container metadata). | Scroll-scrubbed host/dial-out plate. | Paired with hosts PNG on landing (`web/src/app/page.tsx:335-347`). |
| `web/public/brand/ink/grid-ink.png` | PNG, 1448×1086, 48 KB (`web/public/brand/ink/grid-ink.png:1`, binary header). | Wall of terminal windows, one brighter than the rest. | Paper plate №3/“The workspace” (`web/src/app/page.tsx:322-333`). |
| `web/public/brand/ink/grid-ink.mp4` | MP4, 1024×768, 24 fps, 10.041667 s (`web/public/brand/ink/grid-ink.mp4:1`, container metadata). | Scroll-scrubbed terminal-grid plate. | Paired with grid PNG on landing (`web/src/app/page.tsx:322-333`). |
| `web/public/brand/ink/handoff-ink.png` | PNG, 1536×1024, 28 KB (`web/public/brand/ink/handoff-ink.png:1`, binary header). | Laptop terminal and phone joined by a thread of light. | Paper plate №4/“The handoff” (`web/src/app/page.tsx:348-362`). |
| `web/public/brand/ink/handoff-ink.mp4` | MP4, 1024×682, 24 fps, 10.041667 s (`web/public/brand/ink/handoff-ink.mp4:1`, container metadata). | Scroll-scrubbed cross-device handoff. | Paired with handoff PNG on landing (`web/src/app/page.tsx:348-362`). |

The scroll-scrub component leaves the poster frame standing when reduced motion is enabled (`web/src/app/page.tsx:150-190`). The native product has no corresponding marketing plate sequence; only `altar-ink.png` has a current product-flow use because web AuthShell uses it (`web/src/components/onboarding/auth-shell.tsx:53-73`).

**RECOMMEND:** Bundle only `altar-ink.png` for the current native auth batch; do not add the five MP4 files (about 37 MB total) to a product app that has no marketing-page consumer.

### 2.4 Non-visual files in `web/public`

These complete the requested `web/public` inventory but are not drawable assets:

| File | Format / dimensions | Role |
|---|---|---|
| `web/public/manifest.webmanifest` | JSON, no visual dimensions (`web/public/manifest.webmanifest:1-25`). | PWA name, standalone behavior, black theme/background, and 192/512 icon declarations (`web/public/manifest.webmanifest:1-25`; `web/src/app/layout.tsx:14-17`). |
| `web/public/sw.js` | JavaScript, no visual dimensions (`web/public/sw.js:1-8`). | Precaches PWA shell/icons and handles notification navigation; registered only in production (`web/public/sw.js:7-8`; `web/public/sw.js:75-106`; `web/src/lib/query.tsx:30-42`). |

No separate Apple, Linux, Windows, GPU, Claude, Codex, OpenCode, or Aider image file exists in `web/public`; the complete file list above contains only spawnd identity, Pressroom art, PWA metadata, and web infrastructure (`web/public/manifest.webmanifest:1-25`; `web/src/components/icons/AgentIcon.tsx:7-14`). Third-party agent marks are deliberately code-native inline paths, not downloaded logos (`web/src/components/icons/AgentIcon.tsx:86-177`).

## 3. Brand palette: literal values and legal usage

### 3.1 Fixed Pressroom inks

| Token | Literal | Intended surface/use |
|---|---:|---|
| `void` | `#000000` | Pure-black paper; `.grimoire` background and primary-button foreground (`web/src/app/globals.css:94-105`; `web/src/app/globals.css:130-156`). |
| `char` | `#120f0e` | Raised auth/marketing card ink (`web/src/app/globals.css:104-106`; `web/src/app/globals.css:143-148`). |
| `panelg` | `#191514` | Muted and popover surface (`web/src/app/globals.css:105-107`; `web/src/app/globals.css:145-150`). |
| `line-g` | `rgba(242, 237, 226, 0.13)` | Quiet hairline/border and disabled outline (`web/src/app/globals.css:107`; `web/src/app/globals.css:177`; `web/src/app/globals.css:229-235`). |
| `line-strong` | `rgba(242, 237, 226, 0.26)` | Popover border, pane divider, input border, stronger rule (`web/src/app/globals.css:108`; `web/src/app/globals.css:151`; `web/src/app/globals.css:176-180`). |
| `bone` | `#f2ede2` | Main copy, card copy, and primary CTA slab on black (`web/src/app/globals.css:109`; `web/src/app/globals.css:132-156`; `web/src/components/brand/press.tsx:22-28`). |
| `ash` | `#a39a8c` | Muted prose/labels and Pressroom info state (`web/src/app/globals.css:110`; `web/src/app/globals.css:145-146`; `web/src/app/globals.css:171-176`). |
| `hellfire` | `#e11e15` | Canonical logo ink, lines, large marks, selection, and unsupported-platform mark—not small body text on black (`web/src/app/globals.css:100-111`; `web/src/app/globals.css:237-239`; `web/src/app/download/page.tsx:99-105`). |
| `plate` | `#ea2a1b` | Full-bleed red ground carrying black text (`web/src/app/globals.css:112-116`; `web/src/app/security/page.tsx:77-90`; `web/src/app/download/page.tsx:222-240`). |
| `blood` | `#7c100b` | Dark secondary red ink; currently a decorative middle indicator dot on the Download platform plate (`web/src/app/globals.css:117`; `web/src/app/download/page.tsx:152-160`). |
| `ember` | `#ff453a` | Small red text/links on void, fixed Pressroom focus/ring, destructive/positive Pressroom state, and dark product accent (`web/src/app/globals.css:100-102`; `web/src/app/globals.css:161-181`; `web/src/app/globals.css:400-401`). |

The source comments state the contrast rules, not merely preferences:

```css
/* hellfire ... At ~4.4:1 on pure black it clears the 3:1 graphics bar
   but not 4.5:1 body text — small red text on void uses ember */
--color-hellfire: #e11e15;

/* Black body copy on hellfire measures 4.39:1 ... a full-bleed red plate
   carrying black text ... uses ... plate (4.85:1). Line work and small
   marks stay on hellfire proper; only plate grounds use this. */
--color-plate: #ea2a1b;
```

(`web/src/app/globals.css:94-118`)

Consequences:

- `hellfire` is legal for the trident, wordmark, rules, large glyphs, and graphics on black; it is not the small-red-copy color (`web/src/app/globals.css:100-102`; `web/src/components/icons/BrandMark.tsx:4-11`).
- Small red text/interactive emphasis on `void` uses `ember` (`web/src/app/globals.css:100-102`; `web/src/components/brand/press.tsx:30-32`).
- A red background with black body copy uses `plate`, not `hellfire`; `plate` is not a replacement logo ink (`web/src/app/globals.css:112-118`; `web/src/app/security/page.tsx:77-90`).
- Primary actions are bone slabs on void. Hellfire stays “a rule, a mark, a hover” and never the primary button ground (`web/src/app/globals.css:153-156`; `web/src/components/brand/press.tsx:22-28`).
- Pressroom affirmative/warning/destructive status intentionally collapses to red plus bone/ash; it does not import product green/blue (`web/src/app/globals.css:161-176`).

**RECOMMEND:** Encode `hellfireTextOnVoid` as a review lint/checklist concern rather than a general-purpose `brandAccent` prop; the wrong red can be only `0x0a` away and still fail the stated body-text rule.

### 3.2 `.grimoire` semantic skin

The full semantic remap is:

```text
background/foreground       void / bone
muted/mutedForeground       panelg / ash
card/cardForeground         char / bone
popover/popoverForeground   panelg / bone
popoverBorder               lineStrong
popoverAccent               rgba(242,237,226,0.10)
primary/primaryForeground   bone / void
secondary                   rgba(242,237,226,0.05) on bone text
accent                      rgba(242,237,226,0.12) on bone text
destructive                 ember on void; soft rgba(255,69,58,0.14)
success, warning            ember; soft rgba(255,69,58,0.12)
info                        ash; soft rgba(163,154,140,0.14)
tone active                 ember
tone waiting/idle           ash
tone offline                lineStrong
border                      lineG
paneDivider/input           lineStrong
ring/brandAccent            ember
brandAccentSoft             rgba(255,69,58,0.14)
```

(`web/src/app/globals.css:130-183`)

`.pressroom` then makes radii 6 px, sets buttons/labels/fields in sigil mono, uppercases/letterspaces controls, makes secondary actions transparent hairline plates, and renders disabled controls as ash on a quiet hairline rather than dimming a bone slab (`web/src/app/globals.css:185-235`).

Native already contains a literal transcription of all eleven fixed colors and every `.grimoire` semantic mapping (`mobile/src/theme/colors.ts:102-152`). The defect is consumption: native AuthShell uses `useTheme()` and paints its background/card/border/registration marks from `theme.colors`, so a light-mode auth screen becomes `#FAFAFA`/white and dark mode becomes `#030303`/`#0D0D0D`, instead of fixed `void`/`char`/Pressroom lines (`mobile/src/components/auth/auth-shell.tsx:33-45`; `mobile/src/components/auth/auth-shell.tsx:54-115`; `mobile/src/theme/colors.ts:1-18`; `mobile/src/theme/colors.ts:53-70`).

**RECOMMEND:** Add a scoped fixed `grimoireColors` consumption path for AuthShell and borrowed auth controls; do not globally replace the signed-in `useTheme()` palette.

## 4. Agent identity and mark parity

### 4.1 Resolver and four built-ins

The four built-ins are Claude Code (`kind=claude-code`, command `claude`), Codex (`codex`), OpenCode (`opencode`), and Aider Sonnet (`kind=aider`, command beginning `aider --model ...`) (`docs/native/research/07-workspace-model.md:581-592`). Web resolves kind first, then the first non-`KEY=value` command token with path stripped; known substring matches select four brand marks, five exact shells select the shell mark, empty input means Shell, and unknown input becomes the first alphanumeric uppercase monogram (`web/src/lib/agent-identity.ts:6-47`). Native's selector follows the same broad contract and improves the Aider display label to `Aider Sonnet` (`mobile/src/data/selectors/agent.ts:3-29`; `mobile/src/data/selectors/agent.ts:46-70`).

**RECOMMEND:** Keep the native `Aider Sonnet` user-facing definition name, while treating the icon itself as the Aider mark; accessible labels should prefer the actual definition/display name at a call site.

### 4.2 Exact mark inventory and per-agent delta

Every web plate defaults to 28 px, uses a glyph size of `round(size * 0.58)`, and has rounded corners, inset ring, shadow, and overflow clipping (`web/src/components/icons/AgentIcon.tsx:36-56`). Native matches the `0.58` glyph scale but replaces fixed ring/plate behavior with theme border and theme radius (`mobile/src/components/workspace-detail/agent-icon.tsx:8-18`; `mobile/src/components/workspace-detail/agent-icon.tsx:46-60`).

| Identity | Web source and exact treatment | Native now | Delta |
|---|---|---|---|
| Claude Code | Inline 24×24 filled path `M20.998 10.949H24v3.102...`; fixed `#D97757` plate, white glyph, `ring-white/10` (`web/src/components/icons/AgentIcon.tsx:25-34`; `web/src/components/icons/AgentIcon.tsx:86-96`). | Same path, but plate is semantic `warning`, glyph `primaryForeground`, and border is theme `border` (`mobile/src/components/workspace-detail/agent-icon.tsx:31-35`; `mobile/src/components/workspace-detail/agent-icon.tsx:83-93`). | Geometry matches; identity colors do not and will vary by theme. |
| Codex | Full-bleed white rounded plate; 24×24 emblem path; gradient `#B1A7FF` → `#7A9DFF` at `.5` → `#3941FF`, vector `4.33,18.25` to `19.5,5` (`web/src/components/icons/AgentIcon.tsx:61-64`; `web/src/components/icons/AgentIcon.tsx:99-125`). | Plate uses theme `card`; gradient uses `warning` → `info` → `brandAccent`; emblem path is not literal source-identical (`mobile/src/components/workspace-detail/agent-icon.tsx:35-36`; `mobile/src/components/workspace-detail/agent-icon.tsx:96-115`). | Both white plate guarantee and proprietary gradient are lost; exact geometry parity cannot be assumed. |
| OpenCode | Inline path `M16 6H8v12h8V6zm4 16H4V2h16v20z`; fixed black plate, white glyph, `ring-white/20` (`web/src/components/icons/AgentIcon.tsx:25-34`; `web/src/components/icons/AgentIcon.tsx:129-135`). | Same path; plate is theme foreground and glyph theme background (`mobile/src/components/workspace-detail/agent-icon.tsx:37-38`; `mobile/src/components/workspace-detail/agent-icon.tsx:119-124`). | Light mode approximates black/white; dark mode reverses the brand plate. |
| Aider / Aider Sonnet | Inline stroked A path `M5 19 12 5l7 14M8.3 14.4h7.4`, 2.4 round stroke; fixed `#10231b` plate and `#3fcf8e` glyph (`web/src/components/icons/AgentIcon.tsx:31`; `web/src/components/icons/AgentIcon.tsx:137-156`). | Same geometry; semantic `shell` plate and `success` glyph (`mobile/src/components/workspace-detail/agent-icon.tsx:39-40`; `mobile/src/components/workspace-detail/agent-icon.tsx:127-140`). | Colors shift between light/dark and are not the fixed mark. |
| Shell | Inline stroked terminal path `M4.5 6 10 12l-5.5 6M13 19h6.5`, 2.4 round stroke; fixed `#1c2128` plate and `#7ee787` glyph (`web/src/components/icons/AgentIcon.tsx:32`; `web/src/components/icons/AgentIcon.tsx:158-177`). | Same geometry; same semantic `shell`/`success` misuse as Aider (`mobile/src/components/workspace-detail/agent-icon.tsx:41-42`; `mobile/src/components/workspace-detail/agent-icon.tsx:142-155`). | Fixed terminal identity becomes theme-dependent. |
| Unknown/custom | Neutral muted rounded-square plate, muted foreground, border ring; first alphanumeric uppercase letter (`web/src/components/icons/AgentIcon.tsx:33`; `web/src/components/icons/AgentIcon.tsx:73-81`; `web/src/lib/agent-identity.ts:41-47`). | Delegates to global `Monogram`, which hashes among five semantic color palettes and uses pill radius (`mobile/src/components/workspace-detail/agent-icon.tsx:20-28`; `mobile/src/components/ui/monogram.tsx:5-11`; `mobile/src/components/ui/monogram.tsx:34-64`). | Shape and color both differ; an unknown agent looks like an avatar/status rather than the neutral agent fallback. |

Portable web constants, included so implementation does not need to reinterpret the source:

```ts
const plates = {
  claudeCode: { background: "#D97757", foreground: "#FFFFFF", ring: "rgba(255,255,255,.10)" },
  codex:      { background: "#FFFFFF", ring: "rgba(0,0,0,.10)" },
  openCode:   { background: "#000000", foreground: "#FFFFFF", ring: "rgba(255,255,255,.20)" },
  aider:      { background: "#10231b", foreground: "#3fcf8e", ring: "rgba(255,255,255,.10)" },
  shell:      { background: "#1c2128", foreground: "#7ee787", ring: "rgba(255,255,255,.10)" },
};

const paths = {
  claudeCode:
    "M20.998 10.949H24v3.102h-3v3.028h-1.487V20H18v-2.921h-1.487V20H15v-2.921H9V20H7.488v-2.921H6V20H4.487v-2.921H3V14.05H0V10.95h3V5h17.998v5.949zM6 10.949h1.488V8.102H6v2.847zm10.51 0H18V8.102h-1.49v2.847z",
  codexPlate:
    "M19.503 0H4.496A4.496 4.496 0 000 4.496v15.007A4.496 4.496 0 004.496 24h15.007A4.496 4.496 0 0024 19.503V4.496A4.496 4.496 0 0019.503 0z",
  codexEmblem:
    "M9.064 3.344a4.578 4.578 0 012.285-.312c1 .115 1.891.54 2.673 1.275.01.01.024.017.037.021a.09.09 0 00.043 0 4.55 4.55 0 013.046.275l.047.022.116.057a4.581 4.581 0 012.188 2.399c.209.51.313 1.041.315 1.595a4.24 4.24 0 01-.134 1.223.123.123 0 00.03.115c.594.607.988 1.33 1.183 2.17.289 1.425-.007 2.71-.887 3.854l-.136.166a4.548 4.548 0 01-2.201 1.388.123.123 0 00-.081.076c-.191.551-.383 1.023-.74 1.494-.9 1.187-2.222 1.846-3.711 1.838-1.187-.006-2.239-.44-3.157-1.302a.107.107 0 00-.105-.024c-.388.125-.78.143-1.204.138a4.441 4.441 0 01-1.945-.466 4.544 4.544 0 01-1.61-1.335c-.152-.202-.303-.392-.414-.617a5.81 5.81 0 01-.37-.961 4.582 4.582 0 01-.014-2.298.124.124 0 00.006-.056.085.085 0 00-.027-.048 4.467 4.467 0 01-1.034-1.651 3.896 3.896 0 01-.251-1.192 5.189 5.189 0 01.141-1.6c.337-1.112.982-1.985 1.933-2.618.212-.141.413-.251.601-.33.215-.089.43-.164.646-.227a.098.098 0 00.065-.066 4.51 4.51 0 01.829-1.615 4.535 4.535 0 011.837-1.388zm3.482 10.565a.637.637 0 000 1.272h3.636a.637.637 0 100-1.272h-3.636zM8.462 9.23a.637.637 0 00-1.106.631l1.272 2.224-1.266 2.136a.636.636 0 101.095.649l1.454-2.455a.636.636 0 00.005-.64L8.462 9.23z",
  openCode: "M16 6H8v12h8V6zm4 16H4V2h16v20z",
  aider: "M5 19 12 5l7 14M8.3 14.4h7.4",
  shell: "M4.5 6 10 12l-5.5 6M13 19h6.5",
};

const codexGradient = {
  x1: 4.33, y1: 18.25, x2: 19.5, y2: 5,
  gradientUnits: "userSpaceOnUse",
  stops: [[0, "#B1A7FF"], [0.5, "#7A9DFF"], [1, "#3941FF"]],
};
```

These are literal transcriptions of the web component; Claude uses even-odd fill, Aider/Shell use no fill plus 2.4 round stroke, and Codex requires `gradientUnits="userSpaceOnUse"` (`web/src/components/icons/AgentIcon.tsx:86-177`). Native currently omits that Codex gradient-units prop in addition to substituting theme stops (`mobile/src/components/workspace-detail/agent-icon.tsx:96-105`).

**RECOMMEND:** Copy the web paths and literal plate constants verbatim into a shared native AgentIcon, including Codex gradient stops and a neutral rounded-square fallback; logo identity must not be derived from the active theme.

### 4.3 Surface-by-surface rendering delta

| Surface | Web | Native | Required parity |
|---|---|---|---|
| Workspace/session list row | Real AgentIcon with overlaid SessionStatusDot (`web/src/app/hosts/[id]/page.tsx:399-419`; `web/src/components/workspace/agent-switcher.tsx:67-69`). | Real-but-miscolored AgentIcon plus StatusDot in workspace terminal rows (`mobile/src/components/workspace-detail/terminal-row.tsx:115-123`). | Fix shared mark constants; keep overlaid status dot. |
| Full terminal header/pane header | AgentSwitcher displays AgentIcon for current foreground command (`web/src/components/workspace/session-pane.tsx:320-335`; `web/src/components/workspace/agent-switcher.tsx:67-69`). | `inferAgentPresentation` maps every agent to Lucide `Bot`, shell to `Terminal` (`mobile/src/components/terminal-ui/terminal-header.tsx:14-25`; `mobile/src/components/terminal-ui/terminal-header.tsx:156-170`). | Replace generic plate with shared AgentIcon keyed by current command. |
| New-session/launcher choice | Each agent definition gets AgentIcon; shell deliberately uses `SquareTerminal` (`web/src/components/workspace/new-session-menu.tsx:260-278`; `web/src/components/workspace/launcher-fab.tsx:479-490`). | Shell uses `SquareTerminal`, all definitions use `Bot` (`mobile/src/components/launcher/run-step.tsx:25-43`). | Keep shell affordance; use AgentIcon for each definition. |
| Host session list | AgentIcon + SessionStatusDot (`web/src/app/hosts/[id]/page.tsx:399-419`). | Colored Monogram + separate semantic dot (`mobile/src/components/hosts/host-session-list.tsx:37-70`). | Use AgentIcon; retain native dot mapping. |
| Agent settings definitions | 36 px AgentIcon at row start (`web/src/components/settings/AgentsPanel.tsx:208-219`). | No mark (`mobile/src/components/settings/agents-panel.tsx:37-52`). | Add 36 px shared AgentIcon. |
| Host agent-install row | Web panel has no agent art; it presents install/status controls without AgentIcon (`web/src/components/hosts/HostAgentsPanel.tsx:18-31`). | Native adds a generic Monogram (`mobile/src/components/hosts/host-agent-row.tsx:35-54`). | Either omit this extra art like web or use correct AgentIcon; never use a false logo. |
| Legion fleet summary | Up to three recognizable AgentIcon chips with counts; shells get the shell chip (`web/src/components/legion/legion-parts.tsx:129-180`; `web/src/components/legion/legion-parts.tsx:192-213`). | Collapses running agents to a text summary (`mobile/src/components/hosts/legion-host-card.tsx:43-57`; `mobile/src/components/hosts/legion-host-card.tsx:133-143`). | Port icon chips/counts; this is functional scanability as well as brand. |
| Alert/toast | Workspace avatar plus overlaid AgentIcon, or standalone AgentIcon (`web/src/hooks/useSessionAlerts.tsx:155-180`). | Event icons `BellRing`, `MessageCircleQuestion`, `Skull`; agent identity is only in copy (`mobile/src/components/alerts/alert-presenter.tsx:34-44`; `mobile/src/components/alerts/alert-presenter.tsx:138-150`). | Use AgentIcon as the identity plate; event state can remain a secondary badge/tone. |
| Files session aside | 20 px AgentIcon beside the session (`web/src/components/files/session-files-aside.tsx:20-29`). | No equivalent session-files-aside AgentIcon consumer exists in native; current AgentIcon import has one production call site (`mobile/src/components/workspace-detail/terminal-row.tsx:7`; `mobile/src/components/workspace-detail/terminal-row.tsx:115-116`). | When files are session-scoped, reuse the shared AgentIcon; do not create a second mapping. |

**RECOMMEND:** Move identity art out of `workspace-detail/` to a domain-shared component and replace every generic/missing rendering in one batch; a logo that changes by surface is the exact failure the web component was created to prevent (`web/src/components/icons/AgentIcon.tsx:7-14`).

## 5. Host, OS, GPU, and status iconography

The web does **not** use vendor operating-system or GPU logos. Host detail shows `System` as `${os}/${arch}` text; Legion shows OS and a plain spec line such as `12 cores · 64 GB · RTX 4090`; GPU is appended as text (`web/src/app/hosts/[id]/page.tsx:358-374`; `web/src/components/legion/LegionHostCard.tsx:57-70`; `web/src/lib/legion.ts:256-267`). Native already follows that text convention in host list/detail and Legion (`mobile/src/components/hosts/host-list-item.tsx:53-68`; `mobile/src/components/hosts/host-facts.tsx:21-39`; `mobile/src/components/hosts/legion-host-card.tsx:100-120`).

**RECOMMEND:** Do not invent Apple, Linux, architecture, NVIDIA, or AMD marks; the web source of truth intentionally represents these facts as text.

| Concept | Web representation / Lucide names | Native representation / Lucide names | Delta |
|---|---|---|---|
| Host object | Lucide `Server` on host setting plates; semantic StatusDot overlays the lower corner (`web/src/components/settings/HostsPanel.tsx:143-152`). | Main host list has only StatusDot + `ChevronRight`; settings rows use `Server` + online/offline badge (`mobile/src/components/hosts/host-list-item.tsx:48-68`; `mobile/src/components/settings/hosts-panel.tsx:34-55`). | Standardize one `Server` plate + overlaid dot where a host needs a recognizable object icon; list density may justify dot-only only if deliberate. |
| OS / installation support | Host OS is text. Download detection uses `CheckCircle2` supported, `AlertTriangle` unsupported, `Laptop` unknown—not vendor logos (`web/src/app/download/page.tsx:90-106`). | Host OS is text. Install instructions use numbered circles and `Check`/`Copy`, with no OS status glyph (`mobile/src/components/onboarding/install-instructions.tsx:51-100`). | No vendor-logo gap; optional platform-result parity is `CheckCircle2`/`AlertTriangle`/`Laptop`. |
| GPU | Plain text in `specLine` (`web/src/lib/legion.ts:256-267`). | Plain text in Legion spec list (`mobile/src/components/hosts/legion-host-card.tsx:111-120`). | In parity; add no GPU icon. |
| Basic host presence | `StatusDot`: active if online, offline otherwise; settings online dot pulses (`web/src/components/ui/status.tsx:5-50`; `web/src/components/settings/HostsPanel.tsx:145-152`). | Same 8 px semantic StatusDot component, but list explicitly sets `pulse={false}` (`mobile/src/components/ui/status-dot.tsx:14-30`; `mobile/src/components/ui/status-dot.tsx:57-138`; `mobile/src/components/hosts/host-list-item.tsx:48-52`). | Enable pulse for active basic host state if matching web settings. |
| Legion host state | Custom circle `LegionDot`; `hostTone` is offline, active if any session is active, otherwise idle; active pulses (`web/src/lib/legion.ts:75-89`; `web/src/components/legion/legion-parts.tsx:94-125`; `web/src/components/legion/LegionHostCard.tsx:57-59`). | Online always maps to active, offline to offline, never pulses (`mobile/src/components/hosts/legion-host-card.tsx:43-47`; `mobile/src/components/hosts/legion-host-card.tsx:94-99`). | Native loses “online but quiet” and active motion; derive idle/active from sessions. |
| Session activity | `SessionStatusDot` maps active / waiting+input_sent+starting / quiet / stopped to active / waiting / idle / offline and pulses active (`web/src/lib/sessions.ts:56-68`; `web/src/components/ui/status.tsx:53-61`). | Same mapping and reduced-motion-aware pulse (`mobile/src/data/selectors/session.ts:63-75`; `mobile/src/components/ui/status-dot.tsx:57-138`). | Semantics are in parity; preserve them when swapping logos. |
| Connection transport chip | Colored dot for blocked/offline/connecting/channel/direct/STUN/relay; trust row uses `ShieldCheck`, `ShieldAlert`, `ShieldOff` (`web/src/components/terminal/ConnectionChip.tsx:25-50`; `web/src/components/terminal/ConnectionChip.tsx:82-109`). | Badge text only for connection chip (`mobile/src/components/terminal-ui/connection-status.tsx:19-87`). | Native omits transport-kind dot and signaling-trust iconography. |
| Empty-terminal connection stage | `ShieldAlert` blocked, `Unplug` host offline, `PlugZap` dropped/retrying, `LockOpen` reaching/securing, `Lock` secured (`web/src/components/terminal/ConnectingOverlay.tsx:22-38`; `web/src/components/terminal/ConnectingOverlay.tsx:62-123`). | Busy states use Spinner; failed uses `AlertCircle`; all other non-busy states use `Unplug` (`mobile/src/components/terminal-ui/connection-status.tsx:96-140`). | Port stage-specific icons so “blocked”, “offline”, “reconnecting”, and “secured” do not look interchangeable. |
| Live fleet metrics | `Radio` when off, `RadioTower` when live (`web/src/app/legion/page.tsx:1-5`; `web/src/app/legion/page.tsx:62-75`). | Text plus Switch; both Lucide names already exist in native registry but are unused here (`mobile/src/components/hosts/legion-screen.tsx:65-70`; `mobile/src/components/ui/icon.tsx:191-195`). | Add the existing icon names; no asset or dependency work. |
| Capacity state | Continuous scalar bar: active/green with room, warning when tight, destructive when full (`web/src/components/legion/legion-parts.tsx:17-22`; `web/src/components/legion/legion-parts.tsx:24-90`). | Bucketed mode is five neutral segments; exact mode is a neutral foreground fill (`mobile/src/components/hosts/capacity-meter.tsx:7-68`). | Status color and continuous visual language differ; port `free/tight/full` tone logic even when input is bucketed. |

`lucide-react-native` 1.14.0 is already installed, and the native icon registry already imports the relevant `Laptop`, `Lock`, `LockOpen`, `PlugZap`, `Radio`, `RadioTower`, `Server`, shield, terminal, and `Unplug` names (`mobile/package.json:55`; `mobile/src/components/ui/icon.tsx:170-217`). It is a JS component layer over the already-installed SVG foundation and adds no native module/config plugin.

**RECOMMEND:** Reuse the existing native Icon registry for status/action glyphs and reserve custom SVG paths for actual brand marks; no new icon library is justified.

## 6. Native asset and placeholder audit

### 6.1 Current image assets

| Native asset | Actual format / dimensions | Current wiring | Finding |
|---|---|---|---|
| `mobile/assets/images/icon.png` | PNG, 1024×1024, opaque RGB (`mobile/assets/images/icon.png:1`, binary header). | Expo application icon (`mobile/app.json:3-8`). | P3 records it as rasterized from canonical `web/public/icon.svg`, so this is no longer the Phase 0 placeholder (`docs/native/reports/P3-01.md:30-34`). |
| `mobile/assets/images/adaptive-icon.png` | PNG, 1024×1024, opaque RGB, byte-identical to `icon.png` (`mobile/assets/images/adaptive-icon.png:1`, binary header; `mobile/assets/images/icon.png:1`, binary header). | Android adaptive foreground over configured `#030303` background (`mobile/app.json:20-26`). | Canonical art, but wrong adaptive mechanics: an opaque red-square foreground prevents the configured background layer/mask system from participating. |
| `mobile/assets/images/splash.png` | PNG, 1024×1024 RGBA with transparent ground and red trident (`mobile/assets/images/splash.png:1`, binary header). | 200-point contained splash image; light ground `#F4F2ED`, dark ground `#030303` (`mobile/app.json:30-43`). | P3 records it as rasterized from the canonical red trident SVG, so the mark is no longer placeholder; the light ground is neither Pressroom `bone #F2EDE2` nor native product light `#FAFAFA` (`docs/native/reports/P3-01.md:30-34`; `mobile/src/theme/colors.ts:1-6`; `mobile/src/theme/colors.ts:102-113`). |

Phase 0 explicitly called all three launch images temporary solid-color placeholders and deferred real font assets (`docs/native/plan/P0-01-scaffold.md:92-100`). P3 explicitly records replacement of all launch-image placeholders with assets derived from `web/public/icon.svg` and `web/public/brand/spawnd-icon.svg`, plus the exact font bundles (`docs/native/reports/P3-01.md:30-38`). Therefore:

- **No Phase 0 bitmap placeholder remains by provenance** (`docs/native/reports/P3-01.md:30-38`).
- The adaptive icon remains structurally unsuitable despite canonical source art (`mobile/app.json:20-26`; `mobile/assets/images/adaptive-icon.png:1`, binary header).
- The more serious current placeholder is code: AuthShell's cut-corner square and typed `SPAWN` are fabricated stand-ins for the real trident/wordmark (`mobile/src/components/auth/auth-shell.tsx:54-70`; `mobile/src/components/auth/auth-shell.tsx:146-159`; `mobile/src/components/auth/auth-shell.tsx:226-231`).
- About uses a generic `Terminal` glyph on a soft red tile plus system-text `spawn`, not either canonical brand mark (`mobile/src/components/longtail/about-screen.tsx:109-120`).

**RECOMMEND:** Keep `icon.png`; rebuild `adaptive-icon.png` as a transparent black trident foreground with `#E11E15` adaptive background, using the same safe-zone geometry as the canonical icon.

**RECOMMEND:** Keep the canonical splash mark but make its branded ground fixed `void #000000`; do not retain the invented `#F4F2ED` light value.

Launch icon/adaptive/splash references already exist in app config, so replacing PNG contents/background literals adds no package or config plugin (`mobile/app.json:7`; `mobile/app.json:20-43`). Expo Go remains runnable, but its launcher icon is the Expo Go container rather than the standalone app icon; final adaptive/app-icon acceptance necessarily belongs to a later installed build.

### 6.2 Inline SVG currently in native

Only two production modules import `react-native-svg`:

1. `mobile/src/components/workspace-detail/agent-icon.tsx` contains the Claude, Codex, OpenCode, Aider, and shell marks (`mobile/src/components/workspace-detail/agent-icon.tsx:1-2`; `mobile/src/components/workspace-detail/agent-icon.tsx:83-155`).
2. `mobile/src/components/ui/spinner.tsx` draws a 24×24 circle/arc spinner; this is functional iconography, not a logo (`mobile/src/components/ui/spinner.tsx:10`; `mobile/src/components/ui/spinner.tsx:45-69`).

There is no native inline/vector implementation of the spawnd trident or wordmark; AuthShell reconstructs unrelated geometry with Views/Text instead (`mobile/src/components/auth/auth-shell.tsx:54-70`; `mobile/src/components/auth/auth-shell.tsx:146-159`).

**RECOMMEND:** Port the two canonical brand SVGs into React Native Svg components rather than shipping more in-app logo bitmaps.

## 7. Fonts and typographic identity

### 7.1 Web roles

| Role | Web face | Exact use |
|---|---|---|
| App/body sans | `ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif` (`web/src/app/globals.css:430-432`). | Signed-in chrome and ordinary primitives; not a bundled brand face (`web/src/app/globals.css:412-432`). |
| Grimoire prose | IBM Plex Sans 400/500 via `next/font/google`, self-hosted and exposed as `--font-plex-sans` (`web/src/lib/fonts.ts:15-26`; `web/src/app/layout.tsx:61-75`). | Marketing/auth prose only; `.grimoire` resolves `var(--font-plex-sans, "IBM Plex Sans"), "Helvetica Neue", Arial, sans-serif` (`web/src/app/globals.css:120-134`). |
| Poster/display | Rowdies 300 Light, latin, self-hosted (`web/src/lib/fonts.ts:3-13`). | Large marketing/auth display only; the comment explicitly excludes app chrome (`web/src/lib/fonts.ts:3-7`). |
| Sigil/meta/control | `ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace` (`web/src/app/globals.css:122`). | Pressroom buttons, labels, fields, metadata, eyebrow, registration marks (`web/src/app/globals.css:185-216`; `web/src/components/brand/press.tsx:34-60`). |
| App mono/terminal | Platform mono stack (`docs/native/research/01-design-system.md:359-367`). | Terminal/code and compact metadata (`docs/native/research/01-design-system.md:361-367`). |

### 7.2 Native files, loading, and mapping

| File | Face/weight | License |
|---|---|---|
| `mobile/assets/fonts/IBMPlexSans-Regular.ttf` | IBM Plex Sans 400 (`mobile/src/lib/providers.tsx:69-73`). | IBM copyright 2017, reserved name “Plex,” SIL OFL 1.1 (`mobile/assets/fonts/IBMPlexSans-OFL.txt:1-5`). |
| `mobile/assets/fonts/IBMPlexSans-Medium.ttf` | IBM Plex Sans 500 (`mobile/src/lib/providers.tsx:69-73`). | Same included OFL file (`mobile/assets/fonts/IBMPlexSans-OFL.txt:1-5`). |
| `mobile/assets/fonts/Rowdies-Light.ttf` | Rowdies 300 Light (`mobile/src/lib/providers.tsx:69-74`). | Rowdies Project copyright 2018, SIL OFL 1.1 (`mobile/assets/fonts/Rowdies-OFL.txt:1-5`). |
| `mobile/assets/fonts/IBMPlexSans-OFL.txt` | License text, not a font (`mobile/assets/fonts/IBMPlexSans-OFL.txt:1-9`). | Permits use/embed/redistribution subject to OFL conditions and reserved-name rules (`mobile/assets/fonts/IBMPlexSans-OFL.txt:19-26`; `mobile/assets/fonts/IBMPlexSans-OFL.txt:47-54`). |
| `mobile/assets/fonts/Rowdies-OFL.txt` | License text, not a font (`mobile/assets/fonts/Rowdies-OFL.txt:1-9`). | Same OFL terms (`mobile/assets/fonts/Rowdies-OFL.txt:19-26`; `mobile/assets/fonts/Rowdies-OFL.txt:47-54`). |

The provider loads the three TTFs under exactly the family names declared by typography and withholds the app tree until loading succeeds or errors (`mobile/src/lib/providers.tsx:69-76`). `typography.ts` maps `grimoireRegular`, `grimoireMedium`, and `posterLight` correctly, alongside system sans/mono/sigil roles (`mobile/src/theme/typography.ts:3-12`). AuthShell explicitly uses Plex for description, Rowdies for title, and sigil mono for registration marks/its current fake wordmark (`mobile/src/components/auth/auth-shell.tsx:163-168`; `mobile/src/components/auth/auth-shell.tsx:198-203`; `mobile/src/components/auth/auth-shell.tsx:221-231`).

Ordinary native `typeStyles.ui*`, `cardTitle`, and `micro` intentionally omit `fontFamily`, while only `sigilLabel`, `sigilButton`, and `terminal` specify a family (`mobile/src/theme/typography.ts:85-116`). The shared Text component maps body/label/caption/title to those system styles and mono to terminal (`mobile/src/components/ui/text.tsx:29-54`). That is web parity—not an accidental fallback—because web app chrome also uses the system sans stack (`web/src/app/globals.css:430-432`).

The actual font-related brand defect is narrower:

- Native has the right bundled faces and loader (`mobile/src/lib/providers.tsx:69-76`).
- Branded prose/title styles use them in AuthShell (`mobile/src/components/auth/auth-shell.tsx:163-168`; `mobile/src/components/auth/auth-shell.tsx:221-224`).
- The canonical wordmark is vector artwork, so typing `SPAWN` in `fontFamily.sigil` can never match it (`web/src/components/icons/BrandMark.tsx:39-49`; `mobile/src/components/auth/auth-shell.tsx:64-69`; `mobile/src/components/auth/auth-shell.tsx:226-231`).
- About's product title uses the generic shared title style rather than artwork (`mobile/src/components/longtail/about-screen.tsx:109-120`; `mobile/src/components/ui/text.tsx:29-38`).

**RECOMMEND:** Keep system fonts for product UI, keep bundled IBM Plex/Rowdies for Pressroom roles, and replace every typed approximation of the wordmark with vector artwork.

## 8. React Native delivery mechanics and Expo Go compatibility

No new dependency is needed or justified. The installed set already contains Expo SDK 54.0.37, `expo-image ~3.0.11`, `expo-font ~14.0.12`, `lucide-react-native 1.14.0`, and `react-native-svg 15.12.1` (`mobile/package.json:32-65`).

| Need | Delivery | Why | Expo Go SDK 54 status |
|---|---|---|---|
| Trident and wordmark in app UI | `react-native-svg` components with source viewBoxes 538 and 1753×370; copy paths verbatim and accept color only where the web allows it (`web/public/brand/spawnd-icon.svg:1-7`; `web/public/brand/spawnd-wordmark.svg:1-12`). | Resolution-independent, exact silhouette, no raster density variants, accessible wrapper. | **Compatible:** installed version is 15.12.1 (`mobile/package.json:65`), already executes native agent/spinner SVGs (`mobile/src/components/workspace-detail/agent-icon.tsx:1-2`; `mobile/src/components/ui/spinner.tsx:10`), and Expo's SDK 54 docs list 15.12.1 as Included in Expo Go: [Expo SDK 54 react-native-svg](https://docs.expo.dev/versions/v54.0.0/sdk/svg/). |
| Agent/shell marks | One shared `react-native-svg` component; no files in `assets/images` (`web/src/components/icons/AgentIcon.tsx:86-177`). | Existing marks are inline vectors and need runtime plate/size composition. | **Compatible:** same installed/official SDK 54 support as above; no new native module or config plugin (`mobile/package.json:65`). |
| Auth altar backdrop | Copy one `altar-ink.png` and render via installed `expo-image` with `contentFit="cover"`, matching web's centered upper composition (`web/src/components/onboarding/auth-shell.tsx:53-73`). | It is intentional raster screenprint art, 1915×821 but only 16 KB; vector conversion adds no value (`web/public/brand/ink/altar-ink.png:1`, binary header). | **Compatible:** installed `~3.0.11` matches the SDK 54 recommended version (`mobile/package.json:42`); Expo lists it Included in Expo Go and documents PNG/SVG plus `contentFit`: [Expo SDK 54 Image](https://docs.expo.dev/versions/v54.0.0/sdk/image/). |
| App icon | Keep canonical 1024×1024 PNG derived from `web/public/icon.svg` (`docs/native/reports/P3-01.md:30-34`). | Store/launcher assets must be raster packaging resources; `@2x`/`@3x` names are not used for the Expo application icon. | **Compatible:** static config asset, no runtime module; existing Expo Go project already references it (`mobile/app.json:3-8`). Expo Go cannot preview the installed standalone launcher icon. |
| Android adaptive icon | Transparent 1024×1024 black trident foreground plus `#E11E15` config background, sourced from the black/canonical icon art (`web/public/brand/spawnd-icon-black.svg:1-4`; `web/public/icon.svg:1-4`). | Lets Android apply device masks and background/foreground layers; current opaque duplicate defeats that mechanism (`mobile/app.json:20-26`; `mobile/assets/images/adaptive-icon.png:1`, binary header). | **Compatible:** core Expo config/static PNG, no added plugin/module; final launcher rendering needs an installed build, not Expo Go. |
| Splash mark | Existing transparent 1024×1024 PNG from canonical trident; retain `contain`, use fixed `void` ground (`docs/native/reports/P3-01.md:30-34`; `mobile/app.json:30-43`; `web/src/app/globals.css:94-105`). | Correct raster form for native launch packaging; no `@2x`/`@3x` set needed. | **Compatible:** references already exist; no new plugin is proposed (`mobile/app.json:30-43`). Expo Go may not reproduce final standalone launch branding exactly. |
| IBM Plex / Rowdies | Keep existing TTF files and runtime `useFonts` names (`mobile/src/lib/providers.tsx:69-76`). | Exact faces/weights are already bundled; no remote font request. | **Compatible:** installed `expo-font ~14.0.12` is Included in Expo Go and runtime `useFonts` is supported in SDK 54: [Expo SDK 54 Font](https://docs.expo.dev/versions/v54.0.0/sdk/font/). No new config-plugin font embedding is recommended. |
| Status/action icons | Existing `lucide-react-native` through `mobile/src/components/ui/icon.tsx` (`mobile/src/components/ui/icon.tsx:150-225`). | Keeps the web's Lucide names without copying SVGs. | **Compatible:** already installed/used at 1.14.0 and depends on the Expo-Go-supported SVG runtime (`mobile/package.json:55`; `mobile/package.json:65`). No native module/config plugin. |

`@2x`/`@3x` PNG sets are not appropriate for the remaining logo work: the small marks have canonical vectors, while launch assets have Expo-required master dimensions. The altar illustration is already a high-resolution art plate and `expo-image` downscales it; a density triplet would duplicate bundle content without increasing source detail (`web/public/brand/ink/altar-ink.png:1`, binary header; [Expo SDK 54 Image](https://docs.expo.dev/versions/v54.0.0/sdk/image/)).

The existing splash runtime is `expo-splash-screen ~31.0.13`, the SDK 54 recommended version (`mobile/package.json:50`). Its runtime visibility control is Expo Go-compatible, but Expo explicitly says Expo Go shows the app icon and cannot fully reproduce the standalone splash; the proposed work changes existing static art/config and adds no new plugin: [Expo SDK 54 SplashScreen](https://docs.expo.dev/versions/v54.0.0/sdk/splash-screen/).

**RECOMMEND:** Do not add an SVG-transformer package, icon pack, font package, video package, or native asset plugin; every required runtime is already present and Expo Go-safe.

### Licensing and mark provenance

IBM Plex and Rowdies are covered by the included SIL OFL 1.1 texts; keep both license files with distributions (`mobile/assets/fonts/IBMPlexSans-OFL.txt:1-5`; `mobile/assets/fonts/Rowdies-OFL.txt:1-5`). The app repository is MIT/Apache-2.0, but Apache-2.0 explicitly says it does not grant trademark permission (`LICENSE-APACHE:139-142`).

**UNKNOWN:** No separate in-repository attribution/provenance file was found for the spawnd brand kit or the embedded Claude Code, Codex, OpenCode, and Aider mark paths. Implementation should port the existing approved web assets for internal parity, but release/legal owners must confirm trademark permissions and any vendor brand-guideline obligations; the repository software license alone does not resolve that.

## 9. Prioritized asset worklist

| Priority | Source of truth | Native destination | Delivery format | Consumer(s) / acceptance |
|---:|---|---|---|---|
| P0 | `web/public/brand/spawnd-icon.svg` + `web/public/brand/spawnd-wordmark.svg` (`web/public/brand/spawnd-icon.svg:1-7`; `web/public/brand/spawnd-wordmark.svg:1-12`). | New `mobile/src/components/brand/brand-mark.tsx`. | `react-native-svg` components; exact viewBoxes/paths; fixed hellfire lockup. | Replace AuthShell fabrication, About terminal tile, new burger/drawer identity header, and brand empty states (`mobile/src/components/auth/auth-shell.tsx:54-70`; `mobile/src/components/longtail/about-screen.tsx:109-120`). |
| P0 | `web/src/components/icons/AgentIcon.tsx` fixed plates and paths (`web/src/components/icons/AgentIcon.tsx:25-177`). | New shared `mobile/src/components/agents/agent-icon.tsx`; retire workspace-scoped duplicate. | `react-native-svg`, literal plate constants, neutral monogram variant. | Workspace rows, terminal header, launcher, host sessions, Agents settings, Legion chips, alert identity (`mobile/src/components/workspace-detail/terminal-row.tsx:115-123`; `mobile/src/components/terminal-ui/terminal-header.tsx:156-170`; `mobile/src/components/launcher/run-step.tsx:25-43`; `mobile/src/components/hosts/host-session-list.tsx:37-70`; `mobile/src/components/settings/agents-panel.tsx:37-52`; `mobile/src/components/hosts/legion-host-card.tsx:133-143`; `mobile/src/components/alerts/alert-presenter.tsx:138-150`). |
| P0 | `web/public/brand/ink/altar-ink.png` (`web/public/brand/ink/altar-ink.png:1`, binary header). | `mobile/assets/images/altar-ink.png`. | Single bundled PNG through `expo-image`; `cover`, decorative accessibility, dark scrim. | Native AuthShell background must visually continue the landing/auth sheet used by web (`web/src/components/onboarding/auth-shell.tsx:53-74`; `mobile/src/components/auth/auth-shell.tsx:79-106`). |
| P0 | `.grimoire` and Pressroom rules (`web/src/app/globals.css:94-183`). | Existing `mobile/src/theme/colors.ts` plus AuthShell-scoped consumption. | Existing tokens/code, no asset. | Auth background/card/border/actions must use fixed void/char/bone/ash/ember; product chrome stays normal theme (`mobile/src/theme/colors.ts:102-152`; `mobile/src/components/auth/auth-shell.tsx:74-115`). |
| P0 | Canonical display name/ARIA in Wordmark and web metadata (`web/src/components/icons/BrandMark.tsx:51-62`; `web/src/app/layout.tsx:8-17`). | `mobile/app.json`, BrandLockup accessibility, About display copy. | Metadata/copy plus vector wordmark. | User-facing identity reads `spawnd`; technical `spawn://` and protocol identifiers remain untouched (`mobile/app.json:3-18`; `mobile/src/lib/linking.ts:1-4`). |
| P1 | `web/public/brand/spawnd-icon-black.svg` + `web/public/icon.svg` (`web/public/brand/spawnd-icon-black.svg:1-4`; `web/public/icon.svg:1-4`). | Replace `mobile/assets/images/adaptive-icon.png`; set adaptive background to `#E11E15`. | Transparent 1024 PNG foreground + core Expo adaptive background. | Android installed icon respects system masks; no opaque square nested inside a mask (`mobile/app.json:20-26`). |
| P1 | `web/public/brand/spawnd-icon.svg` and `void` (`web/public/brand/spawnd-icon.svg:1-7`; `web/src/app/globals.css:94-105`). | Keep `mobile/assets/images/splash.png`; change existing splash backgrounds in `mobile/app.json`. | Existing 1024 RGBA PNG on fixed black. | Launch brand is red ink on void, not a non-token beige/near-black pair (`mobile/app.json:30-43`). |
| P1 | Web Lucide/status map (`web/src/components/terminal/ConnectionChip.tsx:25-50`; `web/src/components/terminal/ConnectingOverlay.tsx:62-123`; `web/src/app/legion/page.tsx:62-75`). | Existing native connection/Legion components and Icon registry. | `lucide-react-native`, already installed. | Trust, connection stage, and live-metrics states use the same named glyphs (`mobile/src/components/terminal-ui/connection-status.tsx:96-140`; `mobile/src/components/hosts/legion-screen.tsx:65-70`; `mobile/src/components/ui/icon.tsx:170-217`). |
| P1 | Web `hostTone`, AgentChip, and capacity bar (`web/src/lib/legion.ts:75-89`; `web/src/components/legion/legion-parts.tsx:17-90`; `web/src/components/legion/legion-parts.tsx:129-213`). | Existing native Legion card/status/capacity components. | StyleSheet + shared AgentIcon; no image files. | Quiet online hosts are idle, active hosts pulse, running marks are scannable, capacity colors signal free/tight/full (`mobile/src/components/hosts/legion-host-card.tsx:94-143`; `mobile/src/components/hosts/capacity-meter.tsx:7-68`). |
| P2 | Existing bundled IBM Plex/Rowdies (`mobile/assets/fonts/IBMPlexSans-Regular.ttf:1`; `mobile/assets/fonts/IBMPlexSans-Medium.ttf:1`; `mobile/assets/fonts/Rowdies-Light.ttf:1`, binary headers). | Keep current files and family map. | TTF via existing runtime `useFonts`. | Audit that only grimoire prose/poster roles opt in; do not set Plex globally (`mobile/src/lib/providers.tsx:69-76`; `mobile/src/theme/typography.ts:3-12`; `mobile/src/theme/typography.ts:85-116`). |
| Defer | Remaining landing PNG/MP4 plates and `og.jpg` (`web/src/app/page.tsx:214-243`; `web/src/app/page.tsx:308-363`; `web/src/app/layout.tsx:18-32`). | None in current native product build. | Do not bundle. | Add only if a native marketing/about narrative is explicitly designed; the current app has no consumer. |
| Web-only | `favicon-48.png`, `icon-192.png`, `icon-512.png`, `manifest.webmanifest`, `sw.js` (`web/src/app/layout.tsx:39-46`; `web/public/manifest.webmanifest:1-25`; `web/public/sw.js:1-8`). | None. | Remain web/PWA assets. | Native launch assets use their existing 1024 masters/config instead (`mobile/app.json:3-43`). |

## 10. Definition of done for brand parity

1. The auth/launch journey shows the exact trident + drawn wordmark, fixed Pressroom palette, IBM Plex prose, Rowdies display, and altar backdrop; it contains no fabricated square or typed wordmark (`web/src/components/onboarding/auth-shell.tsx:53-74`; `web/src/components/onboarding/auth-shell.tsx:146-159`; `mobile/src/components/auth/auth-shell.tsx:54-70`).
2. The signed-in shell remains neutral/theme-aware, but every spawnd mark stays canonical hellfire and every third-party agent plate stays at its fixed literal colors (`web/src/app/globals.css:318-325`; `web/src/components/icons/BrandMark.tsx:39-49`; `web/src/components/icons/AgentIcon.tsx:25-34`).
3. Claude Code, Codex, OpenCode, Aider Sonnet, Shell, and unknown/custom identities render consistently in rows, headers, launch menus, settings, hosts, Legion, and alerts (`web/src/components/icons/AgentIcon.tsx:7-14`; `mobile/src/data/selectors/agent.ts:14-22`).
4. OS/arch/GPU stay text; `Server`, semantic dots, trust shields, connection-stage glyphs, and capacity tones—not invented vendor marks—carry system state (`web/src/app/hosts/[id]/page.tsx:358-374`; `web/src/components/terminal/ConnectingOverlay.tsx:62-123`; `web/src/components/legion/legion-parts.tsx:17-90`).
5. No new dependency, custom native module, or rebuilding config plugin is introduced; every runtime asset path works in Expo Go on SDK 54 (`mobile/package.json:32-65`).
