# P2-05 — The terminal overlay screen

**Phase 2, parallel with nine other agents. This is the screen the product lives or dies on.**

**Read first:** `00-OVERVIEW.md` (§3 D3, §5, §7.2, §7.4, §7.5, §8), then
`research/09-native-terminal-ux.md` **in full**, then `research/04-terminal-transport.md §7`
(connection states) and `research/11 §TL;DR 6-7` (session uploads).

## 1. Objective

> "When opening the terminal overlay page we need to make sure it works well on mobile… scroll
> needs to feel nice, typing needs to feel nice, we need nice shortcuts, nice keyboard
> interactions."

You own the screen. `P1-09` owns the emulator and transport beneath it — you consume
`TerminalSurface` (`00-OVERVIEW.md §7.5`) and `SessionTransport` (§7.4) and build everything the
user actually touches.

## 2. Files you own

```
src/app/terminal/[sessionId].tsx
src/components/terminal-ui/**
src/data/queries/terminal.ts
```

Do **not** touch `src/terminal/**` — that is `P1-09`'s.

## 3. Specification

### 3.1 Presentation and dismissal

A **full-screen, drag-down-dismissable overlay** — a `card`-presentation route, not
`fullScreenModal` (`00-OVERVIEW.md §3 D7`; `fullScreenModal` cannot be gesture-dismissed).

Use `P1-02`'s `SwipeDismissOverlay` with **`dragHandleRegion='header'`**. This is critical:
inside the terminal, a one-finger vertical drag belongs to the **scrollback**
(`research/09 §TL;DR 8`). Only the header/top edge may start a dismissal. Getting this wrong makes
the terminal unusable, so verify the gesture wiring carefully.

`haptics.overlayOpen()` on present; the overlay fires the dismissal haptic at threshold.

### 3.2 Chrome

- **Header**: session name (editable), agent logo/type, host, a connection chip driven by
  `SessionTransport.state`, and an actions menu (rename, restart, kill, upload, search, font size,
  copy mode, diagnostics).
- **Connection states**: every state in §7.4 gets an honest presentation — connecting, reconnecting
  with a reason, failed with a retry, closed. `research/04 §7` documents the state machine. Never
  show a blank terminal with no explanation.
- **Jump-to-latest pill**: appears when the user has scrolled away from the bottom; tapping returns
  to the end and re-enables follow. Drive it from `TerminalSurface`'s scroll state — **never yank a
  reader who has scrolled away** (`research/09 §TL;DR 8`).
- **Upload progress**: use `P1-09`'s pure upload state machine for the bar's behaviour (≥4%,
  420ms visible, complete-on-settle, 200ms fade).

### 3.3 Input — the part that must feel right

- **xterm's hidden textarea owns raw input, IME, dictation and hardware keys**
  (`research/09 §TL;DR 5`). A native `TextInput` is only the visible composer/fallback — do not
  reimplement key handling natively and do not fight the WebView for focus.
- **Modifier bar**: a persistent row above the keyboard. Keys per `research/09 §TL;DR 6` — web
  parity keys first, then momentary **and locked** Ctrl/Alt, symbols (`|`, `/`, `-`, `~`),
  navigation (arrows, Home/End, PgUp/PgDn), job control (Ctrl-C/D/Z/L/R), and a secondary sheet for
  F-keys. Every key sends bytes via `P1-09`'s `encodeKey` — **do not hand-roll escape sequences**.
- Momentary vs locked modifiers: tap = next-key-only, double-tap or long-press = locked, with
  clear visual state. `haptics.selection()` on modifier toggle.
- **Keyboard transitions** via `react-native-keyboard-controller`: the bar and terminal track the
  keyboard's animation frame-for-frame, not a jumpy `KeyboardAvoidingView`.
- **Never refit terminal rows during the keyboard animation** (`research/09 §TL;DR 7`) — debounce
  the fit until the transition settles. This is the difference between "smooth" and "broken".
- Safe areas and the home indicator handled; landscape supported.
- Dismiss the keyboard by dragging down on the terminal body only when already at the bottom, or
  via an explicit control — never in a way that competes with scrollback.

### 3.4 Selection, copy, search

- Long-press enters selection; provide a native selection toolbar with Copy
  (`TerminalSurface.copySelection()` → `expo-clipboard`).
- Paste sends through the transport, chunked — `P1-09`'s `write()` enforces the 64 KiB frame cap,
  but present progress for a large paste rather than freezing.
- Search UI drives `TerminalSurface.search()`; note the web app has no search, so this is a
  deliberate native addition (`research/09 §TL;DR 4`) — keep it simple.

### 3.5 Font size and theme

Pinch-to-zoom or a stepper for font size, persisted per user in `P1-08`'s `session-ui` store;
theme follows the app theme and applies without reconnecting.

## 4. Rules specific to you

- All bytes go through `SessionTransport`. No direct WebView access, no bridge messages, no
  `RTCPeerConnection`.
- Haptics: `success()` when the session reaches ready, `error()` on unexpected disconnect.
- `expo-keep-awake` while a terminal is foregrounded and connected — release it on blur.

## 5. Tests

- Modifier-bar key presses call `encodeKey` with the right `KeySpec` and forward the result to the
  transport (mock both).
- Momentary vs locked modifier state machine as a **pure unit** — this is subtle; test it hard.
- Follow/auto-scroll state machine as a pure unit: scrolled-away suppresses auto-scroll,
  jump-to-latest restores it.
- Connection-state rendering: one case per `TransportState`.
- Keyboard-transition fit debounce (fake timers) — assert no refit during the transition.
- Upload progress rendering from the state machine.
- Dismissal is only startable from the header region (assert the `dragHandleRegion` prop).

## 6. Deliverables checklist
- [ ] Card-presentation overlay, header-only drag dismissal
- [ ] Full chrome: header, connection chip, actions, jump-to-latest, upload bar
- [ ] Modifier bar with momentary/locked modifiers and an F-key sheet, all via `encodeKey`
- [ ] Keyboard-controller driven transitions, no refit during animation
- [ ] Selection/copy/paste/search
- [ ] Font size + theme without reconnect
- [ ] Keep-awake while connected
- [ ] Tests green; `typecheck`, `lint` clean; progress + report written

## 7. Reporting
Progress `docs/native/progress/P2-05.md` — update often. Report `docs/native/reports/P2-05.md`,
including the modifier-bar key list as shipped and what still needs device verification.
