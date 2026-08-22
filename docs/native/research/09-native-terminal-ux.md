# R09 — Native terminal rendering, input, and mobile keyboard UX

- **TL;DR 1/10:** Render the terminal with offline-bundled xterm.js inside one `react-native-webview`; keep the overlay chrome, modifier bar, clipboard, haptics, gestures, and state native.
- **TL;DR 2/10:** Expo Go includes `react-native-webview` 13.16.1; use `npx expo install`, not registry-latest 14.0.1, because Expo Go fixes the native binary version.
- **TL;DR 3/10:** Match web's xterm 5.5 configuration first: Unicode 11, 13 px/1.2 line height, 100,000-line scrollback, WebGL with DOM fallback, Fit, WebLinks, Clipboard, and Serialize.
- **TL;DR 4/10:** The web app has no Search addon and never calls Serialize; native search is a deliberate addition, while serialization should remain an internal recovery hook.
- **TL;DR 5/10:** Let xterm's hidden HTML textarea own raw input, IME, dictation, and hardware-key events; a native `TextInput` is only the visible multiline composer/fallback.
- **TL;DR 6/10:** Preserve web parity keys exactly, then add momentary/locked Ctrl and Alt, symbols, navigation, job-control shortcuts, and a secondary F-key sheet through one tested byte encoder.
- **TL;DR 7/10:** Use `react-native-keyboard-controller` 1.21.9 from Expo Go for a native sticky accessory transition; never refit terminal rows during soft-keyboard animation.
- **TL;DR 8/10:** Terminal scrollback owns vertical one-finger drags; overlay dismissal starts only from its header/edge, and output never yanks a reader who has scrolled away.
- **TL;DR 9/10:** Batch RN→WebView output for at most 8 ms or 32 KiB, permit one xterm write in flight, cap queued bytes at 4 MiB, and recover overflow from an authoritative replay rather than dropping bytes mid-VT stream.
- **TL;DR 10/10:** Require 60 fps UI, a measured 1 MiB/s sustained acceptance target, and device-free reducer/table/buffer/snapshot tests; real iPhone flood, IME, selection, and WebGL limits remain release-gate measurements.

## Scope and decision

This report owns terminal rendering and user input after another layer supplies ordered PTY bytes
and accepts ordered input bytes. Transport negotiation, encryption, and DataChannel lifecycle are
out of scope except where renderer recovery needs a replay request.

The repository confirms that terminal bytes, replay, viewport control, and file transfers travel
directly between browser and daemon; the server WebSocket carries signaling and disclosed control
data, not terminal content (`README.md:42-45`). Offline history is intentionally unavailable and
the server stores no transcript (`README.md:229-230`). Therefore a mobile renderer must treat a
live worker replay/checkpoint—not server persistence—as its recovery source.

**RECOMMEND:** Build a native terminal overlay around a single offline xterm.js WebView. It is the
only option investigated that combines Expo Go support, the web implementation's exact emulator,
full-screen TUI fidelity, IME support, true color, alternate screen, mouse modes, selection, and a
credible implementation schedule.

**RECOMMEND:** Keep every non-grid surface native: overlay header, connection state, modifier bar,
keyboard accessory, jump-to-latest pill, upload state, selection toolbar, accessibility labels,
haptics, and swipe dismissal. This is not a web wrapper; it is one embedded terminal engine behind
a stable native component boundary.

Fallback: use the same WebView with xterm's DOM renderer if WebGL is unstable or lost. Do not fall
back to a `<Text>` log renderer for an interactive session; that would silently break VT semantics.

## Research date and verified package matrix

Network checks were made on 2026-08-22. “Registry latest” is informational; Expo Go compatibility
is determined by the native version built into the current Expo Go client.

| Package | Registry latest | Expo SDK 57 / Expo Go version | Expo Go | Decision |
|---|---:|---:|---|---|
| `react-native-webview` | 14.0.1 | 13.16.1 | Yes | Use 13.16.1 via Expo install |
| `@xterm/xterm` | 6.0.0 | JS-only | Yes, inside WebView | Begin with repo's `^5.5.0` |
| `@xterm/headless` | 6.0.0 | JS-only but Node-targeted | Unsupported runtime | Tests/research only |
| `@xterm/addon-search` | 0.16.0 | JS-only | Yes, inside WebView | Optional new feature; compatibility-gate |
| `@shopify/react-native-skia` | 2.11.0 | 2.6.2 | Yes | Not needed for v1 |
| `react-native-keyboard-controller` | 1.22.4 | 1.21.9 | Yes | Use 1.21.9 |
| `expo-clipboard` | 57.0.1 | 57.0.1 | Yes | Use |
| `expo-haptics` | 57.0.1 | 57.0.1 | Yes | Use |
| `expo-font` | 57.0.1 | 57.0.1 | Yes | Optional; no terminal font needed on iPhone |
| `expo-asset` | 57.0.13 | 57.0.13 | Yes | Offline asset packaging if required |
| `ghostty-web` | 0.4.0 | JS/WASM | Likely inside WebView | Prototype fallback only |
| `@wterm/core`, `@wterm/dom`, `@wterm/ghostty` | 0.3.4 | JS/WASM | Likely inside WebView | Watch, do not ship first |

