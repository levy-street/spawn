# P1-08 — Realtime: sockets, app lifecycle, and cache coherence

**Phase 1, parallel with eight other agents.** You keep the app live. On a phone that means
handling everything the web client never had to: backgrounding, screen lock, wifi↔cellular
switches, and resuming after hours asleep.

**Read first:** `00-OVERVIEW.md` (§3 D2/D3/D4, §5, §7.3, §7.6, §8), then
`research/10-realtime-and-alerts.md` **in full**, then `research/03-server-api.md §3` for the
server-side WebSocket message catalogue.

---

## 1. Objective

Ship the three WebSocket clients, the app-lifecycle/network wiring, the event→cache mapping, and
the Zustand stores holding transport-local state.

## 2. Files you own

```
src/data/realtime/socket.ts            # shared reconnecting-socket primitive
src/data/realtime/alert-socket.ts      # /ws/alerts, spawn.alerts.v1
src/data/realtime/session-signal.ts    # /ws/browser, spawn.v3 — signalling relay
src/data/realtime/host-signal.ts       # /ws/host, spawn.host.v1 — signalling relay
src/data/realtime/event-map.ts         # inbound event → query invalidation/patch (pure)
src/data/realtime/lifecycle.ts         # AppState + network → focusManager/onlineManager
src/data/realtime/provider.tsx         # mounts the sockets, exposes connection state
src/data/stores/connection.ts          # zustand: socket + transport state
src/data/stores/alerts.ts              # zustand: in-memory alert state
src/data/stores/session-ui.ts          # zustand: per-session UI state that isn't server truth
src/data/realtime/__tests__/**
src/data/stores/__tests__/**
```

You own the **signalling relay**, not the WebRTC peer — `P1-09` owns the WebView worker and the
DataChannels. The boundary: you deliver signalling frames to and from the server; `P1-09` hands you
frames to send and consumes frames you receive. Code against §3.4.

## 3. Specifications

### 3.1 Three separate transports

`research/10 §1`:

| Plane | Endpoint | Subprotocol | Carries |
|---|---|---|---|
| Owner alerts | `/ws/alerts` | `spawn.alerts.v1` | alert + keepalive JSON |
| Terminal session | `/ws/browser?session_id=<uuid>` | `spawn.v3` | lifecycle + WebRTC signalling JSON |
| Host control | `/ws/host?host_id=<uuid>` | `spawn.host.v1` | WebRTC signalling JSON |

Auth on all three: `?token=<jwt>` from `P1-05`'s URL builders (`research/03 §TL;DR 7` — the query
path is the only guaranteed cross-platform auth). Never put terminal bytes on any of these.

### 3.2 `socket.ts` — the shared primitive

One reconnecting-WebSocket implementation the three clients build on:
- subprotocol negotiation; connect/close lifecycle; typed send;
- **server ping every 25s, client watchdog at 80s**, jittered exponential reconnect between **1s
  and 15s** — these are the alert socket's real parameters (`research/10 §TL;DR 2`); use them as
  the default and allow per-socket override;
- a **generation counter**: every reconnect increments it, and frames from a retired generation are
  discarded. This is how you avoid a stale socket resurrecting dead state after a network switch;
- explicit state machine: `idle | connecting | open | reconnecting | closed | failed`, exposed as
  a subscribable value.

There is **no cursor, acknowledgement, replay or durable history** on the alert socket
(`research/10 §TL;DR 2`). Do not design a resume protocol the server does not implement. On
reconnect, the correct behaviour is a **refetch sweep**, not a replay request.

### 3.3 `alert-socket.ts`

Consumes `spawn.alerts.v1`. Parse every documented frame type into a typed union. Alert delivery
is transient and device-local (`research/10 §TL;DR 6`) — alerts are not durable, so hold them in
the Zustand store, and derive visual attention badges from refreshed session state rather than
from stored alerts.

`P2-09` owns alert presentation and local notifications; you own reception and state.

### 3.4 Signalling relays — the contract with `P1-09`

`session-signal.ts` and `host-signal.ts` are thin: connect, authenticate, relay.

```ts
export interface SignalChannel {
  readonly state: SocketState;
  send(frame: unknown): void;
  onFrame(fn: (frame: unknown) => void): () => void;
  close(): void;
}
export function openSessionSignal(sessionId: string): SignalChannel;
export function openHostSignal(hostId: string): SignalChannel;
```

`P1-09`'s transport calls `openSessionSignal`, forwards offer/answer/ICE frames from the WebView
worker into `send`, and pushes frames from `onFrame` into the worker. Do not parse or interpret
the WebRTC payloads — relay them. Do handle lifecycle frames (session ready/closed/revoked) and
map them per §3.5.

