# P1-09 — Terminal core: the WebView worker, WebRTC transport and terminal surface

**Phase 1, parallel with eight other agents. This is the highest-risk and highest-value agent in
the campaign.** Everything else is a list or a form. This is the thing the product is for.

**Read first:** `00-OVERVIEW.md` — especially **§3 D3** (the architecture, and *why* it is shaped
this way), §7.4 and §7.5 (the frozen interfaces), §8. Then `research/04-terminal-transport.md`
**in full** (the protocol), then `research/09-native-terminal-ux.md` **in full** (the renderer and
input design), then `research/11-files-and-preview.md §TL;DR 6-7` for session uploads.

---

## 1. Objective

Ship the mechanism that puts a live, fast, correct terminal on the phone:

1. a **WebView worker document** hosting `RTCPeerConnection` + xterm.js,
2. the **RN↔worker bridge**,
3. `SessionTransport` and `HostTransport` implementing `00-OVERVIEW.md §7.4`,
4. the `TerminalSurface` component implementing §7.5,
5. the `spawn.ctl` protocol codecs,

with unit tests for every codec and state machine. `P2-05` builds the screen around your
`TerminalSurface`; you build no screen chrome.

## 2. Files you own

```
src/terminal/transport/types.ts             # the §7.4 interfaces + frame types
src/terminal/transport/session-transport.ts
src/terminal/transport/host-transport.ts
src/terminal/transport/bridge.ts            # RN ↔ WebView message protocol (typed, versioned)
src/terminal/transport/ctl-codec.ts         # spawn.ctl v1 JSON + SPCT binary header
src/terminal/transport/upload.ts            # session upload state machine
src/terminal/transport/state-machine.ts     # connection state machine (pure)
src/terminal/TerminalSurface.tsx            # the §7.5 component
src/terminal/worker/                        # SOURCE of the worker document
assets/terminal/                            # BUILT worker document + xterm assets
src/terminal/**/__tests__/**
```

## 3. Architecture — build exactly this

Re-read `00-OVERVIEW.md §3 D3`. The essential points:

- **One WebView per live session.** It hosts *both* the `RTCPeerConnection` and xterm.js, so PTY
  bytes go DataChannel → xterm **inside the WebView, never crossing the RN bridge**. A `yes`-style
  flood must cost the bridge nothing.
- **The private key never enters the WebView.** When the signalling transcript needs signing, the
  worker posts a sign request; RN signs via `P1-06`'s `deviceIdentity.signSignalTranscript` and
  posts back the signature.
- **The signalling socket lives in RN.** Use `P1-08`'s `openSessionSignal(sessionId)` /
  `openHostSignal(hostId)` (`P1-08` plan §3.4). Relay frames in both directions.
- **Everything above `SessionTransport` is transport-agnostic**, so a future EAS dev build can
  swap in native `react-native-webrtc` without touching a screen.

### 3.1 Risk R-1 — secure context. Handle this first.

WebKit gates WebRTC on a secure context, and HTML loaded via `source={{ html }}` gets an opaque
origin, which is **not** secure. If you ignore this you will build everything and it will fail on
device with an unhelpful error.

Implement in this order:
1. **Primary:** `source={{ html, baseUrl: 'https://spawn.local/' }}` so WKWebView treats the
   document as an https origin.
2. **Fallback, behind a one-line switch:** ship the worker as a bundled asset and load it via
   `file://` through `expo-asset` (WebKit treats `file:` as potentially trustworthy).
3. Leave a documented third option (serve the worker from the spawn server over https) — do not
   implement it.

Add a **capability probe** the worker runs on boot: report `isSecureContext`, whether
`RTCPeerConnection` is constructible, and whether a DataChannel can be created on a loopback pair.
Surface the result through the transport as a typed diagnostic so the app can show a real error
instead of hanging. Put the probe result in your report — the owner verifies this on device first.

## 4. The worker document

`src/terminal/worker/` holds the source; `assets/terminal/` holds what ships.

**It must be fully offline.** No CDN, no remote script, no font fetch, no analytics. Everything is
bundled. `research/09 §TL;DR 2` — xterm assets are bundled into the app, and the WebView native
binary version is fixed by Expo Go, so install `react-native-webview` with `expo install`.

### 4.1 Contents

- xterm.js 5.5 configured to **match the web app exactly** (`research/09 §TL;DR 3`): Unicode 11,
  13px / 1.2 line height, **100,000-line scrollback**, WebGL renderer with DOM fallback, plus the
  Fit, WebLinks, Clipboard and Serialize addons. The web app has **no Search addon and never calls
  Serialize** (`research/09 §TL;DR 4`) — add Search deliberately for native search, and keep
  Serialize as an internal recovery hook only.
