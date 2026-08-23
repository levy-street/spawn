# F-02 — Keep the terminal in-app, and make the overlay swipe from anywhere

**Fix batch, parallel with five other agents.** Two of the owner's most visible complaints.

**Read first:** `00-OVERVIEW.md` §3 D3, then
`docs/native/research2/14-navigation-and-behaviour.md` §1 and §2 — they contain the diagnosed root
cause and the recommended gesture model.

## 1. The bugs

> "when opening a terminal it opens my browser and goes to 'spawn.local' instead of opening it in app"

**Root cause, from `research2/14 §TL;DR 1`:** `originWhitelist={["https://spawn.local/*"]}` is
matched against the **origin** `https://spawn.local` — with no trailing slash or path — so the
`/*` pattern never matches, the navigation is treated as outside the whitelist, and RN WebView
hands the URL to the OS. `navigationAllowed` never even runs.

> "the overlay swipe is good but i should be able to swipe anywhere on the overlay not just the left edge"

## 2. Files you own

```
mobile/src/terminal/TerminalSurface.tsx
mobile/src/terminal/HostTransportSurface.tsx
mobile/src/terminal/worker/**
mobile/assets/terminal/**
mobile/src/components/terminal-ui/**
mobile/src/app/terminal/[sessionId].tsx
```

## 3. Fix 1 — containment

Per `research2/14 §TL;DR 2`: keep the inline worker and the synthetic HTTPS base, but set
**`originWhitelist={["*"]}`** so every navigation reaches `onShouldStartLoadWithRequest`, and make
that callback a **strict allowlist** that permits only the bootstrap document and cancels
everything else in-app.

Also, per §TL;DR 4, add `onOpenWindow` and keep `allowsLinkPreview={false}` and
`setSupportMultipleWindows={false}` to close `_blank` escape paths. `research2/14 §TL;DR 3`
confirms `loadHTMLString:baseURL:` does not perform a network GET to `spawn.local`, so allowing
that initial navigation is correct and does not need the origin to resolve.

Apply the same treatment to `HostTransportSurface.tsx`, which has the identical pattern.

A terminal link the user taps should open in the system browser **deliberately** via
`Linking.openURL` from the bridge — not by letting the WebView navigate. Check the worker's link
handling (`research2/14 §TL;DR 5` says xterm links already use the bridge callback) and make sure
the RN side opens them explicitly.

## 4. Fix 2 — dismissal from anywhere

`research2/14 §TL;DR 6-7`: the overlay is a React Native `Modal` with a **header-only vertical
pan**, and the native-stack full-screen gesture is currently overridden off.

A one-finger **downward** swipe from anywhere cannot coexist with terminal-owned vertical
scrollback — that constraint stands (`research/09 §TL;DR 8`). So implement the recommendation:
**a rightward, axis-locked swipe recognised from anywhere on the overlay**, with vertical drags
still going to xterm.

Requirements:
- axis lock: once the gesture commits to horizontal, it owns the interaction; a vertical drag never
  starts a dismissal;
- rubber-banding and velocity-aware commit — reuse `@/components/gestures/drag-threshold`
  (`shouldCommitDrag`, `restingOffset`), do not write new threshold maths;
- `haptics.overlayDismiss()` at the commit threshold, while the finger is still down;
- keep the existing header drag as an additional affordance;
- the WebView consumes touches, so the recogniser must sit above it and use the gesture-handler
  APIs that still let taps and vertical scrolls through. State how you achieved this in your report.

## 5. Tests

- `onShouldStartLoadWithRequest` allowlist: the bootstrap document is allowed; an external URL, a
  `_blank` target and an arbitrary origin are all rejected. Table-driven.
- `originWhitelist` is `["*"]` so the callback is authoritative (assert the prop).
- The axis-lock decision as a **pure function**: horizontal intent commits, vertical intent does
  not, diagonal resolves per the documented rule.
- Dismissal fires exactly one haptic at threshold.
- Existing terminal suites still pass unchanged.

## 6. Deliverables
- [ ] Terminal and host WebViews cannot navigate the OS browser
- [ ] Links open deliberately through `Linking.openURL`
- [ ] Rightward axis-locked dismissal from anywhere, vertical still scrolls xterm
- [ ] Reuses `drag-threshold`; one haptic at commit
- [ ] `typecheck`, `lint`, `test` clean for your files
- [ ] Progress `docs/native/progress/F-02.md`; report `docs/native/reports/F-02.md`