**Retire aggressively.** `research/10 §TL;DR 8`: on background or interface change, retire every
stale socket and RTC generation. Expose `retireAll()` for `lifecycle.ts` to call.

### 3.5 `event-map.ts` — pure, and the highest-value thing you test

For every inbound frame, decide what happens to the cache. `research/10 §2` gives the mapping
table.

```ts
export type CacheEffect =
  | { kind: 'invalidate'; key: readonly unknown[] }
  | { kind: 'patch'; key: readonly unknown[]; update: (prev: unknown) => unknown }
  | { kind: 'none'; reason: string };
export function effectsForFrame(frame: RealtimeFrame): CacheEffect[];
```

Keep it a **pure function** with no QueryClient reference — the provider applies the effects. That
makes the entire mapping table unit-testable without a network or a React tree.

Note `research/10 §TL;DR 4`: today **no inbound event directly patches a React Query entity**;
alert events invalidate the sessions prefix and most live state stays transport-local until REST
polling catches up. Start by matching that behaviour exactly. Where a `patch` is obviously
correct and safe, you may add it — but say so explicitly in your report rather than quietly
diverging from the web client.

Use `P1-07`'s `queryKeys` registry for every key. Do not write key tuples by hand.

### 3.6 `lifecycle.ts` — the mobile-only problem

The web client assumes a foregrounded tab. A phone does not. `research/10 §6` enumerates every
assumption that breaks. Implement:

- **AppState → React Query `focusManager`**: `active` marks focused, `background`/`inactive`
  unfocused.
- **Network reachability → `onlineManager`**, using the reachability API available in Expo Go
  (`expo-network`, or `@react-native-community/netinfo` if `P0-01` installed it — use what exists;
  do not add a dependency).
- **On background:** stop watchdogs, retire sockets and RTC generations, cancel timers. Do not hold
  a socket open in the background expecting it to survive; iOS will suspend it.
- **On resume:** a deterministic sweep — reconnect sockets, then refetch the active screen's
  queries, then let `P1-09` re-establish transports for any visible terminal. Order matters; make
  it explicit and testable.
- **On interface change (wifi↔cellular):** treat as a hard reconnect, not a soft retry. The old
  socket is dead even though it has not noticed.

Expose the sweep as a pure-ish, injectable function so it can be tested with a fake clock and fake
socket set.

### 3.7 Stores

Zustand, small and specific:
- `connection.ts` — socket states and per-session/host transport states, so any screen can show a
  connection chip without prop drilling.
- `alerts.ts` — in-memory alerts, claim/dedup semantics per `research/10 §4`.
- `session-ui.ts` — per-session UI state that is not server truth (follow/auto-scroll, font size,
  last-known title). Keyed by session id, cleaned up when a session closes.

No store may duplicate server truth that React Query already owns.

## 4. Rules specific to you

- No UI beyond `provider.tsx`, which renders nothing but children.
- No WebRTC. If you find yourself typing `RTCPeerConnection`, you are in `P1-09`'s territory.
- Never leak a socket: every subscribe returns an unsubscribe, every effect cleans up, every
  generation gets retired.
- No polling loops as a substitute for events, and no `setInterval` that survives backgrounding.

## 5. Tests

Mock `WebSocket` entirely; never open a real one.
- `socket.ts`: connect/open/close transitions; watchdog fires at 80s without a ping (fake timers);
  reconnect backoff is jittered within 1–15s and resets on success; generation counter discards
  frames from a retired generation.
- `event-map.ts`: a case per documented frame type, asserting the exact effects. Table-driven.
- `lifecycle.ts`: background retires everything; resume runs the sweep in the specified order;
  interface change forces a hard reconnect; `focusManager`/`onlineManager` receive the right calls.
- `alert-socket.ts`: frame parsing for every type, including malformed frames (must not throw).
- Stores: reducers/actions, and cleanup when a session closes.

## 6. Deliverables checklist

- [ ] Shared reconnecting socket with 25s/80s/1–15s parameters and generation retirement
- [ ] Three clients on the correct endpoints and subprotocols, authenticated via `?token=`
- [ ] `SignalChannel` contract exactly as §3.4, for `P1-09`
- [ ] Pure `effectsForFrame` mapping using `P1-07`'s query keys
- [ ] Lifecycle wiring for background, resume and interface change
- [ ] Three focused Zustand stores, no duplication of server truth
- [ ] All suites green; `typecheck`, `lint` clean for your files
- [ ] Progress file current; final report written

## 7. Reporting

Progress: `docs/native/progress/P1-08.md`. Final report: `docs/native/reports/P1-08.md` with the
socket parameters as implemented, the **complete frame→effect table**, the resume sweep order, the
`SignalChannel` API `P1-09` must integrate with, any place you diverged from the web client's
invalidation behaviour and why, `## Requests for other agents`, `## Known gaps`.