- The terminal palette from `research/01`'s terminal theme section, for both light and dark,
  switchable at runtime by a bridge message.
- `RTCPeerConnection` managing the two DataChannels.
- The bridge client.

### 4.2 Build step

The worker must end up as a single self-contained HTML string/asset. Do **not** add a bundler
dependency (you may not add dependencies). Options, in preference order: commit a generated
single-file HTML asset produced by a small script you write using what is already installed; or
inline the xterm sources at build time via a Node script run manually and committed. Whatever you
choose, **the generated artefact is committed** and the app never builds it at runtime. Document
the regeneration command in your report.

### 4.3 DataChannel protocol — implement precisely

From `research/04 §2-3`:
- Two channels, **both mandatory, fully ordered, fully reliable**: `spawn.pty` (protocol 2) and
  `spawn.ctl` (protocol 1). The daemon **closes the entire peer** if a channel is unknown,
  duplicated, unordered, lifetime-limited or retransmit-limited. Get the channel options exactly
  right.
- `spawn.pty` is **deliberately unframed raw binary** in both directions.
- `spawn.ctl` v1 is bounded JSON text **plus a 28-byte `SPCT` binary header** for replay and upload
  chunks.
- **Readiness is a five-way gate** (`research/04 §TL;DR 4`): signalling binding accepted → both
  channels open → daemon `ready` received → initial history reconstructed → only then may pending
  stdin flush (at most 64 KiB).
- **A single daemon input frame is capped at 64 KiB.** Every larger paste must be split. Enforce
  this in `write()`, not in the caller.
- Replay merges with live output by an explicit per-viewer `pty_offset`; **arrival order across the
  two channels is never inferred** (`research/04 §TL;DR 5`). Implement the offset-based merge, not
  a heuristic.
- Signed signalling uses **revision 2 / scope `session`** — see `P1-06`, which owns the codec.
  Import it; do not reimplement. The stale `proto/SIGNED_SIGNAL_V1.md` prose will mislead you.

### 4.4 Bridge protocol

`bridge.ts` defines a typed, versioned message union in both directions. Rules:
- **Terminal output never crosses it.** If you are tempted to post PTY bytes to RN, the
  architecture has been misunderstood — re-read §3.
- RN→worker: `init`, `connect`, `signal-frame`, `sign-response`, `input` (modifier-bar keys only),
  `resize`, `set-theme`, `set-font-size`, `scroll`, `set-follow`, `search`, `copy-selection`,
  `upload-*`, `close`.
- worker→RN: `ready`, `state`, `signal-frame`, `sign-request`, `title`, `bell`, `scroll-state`,
  `selection`, `diagnostic`, `upload-progress`, `error`.
- Version the protocol with a constant and reject mismatches loudly.
- Batch worker→RN events: `research/09 §TL;DR 9` sets **8ms / 32 KiB** batching, one xterm write in
  flight, **4 MiB** queued cap, and recovery via authoritative replay rather than mid-VT-stream
  byte dropping. Those numbers apply to the worker's internal write pump; keep the RN event stream
  well below them by coalescing scroll/state events.

## 5. `SessionTransport`, `HostTransport`, and the state machine

Implement `00-OVERVIEW.md §7.4` exactly. `HostTransport` is the same mechanism for
`spawn.host.ctl` — a separate peer per **host**, not per session (`00-OVERVIEW.md §3 D4`), hosted
in one hidden WebView per connected host. `P2-07` (files) consumes it; expose file operations as
typed request/response calls over the ctl channel, per `research/11 §1`.

