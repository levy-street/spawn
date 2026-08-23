# F-04 — Brand and identity parity

**Fix batch, parallel with five other agents.**

**Read first:** `docs/native/research2/15-brand-parity.md` in full — it is your specification and
contains the complete asset inventory and the Pressroom contrast rules.

## 1. What the owner asked for

> "some of the logos and branding isnt right, we need to make sure the branding comes all the way
> through, please check the web app"

## 2. Files you own

```
mobile/src/components/brand/**          # new: BrandMark, Wordmark
mobile/src/components/auth/auth-shell.tsx
mobile/src/components/workspace-detail/agent-icon.tsx
mobile/src/components/ui/monogram.tsx
mobile/assets/images/**
mobile/app.json                          # icon/splash/adaptive config only
```

Plus the **minimum** edits needed to swap a generic icon for the real `AgentIcon` at the call sites
`research2/15 §6` lists (terminal headers, launch choices, host sessions, settings, Legion,
alerts). Change only the icon usage in those files — nothing else. Record each edited line in your
report.

## 3. What to fix

1. **The auth lockup is fabricated.** `auth-shell.tsx:54-70,146-159,226-231` draws a cut-corner
   square and sets `SPAWN` in SF Mono. The real identity is a **wet-ink trident plus a drawn
   `spawnd` wordmark** (`web/src/components/icons/BrandMark.tsx:4-62`). Build reusable
   `BrandMark` and `Wordmark` components with `react-native-svg` (installed) and use them.
2. **Auth never enters the web's `grimoire pressroom` context**, so it renders in the ordinary app
   palette (`research2/13 §TL;DR 2`, `research2/15 §TL;DR 4`). The Pressroom values are already
   transcribed correctly in `mobile/src/theme/colors.ts:102-152` — wire the auth surface to them.
3. **Honour the Pressroom contrast rules as contractual** (`research2/15 §TL;DR 3`):
   `hellfire` for marks and lines, `ember` for small red text on black, `plate` only for red
   grounds carrying black text. Do not improvise brand colour usage.
4. **Agent marks lost their identity**: native replaced every fixed brand plate and the Codex
   gradient with theme colours (`research2/15 §TL;DR 5`). Restore the fixed plates and the
   gradient. All five web marks are inline 24×24 SVGs — port them faithfully.
5. **Agent marks are missing in most places** (`research2/15 §TL;DR 6`). Use the real `AgentIcon`
   at the listed call sites instead of generic `Bot`/event icons.
6. **Host/OS iconography**: `research2/15 §TL;DR 7` — the web app uses **text**, not vendor logos,
   for OS/arch/GPU, with `Server`, semantic dots, trust shields and connection-stage icons carrying
   state. Match that; do not add vendor logos the web app does not use.
7. **Packaging**: fix the opaque adaptive foreground (currently identical to `icon.png`) and the
   non-token light splash ground (`research2/15 §TL;DR 9`, `mobile/app.json:20-42`).
8. **Fonts**: Plex/Rowdies are bundled and loaded correctly. Ordinary app styles stay system sans
   **by design** — only branded prose/display roles opt into Plex/Rowdies
   (`research2/15 §TL;DR 8`). Do not restyle the whole app into Plex.

No new dependencies: `react-native-svg` and `expo-image` are installed.

## 4. Tests
- `BrandMark` and `Wordmark` render at requested sizes and accept a colour.
- Each agent kind renders its own mark; an unknown kind falls back to the monogram.
- The Codex gradient and fixed plates are present (assert the SVG props, not a bitmap).
- Auth shell uses Pressroom tokens, not theme background.

## 5. Deliverables
- [ ] Real trident + wordmark components, used by auth
- [ ] Auth on the Pressroom palette, honouring the contrast rules
- [ ] Agent marks restored with plates and gradient, and used everywhere they were missing
- [ ] OS/GPU stay textual, matching web
- [ ] Adaptive icon and splash corrected
- [ ] `typecheck`, `lint`, `test` clean for your files
- [ ] Progress `docs/native/progress/F-04.md`; report `docs/native/reports/F-04.md`