Expo's current documentation explicitly says WebView is included in Expo Go and recommends
13.16.1 ([Expo WebView](https://docs.expo.dev/versions/latest/sdk/webview/)). The registry's 14.0.1
cannot be substituted into Expo Go because it contains native code.

Expo likewise lists keyboard-controller 1.21.9 as included
([Expo keyboard controller](https://docs.expo.dev/versions/latest/sdk/keyboard-controller/)) and
Skia 2.6.2 as included ([Expo Skia](https://docs.expo.dev/versions/latest/sdk/skia/)).

**RECOMMEND:** For all Expo-native dependencies run `npx expo install <package>` in the eventual
mobile project. Do not pin registry-latest values from this table against Expo Go.

The web app currently declares xterm `^5.5.0` and addon versions Clipboard 0.2, Fit 0.11,
Serialize 0.14, Unicode11 0.9, WebLinks 0.12, and WebGL 0.19
(`web/package.json:25-31`). Use this family for the first native parity build, despite xterm 6.0.0
being current, so emulator differences do not enter the mobile project accidentally.

**UNKNOWN:** Whether Expo Go will have advanced beyond SDK 57 when implementation begins. Resolve
by running `npx expo install --check` then recording the versions actually selected; do not use
the npm “latest” column as an Expo compatibility promise.

## 1. What the web terminal does today

### 1.1 Terminal core and exact options

The web terminal uses the browser xterm renderer, not a bespoke ANSI-to-HTML layer. Its emulator
options are shared with a headless conformance runner, making this file the compatibility baseline
(`web/src/components/terminal/xterm-config.mjs:1-14`).

Real configuration excerpt (`web/src/components/terminal/xterm-config.mjs:17-26`):

```js
export const TERMINAL_FONT_SIZE = 13;
export const TERMINAL_LINE_HEIGHT = 1.2;
export const TERMINAL_FONT_FAMILY =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';

export const TERMINAL_SCROLLBACK_LINES = 100_000;
export const TERMINAL_SNAPSHOT_LINES = 10_000;
```

Exact emulator options (`web/src/components/terminal/xterm-config.mjs:96-108`):

```js
export const XTERM_EMULATION_OPTIONS = Object.freeze({
  allowProposedApi: true,
  convertEol: false,
});
```

The comment explains why `convertEol` must remain false: raw PTY bytes already have real CR/LF
discipline (`web/src/components/terminal/xterm-config.mjs:97-107`). `allowProposedApi` is needed
for Unicode11 and conformance buffer inspection (`web/src/components/terminal/xterm-config.mjs:100-101`).

The live terminal adds (`web/src/components/terminal/Terminal.tsx:1461-1473`):

```ts
const term = new XTerm({
  ...XTERM_EMULATION_OPTIONS,
  cursorBlink: true,
  fontFamily: TERMINAL_FONT_FAMILY,
  fontSize: TERMINAL_FONT_SIZE,
  lineHeight: TERMINAL_LINE_HEIGHT,
  scrollback: TERMINAL_SCROLLBACK_LINES,
  scrollOnUserInput: true,
  smoothScrollDuration: 0,
  theme: { ...terminalTheme(getResolvedTheme()) },
});
```

Consequences for native parity:

- Cursor blinks.
- PTY line endings are not converted.
- Local history can reach 100,000 lines.
- Worker snapshot requests are capped at 10,000 lines.
- User input returns to the live edge.
- Renderer-native smooth scrolling is disabled; touch momentum is custom.
- Unicode cell widths come from Unicode 11, not xterm's old Unicode 6 defaults.

The Unicode11 addon is activated explicitly and the active width table is set to `"11"`
(`web/src/components/terminal/xterm-config.mjs:88-94`,
`web/src/components/terminal/xterm-config.mjs:110-120`). The stated reason is emoji width 2,
matching modern terminals rather than overlapping width-1 emoji.

### 1.2 Themes, exactly

Dark theme changes only the defaults; ANSI indices 0–15 remain xterm defaults
(`web/src/components/terminal/xterm-config.mjs:28-36`):

```json
{
  "background": "#0a0a0a",
  "foreground": "#e5e5e5",
  "cursor": "#e5e5e5"
}
```

Light theme replaces all 16 ANSI colors because xterm's dark-background defaults do not remain
legible on white (`web/src/components/terminal/xterm-config.mjs:38-47`). Exact values
(`web/src/components/terminal/xterm-config.mjs:49-81`):

```json
{
  "black": "#000000",
  "red": "#cd3131",
  "green": "#00bc00",
  "yellow": "#949800",
  "blue": "#0451a5",
  "magenta": "#bc05bc",
  "cyan": "#0598bc",
  "white": "#555555",
  "brightBlack": "#666666",
  "brightRed": "#cd3131",
  "brightGreen": "#14ce14",
  "brightYellow": "#b5ba00",
  "brightBlue": "#0451a5",
  "brightMagenta": "#bc05bc",
  "brightCyan": "#0598bc",
  "brightWhite": "#a5a5a5",
  "background": "#fcfcfc",
  "foreground": "#1f1f1f",
  "cursor": "#1f1f1f",
  "cursorAccent": "#fcfcfc",
  "selectionBackground": "#accef7",
  "selectionInactiveBackground": "#e1e6eb"
}
```

The web terminal subscribes to resolved-theme changes and mutates xterm options without rebuilding
the terminal (`web/src/components/terminal/Terminal.tsx:510-522`). Native should do the same by
sending a small `theme` command across the bridge.

### 1.3 Addons: loaded versus actually used

Imports are Clipboard, Fit, Serialize, Unicode11, WebLinks, WebGL, and xterm itself
(`web/src/components/terminal/Terminal.tsx:3-9`). Bootstrap loads all except WebGL before opening;
WebGL is attached afterward because it needs an opened element
(`web/src/components/terminal/Terminal.tsx:1475-1486`).

| Addon | Web behavior | Native requirement |
|---|---|---|
| `@xterm/addon-webgl` | GPU renderer for real users; DOM renderer for automation or fallback | Attempt after open; catch failure/context loss; preserve DOM fallback |
| `@xterm/addon-fit` | Fits cols/rows to container, sends geometry | Keep; call only after stable layout |
| `@xterm/addon-unicode11` | Width table 11, especially emoji width 2 | Keep exact table |
| `@xterm/addon-clipboard` | Handles terminal clipboard sequences such as OSC 52 | Keep; bridge provider to native clipboard |
| `@xterm/addon-web-links` | Detects/clicks OSC 8 and plain links | Keep; hand URL to native `Linking` after validation |
| `@xterm/addon-serialize` | Instantiated and retained | Keep optional; do not depend on it for authoritative history |
| Search addon | Not imported, loaded, or called | Native search is a new feature, not current parity |

Serialize is assigned to `serializeAddonRef` at
`web/src/components/terminal/Terminal.tsx:1477-1483`, but repository search finds no subsequent
read or serialization call; the declaration itself is at
`web/src/components/terminal/Terminal.tsx:556`. Do not claim user-visible serialization today.

The complete terminal-addon import list has no `SearchAddon`
(`web/src/components/terminal/Terminal.tsx:3-9`), and the component contains no `findNext` or
`findPrevious` call. The requested native surface should expose search so the implementation choice
is insulated, but this is an intentional mobile usability addition.

Registry-latest `@xterm/addon-search` is 0.16.0, JS-only, and therefore works inside Expo Go's
WebView in principle. It publishes no peer dependency declaring which xterm minor it accepts.
**UNKNOWN:** Verify it against pinned xterm 5.5 with the document tests before including it. If it
does not pass, leave the method behind the interface and defer visible search rather than upgrading
the emulator inside the mobile feature.

### 1.4 WebGL lifecycle and fallback

The web app gives WebGL only to the foreground terminal. Background/parked instances release the
GPU renderer, and foreground activation reclaims it (`web/src/components/terminal/Terminal.tsx:311-326`).
Initialization and context-loss handling catch failures and dispose the addon, leaving xterm's DOM
renderer in place (`web/src/components/terminal/Terminal.tsx:262-305`).

The preference logic is explicit: real users default to GPU; `navigator.webdriver` defaults to
DOM so E2E can inspect `.xterm-rows`; `localStorage.spawnRenderer` can force `gpu` or `dom`
(`web/src/components/terminal/Terminal.tsx:3706-3721`).

The upstream WebGL addon requires WebGL2 and instructs consumers to handle context loss by
disposing it ([xterm WebGL addon](https://github.com/xtermjs/xterm.js/tree/master/addons/addon-webgl)).
WKWebView support and memory depend on iOS/device; load failure is expected control flow, not a
fatal terminal error.

**RECOMMEND:** Mobile should preserve a remotely switchable/session-local “DOM renderer” escape
hatch. Do not make WebGL success a prerequisite for opening a terminal.

### 1.5 Output, replay, and exact-write behavior

The terminal accepts bytes as `Uint8Array` and writes those bytes directly to xterm. It keeps a
bounded recent-chunk ring for reconciling live DataChannel bytes on top of a replay
(`web/src/components/terminal/Terminal.tsx:1071-1141`).

The recent live replay cap is exactly 4 MiB
(`web/src/components/terminal/Terminal.tsx:77-82`). A separate bounded write buffer holds live bytes
that arrive while snapshot history is being reset/rendered.

That buffer's real semantics (`web/src/components/terminal/live-write-buffer.ts:24-45`):

```ts
constructor(private readonly maxBytes: number) {}

enqueue(bytes: Uint8Array, offsetAfter: number | undefined, geometry: LiveWriteGeometry) {
  if (this.overflowed) return;
  if (bytes.byteLength > this.maxBytes - this.byteLength) {
    this.writes.length = 0;
    this.byteLength = 0;
    this.overflowed = true;
    return;
  }
  this.writes.push({ bytes, offsetAfter: offsetAfter ?? null, geometry });
  this.byteLength += bytes.byteLength;
}
```

On drain, overflow means “refresh,” already-covered stream offsets are filtered, and any geometry
mismatch also means “refresh” (`web/src/components/terminal/live-write-buffer.ts:42-70`). This is
the correct model for native: never append bytes after an incompatible snapshot or width.

Snapshots do not use `term.reset()`. Web clears visible and scrollback cells with
`ESC[0m ESC[H ESC[2J ESC[3J` to retain terminal modes, then writes the replacement and returns to
bottom (`web/src/components/terminal/Terminal.tsx:629-690`). It also refuses to rewrite the active
alternate screen, where an application owns every cell.

Snapshot refresh timing is bounded: initial warm delay 1,200 ms; resize quiet period 350 ms;
request timeout 6,000 ms; anchored refresh debounce/max 350/2,500 ms; unanchored refresh debounce/max
5,000/20,000 ms (`web/src/components/terminal/Terminal.tsx:53-81`,
`web/src/components/terminal/Terminal.tsx:1354-1418`). Snapshot requests ask for 2,000 lines in the
unanchored case and 10,000 otherwise, with `plain:false`
(`web/src/components/terminal/Terminal.tsx:1354-1379`).

**RECOMMEND:** Reuse R04's offset and replay semantics unchanged. The rendering layer should report
`overflow` or `geometryMismatch`; the data layer decides when/how to request a worker replay.

### 1.6 Fit, resize, keyboard, and scroll anchoring

The current resize contract preserves either exact `viewportY` or the live bottom
(`web/src/components/terminal/Terminal.tsx:2212-2228`). Only a column change owes a history reseed;
a rows-only mobile-keyboard change does not (`web/src/components/terminal/Terminal.tsx:2230-2258`).
The ResizeObserver fit is debounced 80 ms (`web/src/components/terminal/Terminal.tsx:2328-2341`).

Soft-keyboard behavior is deliberate. A visual-viewport inset over 120 px on a coarse pointer is
treated as keyboard, then terminal geometry is frozen and the taller surface is panned so the live
line remains visible (`web/src/components/terminal/Terminal.tsx:61-65`,
`web/src/components/terminal/Terminal.tsx:1545-1576`). The code explicitly avoids refitting because
that rewraps history and churns PTY geometry (`web/src/components/terminal/Terminal.tsx:2260-2276`).

**RECOMMEND:** Preserve this invariant in native: keyboard height may change the viewport mask and
pan offset, but never the PTY `cols × rows` until the keyboard animation has fully ended. If width
did not change, do not reseed.

The app listens to device-pixel-ratio changes, clears WebGL's glyph atlas, and refits; it also
refits after `document.fonts.ready` and visibility changes
(`web/src/components/terminal/Terminal.tsx:2355-2393`). Mobile WebView should clear/re-fit after
orientation, display-scale, font-size, and renderer-context changes.

### 1.7 Web touch scrolling

The web surface disables browser touch actions and routes each drag exactly once: to terminal
history or the containing page (`web/src/components/terminal/Terminal.tsx:99-111`). An alternate
screen has no scrollback, so an unusable vertical drag is handed to the pane stack.

Touch constants are exact (`web/src/components/terminal/Terminal.tsx:86-92`):

```ts
sampleWindow = 120ms
velocityBoost = 1.25
maximumVelocity = 4 px/ms
momentumStartThreshold = 0.08 px/ms
momentumStopThreshold = 0.02 px/ms
decayTimeConstant = 450ms
tapSlop = 8px
```

Momentum is frame-driven, `dt` is clamped to 32 ms, velocity decays exponentially, and the
viewport snaps to row boundaries when motion stops
(`web/src/components/terminal/Terminal.tsx:1908-1937`,
`web/src/components/terminal/Terminal.tsx:1981-2013`). A tap focuses; a scroll gesture does not
(`web/src/components/terminal/Terminal.tsx:1981-1991`,
`web/src/components/terminal/Terminal.tsx:2141-2148`).

The live-edge state is observed from both xterm `onScroll` and the DOM viewport because both paths
are needed across renderers (`web/src/components/terminal/Terminal.tsx:1489-1512`).

### 1.8 Input path and custom key behavior

All pooled terminals currently mount in raw mode with `mobileReturnMode="newline"`, a configured
mobile newline sequence, bracketed image paths, and automatic control acquisition when active
(`web/src/components/terminal/LiveTerminalProvider.tsx:212-225`).

xterm's `onData` is encoded with `TextEncoder` and sent as binary. Before sending, web strips
terminal Device Attributes replies, rewrites coarse-pointer Return, appends pending attachment
paths on submit, and optionally records predictive echo
(`web/src/components/terminal/Terminal.tsx:2712-2759`). Device Attribute responses of form
`ESC [ ? … c` or `ESC [ > … c` are filtered
(`web/src/components/terminal/Terminal.tsx:3925-3945`).

The only keyboard override outside xterm's own encoder is Return:

- `Shift+Enter` sends literal `ESC CR`, bytes `1B 0D`.
- Every event for that press is suppressed so xterm cannot send a second plain CR.
- Mobile plain Return in newline mode sends the configured newline sequence.
- The modifier-bar Send remains plain CR.

This logic and rationale are at `web/src/components/terminal/Terminal.tsx:2150-2172`. Web also
intercepts `beforeinput` types `insertLineBreak`/`insertParagraph` and cleans newlines from xterm's
helper textarea to avoid duplicate virtual-keyboard sends
(`web/src/components/terminal/Terminal.tsx:2028-2040`).

The active provider's mobile prompt newline is exactly
`ESC [ 2 0 0 ~ LF ESC [ 2 0 1 ~`, string `"\x1b[200~\n\x1b[201~"`, hex
`1B 5B 32 30 30 7E 0A 1B 5B 32 30 31 7E`
(`web/src/components/terminal/LiveTerminalProvider.tsx:18-19`). It is a bracketed-paste-wrapped
literal newline for multiline agent prompts. The provider passes that override at
`web/src/components/terminal/LiveTerminalProvider.tsx:217-220`. `Terminal`'s generic fallback is
`ESC CR` (`web/src/components/terminal/Terminal.tsx:93-95`,
`web/src/components/terminal/Terminal.tsx:228-234`), but that fallback is not what active pooled
terminals use. The accessory Send remains plain CR.

Predictive echo is opt-in through `localStorage.spawnPredictEcho = "on"`; it runs only for pristine
printable keystrokes against a settled buffer and is intended for high RTT
(`web/src/components/terminal/Terminal.tsx:2733-2757`). It draws provisional characters in an
overlay with 75% opacity and dotted underline (`web/src/components/terminal/Terminal.tsx:3142-3159`).

**RECOMMEND:** Do not implement predictive echo in mobile v1. Keep it behind the surface interface
and add only after byte-for-byte correctness and RTT measurement; incorrect local cursor prediction
is worse than visible latency.

### 1.9 Modifier bar: every current control and literal bytes

The web bar contract accepts raw `Uint8Array|string`, paste handlers, and submit
(`web/src/components/terminal/ModifierBar.tsx:14-22`). Its current exact key table
(`web/src/components/terminal/ModifierBar.tsx:30-49`) is:

| Visible control | Literal sequence | Hex | Meaning |
|---|---|---|---|
| Paste | Calls paste path | — | Native/browser clipboard |
| Esc | `\x1b` | `1B` | Escape |
| Tab | `\t` | `09` | Horizontal tab |
| ⇧Tab | `\x1b[Z` | `1B 5B 5A` | Back-tab |
| ^C | `\x03` | `03` | SIGINT character |
| ↑ | `\x1b[A` | `1B 5B 41` | Cursor up |
| ↓ | `\x1b[B` | `1B 5B 42` | Cursor down |
| ← | `\x1b[D` | `1B 5B 44` | Cursor left |
| → | `\x1b[C` | `1B 5B 43` | Cursor right |
| Send | `\r` | `0D` | Submit/Enter |

Soft-keyboard Return is not a modifier-bar control, but its active mobile mapping must be kept next
to this table: `"\x1b[200~\n\x1b[201~"` / hex
`1B 5B 32 30 30 7E 0A 1B 5B 32 30 31 7E`. That differs intentionally from Send's `0D`
(`web/src/components/terminal/LiveTerminalProvider.tsx:18-19`,
`web/src/components/terminal/ModifierBar.tsx:41-49`).

The scrollable key group is left of a pinned primary Send button
(`web/src/components/terminal/ModifierBar.tsx:60-83`). Pointer-down prevents default and buttons
have `tabIndex=-1` so pressing a key does not steal xterm textarea focus
(`web/src/components/terminal/ModifierBar.tsx:155-181`). Web keys are 36 px tall/minimum wide;
native must increase the interactive hit target to at least 44×44 pt while preserving visual size.

The Paste control is a visually hidden textarea with `autoCapitalize="off"`,
`autoCorrect="off"`, `inputMode="none"`, and `spellCheck={false}`; it handles native paste events,
manual input fallback, or Clipboard API click (`web/src/components/terminal/ModifierBar.tsx:87-153`).

The modifier bar is only shown for coarse pointers. It sends to the currently focused terminal,
then refocuses on the next animation frame (`web/src/components/session/session-view.tsx:334-347`,
`web/src/components/workspace/workspace-grid.tsx:1843-1865`).

The older `Composer.tsx` defines a two-row visible editor, raw/composer toggle, and primary Send;
Enter sends, Shift+Enter inserts newline, and the comment warns mobile IMEs often swallow Enter
(`web/src/components/terminal/Composer.tsx:17-35`,
`web/src/components/terminal/Composer.tsx:38-72`). No current import of this component was found;
the active provider uses raw input. Treat Composer as behavior reference, not proof of current UI.

### 1.10 Paste, selection, copy, and links

Web paste checks clipboard images first, uploads them, otherwise reads text and calls
`term.paste(text)`—not raw `onData`—so xterm can honor bracketed-paste mode
(`web/src/components/terminal/Terminal.tsx:2629-2697`). Image paste can produce an attachment path
wrapped with literal `ESC[200~` and `ESC[201~`
(`web/src/components/terminal/Terminal.tsx:93-95`,
`web/src/components/terminal/Terminal.tsx:3965-3967`).

Mouse selection is copied automatically on mouse-up with `term.getSelection()` and
`navigator.clipboard.writeText` (`web/src/components/terminal/Terminal.tsx:2176-2181`). WebLinks
supports clickable terminal links. Automated coverage specifically checks OSC 8 links do not leak
their URL into visible text (`web/tests/e2e/terminal.spec.ts:1366-1437`).

The same test region covers Unicode emoji width, cursor-shape sequences, and OSC 52 clipboard,
so native parity cannot be reduced to colored text.

### 1.11 Reader-follow behavior

Output pins only when the reader was already at the live edge. If the reader is away, it stays
away and records new output (`web/src/components/terminal/Terminal.tsx:1071-1141`). The jump button
appears only while away; when new output exists it expands to “New” with a success dot
(`web/src/components/terminal/Terminal.tsx:3302-3325`). Any direct input/control action snaps to
the live edge (`web/src/components/terminal/Terminal.tsx:824-863`,
`web/src/components/terminal/Terminal.tsx:2774-2796`).

Tests assert a mobile history drag is not yanked to bottom, live output does not duplicate, and an
unscrollable/alternate terminal hands drag to the pane stack
(`web/tests/e2e/terminal.spec.ts:1244-1342`).

### 1.12 Connection, viewer, upload, and exit controls on the terminal screen

The connection model contains socket state, protocol-v3 flag, DataChannel-open flag, optional
signed-RTC refusal, trust decision, transport kind/protocol, and RTT
(`web/src/components/terminal/ConnectionChip.tsx:13-23`). Visible states are blocked, offline,
connecting, channel negotiation, direct, P2P/STUN, and relay; relay is warning-colored and RTT is
shown when known (`web/src/components/terminal/ConnectionChip.tsx:70-109`). Details include
security, path, round trip, transport, channel, and protocol
(`web/src/components/terminal/ConnectionChip.tsx:139-155`).

The initial empty terminal has a delayed connecting overlay: enter delay 240 ms, leave 260 ms,
secured hold 420 ms, and “slow” threshold 8 seconds
(`web/src/components/terminal/ConnectingOverlay.tsx:10-20`). It has blocked, host-offline, dropped,
reaching, securing, and secured states (`web/src/components/terminal/ConnectingOverlay.tsx:22-52`).
Once the first terminal content has painted, it clears permanently for that mount, so reconnects
do not obscure retained output (`web/src/components/terminal/ConnectingOverlay.tsx:127-136`).

When another viewer owns geometry/input, web dims the terminal and places “Take control” over it,
including `cols×rows` and viewer count (`web/src/components/terminal/Terminal.tsx:3281-3300`).

Uploads show a 2 px hairline that never affects layout or pointer input. It remains at least 420 ms,
fades over 200 ms, and never draws less than 4% progress
(`web/src/components/terminal/upload-progress-bar.tsx:6-21`). Pending/failed image attachments have
56 px chips with remove buttons (`web/src/components/terminal/Terminal.tsx:3224-3263`).

On session exit, xterm receives a yellow ANSI banner with exit code/signal
(`web/src/components/terminal/Terminal.tsx:1300-1307`). Parent session chrome exposes restart and
close/remove actions (`web/src/components/session/session-view.tsx:311-332`).

For completeness, terminal-adjacent session controls differ slightly by context:

| Context | Controls exposed today | Source |
|---|---|---|
| Workspace pane header | Drag pane from non-control header space; agent switcher/status; inline rename | `web/src/components/workspace/session-pane.tsx:304-370` |
| Workspace pane machine | Change host when multiple hosts exist; offline hosts disabled | `web/src/components/workspace/session-pane.tsx:372-405` |
| Workspace pane directory | Open folder picker; choosing a folder sends the shell a `cd` | `web/src/components/workspace/session-pane.tsx:407-426` |
| Workspace pane options | Open full screen, Rename, Restart, Duplicate, Mute/Unmute alerts | `web/src/components/workspace/session-pane.tsx:428-480` |
| Stacked pane options | Move up, Move down | `web/src/components/workspace/session-pane.tsx:481-493` |
| Workspace pane close | Separate close menu, then Close session | `web/src/components/workspace/session-pane.tsx:495-523` |
| Exited workspace pane | Exit code/status, Restart, Close | `web/src/components/workspace/session-pane.tsx:526-560` |
| Full-screen header | Back, agent switcher, session name/status, host and cwd, Toggle files | `web/src/components/session/session-view.tsx:202-256` |
| Full-screen options | Rename, Restart, Remove from workspace when applicable, Close session | `web/src/components/session/session-view.tsx:257-299` |
| Full-screen exit overlay | Restart, Close | `web/src/components/session/session-view.tsx:311-329` |

The native overlay should carry the controls relevant to a terminal page—dismiss/back, agent,
name/status, connection details, files, and options—while workspace-only pane rearrangement remains
on the workspace/tab screen. “Total parity” does not mean duplicating Move up/down inside the live
overlay; it means those actions remain reachable in the native context corresponding to the web
workspace pane.

### 1.13 Existing automated expectations

The terminal audit command is first-class in the web package
(`web/package.json:13-17`). The manual/test guide lists connection, keyboard, scrollback, resize,
ANSI/Unicode/link/clipboard fidelity, upload, relay, and collaboration flows
(`docs/TERMINAL_WEBUI_TESTING.md:3-30`).

Relevant exact web checks include:

- Shift+Enter emits one `ESC CR`, never an extra CR (`web/tests/e2e/terminal.spec.ts:297-308`).
- Ctrl-C and Enter reach the terminal (`web/tests/e2e/terminal.spec.ts:310-319`).
- Modifier buttons Tab, Ctrl-C, and Send work on mobile
  (`web/tests/e2e/terminal-usability.audit.spec.ts:492-519`).
- Wheel in alternate screen becomes arrow input (`web/tests/e2e/terminal.spec.ts:1212-1231`).
- Touch history preserves its anchor while output arrives
  (`web/tests/e2e/terminal.spec.ts:1244-1286`).
- Emoji width, OSC 8, cursor style, and OSC 52 are emulated
  (`web/tests/e2e/terminal.spec.ts:1366-1437`).

## 2. React Native rendering options

### Decision criteria

A viable renderer must support, without a custom native module:

- Stateful incremental VT/ANSI parsing across arbitrary byte boundaries.
- Cursor addressing, erase/insert/delete, tabs, scroll regions, SGR, DEC private modes.
- Normal and alternate screen buffers.
- 16/256/24-bit color.
- Unicode width and combining/grapheme behavior.
- Bracketed paste, focus, mouse tracking, application cursor/keypad modes.
- OSC 8 links, OSC 52 clipboard, cursor shapes, title/bell events.
- At least 10,000 replay lines and live sustained output.
- Selection, copy, search, touch momentum, keyboard/IME input.
- Expo Go on physical iPhone.

### Option A — `react-native-webview` hosting xterm.js

#### Fidelity

This runs the same emulator and addon family as web, so it supports full VT behavior, alternate
screen, mouse reporting, 256/truecolor, Unicode11 widths, bracketed paste, cursor shape, OSC 8,
OSC 52, selection, and scrollback. xterm describes itself as the component used for shells and
full-screen apps such as `vim` and `tmux`; its public API exposes buffer, modes, selection,
scrolling, parser, and key/data events
([xterm Terminal API](https://xtermjs.org/docs/api/terminal/classes/terminal/)).

Fidelity risk is lowest because the repo already shares its emulation configuration with
`@xterm/headless` conformance (`web/src/components/terminal/xterm-config.mjs:1-12`).

#### Expo Go viability

Verified yes. Expo Go includes `react-native-webview` 13.16.1 and supports inline HTML
([Expo WebView](https://docs.expo.dev/versions/latest/sdk/webview/)). Expo DOM components also
support Expo Go and embedded offline exports in SDK 56+
([Expo DOM components](https://docs.expo.dev/guides/dom-components/)), but a manual WebView gives
the terminal bridge, focus, renderer fallback, and gesture ownership clearer boundaries.

#### Offline bundle; no CDN

**RECOMMEND:** Build one deterministic, minified terminal document from the repo-pinned xterm and
addons. Bundle xterm JS, addon JS, and xterm CSS into the app; never load code, CSS, fonts, or WASM
from a network URL.

Preferred artifact properties:

1. One generated HTML/JS payload imported by the native component, or an Expo embedded DOM export.
2. All `@xterm/*` code and CSS included at build time.
3. No external `<script>`, stylesheet, image, or font URLs.
4. CSP `default-src 'none'`; permit only the bundled script/style mechanism.
5. Synthetic base origin such as `https://spawn.invalid/`.
6. `originWhitelist` limited to that document strategy.
7. `onShouldStartLoadWithRequest` blocks navigation.
8. Links are reported to RN and opened through validated native `Linking`.
9. New windows/popups disabled.
10. No cookies, storage credentials, or session tokens injected into the document.

The terminal page receives bytes and theme values only. It never receives account tokens or opens
transport sockets, which materially limits the effect of terminal-generated link/content attacks.

**UNKNOWN:** Whether a single inlined minified xterm 5.5 payload or Expo's embedded DOM export has
lower peak memory under SDK 57. Resolve with bundle-size and cold-open profiling. Both work offline;
choose the smaller measured resident-set path.

#### Bridge shape and throughput

`react-native-webview` messages are strings. Native uses `ref.postMessage(string)` and web content
uses `window.ReactNativeWebView.postMessage(string)`; an `onMessage` handler must be present
([WebView guide](https://github.com/react-native-webview/react-native-webview/blob/master/docs/Guide.md)).

Use a versioned envelope:

```ts
type NativeToTerminal =
  | { v: 1; t: "write"; seq: number; bytes: string; rawBytes: number }
  | { v: 1; t: "resize"; cols: number; rows: number }
  | { v: 1; t: "theme"; theme: XtermTheme }
  | { v: 1; t: "command"; id: number; command: SurfaceCommand };

type TerminalToNative =
  | { v: 1; t: "ready"; cols: number; rows: number; renderer: "webgl" | "dom" }
  | { v: 1; t: "ack"; seq: number; parsedBytes: number }
  | { v: 1; t: "data"; bytes: string }
  | { v: 1; t: "resize"; cols: number; rows: number }
  | { v: 1; t: "scroll"; viewportY: number; baseY: number; buffer: "normal" | "alternate" }
  | { v: 1; t: "selection"; text: string; hasSelection: boolean }
  | { v: 1; t: "link"; url: string }
  | { v: 1; t: "clipboardWrite"; requestId: number; text: string }
  | { v: 1; t: "result"; id: number; ok: boolean; value?: unknown; error?: string }
  | { v: 1; t: "rendererLost"; from: "webgl" };
```

Encode byte fields as base64. Base64 has deterministic `4 × ceil(n/3)` size, approximately 33%
overhead; it preserves arbitrary control bytes and split UTF-8 exactly. A JSON number array is
several times larger and much slower. Sending JS strings as decoded text can corrupt invalid UTF-8
or split decoder state and is not suitable for the protocol boundary.

**RECOMMEND:** Coalesce output until the first of:

- 8 ms elapsed,
- 32 KiB raw bytes accumulated,
- an explicit flush before resize/replay boundary,
- terminal becomes idle and the current microtask finishes.

Permit one xterm `write` callback in flight. While it parses/renders, append incoming chunks to one
pending byte deque. On callback, post `ack(seq)` and immediately schedule the next coalesced write.
Do not call `injectJavaScript` per chunk; use the WebView message channel.

Install the native→document message handler on both `window` and `document` behind one sequence-ID
deduplicator. React Native WebView releases/platforms have historically differed in the event target;
the protocol must execute a command at most once even if both listeners receive it.

The bridge cost is real. A community measurement on Android reported roughly 14 ms RN→WebView for
a 20 KiB message, 31–33 ms round trips for tiny/10k messages, 57 ms for 1 MB, and 345 ms native→web
for 10 MB; these are not guarantees, but they justify batching rather than one message per PTY
chunk ([react-native-webview discussion #3669](https://github.com/react-native-webview/react-native-webview/discussions/3669)).

**UNKNOWN:** Actual bridge and parser throughput on spawn's minimum supported iPhone. Resolve with
the acceptance benchmark in §6; do not turn the numbers above into a product claim.

#### Input

xterm's own hidden textarea already owns composition and keyboard event translation. Let it remain
focused while native accessory buttons use press handlers that do not intentionally blur the
WebView. Messages flowing WebView→RN are small user-input bursts, so bridge cost is not a throughput
problem, though each special-key press should update local pressed state immediately.

For external keyboards, DOM `KeyboardEvent` includes modifier and function-key information that RN
core `TextInput.onKeyPress` does not expose reliably. This is a major advantage of keeping xterm's
input path.

#### Scroll ownership and gesture conflicts

Set the outer RN WebView's document scrolling off and make `html`, `body`, and the root fixed,
overflow-hidden. xterm's `.xterm-viewport` owns terminal history. This prevents WKWebView from
panning the whole document when the keyboard opens.

Concrete WebView policy:

```tsx
<WebView
  scrollEnabled={false}
  bounces={false}
  overScrollMode="never"
  hideKeyboardAccessoryView
  keyboardDisplayRequiresUserAction={false}
  textInteractionEnabled={false}
  allowsLinkPreview={false}
  setSupportMultipleWindows={false}
  onShouldStartLoadWithRequest={allowOnlyBootstrapDocument}
  onMessage={handleVersionedTerminalMessage}
/>
```

`textInteractionEnabled={false}` disables the WebView's competing page-selection UI; the custom
xterm selection mode below remains active. Revisit only if physical-device testing proves native
WebKit handles can operate on the chosen DOM renderer. These props are documented by the upstream
[React Native WebView reference](https://github.com/react-native-webview/react-native-webview/blob/master/docs/Reference.md).

Gesture policy:

- One-finger vertical drag inside the grid: terminal scrollback/selection.
- Horizontal drag inside grid: terminal mouse/selection by default, not tab swipe.
- Overlay dismissal: begin only on native header, grabber, or a narrow leading-edge activation zone.
- Swipe between tabs: begin from native header/tab strip, never steal an active terminal gesture.
- Alternate-screen drag with no history: may dismiss/hand off only after the surface reports that
  no terminal mouse mode or selection is active.
- Two-finger pinch: terminal font scale.
- Downward drag on modifier/accessory bar: keyboard dismissal.

This preserves the web rule that a gesture chooses one owner for its entire lifetime
(`web/src/components/terminal/Terminal.tsx:99-111`).

#### Selection and copy

WebGL/canvas cells are not ordinary selectable DOM text, and phone WebView selection handles vary.
Do not depend on WKWebView's default page selection menu.

Implement a terminal-owned selection mode inside the document:

1. Long-press a cell for 350–450 ms; cancel if movement exceeds 8 pt.
2. Ask xterm for the buffer/cell under that coordinate.
3. Select the word under the cell; on whitespace select the line's nonblank run.
4. Draw two large touch handles inside the WebView, aligned to cell boundaries.
5. During handle drag call xterm selection APIs at animation-frame cadence.
6. Post selected text and selection rectangles only after a changed frame/end, not per pointer event.
7. Show a native floating toolbar: Copy, Select line, Select all, Cancel.
8. Copy with `Clipboard.setStringAsync(text)`.
9. Clear selection after successful copy unless the user pinned selection mode.

Expo Clipboard is included in Expo Go and exposes `setStringAsync`/`getStringAsync`; iOS 16+
also offers `ClipboardPasteButton`, which avoids a clipboard-read permission prompt
([Expo Clipboard](https://docs.expo.dev/versions/latest/sdk/clipboard/)).

Bridge OSC 52 writes through a custom ClipboardAddon provider to the same native API. Never allow
terminal output to trigger an arbitrary native action beyond writing clipboard text; rate-limit
notifications and show a subtle “Copied by terminal” toast if product policy requires disclosure.

For the repo's ClipboardAddon API, the provider is the second constructor parameter:

```ts
const clipboard = new ClipboardAddon(undefined, {
  readText: async () => bridgeRequest<string>("clipboardRead"),
  writeText: async (_selection, text) => {
    await bridgeRequest("clipboardWrite", { text });
  },
});
term.loadAddon(clipboard);
```

The provider must correlate request IDs and reject/timeout cleanly if native goes away. Reads are
allowed only after a user paste gesture; OSC 52 output may write but must never read clipboard
silently. The current addon type exposes `readText(selection)` and `writeText(selection,text)`
([ClipboardAddon typings](https://github.com/xtermjs/xterm.js/blob/master/addons/addon-clipboard/typings/addon-clipboard.d.ts)).

#### Keyboard behavior

The WebView must set xterm's helper textarea attributes after open:

```html
autocomplete="off"
autocapitalize="off"
autocorrect="off"
spellcheck="false"
enterkeyhint="enter"
```

Keep viewport zoom disabled at the document level and implement terminal font pinch explicitly.
Do not reset or replace the helper textarea during an active composition.

#### Performance and memory

Advantages:

- Mature incremental parser and renderer.
- WebGL glyph atlas and render coalescing.
- One grid/canvas rather than thousands of RN views.
- Identical emulator behavior to desktop reference.

Failure modes:

- Main-thread parser/render saturation during `yes`-style output.
- WebView string-copy and base64 overhead.
- WebGL context loss or renderer-process eviction.
- Large scrollback memory.
- Selection handles and native overlay gestures fighting for touch ownership.
- Keyboard focus loss when a native button is pressed.
- iOS/Android differences in WebView hardware-key delivery.

Mitigations are bounded batching, one active WebView, DOM fallback, authoritative reseed, explicit
gesture zones, and device acceptance tests.

Do not keep one WebView per session warm. Keep only the open overlay's renderer alive; central
session state/transport continues elsewhere and replays into a newly opened surface. The web app's
GPU policy—only foreground terminals get WebGL—supports this resource model
(`web/src/components/terminal/Terminal.tsx:311-326`).

#### Honest effort

Estimated implementation for a competent RN engineer familiar with xterm:

- 1–2 weeks: offline page, bridge, theme, fit, basic raw input.
- 1 week: keyboard accessory, safe-area behavior, scroll/follow reducer.
- 1–2 weeks: selection mode, clipboard, link handling, search.
- 1–2 weeks: replay/overflow recovery, WebGL fallback, flood instrumentation, tests.
- 1–2 weeks: device hardening across iOS/Android/IME/external keyboards.

Total: roughly 5–9 engineer-weeks for production quality, excluding R04 transport work.

### Option B — pure RN emulator with JS parser plus Views/SVG/Skia

#### Parser candidates

`@xterm/headless` 6.0.0 exists and is the same emulator core without browser rendering. Its own
package says it is experimental and “can be run in node.js,” with addons only if they are packaged
for Node and avoid DOM APIs
([npm `@xterm/headless`](https://www.npmjs.com/package/@xterm/headless)).

It is not a supported Hermes/React Native package. As of July 2026, 6.0.0 also has a published
`module` field pointing to a nonexistent file and lacks the intended exports map
([xterm issue #6052](https://github.com/xtermjs/xterm.js/issues/6052)). A bundler workaround might
load CommonJS, but that does not turn the Node target into a maintained RN API.

ANSI-to-text/HTML packages are formatters, not terminals. They generally do not maintain cursor
addressing, scroll regions, alternate screens, modes, mouse protocol, or incremental UTF-8/parser
state. `node-pty` is a native PTY backend, not a renderer/parser, and cannot be added to Expo Go.

#### Renderer choices

RN `<View>/<Text>` cells:

- 80×24 already means up to 1,920 cell elements before scrollback.
- Attribute runs reduce nodes but must be recomputed on every dirty line.
- Precise monospace glyph metrics and combining marks vary by platform.
- Cursor, underline variants, selection, ligature/emoji widths, and clipping need custom logic.

`react-native-svg`:

- Can draw text/rules, but is not a terminal layout engine.
- Thousands of SVG text spans remain costly.
- Glyph metrics still differ from xterm/conformance.

Skia:

- Technically viable and included in Expo Go at 2.6.2
  ([Expo Skia](https://docs.expo.dev/versions/latest/sdk/skia/)).
- Can batch glyph drawing into a canvas and make a fast dirty-row renderer.
- Still requires a full cell model, font shaping/atlas, emoji fallback, cursor, selection, link hit
  testing, touch handles, scrolling, accessibility mirror, and every mode/input mapping.

#### Fidelity

If `@xterm/headless` could be made reliable under Hermes, its grid emulation could cover VT,
alternate screen, colors, and modes. Everything visible and interactive would still be new code.
Without it, a bespoke parser is a terminal-emulator project, not an app feature.

Likely failure modes:

- Incorrect wide/combining/emoji cell widths.
- Parser desynchronization across byte chunks.
- Dirty-row or scroll-region rendering bugs.
- Different reflow/snapshot behavior from web.
- Missing OSC/DCS/APC handling and security limits.
- Broken application-cursor/keypad/mouse modes.
- Selection/copy accessibility regressions.
- Headless package breaks under Metro/Hermes update.

#### Expo Go viability

Skia itself: yes. `@xterm/headless` under Hermes: unverified and unsupported. Any native C/Rust/Zig
terminal module: no, because it is not built into Expo Go.

#### Honest effort

- Parser integration and conformance: 3–6 weeks if headless works; months if bespoke.
- Skia cell renderer and glyph atlas: 4–8 weeks.
- Reflow/scrollback/selection/input/mouse/accessibility: 6–12 weeks.
- Cross-device hardening: 4–8 weeks.

Realistic parity estimate: 4–6 engineer-months, with continuing emulator maintenance. A minimally
usable prototype could appear in 8–12 weeks but would not satisfy “total feature parity.”

**RECOMMEND:** Do not choose pure RN for v1. Keep the stable `TerminalSurface` interface so a
future Skia renderer can be evaluated behind conformance tests without touching app screens.

### Option C — `<Text>` runs in a virtualized list

This can render append-only logs efficiently if each committed line is immutable and style runs
are bounded. It cannot honestly emulate a terminal because a terminal rewrites arbitrary cells.

Missing or fragile behavior:

- Cursor-addressed updates and in-place progress bars.
- Erase/insert/delete cells and lines.
- Scroll regions.
- Alternate screen and full-screen TUIs.
- Resize reflow at exact cell widths.
- Application mouse mode.
- Cursor shapes and blinking.
- Combining/wide graphemes.
- Bracketed paste and terminal modes.
- OSC links/clipboard semantics.
- 24-bit styled runs without explosive child counts.

Expo Go viability is yes because it is core RN. Full-terminal fidelity is no. Effort is perhaps
1–3 weeks for a log viewer, then unbounded as missing emulator behavior accumulates.

**RECOMMEND:** Reserve this only for a future read-only transcript/log component. Never present it
as the live terminal fallback.

### Option D — other current options

#### `ghostty-web` 0.4.0

This is Ghostty's VT parser compiled to WASM with an xterm-like browser API, zero runtime
dependencies, and an advertised ~400 KiB WASM bundle
([npm `ghostty-web`](https://www.npmjs.com/package/ghostty-web)). It can run in the same WebView
without a custom native module if WASM and assets are bundled locally.

Pros:

- Strong VT lineage and xterm-compatible surface.
- Parser in WASM may outperform JS.
- Expo Go viable in principle because all native execution remains WebView/WASM.

Cons:

- Version 0.4.0 is young relative to xterm.
- Spawn's addons, replay workarounds, tests, and themes target xterm.
- WASM asset URL/CSP/offline packaging adds another failure mode.
- Exact OSC 52, Unicode11, selection, WebGL/DOM fallback, and iOS WebView behavior need proof.

#### wterm 0.3.4

wterm renders to DOM and offers a small Zig/WASM core or `@wterm/ghostty` full backend. Its project
claims native DOM text selection/copy/find/accessibility and a ~400 KiB Ghostty core
([wterm repository](https://github.com/vercel-labs/wterm)). It is even newer and has no spawn
conformance history.

#### Native terminal packages

Registry checks for obvious React Native terminal package names did not identify a maintained,
full-fidelity emulator suitable for Expo Go. Native wrappers around platform terminal cores would
require a development build and violate the physical-iPhone Expo Go requirement.

**RECOMMEND:** Treat `ghostty-web` as the renderer fallback experiment if xterm cannot meet the
measured flood budget. Keep the same bridge and `TerminalSurface` API, then replay spawn's ANSI,
Unicode, cursor, OSC 8/52, alternate-screen, resize, and snapshot corpus before considering a swap.

### Comparative scorecard

| Option | Full VT/alt/mouse/color | Mobile perf potential | Expo Go | Parity effort | Principal failure |
|---|---|---|---|---|---|
| xterm in WebView | Yes; same core | High with batching/WebGL | Yes, verified | 5–9 weeks | bridge/WebView memory |
| xterm headless + Skia | Parser maybe; UI custom | Highest eventually | Skia yes; parser unsupported | 4–6 months | unsupported Hermes + renderer bugs |
| RN Text virtual list | No | Good for logs | Yes | 1–3 weeks for logs only | not a terminal |
| ghostty-web in WebView | Likely broad | High | Likely | 6–12 weeks plus conformance | young integration/WASM assets |
| wterm in WebView | Broad claims | High | Likely | unverified | very young API |
| custom native core | Potentially yes | High | No | large | violates hard constraint |

## 3. Stable `TerminalSurface` boundary

The rest of mobile must not know that v1 uses xterm/WebView.

```ts
export type TerminalTheme = {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent?: string;
  selectionBackground?: string;
  selectionInactiveBackground?: string;
  ansi?: readonly string[];
};

export type TerminalModifiers = {
  shift?: boolean;
  ctrl?: boolean;
  alt?: boolean;
  meta?: boolean;
};

export type TerminalKey =
  | { kind: "text"; text: string }
  | { kind: "named"; key: NamedTerminalKey };

export type NamedTerminalKey =
  | "Escape" | "Tab" | "BackTab" | "Enter" | "Backspace"
  | "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight"
  | "Home" | "End" | "Insert" | "Delete" | "PageUp" | "PageDown"
  | "F1" | "F2" | "F3" | "F4" | "F5" | "F6"
  | "F7" | "F8" | "F9" | "F10" | "F11" | "F12";

export type TerminalScrollState = {
  atBottom: boolean;
  viewportY: number;
  baseY: number;
  buffer: "normal" | "alternate";
  newOutputWhileAway: boolean;
};

export type TerminalSurfaceHandle = {
  write(data: Uint8Array): void;
  resize(cols: number, rows: number): void;
  scrollTo(target: "top" | "bottom" | { line: number }): void;
  clear(options?: { scrollback?: boolean }): void;
  search(query: string, options?: {
    direction?: "next" | "previous";
    regex?: boolean;
    caseSensitive?: boolean;
    wholeWord?: boolean;
  }): Promise<{ found: boolean; index?: number }>;
  focus(options?: { showKeyboard?: boolean }): void;
  blur(): void;
  paste(text: string): void;
  sendKey(key: TerminalKey, modifiers?: TerminalModifiers): void;
  getSelection(): Promise<string>;
  selectAll(): void;
  setFontSize(px: number): void;
};

export type TerminalSurfaceProps = {
  onData(bytes: Uint8Array): void;
  onReady?(geometry: { cols: number; rows: number }): void;
  onResize?(geometry: { cols: number; rows: number }): void;
  onScrollState?(state: TerminalScrollState): void;
  onSelectionChange?(value: { text: string; active: boolean }): void;
  onLink?(url: string): void;
  onOverflow?(reason: "queue" | "geometry" | "renderer-lost"): void;
  theme: TerminalTheme;
  readOnly?: boolean;
  fontSize?: number;
};
```

Minimum required shape is therefore exactly the requested
`<TerminalSurface onData ref={{ write, resize, scrollTo, clear, search }} />`, with optional methods
needed for mobile input and selection.

Semantics:

- `write` takes raw bytes and never changes transport ordering.
- `resize` changes xterm grid only after native layout has stabilized.
- `paste` invokes xterm paste semantics; it does not send raw text directly.
- `sendKey` is mode-aware and testable separately from views.
- `clear({scrollback:true})` mirrors `ESC[2J ESC[3J` behavior without resetting modes.
- `search` is an addition; unsupported renderers may return `{found:false}` only during migration.
- `onData` means bytes generated by terminal input, not output.
- `onOverflow` never silently drops the middle of the VT stream.
- `readOnly` keeps output/selection/scroll active but suppresses input.

## 4. Mobile input design

### 4.1 Primary raw-input architecture

**RECOMMEND:** In the xterm renderer, use xterm's own hidden textarea for raw typing. It already
coordinates composition events with terminal input and preserves external-key `KeyboardEvent`
metadata. Tap-to-focus calls `term.focus()` inside the WebView.

Native UI observes focus/keyboard height but does not mirror every character through a controlled
RN `TextInput`. This avoids:

- another bridge hop before xterm key encoding,
- Android controlled-input flicker,
- accidental composition commits,
- duplicate Backspace/Return events,
- losing application cursor/keypad mode awareness.

Raw-input requirements:

- autocorrection off,
- autocapitalization off,
- spellcheck off,
- autofill off,
- smart insert/delete off where applicable,
- no predictive replacement,
- no automatic period after double-space,
- preserve marked/composing text until composition ends,
- keep Return behavior explicit.

HTML supports the first four directly. iOS smart quotes/dashes do not have portable React Native
props in current `TextInput`; verify the actual WKWebView keyboard behavior. Shell users should also
have a “Compose” sheet when language/dictation input is desired.

### 4.2 Hidden RN `TextInput` fallback

If a future pure-RN renderer needs an input proxy, use a hidden-but-focusable native `TextInput`
with a sentinel, not an always-empty controlled input:

```tsx
const SENTINEL = "\u200B";

<TextInput
  value={proxyValue}
  autoCapitalize="none"
  autoCorrect={false}
  autoComplete="off"
  textContentType="none"
  spellCheck={false}
  smartInsertDelete={false}
  submitBehavior="submit"
  onKeyPress={({ nativeEvent }) => {
    if (nativeEvent.key === "Backspace" && proxyValue === SENTINEL) send([0x7f]);
  }}
  onChangeText={handleCompositionAwareDiff}
/>
```

Backspace on an empty-looking field is detected because the sentinel remains behind the cursor.
After committed text is diffed and sent, restore the sentinel. Do not restore it during marked-text
composition; wait for composition/end-edit signals or the next stable diff.

React Native documents `onKeyPress` values including Enter and Backspace, but explicitly says
Android only handles soft-keyboard input there, not hardware keyboards
([RN TextInput](https://reactnative.dev/docs/textinput#onkeypress)). That is why this is fallback,
not the preferred path.

The same docs confirm `autoCapitalize="none"`, `autoCorrect={false}`, `spellCheck={false}`, and
`textContentType="none"`; `smartInsertDelete={false}` only suppresses extra space around paste/cut,
not all smart punctuation ([RN TextInput](https://reactnative.dev/docs/textinput)).

**UNKNOWN:** Reliable hardware Escape/Ctrl/Alt/F-key delivery through Expo Go's core RN TextInput,
especially Android. The documented limitation means it cannot be accepted without a physical
keyboard matrix; the WebView DOM path is the fallback that should ship.

### 4.3 Visible composer, IME, and dictation

Add a native “Compose” button in the secondary input sheet, not as the default screen mode.

Composer behavior:

- Native multiline `TextInput`, 2–6 visible lines.
- Autocorrect/autocapitalize/spellcheck still off for command safety.
- Dictation and IME are allowed; marked text remains local.
- Return inserts a newline by default.
- A visible Send button is the only unambiguous submit action.
- “Paste into terminal” calls surface `paste(text)`, honoring bracketed-paste mode.
- “Type literally” is optional and sends committed UTF-8 without paste wrappers.
- Composer text survives keyboard dismissal and overlay orientation.
- Clear only after renderer accepts the command.

This follows the web Composer's explicit warning that IMEs can swallow Enter and its visible Send
button is primary (`web/src/components/terminal/Composer.tsx:17-35`).

Dictation arrives as composed text, not synthetic key-by-key input. Treat it like composer paste;
never attempt to infer Ctrl or shell editing commands from dictated words.

### 4.4 Paste

**RECOMMEND:** Use `expo-clipboard` 57.0.1. On iOS 16+, prefer native
`ClipboardPasteButton` when `isPasteButtonAvailable` so the OS mediates paste without a permission
prompt. Else perform `getStringAsync()` only from a direct user gesture.

Paste rules:

1. Native clipboard returns text.
2. RN sends a `paste` command to WebView.
3. WebView calls `term.paste(text)`.
4. xterm adds `ESC[200~` / `ESC[201~` only if the application enabled bracketed paste.
5. Input generated by that paste returns through normal `onData` ordering.
6. Never concatenate paste directly with a separately queued Enter without an ordering barrier.
7. Show progress for exceptionally large paste; ask confirmation above 100 KiB.
8. Cap a single interactive text paste at 1 MiB; offer file upload beyond that.

Web already calls `term.paste`, not direct send (`web/src/components/terminal/Terminal.tsx:2679-2697`).

### 4.5 Modifier/shortcut bar layout

The bar sits immediately above the keyboard/home-indicator safe region, native and horizontally
scrollable. Send is pinned at the trailing edge. Visual key caps can remain 36 pt, but each press
target is minimum 44×44 pt.

Primary always-visible order in portrait:

1. Paste
2. Esc
3. Tab
4. Ctrl (stateful)
5. Alt (stateful)
6. ↑
7. ↓
8. ←
9. →
10. `|`
11. Send, pinned

Keep web parity commands discoverable:

- Long-press Tab: Shift-Tab.
- Long-press Ctrl: quick actions `^C`, `^D`, `^Z`, `^L`, `^R`.
- Long-press arrows: Up→Page Up, Down→Page Down, Left→Home, Right→End.
- Long-press `|`: `/`, `-`, `~`, `\` symbol palette.
- “More” sheet: Home, End, Page Up, Page Down, Insert, Delete, F1–F12.

In landscape, show Paste, Esc, Tab, Ctrl, Alt, all arrows, `| / - ~`, `^C`, and Send without a
second sheet when width permits.

Modifier state:

- Tap Ctrl/Alt: armed for the next key, then clears.
- Double-tap within 300 ms: lock; cap fills and lock glyph appears.
- Tap a locked modifier: clear.
- Ctrl and Alt may be combined.
- Momentary state clears after a printable/named key, terminal blur, session switch, or 10 seconds.
- Locked state clears on terminal close/session switch, but not after each key.
- Shift is expressed through long-press variants and external keyboard; optional stateful Shift can
  be added to the More sheet.
- VoiceOver label includes state: “Control, off/armed/locked.”

Quick `^C` must remain one tap because it is the highest-frequency emergency action and exists on
web (`web/src/components/terminal/ModifierBar.tsx:30-39`).

### 4.6 Exact key encoding table

All sequences below are literal bytes. Unit tests must assert hex, not visual escaped strings.

| Key | Normal-mode bytes | Application-mode bytes | Hex normal |
|---|---|---|---|
| Escape | `\x1b` | same | `1B` |
| Tab | `\x09` | same | `09` |
| Shift-Tab | `\x1b[Z` | same | `1B 5B 5A` |
| Enter/Send | `\x0d` | same | `0D` |
| Shift-Enter | `\x1b\x0d` | same | `1B 0D` |
| Mobile prompt newline | `\x1b[200~\x0a\x1b[201~` | same | `1B 5B 32 30 30 7E 0A 1B 5B 32 30 31 7E` |
| Backspace | `\x7f` | same | `7F` |
| Up | `\x1b[A` | `\x1bOA` | `1B 5B 41` |
| Down | `\x1b[B` | `\x1bOB` | `1B 5B 42` |
| Right | `\x1b[C` | `\x1bOC` | `1B 5B 43` |
| Left | `\x1b[D` | `\x1bOD` | `1B 5B 44` |
| Home | `\x1b[H` | `\x1bOH` | `1B 5B 48` |
| End | `\x1b[F` | `\x1bOF` | `1B 5B 46` |
| Insert | `\x1b[2~` | same | `1B 5B 32 7E` |
| Delete | `\x1b[3~` | same | `1B 5B 33 7E` |
| Page Up | `\x1b[5~` | same | `1B 5B 35 7E` |
| Page Down | `\x1b[6~` | same | `1B 5B 36 7E` |
| F1 | `\x1bOP` | same | `1B 4F 50` |
| F2 | `\x1bOQ` | same | `1B 4F 51` |
| F3 | `\x1bOR` | same | `1B 4F 52` |
| F4 | `\x1bOS` | same | `1B 4F 53` |
| F5 | `\x1b[15~` | same | `1B 5B 31 35 7E` |
| F6 | `\x1b[17~` | same | `1B 5B 31 37 7E` |
| F7 | `\x1b[18~` | same | `1B 5B 31 38 7E` |
| F8 | `\x1b[19~` | same | `1B 5B 31 39 7E` |
| F9 | `\x1b[20~` | same | `1B 5B 32 30 7E` |
| F10 | `\x1b[21~` | same | `1B 5B 32 31 7E` |
| F11 | `\x1b[23~` | same | `1B 5B 32 33 7E` |
| F12 | `\x1b[24~` | same | `1B 5B 32 34 7E` |
| `|` | `|` | same | `7C` |
| `/` | `/` | same | `2F` |
| `-` | `-` | same | `2D` |
| `~` | `~` | same | `7E` |
| `\` | `\` | same | `5C` |

Application cursor mode is reported by xterm's `term.modes.applicationCursorKeysMode`; the native
surface encoder must choose SS3 sequences for arrows/Home/End when active. The web modifier bar
currently hardcodes CSI arrows (`web/src/components/terminal/ModifierBar.tsx:35-38`); mode-aware
native keys are a correctness improvement.

Ctrl encoding for ASCII:

```ts
function ctrlByte(ch: string): number | null {
  const c = ch.toUpperCase().charCodeAt(0);
  if (c >= 0x40 && c <= 0x5f) return c & 0x1f;
  if (ch === "?") return 0x7f;
  return null;
}
```

Exact quick actions:

| Action | Byte | Hex |
|---|---|---|
| Ctrl-C | `\x03` | `03` |
| Ctrl-D | `\x04` | `04` |
| Ctrl-Z | `\x1a` | `1A` |
| Ctrl-L | `\x0c` | `0C` |
| Ctrl-R | `\x12` | `12` |
| Ctrl-@ / Ctrl-Space | `\x00` | `00` |
| Ctrl-[ | `\x1b` | `1B` |
| Ctrl-\ | `\x1c` | `1C` |
| Ctrl-] | `\x1d` | `1D` |
| Ctrl-^ | `\x1e` | `1E` |
| Ctrl-_ | `\x1f` | `1F` |
| Ctrl-? | `\x7f` | `7F` |

Alt plus a printable/control key prefixes `ESC` (`1B`) to its encoded bytes. Examples:

| Combination | Sequence | Hex |
|---|---|---|
| Alt-b | `\x1bb` | `1B 62` |
| Alt-f | `\x1bf` | `1B 66` |
| Alt-Backspace | `\x1b\x7f` | `1B 7F` |
| Ctrl-Alt-C | `\x1b\x03` | `1B 03` |

Modified cursor CSI parameter is `1 + Shift(1) + Alt(2) + Ctrl(4)`:

| Combination | Up sequence |
|---|---|
| Shift-Up | `\x1b[1;2A` |
| Alt-Up | `\x1b[1;3A` |
| Alt-Shift-Up | `\x1b[1;4A` |
| Ctrl-Up | `\x1b[1;5A` |
| Ctrl-Shift-Up | `\x1b[1;6A` |
| Ctrl-Alt-Up | `\x1b[1;7A` |
| Ctrl-Alt-Shift-Up | `\x1b[1;8A` |

Substitute `B/C/D` for Down/Right/Left. Let xterm encode hardware keyboard events; use this table
for native accessory buttons so terminal mode and tested behavior stay centralized.

Return routing on native mobile:

- Soft keyboard Return in the active prompt-newline mode emits the exact bracketed LF above.
- Native accessory Send always emits CR (`0D`).
- External hardware Return should emit CR; Shift-Return emits `ESC CR`.
- If exact web coarse-pointer behavior is required instead, a setting may map external plain Return
  to prompt newline too; hardware users generally expect physical Return to submit.
- `beforeinput`/`input` and `keydown` paths share a per-press suppression token so one key cannot
  emit both prompt newline and CR, mirroring web's duplicate defense
  (`web/src/components/terminal/Terminal.tsx:2028-2040`,
  `web/src/components/terminal/Terminal.tsx:2150-2172`).

### 4.7 Keyboard layout and animation

**RECOMMEND:** Use `react-native-keyboard-controller` 1.21.9. Expo says it is included in Expo Go
and designed for consistent native keyboard behavior on iOS and Android
([Expo keyboard controller](https://docs.expo.dev/versions/latest/sdk/keyboard-controller/)).

Screen stack:

```text
native overlay header / drag handle
terminal viewport mask (flex: 1)
jump-to-latest pill (absolute inside viewport)
modifier bar (KeyboardStickyView)
bottom safe-area fill / home indicator
system keyboard
```

Use `KeyboardStickyView` for the accessory so only the footer tracks keyboard translation. Avoid
wrapping the whole terminal in `KeyboardAvoidingView`: it changes height/padding/position and can
trigger repeated fit/resize. React Native documents those three behaviors and platform differences
([KeyboardAvoidingView](https://reactnative.dev/docs/keyboardavoidingview)).

Animation rules:

- Accessory follows the keyboard's interactive translation at native frame rate.
- Terminal grid dimensions stay frozen throughout keyboard transition.
- Viewport mask/pan animates so cursor row remains 8–12 pt above modifier bar.
- After keyboard fully closes, refit once if actual container width/height changed.
- A rows-only change never requests history reseed.
- Theme/color updates never blur input.
- Tapping terminal while keyboard hidden focuses without first jumping history if selection mode is active.

Keyboard dismissal:

- Downward drag on modifier bar/background dismisses interactively where supported.
- A dedicated keyboard-chevron button is always available.
- A terminal scroll does not dismiss by default; users commonly need to inspect output while typing.
- Downward overscroll at the live edge may begin dismissal only after 24 pt and only outside
  application mouse mode/selection.

`KeyboardGestureArea` can drive interactive dismissal, but linking it to an input inside a WebView
is not guaranteed by the native `nativeID` mechanism.

**UNKNOWN:** Whether keyboard-controller's fully interactive gesture can bind to WKWebView's xterm
textarea in Expo Go. Resolve with a one-screen physical iPhone spike. Fallback is animated sticky
accessory plus explicit `Keyboard.dismiss()`/WebView blur; both remain Expo Go-compatible.

### 4.8 Safe areas, home indicator, landscape

- Overlay header consumes top safe inset only when it extends under status/island.
- Modifier bar padding bottom is `max(bottomSafeInset, 4)` when keyboard is hidden.
- When keyboard is visible, keyboard already covers the home-indicator region; avoid double inset.
- Jump pill bottom offset = modifier bar visible height + 12 pt.
- Selection toolbar is clamped between top safe inset/header and keyboard/modifier bar.
- On rotation, cancel momentum/selection-handle drag, capture anchor, wait for stable width, fit,
  send one resize, then restore bottom or exact line anchor.
- Landscape may use two compact modifier rows or one wider row; never reduce hit targets below 44 pt.
- Do not place Send under the home indicator or right-side landscape safe inset.

### 4.9 External Bluetooth/hardware keyboard

Preferred xterm/WebView behavior:

- Focus xterm textarea on terminal tap.
- Let xterm process DOM keydown/keypress/composition.
- Preserve Ctrl, Alt/Option, Shift, Meta, arrows, navigation, and F keys.
- Apply only spawn's Shift-Enter override (`ESC CR`).
- Meta-C/Meta-V should use platform copy/paste when selection exists; otherwise let xterm behavior
  follow the user's terminal setting.
- Escape should leave native sheets first only when a sheet is open; otherwise send Escape.
- Command-W must not close a native session accidentally.

Core RN cannot be the only hardware-key path because Android `TextInput.onKeyPress` explicitly
omits hardware input ([RN TextInput](https://reactnative.dev/docs/textinput#onkeypress)).

**UNKNOWN:** Which Bluetooth keyboard layouts and iPad hardware function keys WKWebView exposes in
Expo Go. Resolve on iPhone/iPad with US and one non-US layout before release. The surface should log
sanitized key code/modifier diagnostics behind a developer toggle, never actual typed text.

## 5. Scrolling, selection, haptics, and font

### 5.1 Follow/auto-scroll state machine

Model follow separately from pixel scroll:

```ts
type FollowState =
  | { mode: "following"; unreadBytes: 0 }
  | { mode: "reading"; anchorLine: number; unreadBytes: number }
  | { mode: "selecting"; anchorLine: number; unreadBytes: number }
  | { mode: "replaying"; returnTo: "bottom" | { line: number }; unreadBytes: number };
```

Transitions:

| Event | From | To/action |
|---|---|---|
| First paint | any | following; scroll bottom |
| Output | following | write; remain bottom after write callback |
| User drags ≥8 pt upward | following | reading at captured line |
| Output | reading/selecting | do not move; increment unread bytes; show New pill |
| Jump pill | reading/selecting | clear selection; following; bottom; unread=0 |
| User sends input | reading | following; bottom; unread=0 |
| User manually reaches bottom | reading | following; unread=0 |
| Resize width | following | replay; restore bottom |
| Resize width | reading | replay; restore line anchor |
| Keyboard rows/mask only | any | preserve mode/anchor; no replay |
| Enter selection | reading/following | selecting; freeze follow |
| Cancel selection | selecting | previous reading/follow state |
| Alternate screen | any | no normal scrollback; app owns grid |

This matches web's “pin only if already at edge” rule and New pill
(`web/src/components/terminal/Terminal.tsx:1071-1141`,
`web/src/components/terminal/Terminal.tsx:3302-3325`).

Jump pill behavior:

- Icon-only when away with no new output.
- Expands to “New” plus green dot when unread output arrives, matching web.
- Optional badge shows rounded line count only if cheaply known; bytes are not user-friendly.
- One light haptic on press.
- Hide immediately after acknowledged bottom scroll.
- Accessibility label: “Jump to latest output, new output available.”

### 5.2 Momentum and stream-jank avoidance

Use xterm's own viewport scrolling inside WebView. Coalesce RN scroll-state notifications to one per
animation frame and emit only transitions/meaningful line changes. Never set React state for every
PTY chunk or pixel of momentum.

On output while reader is away:

- Parse/render output normally.
- Do not call `scrollToBottom`.
- Do not recompute native selection toolbar unless selection changed.
- Update unread counter at most 10 times/second.
- Keep jump pill animation on native UI thread.

On output while following:

- Capture `wasAtBottom` before write.
- In xterm write callback, schedule one `scrollToBottom` on next frame.
- Coalesce multiple callbacks into one pin.
- Optionally correct once on the following frame after slow layout, as web does
  (`web/src/components/terminal/Terminal.tsx:1687-1724`).

### 5.3 Selection and copy on a phone

Normal mode long press enters terminal selection, not overlay dismissal and not native page context
menu. Haptic once on word acquisition.

Selection mode rules:

- Initial word selection follows buffer cells and soft-wrapped lines.
- Drag handles snap to cell boundaries.
- Auto-scroll near top/bottom at a capped 2–12 rows/second.
- Wide characters move as one cell cluster; do not split combining marks.
- Selection can cross wrapped visual rows and scrollback pages.
- Alternate screen selection is allowed over the current grid but has no history beyond it.
- Incoming output never changes selected anchor text silently; if buffer trimming invalidates it,
  cancel selection and announce “Selection expired.”
- Native Copy writes exact `term.getSelection()` text with `expo-clipboard`.
- Copy line strips trailing padding cells but preserves intentional internal spaces.
- Select all should be limited to xterm's currently retained buffer and warn before very large copy.
- Long press on OSC 8 link offers Open Link and Copy Link in addition to text actions.

Do not auto-copy immediately on touch selection end. Web does that for mouse
(`web/src/components/terminal/Terminal.tsx:2176-2181`), but phone users need an explicit Copy action
so adjusting handles does not repeatedly overwrite clipboard.

### 5.4 Haptics on this screen

Use `expo-haptics` 57.0.1, included in Expo Go
([Expo Haptics](https://docs.expo.dev/versions/latest/sdk/haptics/)). Haptics reinforce stateful
actions, never every typed character.

| Event | Haptic |
|---|---|
| Esc/Tab/arrow/symbol accessory key | `selectionAsync()` or none under rapid repeat |
| Ctrl/Alt arm or clear | `selectionAsync()` |
| Ctrl/Alt lock by double tap | `impactAsync(Medium)` |
| Ctrl-C / Ctrl-D / Ctrl-Z | `impactAsync(Light)` |
| Send | `impactAsync(Light)` |
| Long-press variant menu opens | `impactAsync(Medium)` |
| Selection word acquired / handle snaps | `selectionAsync()`; throttle ≥50 ms |
| Copy succeeds | `notificationAsync(Success)` only for explicit toolbar Copy |
| Jump to latest | `impactAsync(Light)` |
| Take control succeeds | `notificationAsync(Success)` |
| Input rejected because viewer/offline | `notificationAsync(Warning)` |
| Upload completes/fails | Success/Error notification |
| WebGL→DOM fallback | none; this is not user action |
| Every ordinary typed character | none |

Expo documents that iOS haptics can be unavailable under low-power mode, disabled Taptic Engine,
camera use, or active dictation. Haptics are optional feedback; never make flow depend on them
([Expo Haptics](https://docs.expo.dev/versions/latest/sdk/haptics/)).

### 5.5 Font and metrics

Web's exact stack and metrics are:

```text
13 px
line-height 1.2 (15.6 px nominal)
ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas,
"Liberation Mono", "Courier New", monospace
```

Source: `web/src/components/terminal/xterm-config.mjs:17-21`; web also derives 15.6 px as its row
height (`web/src/components/terminal/Terminal.tsx:53`).

On iPhone, preserve the CSS stack in the WebView. `ui-monospace`/SF Mono/Menlo are system-resolved;
there is no need to bundle or redistribute Apple's font files. This is closer to the desktop web
language than replacing it with a fashionable third-party monospace.

The terminal configuration references only the system/fallback CSS stack above
(`web/src/components/terminal/xterm-config.mjs:17-21`). The separate web font module declares
Rowdies for display type and IBM Plex Sans for marketing/body chrome, not the terminal grid
(`web/src/lib/fonts.ts:1-25`).

Licensing:

- Do not bundle SF Mono, Menlo, Monaco, Consolas, or Courier New without an explicit redistribution
  license; their presence in a CSS fallback list does not grant redistribution.
- Liberation Fonts 2.x is licensed under SIL Open Font License and Liberation Mono is intended as a
  Courier-compatible free family
  ([Liberation Fonts project](https://github.com/liberationfonts/liberation-fonts)).
- Liberation Mono 2.1.5 could be bundled for Android consistency if exact device tests require it.

**RECOMMEND:** Bundle no mono font for iOS v1; use the exact CSS stack. If Android metrics vary too
much, bundle only `LiberationMono-Regular.ttf` under OFL with license notice, then measure its asset
size in the chosen release rather than trusting a stale web listing.

**UNKNOWN:** Exact compressed and resident size of the eventual Liberation Mono asset. Resolve by
recording the chosen TTF's byte count and EAS bundle delta before adding it.

Font-size control:

- Default 13 px.
- User range 10–20 px in 1 px steps.
- Preserve line-height ratio 1.2.
- Two-finger pinch adjusts a preview continuously, clamps 10–20.
- Commit one fit/resize after pinch ends, preserving bottom/line anchor.
- Haptic only at 13 default and 10/20 limits.
- Double-tap with two fingers resets to 13.
- Persist per user/device, not per session.
- Terminal grid opts out of Dynamic Type because arbitrary scaling breaks fixed-cell layout; expose
  the explicit terminal font setting to meet accessibility needs.
- Native chrome/modifier labels still respect the app's normal accessibility type policy.

## 6. Performance budget and flood behavior

### 6.1 Acceptance budgets

Targets, not claims:

| Metric | Target |
|---|---:|
| Native overlay/modifier animation | 60 fps; 16.7 ms frame budget |
| Terminal visible output | ≥55 fps p95 during normal interactive output |
| Accessory-key visual response | <16 ms local |
| Input byte enqueued to transport | <50 ms p95, excluding network |
| RN→WebView output batch delay | ≤8 ms normal |
| Normal max raw batch | 32 KiB |
| Emergency max raw batch | 64 KiB |
| Sustained flood acceptance | 1 MiB/s for 30 s, no byte loss/reseed |
| Burst acceptance | 4 MiB/s for 2 s, bounded recovery allowed |
| Pending renderer bytes | ≤4 MiB |
| Ack-stall threshold | 2 s while app foreground/visible |
| Scroll-state RN updates | ≤1/frame; unread badge ≤10/s |
| Long JS task warning | >50 ms |
| WebGL context loss | automatic DOM fallback, no session loss |

**UNKNOWN:** The chosen renderer's actual maximum bytes/second on a physical iPhone. It cannot be
derived from desktop xterm or bridge benchmarks. The table is the release gate to measure.

### 6.2 Coalescing algorithm

```ts
const FLUSH_AFTER_MS = 8;
const MAX_BATCH_BYTES = 32 * 1024;
const MAX_PENDING_BYTES = 4 * 1024 * 1024;
const ACK_STALL_MS = 2_000;

enqueue(bytes, streamOffset, geometry) {
  if (stale) return;
  if (pendingBytes + bytes.length > MAX_PENDING_BYTES) {
    pending.clear();
    stale = true;
    onOverflow("queue");
    return;
  }
  pending.push({ bytes, streamOffset, geometry });
  if (pendingBytes >= MAX_BATCH_BYTES) flushSoon();
  else scheduleFlushIn(FLUSH_AFTER_MS);
}

flush() {
  if (writeInFlight || stale || pending.empty) return;
  const batch = pending.takeUpTo(MAX_BATCH_BYTES);
  writeInFlight = batch.seq;
  webview.postMessage(encodeBase64Envelope(batch));
}

onAck(seq) {
  if (seq !== writeInFlight) protocolFault();
  writeInFlight = null;
  flush();
}
```

Preserve per-chunk `streamOffset` and `geometry` metadata outside the base64 payload so the buffer
can filter bytes covered by a replay and detect incompatible geometry, matching
`PostRenderLiveWriteBuffer` (`web/src/components/terminal/live-write-buffer.ts:42-70`).

### 6.3 What to drop under flood

Never drop an arbitrary byte range and continue parsing. Escape sequences, UTF-8 code points, OSC,
DCS, APC, and bracketed data may span chunks; one missing byte can permanently change parser mode.

Allowed coalescing/drops:

- Coalesce multiple output chunks into one exact byte array.
- Drop intermediate native progress counters and scroll telemetry.
- Drop intermediate visual frames; xterm may parse several writes before next paint.
- Coalesce repeated bottom-pin requests.
- Coalesce theme/font commands to the newest value before execution.
- Drop provisional predictive-echo frames.
- If queue exceeds 4 MiB, discard the entire uncommitted queue, mark renderer stale, and request an
  authoritative worker replay/checkpoint at known offset and geometry.

Overflow recovery:

1. Stop feeding the stale parser.
2. Keep last valid grid visible with nonmodal “Catching up…” status.
3. Request snapshot/replay through R04.
4. Buffer new live writes in the same 4 MiB bounded offset-aware structure.
5. Clear/reseed only normal screen; never destructively rewrite an active alternate screen without
   a protocol-supported full state.
6. Filter live chunks already covered by replay offset.
7. If any uncovered chunk geometry differs, request again.
8. Resume after replay write callback and live-buffer drain.
9. If no replay arrives within 6 s, offer reconnect/retry; do not fake continuity.

This mirrors web's overflow→refresh and geometry mismatch→refresh behavior
(`web/src/components/terminal/live-write-buffer.ts:26-70`) and 6 s snapshot timeout
(`web/src/components/terminal/Terminal.tsx:66-68`).

### 6.4 `yes`-style flood plan

A `yes` flood produces enormous repeated output and is principally parser/render/bridge pressure.

- Keep one xterm write in flight.
- Pack 32 KiB messages at 8 ms cadence; permit 64 KiB only while catching up.
- Do not post per-chunk React state.
- Hide cursor blink/predictive overlay while continuously saturated if profiling proves useful.
- Let xterm trim at 100,000 lines.
- Detect WebGL context loss and fall back to DOM.
- If WebView process terminates, remount and request replay; session transport remains outside.
- When app backgrounds, stop render delivery and retain only bounded offset-aware bytes; resume from
  replay rather than allowing unlimited memory.
- Do not “optimize” repeated lines by semantic deduplication; identical lines are real terminal data.

### 6.5 Memory budget and instrumentation

Measure, do not infer:

- WebView cold resident delta.
- DOM versus WebGL delta.
- 100k-line scrollback delta with ASCII and truecolor/wide glyph cases.
- Base64 peak copy size for 32/64 KiB messages.
- Queue high-water mark.
- xterm write callback latency p50/p95/p99.
- bridge post→receive latency p50/p95.
- frames missed during output and keyboard animation.
- WebGL context-loss and WebView process-termination count.
- time to first painted prompt after opening overlay.

Do not log terminal content. Metrics contain sizes, times, sequence numbers, geometry, renderer, and
offsets only.

## 7. Automated verification with no device

The device-free suite cannot certify WKWebView keyboard/selection performance, but it can make the
logic deterministic and prevent most regressions.

### 7.1 Key encoder unit tests

Create pure `encodeTerminalKey(key, modifiers, modes): Uint8Array` tests.

Required table cases:

- Esc `1B`.
- Tab `09`.
- BackTab `1B 5B 5A`.
- Enter `0D`.
- ShiftEnter exactly `1B 0D`, never `1B 0D 0D`.
- Soft mobile Return exactly `1B 5B 32 30 30 7E 0A 1B 5B 32 30 31 7E`, never followed by `0D`.
- Accessory Send stays `0D` while soft Return uses the multiline sequence.
- Backspace `7F`.
- Normal arrows CSI.
- Application arrows SS3.
- Normal/application Home and End.
- Insert/Delete/PageUp/PageDown.
- F1–F12 exact table.
- Ctrl-A through Ctrl-Z each equals uppercase code `& 0x1f`.
- Ctrl-Space/NUL and Ctrl punctuation edge cases.
- Alt prefixes exactly one Escape.
- Ctrl+Alt applies Ctrl first, then Escape prefix.
- Modified arrows use CSI parameters 2–8.
- `| / - ~ \` exact ASCII.
- Unicode committed text round-trips UTF-8.
- Empty text yields no bytes.
- Modifier momentary state clears once.
- Double tap locks and third tap clears.
- Session switch clears all modifier states.

Parity fixtures should include current web bytes from
`web/src/components/terminal/ModifierBar.tsx:30-49` and ShiftEnter from
`web/src/components/terminal/Terminal.tsx:2150-2168`.

### 7.2 Bridge/write-buffer unit tests

Use fake timers and a fake WebView sender.

Cases:

1. Three chunks within 8 ms become one batch in order.
2. 32 KiB triggers immediate flush.
3. At most one batch is in flight before ack.
4. Ack flushes pending immediately.
5. Wrong/out-of-order ack is a protocol fault.
6. Base64 round-trips all 0–255 byte values.
7. Split multibyte UTF-8 bytes remain byte-exact.
8. Split CSI/OSC/DCS sequences remain byte-exact.
9. Queue reaches exactly 4 MiB without overflow.
10. One more byte clears queue, latches stale, emits one overflow.
11. Further writes while stale do not grow memory.
12. Replay offset filters covered writes.
13. Uncovered write preserves order and maximum offset.
14. Geometry mismatch requests refresh.
15. Reset/replay clears stale only after write callback.
16. Ack timeout at 2 s requests recovery once.
17. Theme/resize commands cannot overtake an earlier output boundary.
18. Background/resume requests replay rather than retaining unlimited bytes.

Port the existing semantics directly; the source is only 78 lines
(`web/src/components/terminal/live-write-buffer.ts:1-78`).

### 7.3 Follow/auto-scroll reducer tests

The reducer takes events and returns state/effects; it must not access views.

Required cases:

- Initial paint follows bottom.
- Output while following schedules one post-write bottom pin.
- Multiple output events coalesce one pin.
- Upward drag enters reading.
- Output while reading preserves anchor and marks unread.
- Unread increments without unbounded integer growth.
- Manual arrival at bottom clears unread.
- Jump pill clears unread and follows.
- Any actual user input follows bottom.
- Modifier arming alone does not snap; emitted key does.
- Selection freezes follow.
- Copy/cancel restores prior reading state.
- Rows-only keyboard mask preserves anchor and sends no resize.
- Width change captures bottom/line anchor and requests replay.
- Replay success restores requested anchor.
- Replay overflow stays stale and requests again.
- Alternate screen has no normal scrollback.
- Terminal drag at unusable edge returns “handoff.”
- Overlay-dismiss gesture never changes terminal anchor.

These match existing mobile expectations at
`web/tests/e2e/terminal.spec.ts:1244-1342`.

### 7.4 Modifier bar component tests and snapshots

Use React Native Testing Library with `expo-haptics`, safe-area, keyboard-controller, Clipboard, and
TerminalSurface mocked.

Snapshots/states:

- Light portrait.
- Dark portrait.
- Landscape compact.
- Bottom inset 0 and 34 pt.
- Keyboard hidden/visible.
- Ctrl off/armed/locked.
- Ctrl+Alt locked.
- Read-only/viewer disabled state.
- Offline disabled state.
- VoiceOver large text.
- More/F-key sheet.
- Long-press quick-action popover.

Behavior assertions:

- Every target is ≥44×44.
- Send remains pinned while main row scrolls.
- Tap does not blur terminal.
- Haptic fires once per action and never for rerender.
- Rapid arrow repeat rate is bounded and stops on release/cancel.
- Paste calls surface `paste`, not raw `onData`.
- Paste permission failure renders recoverable message.
- Ctrl-C calls exact `03` and clears momentary Ctrl.
- Read-only blocks send but leaves Paste/Copy policy explicit.
- Accessibility labels announce modifier state and arrow direction.

Snapshot native chrome only. Do not use image snapshots of xterm/WebGL as the primary correctness
test; GPU rasterization differs by platform.

### 7.5 Terminal document/bridge tests

The offline HTML artifact can be tested in Node Playwright without a server:

1. `page.setContent()` the generated document.
2. Stub `window.ReactNativeWebView.postMessage` to capture messages.
3. Send the native `ready/theme/resize/write/command` envelopes.
4. Assert ack sequence, input data, resize, scroll, selection, link, and error envelopes.
5. Force WebGL creation failure and assert DOM readiness.
6. Dispatch `webglcontextlost` and assert fallback message/no content reset.
7. Verify the document makes no network requests.
8. Verify navigation attempts are reported, not followed.
9. Verify CSP blocks injected remote scripts.
10. Simulate compositionstart/update/end and assert only committed terminal input.
11. Simulate ShiftEnter and assert one `ESC CR`.
12. Write OSC 8 and assert displayed label plus native link event.
13. Write OSC 52 and assert clipboard request, never direct navigation.
14. Write alternate-screen sequences and assert surface mode report.
15. Search normal/regex/case-sensitive paths.
16. Clear scrollback without resetting application modes.

Use web's fidelity corpus as fixtures: emoji width, OSC 8 URL hiding, cursor shapes, and OSC 52 are
already expected at `web/tests/e2e/terminal.spec.ts:1366-1437`.

### 7.6 Parser/grid conformance

For byte-level VT fixtures, feed identical bytes and options to `@xterm/headless` in Node and the
WebView xterm build, then compare visible cells, cursor, active buffer, modes, and colors. The repo
already states its conformance runner uses the same headless emulation core and exact options
(`web/src/components/terminal/xterm-config.mjs:1-12`).

Include fixtures for:

- CR/LF discipline with `convertEol:false`.
- Partial UTF-8 across writes.
- Wide emoji/combining marks under Unicode11.
- 16/256/truecolor SGR.
- Erase/insert/delete line/cell.
- DEC scroll region and origin mode.
- Alternate buffer 1047/1048/1049 enter/exit.
- Application cursor mode.
- Bracketed paste mode.
- Mouse modes and coordinate encoding.
- OSC 8, OSC 52, title, bell.
- DECSCUSR cursor shapes.
- Snapshot clear/reseed without mode reset.
- Resize and reflow at narrow/wide geometry.

### 7.7 Flood/load tests without a device

These are deterministic pipeline tests, not proof of iPhone performance:

- Generate 1 MiB of `yes\r\n` data in randomized 1–16 KiB transport chunks.
- Assert exact aggregate bytes in WebView and bounded RN queue.
- Delay acks to just under/over 2 s and assert behavior.
- Generate one 4 MiB burst and assert bounded memory.
- Exceed 4 MiB by one byte and assert one replay request.
- Flood while reader is away and assert anchor/new state.
- Flood across width change and assert geometry refresh.
- Flood during selection and ensure no native render-state loop.
- Randomly split every escape/UTF-8 boundary and compare final headless grid.
- Run DOM renderer in CI; optionally run software WebGL where available, but never require it.

### 7.8 What no-device tests cannot settle

The following remain mandatory physical-device release gates:

- WKWebView WebGL stability and process memory.
- Actual 1 MiB/s sustained and 4 MiB/s burst throughput.
- iPhone keyboard animation and cursor visibility.
- Autocorrection/smart punctuation suppression.
- Japanese/Chinese/Korean composition and dictation.
- Long-press selection handle ergonomics.
- Interactive keyboard dismissal with WebView focus.
- Bluetooth keyboard modifiers/F keys/layouts.
- VoiceOver traversal between native chrome and WebView.
- Haptics under low power/dictation.

Automated tests can make implementation agents productive without a device, but these unknowns must
remain explicit rather than being inferred from a simulator/headless browser.

## 8. Implementation order for downstream plans

1. Define the renderer-neutral types and pure key/follow/write-buffer modules.
2. Generate the self-contained offline xterm document from repo-pinned 5.5 dependencies.
3. Implement versioned base64 bridge with ready/ack and one write in flight.
4. Apply exact xterm config, themes, addons, Unicode11, DOM fallback.
5. Add fit/resize with stable-layout and keyboard-freeze invariants.
6. Add raw focus/input, ShiftEnter override, mode-aware accessory encoder.
7. Add native modifier bar, Clipboard, Haptics, keyboard-controller sticky layout.
8. Add follow reducer, momentum ownership, New pill, overlay gesture exclusion zones.
9. Add selection mode, copy/link handling, and optional search.
10. Add bounded replay recovery and flood instrumentation.
11. Complete device-free suite.
12. Run the explicit physical-iPhone release gates when device access exists.

## 9. Recommendations and unresolved decisions

**RECOMMEND:** Ship xterm 5.5 plus the exact web addon/config family inside Expo Go's WebView
13.16.1. Upgrade to xterm 6 only in a separate conformance change after mobile parity is green.

**RECOMMEND:** Keep WebGL preferred and DOM fallback automatic. Provide an internal renderer toggle
equivalent to web's `spawnRenderer` preference.

**RECOMMEND:** Use xterm's helper textarea for raw/IME/hardware input and a native visible composer
only for multiline/dictation workflows.

**RECOMMEND:** Use keyboard-controller's sticky accessory; freeze PTY geometry during keyboard
animation and refit once afterward only if actual layout changed.

**RECOMMEND:** Preserve web's Paste/Esc/Tab/ShiftTab/^C/arrows/Send bytes, then add stateful Ctrl/Alt,
symbols, navigation, job-control, and a More F-key sheet through one pure encoder.

**RECOMMEND:** Give vertical terminal scroll and selection priority inside the grid. Limit overlay
dismiss/tab swipes to native header/edge zones so a terminal gesture is never stolen midway.

**RECOMMEND:** Batch 8 ms/32 KiB, allow one xterm write in flight, cap 4 MiB, drop render frames and
telemetry—not bytes—and recover overflow from authoritative replay.

**RECOMMEND:** Use exact web themes, 13 px × 1.2 metrics, and system-resolved mono stack on iPhone;
offer explicit 10–20 px pinch/setting rather than Dynamic Type in the fixed grid.

**UNKNOWN:** Can keyboard-controller's interactive dismissal follow a focused WKWebView textarea?
Resolve with an Expo Go iPhone spike; explicit dismiss is the safe fallback.

**UNKNOWN:** Does WKWebView deliver every needed external-key code/modifier on the minimum iOS and
supported layouts? Resolve with the hardware-key matrix; do not switch to core RN TextInput as a
purported fix because Android hardware keypress is documented missing there.

**UNKNOWN:** What sustained/peak throughput and scrollback memory does xterm WebGL achieve on the
minimum iPhone? Resolve against the numeric §6 budgets; DOM fallback and `ghostty-web` prototype are
the contingency paths.

**UNKNOWN:** Can the desired custom touch selection meet VoiceOver and handle ergonomics inside
WKWebView? Resolve with accessibility/device testing; retain explicit Copy line/visible screen as
fallback actions even if freeform handles need another pass.

**UNKNOWN:** Should native expose Search immediately even though web lacks it? The stable interface
includes it. Product/orchestrator must decide whether v1 treats it as a small mobile addition or
defers the visible search UI until web also gains parity.