`state-machine.ts` holds the connection state machine as a **pure reducer**:
```ts
export function reduce(state: TransportState, ev: TransportEvent): TransportState;
```
covering the five-way readiness gate, reconnection with backoff, retirement on app background
(coordinate with `P1-08`'s `retireAll()`), and terminal failure. Pure so it is exhaustively
testable without a WebView.

## 6. `TerminalSurface`

Implements `00-OVERVIEW.md §7.5`. It renders the WebView, wires the bridge, and exposes the
imperative handle. It owns **no chrome** — no header, no modifier bar, no connection chip. Those
are `P2-05`'s.

Behaviour it must get right:
- **Scroll ownership**: the terminal's scrollback owns one-finger vertical drags
  (`research/09 §TL;DR 8`). Configure the WebView and gesture handling so a vertical drag inside
  the terminal scrolls the buffer and does **not** start the overlay dismissal. `P1-02`'s
  `SwipeDismissOverlay` takes `dragHandleRegion='header'` for exactly this reason.
- **Never yank a reader**: if the user has scrolled away from the bottom, new output must not jump
  them to the end. Expose follow state via `setFollow`/`scroll-state` so `P2-05` can show a
  jump-to-latest pill.
- **Never refit rows during the soft-keyboard animation** (`research/09 §TL;DR 7`) — debounce the
  fit until the keyboard transition settles, or the terminal reflows repeatedly and looks broken.
- Theme changes and font-size changes apply without a reconnect.

## 7. Key encoding

`research/09 §TL;DR 6` requires **one tested byte encoder** for all special keys: web-parity keys
first, then momentary/locked Ctrl and Alt, symbols, navigation and job-control shortcuts.

Own the encoder here (`P2-05` renders the bar and calls it):
```ts
export function encodeKey(key: KeySpec): string;   // returns the exact byte sequence
```
Cover Esc, Tab, arrows, Home/End, PgUp/PgDn, Ctrl-<letter>, Alt-<key>, function keys, and the
literal characters the bar exposes. `research/09` gives the escape sequences literally — transcribe
them, do not derive them from memory. This table is pure and must be exhaustively unit-tested; a
wrong Ctrl-C is a broken product.

## 8. Session uploads

`research/11 §TL;DR 6-7`: session uploads use `spawn.ctl` (**not** the host protocol) — 20 MiB max,
48 KiB binary chunks, resumable with a stable upload UUID, four active uploads per viewer, durable
pre-final reconciliation, and `outcome_unknown` after final dispatch. The progress bar is a
**size-weighted pure state machine** (aggregate clamped bytes, show at least 4%, stay visible
420ms, paint complete when settled, fade 200ms) — `research/11` says to port its tests unchanged.
Do that: implement `upload.ts` as a pure state machine plus the ctl wiring, and port the web tests.

Do **not** merge session uploads with host file transfers behind one retry policy — their
acknowledgement boundaries, chunk sizes, ceilings and reconciliation differ (`research/11 §Scope`).

## 9. Rules specific to you

- No screen chrome, no navigation, no toasts.
- Import `P1-06` for signing and `P1-08` for signalling. Code against their published signatures;
  they may not exist yet mid-phase.
- Do not add dependencies. xterm must be vendored into `assets/terminal/`; if that proves
  impossible with what is installed, **stop and report it** rather than running `npm install`.
- Do not run the app, a simulator, or a device. Your verification is unit tests plus the capability
  probe's *code path*, not its device result.

## 10. Tests

Everything except the WebView itself is testable, so test it all.
- `ctl-codec.ts`: `SPCT` 28-byte header encode/decode, field-by-field, including bounds and
  malformed input; JSON frame validation.
- `state-machine.ts`: the five-way readiness gate in every order; premature stdin is buffered not
  sent; reconnect backoff; retirement; failure terminal states.
- `encodeKey`: exhaustive table test, one case per key/modifier combination.
- `upload.ts`: the ported web progress tests, plus chunking at 48 KiB, the 20 MiB ceiling, the
  four-concurrent cap, resume with a stable UUID, and `outcome_unknown` handling.
- `bridge.ts`: message serialisation both ways, version mismatch rejection, event coalescing.
- 64 KiB input chunking in `write()`.
- Replay/live merge by `pty_offset`, including out-of-order arrival across channels.
- `TerminalSurface`: renders, forwards handle calls to the bridge (mock the WebView), does not
  refit during a simulated keyboard transition.

## 11. Deliverables checklist

- [ ] Offline worker document with xterm 5.5 at web-parity configuration, committed as an asset
- [ ] Secure-context strategy implemented with the documented fallback and a capability probe
- [ ] Both DataChannels with exactly correct options; peer-closing pitfalls avoided
- [ ] Five-way readiness gate; 64 KiB input chunking; offset-based replay merge
- [ ] Signing delegated to `P1-06`; key never in the WebView
- [ ] Signalling relayed through `P1-08`; no socket owned here
- [ ] `SessionTransport`, `HostTransport`, `TerminalSurface` matching §7.4/§7.5 exactly
- [ ] `encodeKey` table complete and exhaustively tested
- [ ] Upload state machine with the web tests ported
- [ ] All suites green; `typecheck`, `lint` clean for your files
- [ ] Progress file current; final report written

## 12. Reporting

Progress: `docs/native/progress/P1-09.md` — update it often; you are the agent most likely to be
long-running.

Final report: `docs/native/reports/P1-09.md`, and make it good. It must contain: the bridge message
union in full; the worker regeneration command; the capability-probe design and what the owner
should look for on device; the exact DataChannel options used; the `encodeKey` table; every place
`research/04` or `research/09` was wrong; `## Requests for other agents`; `## Known gaps` — being
explicit about what genuinely cannot be verified without a physical iPhone.
