# R04 — Terminal transport: WebRTC DataChannels, signed signalling, and session I/O

## TL;DR

1. Terminal content never uses the application server: `/ws/browser` is authenticated signalling/lifecycle metadata only, while raw PTY bytes use endpoint-to-endpoint WebRTC DataChannels (`spawn.pty` plus `spawn.ctl`). (`docs/INTERFACE_MATRIX.md:40-42`, `docs/INTERFACE_MATRIX.md:55-64`)
2. Both channels are mandatory, fully ordered, and fully reliable; the daemon rejects an unknown, duplicate, unordered, lifetime-limited, or retransmit-limited channel and closes the entire peer. (`web/src/components/terminal/useSessionSocket.ts:432-441`, `daemon/src/rtc.rs:1823-1894`)
3. `spawn.pty` is deliberately unframed raw binary in both directions; `spawn.ctl` v1 is bounded JSON text plus a 28-byte `SPCT` binary header for replay and upload chunks. (`proto/README.md:818-844`)
4. Readiness is a five-way gate: signalling binding accepted, both channels open, daemon `ready` received, initial history reconstructed, then pending stdin (at most 64 KiB) may flush; every larger paste must be split because one daemon input frame is capped at 64 KiB. (`web/src/components/terminal/useSessionSocket.ts:796-832`, `daemon/src/pty.rs:148-153`)
5. Replay is endpoint-only, encrypted at rest on the host with per-worker ChaCha20-Poly1305, and merged with live output by an explicit per-viewer `pty_offset`; arrival order across the two DataChannels is never inferred. (`daemon/src/sessiond/scrollback.rs:58-78`, `proto/README.md:1018-1028`)
6. Signed signalling signs one exact revision-2 binary transcript with pure Ed25519; it has no timestamp, and replay fencing instead uses the signed RTC UUID plus outer 128-bit nonce, daemon ownership generation, finite broker lifetime, and retired-binding tombstones. (`web/src/lib/signed-signal.ts:186-210`, `server/spawn_server/ws/host_signal.py:20-30`)
7. The checked-in `SIGNED_SIGNAL_V1.md` and `SIGNED_SIGNAL_WIRE_V1.md` prose still says transcript version 1 / `agent`; current code, vectors, and `proto/README.md` require version 2 / `session` and must be treated as authoritative. (`proto/SIGNED_SIGNAL_V1.md:19-30`, `web/src/lib/signed-signal.ts:6-20`, `proto/README.md:1366-1380`)
8. `react-native-webrtc` 124.0.8 requires custom native code and cannot run in Expo Go; its config plugin 15.0.2 only makes it viable in a development/EAS build. [Upstream](https://github.com/react-native-webrtc/react-native-webrtc), [registry package](https://registry.npmjs.org/react-native-webrtc/latest), [registry plugin](https://registry.npmjs.org/%40config-plugins%2Freact-native-webrtc/latest)
9. Expo SDK 57 includes `react-native-webview` 13.16.1 in Expo Go, and WKWebView can run WebRTC; a dedicated HTTPS WebView transport worker is therefore the only existing direct, E2E, Expo-Go-compatible route. [Expo SDK 57 WebView](https://docs.expo.dev/versions/v57.0.0/sdk/webview/), [Apple WKWebView](https://developer.apple.com/videos/play/wwdc2021/10032/)
10. **RECOMMEND:** ship a swappable `SessionTransport` around a WebView worker for the Expo-Go milestone, bridge control/events as JSON but terminal bytes in bounded base64 batches, and later add native `react-native-webrtc` behind the same interface for development/production builds.

## Scope, authority, and important document drift

This report covers only the per-session terminal transport: authentication of the browser signalling socket, signed RTC signalling, ICE/DTLS/SCTP, the two DataChannels, replay/live merge, stdin, resize/display ownership, direct session uploads, reconnection, and the Expo Go transport decision. Host-wide `spawn.host.ctl` file operations are a different peer/protocol and are mentioned only where they constrain signed-signal topology.

The current interaction matrix says terminal input/output has no HTTP surface and uses ordered reliable `spawn.pty`; replay, resize, display ownership, and upload likewise have no HTTP surface and use ordered reliable `spawn.ctl` v1. It names `/ws/browser` with subprotocol `spawn.v3`, `spawn.pty` protocol 2, and `spawn.ctl` protocol 1. (`docs/INTERFACE_MATRIX.md:40-42`, `docs/INTERFACE_MATRIX.md:55-64`)

There is a material spec-name/version trap:

- `proto/SIGNED_SIGNAL_V1.md` still prints transcript version `1` and scope code 1 as `agent`. (`proto/SIGNED_SIGNAL_V1.md:19-30`)
- `proto/SIGNED_SIGNAL_WIRE_V1.md` likewise still prints `agent` in the JSON topology. (`proto/SIGNED_SIGNAL_WIRE_V1.md:12-27`)
- Current browser and daemon code both encode transcript revision **2**, with scope code 1 named **`session`**. (`web/src/lib/signed-signal.ts:6-20`, `daemon/src/signed_signal.rs:13-22`, `daemon/src/signed_signal.rs:46-65`)
- The current exhaustive protocol reference explicitly says revision 2 and rejects revision 1. (`proto/README.md:1366-1380`)
- The golden fixture itself begins `...5631 02...` after the ASCII magic and uses `"scope_type":"session"`. (`proto/signed-signal-v1-vectors.json:25-38`)

**RECOMMEND:** implement and name the mobile codec `signed-signal transcript revision 2`; retain the existing fixture filenames for compatibility, but do not copy the stale version/scope prose.

## 1. Transport planes and invariants

### 1.1 Three distinct planes

| Plane | Connection | Carries | Must never carry |
|---|---|---|---|
| Browser signalling | `wss://<server>/ws/browser?session_id=<UUID>`, WS subprotocol `spawn.v3` | `rtc.config`, `rtc.offer`, `rtc.answer`, `rtc.candidate`, `rtc.status`, `rtc.close`, `session.status`, `session.exit` | PTY bytes, history, viewport operations, uploads |
| Session PTY | WebRTC DataChannel label `spawn.pty`, signalled protocol `spawn.pty` version 2 | raw binary stdin and raw binary PTY output | JSON, application framing, replay metadata |
| Session control | WebRTC DataChannel label `spawn.ctl`, internal protocol version 1 | control JSON, ready/display/history events, replay binary chunks, upload JSON/binary chunks | signalling |

The server route constant is `spawn.pty` protocol 2 and WS subprotocol `spawn.v3`. (`server/spawn_server/ws/browser.py:41-47`)

The server explicitly closes with code 4002 if binary content arrives on the signalling WS, closes if terminal-control operation names arrive there, and closes retired `upload` frames. (`server/spawn_server/ws/browser.py:344-390`)

The daemon states the invariant directly: the central WebSocket is authenticated, content-free control/signalling; PTY input/output and replay are endpoint-only. (`daemon/src/rtc.rs:1-4`)

The control plane therefore observes account/session/host metadata, connection and signalling timing, IP/traffic metadata, and SDP/ICE, but not terminal bytes. DTLS keys live at the peers and a TURN server relays opaque ciphertext. (`docs/TRUST.md:41-69`, `docs/TRUST.md:83-105`)

### 1.2 Mandatory channel properties

The browser creates both channels before creating the offer:

```ts
// web/src/components/terminal/useSessionSocket.ts:432-441
const pc = new RTCPeerConnection({
  iceServers,
  iceTransportPolicy: forceRelay ? "relay" : "all",
});
const reliableOrderedChannel: RTCDataChannelInit = { ordered: true };
const ptyDc = pc.createDataChannel("spawn.pty", reliableOrderedChannel);
const ctlDc = pc.createDataChannel("spawn.ctl", reliableOrderedChannel);
```

Omitting `maxPacketLifeTime` and `maxRetransmits` is semantically required, not an incidental default. The daemon accepts only:

```rust
// daemon/src/rtc.rs:1823-1829
let reliable = dc.ordered()
    && dc.max_packet_lifetime().is_none()
    && dc.max_retransmits().is_none();
let known_label = matches!(dc.label(), CONTROL_DATA_CHANNEL_LABEL | PTY_DATA_CHANNEL_LABEL);
if !reliable || !known_label {
    let _ = close.initiate();
}
```

It separately tracks `pty_seen`, `control_seen`, `pty_open`, `control_open`, and a terminal failure flag. A second channel with either label fails; readiness becomes true only when both known channels are open. (`daemon/src/rtc.rs:375-500`)

The browser supplies no other `RTCDataChannelInit` member: these are in-band browser-created channels (`negotiated:false`, ID chosen by SCTP), and the WebRTC `protocol` string is empty because `protocol` is omitted. The `spawn.pty` **protocol version 2** in signed signalling is an application route/version, not the RTCDataChannel `protocol` property. (`web/src/components/terminal/useSessionSocket.ts:432-441`, `web/src/lib/ws.ts:118-131`)

Both must appear/open within 10 seconds on the daemon; otherwise it reports `rtc.status:failed` and closes the peer. (`daemon/src/rtc.rs:73-87`, `daemon/src/rtc.rs:1778-1803`)

**There is no per-message application compression.** PTY bytes are passed unchanged. Replay chunks and uploads are unchanged payload bytes. JSON history deltas use base64, which expands data. WebRTC itself supplies DTLS/SCTP transport behavior, but neither client nor daemon invokes deflate, Brotli, or another application compressor on these channels. (`proto/README.md:818-836`, `web/src/lib/session-ctl.ts:430-458`, `daemon/src/rtc.rs:2326-2344`)

## 2. End-to-end sequence: tap to rendered bytes

The following is the exact session-opening sequence a mobile implementation must reproduce.

### 2.1 Authentication and signalling setup

1. The user taps an existing session. The UI already knows its canonical session UUID and creates/claims the terminal surface.

2. The client measures its initial terminal grid. The web client waits for xterm's first fit and stores `{cols, rows}` as `initialSize`; it does **not** emit a standalone resize before the transport exists. (`web/src/components/terminal/Terminal.tsx:2230-2237`)

3. The client opens:

   ```text
   GET /ws/browser?session_id=<session UUID>
   Sec-WebSocket-Protocol: spawn.v3
   ```

   The URL helper and required subprotocol are the browser contract. (`web/src/lib/ws.ts:1-14`, `web/src/lib/ws.ts:21-34`)

4. Server authentication accepts, in priority order, an `Authorization: Bearer <access-token>` header, the `spawn_session` cookie, or `?token=<access-token>`. It then requires token kind `access`, subject `user:<id>`, a live user row, and ownership of the requested session. (`server/spawn_server/ws/browser.py:123-186`)

5. The server requires `spawn.v3`, accepts it, and immediately sends content-free frames:

   ```json
   {"type":"rtc.config","enabled":true,"ice_servers":[...],"binding_nonce_required":true}
   {"type":"session.status","status":"running"}
   ```

   (`server/spawn_server/ws/browser.py:159-200`)

6. The browser marks its coarse socket `state` as `open` as soon as this WebSocket opens. This does **not** mean terminal I/O is ready; `dcOpen` is a separate condition. (`web/src/components/terminal/useSessionSocket.ts:1245-1269`)

### 2.2 RTC generation and trust

7. On enabled `rtc.config`, the client must require `binding_nonce_required:true`. If omitted/false, it closes the WS with protocol error rather than negotiating a weaker binding. (`web/src/components/terminal/useSessionSocket.ts:1284-1295`)

8. The client creates a new RTC session UUID and a 16-byte CSPRNG nonce encoded as exactly 32 lowercase hex characters. No CSPRNG means fail closed. (`web/src/components/terminal/useSessionSocket.ts:148-175`, `server/spawn_server/ws/host_signal.py:94-103`)

9. It creates `RTCPeerConnection({iceServers, iceTransportPolicy:"all"})`, or `"relay"` only for the explicit diagnostic force-TURN hook, then creates both mandatory channels as above. (`web/src/components/terminal/useSessionSocket.ts:410-442`)

10. Before `createOffer`, it resolves browser/host trust. That ordering avoids delaying daemon ICE gathering while browser identity/pin data is read. Trust produces one of:

    - `signed`, with an opaque signing capability and a verified or first-contact host pin;
    - `unpinned`, allowing raw SDP only for the explicit compatibility/first-contact policy;
    - `refuse`, which is fatal and not silently downgraded or auto-retried.

    (`web/src/components/terminal/useSessionSocket.ts:1165-1201`, `web/src/lib/signed-rtc-trust.ts:17-62`, `web/src/lib/signed-rtc-trust.ts:93-149`, `web/src/lib/signed-rtc-trust.ts:191-231`)

11. The client calls `createOffer()` and `setLocalDescription(offer)`. In signed mode it constructs one immutable `SignedRtcLiveSession` route:

    ```ts
    {
      scopeType: "session",
      scopeId: sessionId,
      protocol: "spawn.pty",
      protocolVersion: 2,
    }
    ```

    and signs the exact local SDP. (`web/src/components/terminal/useSessionSocket.ts:1203-1223`)

12. It sends one offer carrier on the signalling WS:

    ```json
    {
      "type":"rtc.offer",
      "session_id":"<new RTC UUID>",
      "binding_nonce":"<32 lowercase hex>",
      "scope_type":"session",
      "scope_id":"<PTY session UUID>",
      "protocol":"spawn.pty",
      "protocol_version":2,
      "signed_envelope":"<opaque exact JSON string>"
    }
    ```

    Raw mode substitutes `"sdp":"..."`; signed mode must contain no sibling `sdp`. (`web/src/components/terminal/useSessionSocket.ts:1219-1237`, `server/spawn_server/ws/browser.py:391-422`)

### 2.3 Server binding, daemon answer, ICE, DTLS, SCTP

13. The server structurally validates the exact outer tuple, nonce, SDP/envelope bounds, and signed-mode shape. It does **not** verify the Ed25519 signature or provide a pin; it forwards the original signed string unchanged. (`server/spawn_server/ws/signed_signal_relay.py:1-7`, `server/spawn_server/ws/signed_signal_relay.py:114-229`)

14. The signalling broker binds the RTC UUID to this browser route, session scope, selected daemon connection, durable daemon ownership generation, nonce, protocol/version, and signed/raw mode. An active ID collision or retired exact binding identity is rejected. (`server/spawn_server/ws/broker.py:270-353`)

15. The server sends the browser `rtc.status:"negotiating"` with `binding_generation`, then forwards the exact offer plus ICE servers to the daemon's `/ws/daemon` control connection. (`server/spawn_server/ws/browser.py:463-536`)

16. In signed mode, the daemon verifies the envelope against every locally approved browser public-key pin and its own host identity key. By default it rejects unsigned offers; `SPAWND_REQUIRE_SIGNED_RTC=0` or `false` is the explicit recovery escape hatch. (`daemon/src/run.rs:1013-1035`, `daemon/src/run.rs:1145-1228`)

17. The daemon additionally requires the verified signed session/scope to equal the outer bound route, captures the concrete session backend generation, creates its peer, applies the verified offer SDP, creates an answer, applies local SDP, and signs that exact answer for the offering browser key. (`daemon/src/run.rs:1038-1070`, `daemon/src/run.rs:1229-1278`, `daemon/src/rtc.rs:572-843`, `daemon/src/rtc.rs:1693-1706`)

18. Both peers trickle ICE candidates using `rtc.candidate`. Candidates emitted before the offer goes out are queued; remote candidates received before the answer is safely applied are queued. Every candidate repeats and must match the complete bound tuple. (`web/src/components/terminal/useSessionSocket.ts:1003-1017`, `web/src/components/terminal/useSessionSocket.ts:1339-1416`)

19. The browser accepts `rtc.answer` only after its RTC UUID, nonce, broker generation, session scope/id, protocol, and protocol version match. In signed mode it verifies the host key pin, intended browser key, signature, transcript, role, and SDP, and then applies **only** the SDP returned by the verifier; the raw sibling is never read. Any error closes the peer permanently for that generation. (`web/src/components/terminal/useSessionSocket.ts:1296-1392`, `web/src/lib/signed-rtc-live.ts:172-220`, `web/src/lib/signed-rtc-live.ts:243-279`)

20. ICE selects direct host, server-reflexive/STUN, or TURN relay candidates. WebRTC then negotiates DTLS endpoint-to-endpoint and SCTP DataChannels. TURN does not terminate DTLS and therefore sees ciphertext, peer addresses, volume, and timing, not terminal content. (`docs/TRUST.md:50-69`)

### 2.4 Channel opening, replay barrier, and live rendering

21. The daemon receives the two browser-created channels, rejects incorrect properties/labels/duplicates, and waits for both open. (`daemon/src/rtc.rs:1753-1894`)

22. Once both are open, the daemon registers this viewer, installs the live PTY direct sink, sends bound signalling `rtc.status:"connected"`, and sends on `spawn.ctl`:

    ```json
    {
      "version":1,
      "kind":"event",
      "event":"ready",
      "upload_capability":"<UUID>",
      "agent_generation":7,
      "upload_max_bytes":20971520,
      "upload_chunk_bytes":49152
    }
    ```

    The server uses `connected` to extend/mark the broker binding; the browser does not use it as terminal readiness. `agent_generation` is frozen v1 vocabulary for the current session backend generation. (`daemon/src/rtc.rs:2121-2144`, `server/spawn_server/ws/browser.py:308-318`, `web/src/lib/session-ctl.ts:62-71`, `daemon/src/rtc.rs:2527-2576`, `docs/INTERFACE_MATRIX.md:81-86`)

23. PTY output may race ahead of replay. The browser counts all received PTY bytes and buffers pre-bootstrap chunks, with a hard 12 MiB cap. (`web/src/components/terminal/useSessionSocket.ts:1042-1081`, `web/src/lib/session-ctl.ts:1-9`)

24. Only after `ready` and both channel-open callbacks, the client sends initial history on `spawn.ctl`:

    ```json
    {
      "version":1,
      "kind":"request",
      "request_id":"<fresh UUID>",
      "operation":"history",
      "lines":400,
      "plain":false,
      "cols":<initial cols>,
      "rows":<initial rows>
    }
    ```

    It also sends `history_subscribe`. (`web/src/components/terminal/useSessionSocket.ts:930-970`)

25. The daemon optionally applies the requested geometry if this viewer owns display control, captures replay with a source watermark, translates it to this viewer's `spawn.pty` byte coordinate, and returns replay metadata followed by 0..N binary chunks. (`daemon/src/rtc.rs:2639-2892`, `daemon/src/rtc.rs:2983-3118`)

26. The browser assembles only chunks correlated to the request UUID and exact metadata, renders replay first, treats returned `pty_offset` as an explicit barrier, discards buffered live bytes at or before it, slices a straddling chunk, and renders only the suffix. (`web/src/components/terminal/useSessionSocket.ts:834-928`, `web/src/lib/session-ctl.ts:196-281`, `web/src/lib/session-ctl.ts:326-346`)

27. Terminal readiness becomes true only when `ptyOpen && ctlOpen && serverReady && bootstrapDone`. At that point it clears the 10-second client connect timer, marks `dcOpen`, resolves upload waiters, and flushes same-generation pending stdin. (`web/src/components/terminal/useSessionSocket.ts:796-832`)

28. Subsequent `spawn.pty` binary messages are passed as `Uint8Array` to xterm in DataChannel order. Blob-to-ArrayBuffer conversions use a promise tail so asynchronous decode cannot reorder messages. (`web/src/components/terminal/useSessionSocket.ts:1054-1081`, `web/src/lib/session-ctl.ts:283-295`)

29. On normal close/unmount, the client sends `rtc.close` with RTC UUID, nonce, and session tuple, closes both channels and the peer, then closes the signalling WS with code 1000. (`web/src/components/terminal/useSessionSocket.ts:332-392`, `web/src/components/terminal/useSessionSocket.ts:1489-1509`)

30. A process exit is disclosed separately on signalling as `{"type":"session.exit","exit_code":number|null,"signal":string|null}` and status is one of `starting | running | exited | killed`. The hook passes these to UI callbacks; the terminal writes a local yellow exit banner. This metadata frame is not PTY output and must not be injected into the byte stream by the transport. (`web/src/lib/ws.ts:59-67`, `web/src/components/terminal/useSessionSocket.ts:1280-1284`, `web/src/components/terminal/Terminal.tsx:1300-1307`)

## 3. Complete DataChannel protocol

### 3.1 `spawn.pty`

| Property | Contract |
|---|---|
| Label | exact ASCII `spawn.pty` |
| Creator | browser/mobile peer |
| Ordered | `true` |
| Reliable | yes; both `maxPacketLifeTime` and `maxRetransmits` omitted / `null` |
| Browser → daemon message | non-empty binary bytes, interpreted as stdin |
| Daemon → browser message | binary raw PTY output |
| Text message | ignored by the daemon for stdin; browser ignores text output |
| Application header | none |
| Application compression | none |
| Application ACK/sequence | none; relies on reliable ordered SCTP |
| Maximum daemon worker input frame | 64 KiB |
| Daemon live output chunking | split into at most 16 KiB DataChannel messages |

The daemon callback passes `is_string` and bytes to the input forwarder; only binary, non-empty messages become PTY input. (`daemon/src/rtc.rs:1908-1946`, `daemon/src/rtc.rs:3140-3190`)

The worker's PTY input cap is 64 KiB, with 32 queued input items; its PTY reader emits at most 8 KiB per read with queue depth 8. (`daemon/src/sessiond/worker.rs:47-58`)

Spawnd splits direct output into 16 KiB parts, provides each viewer a queue of 128 parts, and drops/disconnects a lagging viewer rather than buffering indefinitely. (`daemon/src/pty.rs:122-153`, `daemon/src/pty.rs:703-738`)

The browser does not inspect `ptyDc.bufferedAmount` for ordinary keystrokes. Before readiness it maintains a separate 64 KiB generation-bound queue; after readiness, `send()` is immediate and returns success unless the platform throws. (`web/src/components/terminal/useSessionSocket.ts:137-146`, `web/src/components/terminal/useSessionSocket.ts:1592-1603`, `web/src/lib/session-ctl.ts:297-324`)

**Large-input trap:** the current web `sendBinary` sends its entire `Uint8Array` as one DataChannel message, while `SessionHandle::write_stdin` rejects a worker input above 64 KiB. Therefore a paste encoded above 65,536 bytes can be handed to WebRTC but fail at the daemon instead of being fully written. (`web/src/components/terminal/useSessionSocket.ts:1592-1603`, `daemon/src/pty.rs:152-153`, `daemon/src/pty.rs:990-1004`)

Even legal-size input has no endpoint ACK: spawnd uses a depth-32 `try_send` worker-command queue; a full queue makes that chunk fail and only logs a warning in the RTC callback. `RTCDataChannel.send()` success therefore means “accepted by the local WebRTC stack,” not “enqueued to the PTY.” (`daemon/src/pty.rs:150-152`, `daemon/src/pty.rs:1005-1011`, `daemon/src/rtc.rs:1933-1944`)

**RECOMMEND:** mobile `sendInput` must split input into ordered binary messages no larger than 64 KiB (16 KiB is the conservative cross-engine choice) before `spawn.pty.send`; for bulk paste it should also pace chunks against a bounded local `bufferedAmount` high/low watermark and yield between drains. This adds no wire header and does not change semantics: a PTY is a byte stream and its worker reads already have arbitrary boundaries. It reduces queue overflow but cannot create an end-to-end guarantee without a future protocol ACK. Never stringify input at the transport layer because control bytes and arbitrary UTF-8 paste bytes must remain exact.

### 3.2 `spawn.ctl` text requests

| Property | Contract |
|---|---|
| Label | exact ASCII `spawn.ctl` |
| Ordered/reliable | identical to `spawn.pty` |
| Protocol | locked version 1 inside each JSON/binary frame |
| Text bound | 16 KiB UTF-8 |
| Request ID | UUID text; new per ordinary operation; upload start uses stable upload UUID |
| Outstanding requests | at most 128 in browser tracker; at most 128 queued-before-ready control texts |

The generic encoder is literal:

```ts
// web/src/lib/session-ctl.ts:348-365
const text = JSON.stringify({
  ...parameters,
  version: SESSION_CTL_VERSION,
  kind: "request",
  request_id: requestId,
  operation,
});
return new TextEncoder().encode(text).byteLength <= SESSION_CTL_MAX_REQUEST_BYTES
  ? text
  : null;
```

Every request operation and parameter shape:

| Operation | Parameters | Result/effect |
|---|---|---|
| `history` | `lines` default 400; `plain:false`; optional `cols`,`rows` | replay metadata + chunks; optional initial resize if owner |
| `snapshot` | `lines` default 5000; `plain:false` | fresh replay metadata + chunks |
| `resize` | `cols`,`rows` | owner-only PTY/emulator resize; small ACK |
| `take_control` | `cols`,`rows` | transfers display ownership, resizes; small ACK + display events |
| `scroll` | non-zero `lines` in -200..200 | deprecated/no-op ACK |
| `redraw` | none | deprecated/no-op ACK |
| `history_subscribe` | none | enables committed-history events/capability path |
| `upload_start` | capability, frozen `agent_generation`, name, MIME, destination, byte/chunk counts, SHA-256 | ready/resume, cached complete, or error |
| `upload_cancel` | capability, generation, `upload_id` | cancels pre-publication temporary state |
| `upload_complete` | response operation only; clients do not request it | final acknowledged upload result |

The browser union is authoritative. (`web/src/lib/session-ctl.ts:18-28`)

The daemon validates history/snapshot line count 1..10,000, columns 20..400, rows 5..200, and scroll -200..200 excluding zero. Defaults are history 400 and snapshot 5000. (`daemon/src/session_ctl.rs:1-33`, `daemon/src/session_ctl.rs:163-270`)

`plain:true` is not implemented: the daemon returns `plain_replay_unsupported` rather than pretending ANSI replay is plain text. (`proto/README.md:866-876`)

### 3.3 `spawn.ctl` text responses and events

Ordinary response base:

```ts
// web/src/lib/session-ctl.ts:30-50
interface SessionCtlResponse {
  version: number;
  kind: "response";
  request_id?: string | null;
  operation?: SessionCtlOperation;
  ok: boolean;
  plain?: boolean;
  pty_offset?: number | null;
  total_bytes?: number;
  chunks?: number;
  error?: { code?: string; detail?: string };
  state?: "ready" | "complete";
  next_sequence?: number;
  received_bytes?: number;
  path?: string;
  sha256?: string;
  history_epoch?: string;
  history_offset?: number;
}
```

Complete unsolicited event set:

```ts
// web/src/lib/session-ctl.ts:52-109 (trimmed)
{version:1, kind:"event", event:"ready",
 upload_capability: UUID, agent_generation: positiveSafeInt,
 upload_max_bytes: 20971520, upload_chunk_bytes: 49152}

{version:1, kind:"event", event:"display_state",
 owner:boolean, cols:number|null, rows:number|null, viewers:number}

{version:1, kind:"event", event:"history_delta",
 history_epoch: decimalU64String, history_offset:safeInt, data:base64}

{version:1, kind:"event", event:"history_wipe",
 history_epoch: decimalU64String}

{version:1, kind:"event", event:"history_gap"}
```

The current web hook intentionally discards all three history events because its live xterm buffer already consumes raw bytes; the daemon still sends them, so a new mobile client must either reproduce that behavior or deliberately implement the documented anchored-delta scrollback model. (`web/src/components/terminal/useSessionSocket.ts:1126-1159`)

**RECOMMEND:** for parity with the current implementation, use replay/snapshot plus live PTY offsets first and ignore `history_delta`/`wipe`/`gap`; retain parser support so a later native scrollback store can consume them without a wire change.

### 3.4 `SPCT` binary header, byte by byte

Both replay (daemon → client) and upload (client → daemon) use the same 28-byte fixed header:

| Offset | Width | Encoding | Meaning |
|---:|---:|---|---|
| 0 | 4 | bytes `53 50 43 54` | ASCII `SPCT` magic |
| 4 | 1 | `01` | control protocol version 1 |
| 5 | 1 | `01` replay, `02` upload | frame kind |
| 6 | 2 | `u16 little-endian` | flags; only bit 0 allowed, `last` |
| 8 | 16 | raw UUID network byte spelling | replay request UUID or stable upload UUID |
| 24 | 4 | `u32 little-endian` | zero-based sequence number |
| 28 | ≤49,152 | raw bytes | payload |

Literal upload encoder:

```ts
// web/src/lib/session-ctl.ts:430-458
const frame = new Uint8Array(CHUNK_HEADER_BYTES + payload.byteLength);
frame.set(CHUNK_MAGIC);
frame[4] = SESSION_CTL_VERSION;
frame[5] = 2;
const view = new DataView(frame.buffer);
view.setUint16(6, last ? 1 : 0, true);
frame.set(requestBytes, 8);
view.setUint32(24, sequence, true);
frame.set(payload, CHUNK_HEADER_BYTES);
```

Literal replay decoder:

```ts
// web/src/lib/session-ctl.ts:637-658
if (bytes[4] !== SESSION_CTL_VERSION || bytes[5] !== 1) return null;
const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const flags = view.getUint16(6, true);
if ((flags & ~1) !== 0) return null;
const requestId = bytesToUuid(bytes.subarray(8, 24));
return {
  requestId,
  sequence: view.getUint32(24, true),
  last: (flags & 1) !== 0,
  payload: bytes.slice(CHUNK_HEADER_BYTES),
};
```

### 3.5 Chunking, ACK, sequencing, and flow control

Replay:

- Metadata is sent first with exact `total_bytes` and `chunks`.
- Payload is split into 48 KiB chunks.
- The client accepts a chunk only for a registered request with already accepted metadata.
- It rejects duplicates, out-of-range sequences, incorrect final flags, incorrect exact payload lengths, aggregate size above 12 MiB, and mismatched operation/request.
- It assembles only after all expected sequence numbers exist. (`web/src/lib/session-ctl.ts:196-281`, `web/src/lib/session-ctl.ts:637-685`)
- There is no per-chunk ACK. Reliable ordered SCTP carries the frames; the response metadata and request ID are the application correlation layer.

Upload:

- Whole upload maximum: 20 MiB.
- Payload: 48 KiB except exact final remainder.
- `upload_start` response is the resume ACK: `state:"ready"`, `next_sequence`, `received_bytes`.
- The stable upload UUID and exact manifest make three bounded start retries idempotent.
- There is no per-chunk ACK. Chunks must arrive in exact sequence with exact sizes/final bit.
- Completion response is the durable effect ACK: `operation:"upload_complete"`, path, total, SHA-256.
- The client waits when `ctlDc.bufferedAmount > 256 KiB`, sets `bufferedAmountLowThreshold=128 KiB`, and gives the low-water event 5 seconds. (`web/src/components/terminal/useSessionSocket.ts:568-592`)
- Daemon control responses use queue depth 64 and a 2-second enqueue/send timeout; display-state is a latest-value watch stream, so intermediate display states coalesce. (`daemon/src/session_ctl.rs:1-33`, `daemon/src/session_ctl.rs:442-467`, `daemon/src/rtc.rs:2274-2344`)
- Both daemon DataChannel send paths time out after 2 seconds and close a stalled viewer. (`daemon/src/rtc.rs:73-87`, `daemon/src/rtc.rs:2326-2357`)

## 4. Signed signalling, byte-exact

### 4.1 Canonical binary transcript revision 2

All integers below are unsigned **big-endian**. Text is strict UTF-8, unnormalized, with no NUL terminator. UUIDs are exactly 36 ASCII bytes in lowercase hyphenated canonical syntax.

| Order | Bytes | Field | Exact value/validation |
|---:|---:|---|---|
| 1 | 23 | domain magic | ASCII `SPAWN-RTC-SIGNAL-SIG-V1` |
| 2 | 1 | transcript revision | `0x02` only |
| 3 | 1 | signal kind | offer `0x01`, answer `0x02` |
| 4 | 4 | protocol version | `u32 BE`, 1..2³²−1; session must be exactly 2 |
| 5 | 2 + 36 | RTC session ID | `u16 BE=36`, then canonical RTC UUID text |
| 6 | 1 | scope type | session `0x01`, host `0x02` |
| 7 | 2 + 36 | scope ID | `u16 BE=36`, then canonical PTY session UUID text |
| 8 | 1 | sender role | browser `0x01`, daemon `0x02` |
| 9 | 32 | intended peer public key | raw strict Ed25519 compressed point |
| 10 | 4 + N | SDP | `u32 BE=N`, then 1..1,048,576 strict UTF-8 bytes |

The JSON `protocol` string and `signature_algorithm` string are **not literal transcript fields**. Compatibility/security instead comes from exact envelope-shape checks plus the fixed valid-topology mapping from `protocol` to scope/version/kind/role before signature verification. A new client must not insert either string into the transcript. (`web/src/lib/signed-signal-wire.ts:91-130`, `web/src/lib/signed-signal-wire.ts:191-263`)

This is the browser encoder:

```ts
// web/src/lib/signed-signal.ts:186-210
const output = new Uint8Array(length);
const view = new DataView(output.buffer);
let offset = 0;
output.set(SIGNED_SIGNAL_MAGIC, offset);
offset += SIGNED_SIGNAL_MAGIC.byteLength;
output[offset++] = SIGNED_SIGNAL_VERSION;
output[offset++] = enumCode(transcript.signalKind, signalKindCode, "signalKind");
view.setUint32(offset, transcript.protocolVersion, false); offset += 4;
view.setUint16(offset, sessionId.byteLength, false); offset += 2;
output.set(sessionId, offset); offset += sessionId.byteLength;
output[offset++] = enumCode(transcript.scopeType, scopeTypeCode, "scopeType");
view.setUint16(offset, scopeId.byteLength, false); offset += 2;
output.set(scopeId, offset); offset += scopeId.byteLength;
output[offset++] = enumCode(transcript.senderRole, senderRoleCode, "senderRole");
output.set(peerKey, offset); offset += ED25519_PUBLIC_KEY_BYTES;
view.setUint32(offset, sdp.byteLength, false); offset += 4;
output.set(sdp, offset);
```

The Rust encoder performs the same operations using `to_be_bytes()`. (`daemon/src/signed_signal.rs:160-188`)

Validation rejects wrong magic/revision/enums, protocol zero, noncanonical UUID text, invalid/lone-surrogate UTF-8, empty or oversized SDP, truncation, trailing bytes, malformed/noncanonical Ed25519 points, and small-order public keys. (`web/src/lib/signed-signal.ts:64-150`, `daemon/src/signed_signal.rs:191-241`, `daemon/src/signed_signal.rs:345-363`)

### 4.2 Signature algorithm and wire encoding

The algorithm is pure RFC 8032 Ed25519 over the complete encoded transcript. It does **not** prehash with SHA-256. Fixture SHA-256 values are diagnostics only.

```ts
// web/src/lib/signed-signal.ts:381-417 (trimmed)
const encoded = encodeSignedSignalTranscript(transcript);
const signature = new Uint8Array(
  await crypto.subtle.sign({ name: "Ed25519" }, privateKey, encoded),
);
return encodeBase64Url(signature);

return crypto.subtle.verify(
  { name: "Ed25519" }, publicKey, signature, encoded,
);
```

```rust
// daemon/src/signed_signal.rs:319-333
Ok(signing_key.sign(&transcript.encode()?))
// ...
verifying_key
    .verify_strict(&transcript.encode()?, signature)
```

Public keys are 32 raw bytes → exactly 43 characters of canonical unpadded base64url. Signatures are 64 bytes → exactly 86 characters. `=` padding, a non-URL alphabet, wrong width, noncanonical re-encoding, invalid point, and weak/small-order key all fail. (`web/src/lib/signed-signal.ts:6-16`, `daemon/src/signed_signal.rs:336-389`, `daemon/src/signed_signal.rs:425-452`)

The browser generates its Ed25519 private `CryptoKey` nonextractable and exposes a bounded signing closure rather than the private key. (`web/src/lib/signed-signal.ts:319-379`, `web/src/lib/signed-signal-wire.ts:24-28`)

### 4.3 Exact JSON envelope

An envelope is one JSON object with **exactly** these 12 fields and no duplicate/additional/missing field:

```ts
// web/src/lib/signed-signal-wire.ts:61-89
interface SignedRtcEnvelope {
  type: "rtc.offer" | "rtc.answer";
  signature_algorithm: "ed25519";
  sender_identity_public_key: string;
  intended_peer_identity_public_key: string;
  protocol: "spawn.pty" | "spawn.host.ctl";
  protocol_version: number;
  session_id: string;
  scope_type: "session" | "host";
  scope_id: string;
  sender_role: "browser" | "daemon";
  sdp: string;
  signature: string;
}
```

Valid topologies are exactly:

| Kind | Signer | Scope | Protocol/version |
|---|---|---|---|
| offer | browser | session | `spawn.pty` / 2 |
| answer | daemon | session | `spawn.pty` / 2 |
| offer | browser | host | `spawn.host.ctl` / 1 |
| answer | daemon | host | `spawn.host.ctl` / 1 |

The protocol/scope/version and offer/browser-answer/daemon mappings are checked before signature acceptance. (`web/src/lib/signed-signal-wire.ts:191-263`, `server/spawn_server/ws/signed_signal_relay.py:166-186`)

JSON bytes and property order are **not signed**. A verifier parses the exact-shaped object, independently pins sender and intended-peer keys, reconstructs the canonical binary transcript, verifies Ed25519, and returns trusted transcript fields. (`web/src/lib/signed-signal-wire.ts:133-189`, `proto/SIGNED_SIGNAL_WIRE_V1.md:60-74`)

Presence of `signed_envelope` selects signed mode even if malformed; a sibling raw `sdp` is an error and never a downgrade path. (`server/spawn_server/ws/signed_signal_relay.py:232-257`)

### 4.4 Nonce, timestamps, and replay windows

There is **no timestamp field** and **no signed timestamp replay window**. Do not invent either: doing so changes transcript bytes and makes every signature fail.

Likewise, `binding_nonce` and `binding_generation` are **outer signalling/broker fields, not signed transcript bytes**. They fence the live broker route and every relayed callback; the independently signed RTC UUID, scope, intended peer, role, version, and SDP fence the cryptographic signal. (`web/src/lib/ws.ts:118-195`, `server/spawn_server/ws/broker.py:270-353`)

Replay/freshness is layered instead:

1. `session_id` in the signed transcript is a new canonical RTC-generation UUID; a signature cannot move to another RTC generation.
2. `scope_type`, `scope_id`, role, intended peer key, protocol version, and SDP prevent cross-scope, reflection, redirection, downgrade, or modified-fingerprint reuse.
3. The outer `binding_nonce` is 128 CSPRNG bits (16 bytes, 32 lowercase hex).
4. The broker adds the selected daemon's positive safe-integer ownership `binding_generation`.
5. Every answer, candidate, status, and close must repeat the complete tuple. (`web/src/lib/ws.ts:118-196`)
6. A pre-connected broker binding lives 60 seconds; a connected binding is extended to 24 hours; an exact retired identity is tombstoned for 5 minutes. These are broker lifetimes, not signed timestamps. (`server/spawn_server/ws/host_signal.py:20-30`, `server/spawn_server/ws/broker.py:400-477`, `server/spawn_server/ws/broker.py:532-547`)
7. Daemon callbacks are also fenced to a concrete backend generation so a replacement worker cannot receive a stale callback. (`proto/README.md:1034-1044`)

### 4.5 Trust of each side

Browser verifies daemon:

- Resolve locally persisted host pin / first-contact decision before offer.
- Sign for that exact intended host public key.
- Require answer sender key to equal host pin.
- Require answer intended key to equal browser identity public key.
- Verify signature and exact immutable route/transcript.
- Apply only verified SDP. (`web/src/lib/signed-rtc-live.ts:71-165`, `web/src/lib/signed-rtc-live.ts:172-220`)

Daemon verifies browser:

- Read its durable host identity.
- Try the offer against each daemon-local approved browser pin.
- Require the exact signed RTC UUID and session scope to match outer routing.
- Default-reject unsigned offers.
- Sign answer for the verified offer's sender key. (`daemon/src/run.rs:1013-1070`, `daemon/src/run.rs:1145-1278`)

Server:

- Authenticates user/session ownership and the selected daemon generation.
- Structurally validates and routes.
- Does not validate the signature or supply trusted pins. (`server/spawn_server/ws/browser.py:123-200`, `server/spawn_server/ws/signed_signal_relay.py:1-7`)

### 4.6 Golden-vector self-test for a new client

`proto/signed-signal-v1-vectors.json` supplies:

- intended peer key wire `PUAXw-hDiVqStwqnTRt-vJyYLM8uxJaMwM1V8Sr0Zgw`;
- signing key wire `11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo`;
- RFC 8032 test seed `9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60`. (`proto/signed-signal-v1-vectors.json:1-21`)

For `session-offer`, a conforming codec must produce:

```text
SHA-256 diagnostic:
0497663df7234f1cdcd827c341a06340d27916012a302f5be0cf49ab18cb92d0

Ed25519 signature wire:
Axc3xSw-lL6IxTn450AW-TCZhpAyKICuWyIFOPJ10X7A4JVd1Z_k34I0nheEuoaQWsK-rGlACSCkElO5DZNEBA
```

and byte-for-byte equal `transcript_hex`. (`proto/signed-signal-v1-vectors.json:25-38`)

For `host-answer`, expected diagnostic/signature are:

```text
92a0156bb584ab071f5113588e3589b7f1c62f36cf01c3dab75a8a600d69a7b2
AH1t-tqSvBOUfYbYv7QI4ptplsFzSzcbYQ5EdEQVuIzXe-XtYa6Af8Ib3iMN2qpmDWQXwu58EUe-fHzoevEyDA
```

(`proto/signed-signal-v1-vectors.json:41-54`)

Self-test procedure:

1. Parse the fixture without normalizing UUID/SDP.
2. Encode transcript and compare every byte to `transcript_hex`.
3. Compute SHA-256 only as a diagnostic and compare `sha256_hex`.
4. Sign with the fixture seed; compare 64 bytes and canonical wire string.
5. Verify with signing public key.
6. Verify the other vector's signature against this transcript and require failure.
7. Mutate exactly one of kind, protocol version, RTC UUID, scope type/id, role, intended key, or SDP while retaining the signature; require failure.
8. Decode then re-encode and require byte equality.
9. Run the negative public-key corpus and reject all invalid/small-order/noncanonical entries.
10. Load `proto/signed-signal-wire-v1-vectors.json`, accept numeric spellings `2`, `2.0`, `2e0`, `2E+0` as the parsed integer 2, reject listed invalid numbers, verify both positive envelopes, and reject both correctly signed wrong-topology envelopes. (`proto/signed-signal-wire-v1-vectors.json:19-40`, `proto/signed-signal-wire-v1-vectors.json:42-79`, `proto/signed-signal-wire-v1-vectors.json:80-115`)

**RECOMMEND:** make these fixture tests a prerequisite for connecting to a real daemon. A client that passes a hand-written round trip but not the shared bytes is not compatible.

## 5. Replay, scrollback, and live merge

### 5.1 Host persistence and encryption bounds

Scrollback is not fetched from the application server. Each `spawn-worker` owns an append-only segmented log of committed terminal lines on the user's host. Lines are committed once when they scroll off the emulator screen; in-place TUI repaints are not history. (`daemon/src/sessiond/scrollback.rs:1-17`, `docs/SESSIOND.md:390-410`)

At-rest format:

```text
u32 little-endian ciphertext_len
u8 kind                       // current history kind = 3
u64 little-endian sequence
ciphertext || 16-byte AEAD tag
```

Cipher: ChaCha20-Poly1305, one seal per record. Nonce is 12 bytes: four zero bytes then the `u64` sequence in little-endian. AAD is `kind || sequence_le`. (`daemon/src/sessiond/scrollback.rs:58-78`, `daemon/src/sessiond/scrollback.rs:602-644`)

The 32-byte key is random per worker, never persisted, `mlock`ed where permitted, marked `MADV_DONTDUMP` on Linux, and zeroized on drop. Old ciphertext is removed at next worker start because a new worker cannot decrypt it. (`daemon/src/sessiond/scrollback.rs:28-33`, `daemon/src/sessiond/scrollback.rs:110-166`, `daemon/src/sessiond/secret.rs:17-53`)

Bounds:

- segment rotation target: conservative 256 KiB charge;
- total resource hard maximum/default: 8 MiB;
- hard 128 segment files;
- directory mode 0700; segment files are private;
- encrypted records and storage/accounting overhead are charged, not merely plaintext;
- oldest segments are evicted; an app `ED 3` physically unlinks all retained segments without resetting the nonce sequence. (`daemon/src/sessiond/scrollback.rs:46-59`, `daemon/src/sessiond/scrollback.rs:115-210`, `docs/SESSIOND.md:290-321`)

**Source-over-prose correction:** `docs/SESSIOND.md:412-414` and `proto/README.md:1010-1016` still say replay retains whole segments/fails if the newest segment cannot fit. Current source is newer: it decrypts/validates whole segments but retains the newest complete **history batches/records** that fit, and a too-small budget degrades to less/no history. (`daemon/src/sessiond/scrollback.rs:218-342`)

Authentication failure, a sequence gap/overlap, malformed framing, or unreadable segment wipes accumulated plaintext and fails the replay closed. (`daemon/src/sessiond/scrollback.rs:250-341`)

### 5.2 Replay shape

The worker synthesizes this v2 stream at capture time:

```text
ESC [ 8 ; <rows> ; <cols> t
ESC _ sp:h1 ESC \
<committed styled history lines>
ESC [ 8 ; <rows> ; <cols> t
<full emulator-serialized current screen repaint>
```

The APC sentinel literal is `\x1b_sp:h1\x1b\\`. (`daemon/src/sessiond/scrollback.rs:61-73`, `daemon/src/sessiond/worker.rs:786-831`)

Committed history is flowing styled text. The screen section is a complete idempotent repaint at current geometry. The current live terminal is seeded with history flowing into its own scrollback and only the final full screen repaint; it is not geometry-walked. (`web/src/components/terminal/Terminal.tsx:3880-3901`)

### 5.3 Fetch bounds and framing

Initial client request is 400 lines, `plain:false`, with current geometry. Deeper snapshots are normally 5,000 lines by daemon default; the UI may request 10,000 for deep scrollback. (`web/src/components/terminal/useSessionSocket.ts:930-970`, `daemon/src/session_ctl.rs:163-169`)

The daemon maps 10,000 lines to at most 8 MiB; otherwise it estimates `lines * 256`, clamped 64 KiB..8 MiB. `spawn.ctl` independently rejects aggregate response above 12 MiB. (`daemon/src/rtc.rs:3054-3095`, `web/src/lib/session-ctl.ts:1-9`)

Replay response order is:

1. JSON metadata with `request_id`, operation, `ok:true`, `plain:false`, `pty_offset`, `total_bytes`, `chunks`, and optional history epoch/offset.
2. Exactly `ceil(total_bytes / 49152)` `SPCT kind=1` frames.
3. Chunk sequences 0..N−1; final bit only on N−1; exact final remainder.

### 5.4 Why merge needs an explicit offset

`spawn.pty` and `spawn.ctl` are each ordered, but have no total order relative to each other. A live PTY message can arrive before replay metadata even if replay captured it first. (`proto/README.md:1018-1028`)

The daemon therefore samples the viewer's direct-stream offset before replay, waits until the worker/source watermark is available, then returns the translated per-viewer `pty_offset`. (`docs/SESSIOND.md:465-479`, `daemon/src/pty.rs:657-699`)

The merge algorithm is exact:

```ts
// web/src/lib/session-ctl.ts:326-346
if (anchor === null) return { bytes, anchor: null };
if (offsetAfter <= anchor) {
  return { bytes: null, anchor: offsetAfter === anchor ? null : anchor };
}
const start = offsetAfter - bytes.byteLength;
return {
  bytes: start < anchor ? bytes.subarray(anchor - start) : bytes,
  anchor: null,
};
```

Thus:

- live chunk entirely before/equal capture boundary → discard;
- live chunk straddles boundary → keep only suffix after boundary;
- first live chunk wholly after boundary → keep it and clear anchor;
- later chunks → render normally.

Snapshot responses whose `pty_offset` is ahead of locally received bytes are queued (at most eight) until the PTY stream catches up. (`web/src/components/terminal/useSessionSocket.ts:851-928`)

The terminal also retains a 4 MiB recent-live ring for applying PTY suffixes after later snapshot rewrites; if the ring no longer reaches the snapshot anchor, it refuses the stale rewrite and asks for a fresh snapshot rather than creating a gap. (`web/src/components/terminal/Terminal.tsx:77-81`, `web/src/components/terminal/Terminal.tsx:590-618`)

### 5.5 Write buffering and rendering budget

There are three distinct buffers; none should be conflated with wire flow control:

1. **Pre-bootstrap PTY buffer:** 12 MiB hard bound in the socket hook while initial replay is in flight. Overflow closes/retries the connection. (`web/src/components/terminal/useSessionSocket.ts:1054-1067`)
2. **Post-render live write buffer:** 4 MiB in `Terminal.tsx`, holding live chunks behind asynchronous xterm reset/seed writes. It records geometry and offset. Overflow or a geometry mismatch returns `refresh`; otherwise it drops chunks covered by the replay offset and drains the rest. (`web/src/components/terminal/Terminal.tsx:568-576`, `web/src/components/terminal/live-write-buffer.ts:13-77`)
3. **xterm sequencer:** writes one op, waits for xterm's completion callback, applies an optional resize, then writes the next. This guarantees geometry/write order. It has no timer, byte batch, or per-frame budget. (`web/src/components/terminal/Terminal.tsx:3804-3837`)

Therefore the requested “batch sizes, timers, frame budget” answer is precise:

- wire output batch: daemon at most 16 KiB per `spawn.pty` DataChannel message;
- replay/upload binary batch: 48 KiB payload;
- worker PTY read: 8 KiB, queue depth 8;
- browser post-render hold: 4 MiB;
- initial bootstrap hold: 12 MiB;
- xterm writes: serialized by completion callback, not rAF/time slicing;
- no application compression and no terminal-render frame-time budget.

**RECOMMEND:** a native terminal renderer should add its own bounded render coalescer (for example one byte queue flushed once per display frame), but this is an implementation optimization above the protocol. Preserve byte order and apply replay barriers before coalescing.

## 6. Input path and exact key sequences

### 6.1 General stdin

xterm's `onData` returns a JavaScript string containing the terminal bytes it encoded for the current terminal modes. The browser:

1. removes xterm-generated terminal Device Attributes replies of `ESC [ ? ... c` or `ESC [ > ... c` so replay queries do not leak back into the PTY;
2. optionally remaps mobile Return;
3. optionally prepends ready attachment references when submitting;
4. UTF-8 encodes with `TextEncoder`;
5. sends as binary `spawn.pty`. (`web/src/components/terminal/Terminal.tsx:2712-2759`, `web/src/components/terminal/Terminal.tsx:3925-3963`)

```ts
// web/src/components/terminal/Terminal.tsx:2719-2732
const enc = new TextEncoder();
term.onData((d) => {
  const filtered = stripDeviceAttributeResponses(d);
  const mapped = rewriteMobileReturn(filtered, mode, coarse, mobileReturnBytes);
  const withAttachments = appendAttachmentsForSubmit(mapped);
  if (withAttachments) socket.sendBinary(enc.encode(withAttachments));
});
```

Normal desktop/native keyboard sequences should come from the terminal emulator because cursor-key application mode, bracketed-paste mode, and other DEC modes change encoding. Do not hard-code every key globally.

### 6.2 Mobile modifier bar literals

The web accessory bar sends these exact bytes directly:

| UI key | Bytes | Hex |
|---|---|---|
| Esc | `\x1b` | `1b` |
| Tab | `\t` | `09` |
| Shift+Tab | `\x1b[Z` | `1b 5b 5a` |
| Ctrl-C | `\x03` | `03` |
| Up | `\x1b[A` | `1b 5b 41` |
| Down | `\x1b[B` | `1b 5b 42` |
| Left | `\x1b[D` | `1b 5b 44` |
| Right | `\x1b[C` | `1b 5b 43` |
| Send/Enter | `\r` | `0d` |

(`web/src/components/terminal/ModifierBar.tsx:24-50`)

The web sends on pointer-down and prevents default so the hidden terminal input does not lose focus. A native bar should add haptics at this UI layer without changing bytes. (`web/src/components/terminal/ModifierBar.tsx:155-185`)

### 6.3 Return/newline behavior

- Plain Enter/Send is carriage return: `\r`.
- Shift+Enter is `ESC CR` (`\x1b\r`), used by Claude Code-style TUIs as “insert newline”; every browser event for the same press is suppressed to avoid a second plain `\r`. (`web/src/components/terminal/Terminal.tsx:93-95`, `web/src/components/terminal/Terminal.tsx:2150-2172`)
- The pooled live mobile terminal's ordinary software-keyboard Return is a bracketed literal newline: `\x1b[200~\n\x1b[201~`. The accessory bar preserves a separate plain-CR Send. (`web/src/components/terminal/LiveTerminalProvider.tsx:18-23`, `web/src/components/terminal/LiveTerminalProvider.tsx:212-225`, `web/src/components/terminal/Terminal.tsx:1866-1886`)

### 6.4 Paste

Text paste calls terminal-emulator `paste(text)`, letting current bracketed-paste mode decide whether to wrap with `ESC[200~` / `ESC[201~`. (`web/src/components/terminal/Terminal.tsx:2629-2697`)

For uploaded image paths in `bracketed-path` mode, the web explicitly sends:

```text
ESC [ 2 0 0 ~
<shell-single-quoted endpoint path>
ESC [ 2 0 1 ~
```

(`web/src/components/terminal/Terminal.tsx:951-971`, `web/src/components/terminal/Terminal.tsx:3965-3971`)

Ready deferred attachments are prepended as space-separated `@<compact path>` tokens immediately before a Return submit. (`web/src/components/terminal/Terminal.tsx:796-822`)

### 6.5 Predictive echo

Predictive echo is purely a visual overlay; it never mutates the authoritative terminal buffer. It predicts only one printable ASCII character at a time, never across a wrap boundary, and holds at most 64 characters. Nonprintable input clears pending prediction. (`web/src/components/terminal/predictive-echo.ts:1-27`, `web/src/components/terminal/predictive-echo.ts:57-81`)

Authoritative output confirms glyphs/cursor advance. An echo timeout is 2 seconds. Two hard mismatches within 10 seconds disable prediction for 30 seconds. (`web/src/components/terminal/predictive-echo.ts:19-27`, `web/src/components/terminal/predictive-echo.ts:83-142`)

It is opt-in only via `localStorage.spawnPredictEcho="on"`, and prediction is suppressed while a live replay seed is being written. (`web/src/components/terminal/Terminal.tsx:2733-2758`)

**RECOMMEND:** do not make predictive echo a transport concern. Expose authoritative `onOutput` and RTT; implement prediction above the terminal model so transport swapping cannot corrupt terminal state.

### 6.6 Latency measurements

There are two different latency signals:

1. Transport `connInfo` polls `RTCPeerConnection.getStats()` immediately after readiness and every 5 seconds. It selects the transport's nominated/succeeded candidate pair, classifies it as `relay`, `stun`, or `direct`, exposes the local candidate protocol, and converts `currentRoundTripTime` seconds to a rounded minimum-1-ms value. This is network RTT, not keystroke latency. (`web/src/components/terminal/useSessionSocket.ts:1520-1590`)
2. The opt-in felt-latency HUD (`localStorage.spawnLatencyHud="on"`) timestamps a pristine single printable ASCII keystroke, pairs the oldest pending key with the first later PTY output, and closes paint time on the animation frame after xterm's write callback. It keeps 60 seconds of samples, at most 32 pending keys and 50 spikes, expires an unpaired key after 2 seconds, treats >100 ms as a spike, and updates display text once a second. (`web/src/components/terminal/latency-hud.ts:1-19`, `web/src/components/terminal/latency-hud.ts:60-116`, `web/src/components/terminal/Terminal.tsx:1125-1138`, `web/src/components/terminal/Terminal.tsx:2729-2735`)

The second measure deliberately includes application echo and render delay; it is not a protocol ping and should not be used to declare a peer dead. A mobile renderer can reproduce it above `SessionTransport` with its own post-paint callback.

## 7. Viewport, resize, and display ownership

### 7.1 Grid computation

The web does not use `web/src/lib/viewport.ts` to calculate terminal cells. It opens xterm, loads `FitAddon`, and calls `fit.fit()` against the measured terminal container; xterm computes integer `term.cols`/`term.rows` from the rendered font metrics and available pixels. (`web/src/components/terminal/Terminal.tsx:1456-1488`, `web/src/components/terminal/Terminal.tsx:2306-2320`)

`viewport.ts` only derives CSS keyboard insets:

```ts
// web/src/lib/viewport.ts:38-46
if (scale > 1.01) return { height: null, keyboard: 0 };
const height = Math.min(visualHeight, layoutHeight);
const keyboard = Math.max(0, layoutHeight - height - offsetTop);
if (keyboard < 1) return { height: null, keyboard: 0 };
return { height, keyboard };
```

For a native renderer, the equivalent cell calculation is renderer-owned: floor usable pixel width/actual measured cell width and usable height/actual measured row height, then validate 20..400 columns and 5..200 rows before sending. The bounds are wire requirements, while the precise cell metrics belong to the terminal component. (`web/src/lib/session-ctl.ts:591-607`, `daemon/src/session_ctl.rs:1-33`)

### 7.2 When resize is sent

- Initial fit sets `initialSize`; no resize frame yet. (`web/src/components/terminal/Terminal.tsx:2230-2237`)
- Container changes debounce for 80 ms, then call fit on `requestAnimationFrame`. (`web/src/components/terminal/Terminal.tsx:2328-2341`)
- Only a changed grid sends a resize.
- Only the current display owner sends `{type:"resize",cols,rows}`; the hook maps it to a `spawn.ctl` `resize` request, never the signalling WS. (`web/src/components/terminal/Terminal.tsx:2238-2257`, `web/src/components/terminal/useSessionSocket.ts:1605-1624`)
- On DataChannel readiness/reconnection, the owner resends its last known size unconditionally. (`web/src/components/terminal/Terminal.tsx:2766-2772`)
- Taking control sends `take_control` with the local fitted grid. (`web/src/components/terminal/Terminal.tsx:831-863`)
- A follower on coarse pointer adopts the owner's reported geometry locally and does not drive the PTY. (`web/src/components/terminal/Terminal.tsx:866-940`, `web/src/components/terminal/Terminal.tsx:2278-2305`)

### 7.3 Keyboard behavior

On a coarse pointer, a visual-viewport obstruction above 120 px is treated as the soft keyboard. The web freezes terminal rows and pans the existing terminal instead of fitting/resizing, preventing full-history reflow and PTY churn. (`web/src/components/terminal/Terminal.tsx:53-65`, `web/src/components/terminal/Terminal.tsx:1545-1576`, `web/src/components/terminal/Terminal.tsx:2260-2277`)

Width changes, but not row-only changes, trigger a history reseed. A 350 ms “reflow quiet” window suppresses destructive scrollback healing while layout settles. (`web/src/components/terminal/Terminal.tsx:53-60`, `web/src/components/terminal/Terminal.tsx:2241-2257`)

The web listens to `ResizeObserver`, `visualViewport.resize/scroll`, font readiness, device-pixel-ratio media-query changes, and `document.visibilitychange`; visibility becoming `visible` only schedules a refit. (`web/src/components/terminal/Terminal.tsx:2328-2402`)

### 7.4 Daemon reaction

The daemon's display-control hub assigns the first viewer as owner and sends latest display-state to all viewers. Only owner resize is accepted; `take_control` transfers ownership, applies the provided grid, and emits updated state. (`daemon/src/session_ctl.rs:718-929`, `daemon/src/rtc.rs:2639-2892`)

`SessionHandle::resize` deduplicates unchanged geometry, sends private worker `T_RESIZE`, and the worker applies it to both PTY master and emulator. Narrowing can commit displaced rows to encrypted history. (`docs/SESSIOND.md:513-522`, `daemon/src/sessiond/worker.rs:743-774`)

## 8. Connection state machine, timeouts, and resumption

### 8.1 Public state versus real readiness

The hook's public `SocketState` is:

```ts
type SocketState = "idle" | "connecting" | "open" | "closed" | "error";
```

(`web/src/components/terminal/useSessionSocket.ts:105`)

This describes the signalling WS. Real terminal readiness is the separate `dcOpen` plus internal RTC state:

```text
idle
  -> connecting (opening signalling WS)
  -> open (signalling WS selected spawn.v3)
  -> RTC new/signing/offered/verifying
  -> channels ptyOpen + ctlOpen
  -> daemon ready
  -> initial history/bootstrapDone
  -> dcOpen / I/O ready
```

The signed-session substate is `new | signing | offered | verifying | applied | failed`, and it allows exactly one signed offer and one answer attempt. (`web/src/lib/signed-rtc-live.ts:69-73`, `web/src/lib/signed-rtc-live.ts:121-220`)

### 8.2 Timeout and retry table

| Condition | Browser behavior | Daemon/server behavior |
|---|---|---|
| RTC not fully ready | close/retry after 10 s | daemon reaps peer not connected after 30 s |
| both required channels missing | same client 10 s gate | fail after 10 s |
| peer `disconnected` | 5 s grace, then close/retry | 15 s grace, then close |
| peer `failed` | close/retry | close/report failure |
| DataChannel send stall | upload low-water wait 5 s | any channel send timeout 2 s → disconnect viewer |
| upload channel not ready | caller waits 20 s | n/a |
| `upload_start` ACK | three attempts, 5 s each | stable manifest resumes/cached completes |
| final upload ACK | 30 s; never retry final frame | completion cached by stable upload ID |
| RTC retry | exponential 5,10,20,40,60… s cap | n/a |
| signalling WS reconnect | linear `min(10s, 500ms * attempt)` | browser route recreated |
| broker preconnect binding | n/a | 60 s TTL |
| connected broker binding | n/a | 24 h TTL |

Browser constants are together at `web/src/components/terminal/useSessionSocket.ts:137-146`; RTC retry is `web/src/components/terminal/useSessionSocket.ts:394-408`; PC state handling is `web/src/components/terminal/useSessionSocket.ts:1018-1040`; WS reconnect is `web/src/components/terminal/useSessionSocket.ts:1467-1485`.

### 8.3 Failure transitions

- Missing CSPRNG nonce: close WS protocol error, do not negotiate. (`web/src/components/terminal/useSessionSocket.ts:410-425`)
- Trust refusal/signature/pin/route failure: fatal for this generation; no raw fallback. (`web/src/components/terminal/useSessionSocket.ts:1184-1201`, `web/src/lib/signed-rtc-live.ts:172-220`)
- `rtc.status:disabled`: cleanup without retry.
- `failed`, `unavailable`, `collision`: cleanup and retry where ICE config remains available. (`web/src/components/terminal/useSessionSocket.ts:1417-1461`)
- PTY or control channel close/error: close the peer and retry. (`web/src/components/terminal/useSessionSocket.ts:1042-1053`, `web/src/components/terminal/useSessionSocket.ts:1083-1095`)
- Signalling WS close: tears down RTC, sets `closed`, and runs WS reconnect backoff. (`web/src/components/terminal/useSessionSocket.ts:1467-1485`)
- Unknown/binary signalling frame in browser: protocol failure; binary causes WS close. (`web/src/components/terminal/useSessionSocket.ts:1270-1279`, `web/src/components/terminal/useSessionSocket.ts:1463-1465`)
- Lagging daemon-side direct sink: viewer is disconnected; reconnect uses bounded replay. (`daemon/src/pty.rs:703-738`)

### 8.4 Reconnect/resume semantics

There is no ICE restart and no byte-level resume of the old peer. Reconnection creates a new RTC UUID, nonce, broker binding, peer, channels, and initial replay. Replay is the resume mechanism.

Same-hook keystrokes entered while the new DataChannel is unavailable can queue up to 64 KiB for the current session-effect generation and flush only after the full readiness gate. On component/session replacement the queue is cleared. (`web/src/lib/session-ctl.ts:297-324`, `web/src/components/terminal/useSessionSocket.ts:796-832`, `web/src/components/terminal/useSessionSocket.ts:1489-1509`)

Uploads are cancelled on channel close. Only the start exchange retries automatically; after final dispatch, disconnect/timeout is permanently `outcome_unknown` and requires destination reconciliation rather than automatic retry. (`web/src/components/terminal/useSessionSocket.ts:683-775`, `proto/README.md:930-955`)

### 8.5 Foreground-browser assumptions and mobile backgrounding

The transport hook contains no `document.visibilityState`, Page Lifecycle, or native AppState handling. It assumes JS timers, WS callbacks, WebRTC callbacks, and the peer remain runnable. The only visibility listener in `Terminal.tsx` refits when the page becomes visible; it does not explicitly suspend/resume transport. (`web/src/components/terminal/Terminal.tsx:2355-2363`)

The web warm pool keeps up to six parked terminals connected and rendered offscreen, evicting least-recently-active unclaimed instances. (`web/src/components/terminal/LiveTerminalProvider.tsx:18-23`, `web/src/components/terminal/LiveTerminalProvider.tsx:59-130`, `web/src/components/terminal/LiveTerminalProvider.tsx:156-190`)

On iOS this cannot be carried over literally. Apple says ordinary apps are suspended shortly after entering background; a terminal WebRTC/WebSocket session is not an allowed indefinite background mode. [Apple background execution modes](https://developer.apple.com/documentation/Xcode/configuring-background-execution-modes), [Apple networking guidance](https://developer.apple.com/documentation/technotes/tn3151-choosing-the-right-networking-api).

`react-native-webview` also documents that iOS may terminate the WebContent process to reclaim memory, especially after time in background, and exposes `onContentProcessDidTerminate`. [React Native WebView reference](https://github.com/react-native-webview/react-native-webview/blob/master/docs/Reference.md)

**RECOMMEND:** on RN `AppState` transition away from `active`, stop accepting new user input, mark connection `suspended`, best-effort send `rtc.close`, close the worker peer, and retain only renderer state. On return to `active`, recreate the worker/peer and run full replay bootstrap. `AppState` exposes `active`, iOS `inactive`, and `background`. [React Native AppState](https://reactnative.dev/docs/appstate)

**RECOMMEND:** handle WebView `onContentProcessDidTerminate` as a transport crash: invalidate all worker generations, discard unacknowledged bridge messages, reload the trusted worker page, reconnect, replay, then announce ready. Never assume a hidden WebView survived backgrounding.

## 9. Direct session file upload

This is upload only. Session-channel download does not exist. Replay is a bounded terminal-history fetch, not a generic file download. Host file read/write/download lives on the separate `spawn.host.ctl` protocol, outside R04. (`docs/INTERFACE_MATRIX.md:40-42`, `docs/INTERFACE_MATRIX.md:55-64`, `docs/SESSIOND.md:254-258`)

### 9.1 Start manifest

After `ready`, client has an unguessable per-control-channel capability and exact backend generation. It hashes the entire file SHA-256 before dispatch. File size must be 1..20 MiB. (`web/src/components/terminal/useSessionSocket.ts:619-639`, `web/src/lib/session-ctl.ts:519-543`)

```json
{
  "version":1,
  "kind":"request",
  "request_id":"<stable upload UUID>",
  "operation":"upload_start",
  "capability":"<ready capability UUID>",
  "agent_generation":7,
  "name":"notes.txt",
  "mime_type":"text/plain",
  "destination":"cwd",
  "total_bytes":90000,
  "chunks":2,
  "sha256":"<64 lowercase hex>"
}
```

Destination is `attachments` or `cwd`. Name is 1..255 UTF-8 bytes, neither `.` nor `..`, no control characters, slash, or backslash. MIME is 1..128 printable ASCII bytes and cannot contain semicolon. (`web/src/lib/session-ctl.ts:368-407`)

### 9.2 Start ACK/resume

Response:

```json
{
  "version":1,
  "kind":"response",
  "request_id":"<upload UUID>",
  "operation":"upload_start",
  "ok":true,
  "state":"ready",
  "next_sequence":1,
  "received_bytes":49152
}
```

The browser retries this exact manifest/stable ID at most three times with a 5-second wait. An identical in-progress manifest resumes; an identical completed manifest returns cached completion; ID reuse with a different manifest fails. (`web/src/components/terminal/useSessionSocket.ts:683-713`, `proto/README.md:938-955`)

### 9.3 Data/progress/backpressure

Starting at `next_sequence`, slice file into 49,152-byte payloads, frame `SPCT kind=2`, set final bit only on final frame, and send in order. Progress is the number of file bytes handed to `ctlDc.send`, not daemon durable bytes. (`web/src/components/terminal/useSessionSocket.ts:707-750`)

Before every chunk, if `bufferedAmount` exceeds 256 KiB, wait for it to fall to 128 KiB, abort, or time out after 5 seconds. (`web/src/components/terminal/useSessionSocket.ts:568-592`)

The daemon admits at most four active uploads per viewer and 64 globally, verifies capability/generation/framing/order/length/hash/destination, writes private mode-0600 same-directory temporary state, and atomically publishes without overwriting an existing regular file or symlink. (`proto/README.md:938-985`)

### 9.4 Completion and cancellation

Successful completion:

```json
{
  "version":1,
  "kind":"response",
  "request_id":"<upload UUID>",
  "operation":"upload_complete",
  "ok":true,
  "state":"complete",
  "path":"/endpoint/path/notes.txt",
  "total_bytes":90000,
  "sha256":"<same digest>"
}
```

Client waits up to 30 seconds after final dispatch. It never retries a final chunk. A timeout, abort, or disconnect after final dispatch becomes `DirectSessionUploadError("outcome_unknown", ...)`; publication may already have linearized. (`web/src/components/terminal/useSessionSocket.ts:735-768`)

Before final dispatch, cancellation sends:

```json
{
  "version":1,
  "kind":"request",
  "request_id":"<new cancellation UUID>",
  "operation":"upload_cancel",
  "capability":"<ready UUID>",
  "agent_generation":7,
  "upload_id":"<stable upload UUID>"
}
```

(`web/src/lib/session-ctl.ts:409-428`)

Control-channel close cancels all viewer uploads immediately, then drains cleanup under one bounded peer-close deadline. (`daemon/src/rtc.rs:2579-2600`)

The web additionally requires a tab-local durable reconciliation reservation before `upload_start`; eight unresolved records block further effects, and the record is promoted to `outcome_unknown` before final dispatch. A native app must reproduce this semantic with durable mobile storage even though `sessionStorage` itself is web-specific. (`proto/README.md:913-938`, `proto/README.md:957-975`)

**RECOMMEND:** transport exposes upload state and stable IDs, but the data layer owns a durable reconciliation ledger. Do not hide `outcome_unknown` as an ordinary retryable network error.

## 10. Native transport options under the Expo Go constraint

Verification date: **2026-08-22**. NPM versions below were read from the public registry `latest` metadata; Expo-compatible versions come from the SDK 57 docs.

### 10.1 Decision matrix

| Option | Expo Go | Cost | Latency/throughput | Security/privacy | Swap later? | Verdict |
|---|---|---:|---|---|---|---|
| `react-native-webrtc` | **No** | medium once dev build allowed | best; binary stays in native/WebRTC bridge | preserves direct DTLS/TURN ciphertext model | yes, with abstraction | production future, not milestone path |
| Hidden/dedicated `react-native-webview` worker | **Yes** | medium-high | one JSON string bridge/copy; viable with bounded batching | preserves peer DTLS; worker code/origin/key handling must be trusted | yes | **recommended Expo Go path** |
| WebSocket relay through spawn-server | technically yes | very high server+daemon work | extra server/Redis hops; server bandwidth and buffering | destroys “server cannot see PTY/upload” content guarantee unless adding a new inner E2E protocol | yes at UI, but two backends | reject as default |
| Direct WebSocket from RN to daemon | no existing endpoint; generally unreachable | very high | could be low on LAN | new daemon TLS/auth/NAT attack surface | maybe | not a real general solution |
| WebTransport/QUIC | not a present Expo/browser/daemon path | very high | potentially good | still needs endpoint reachability/certs or server relay | maybe | no benefit for milestone |
| Pure-JS WebRTC | **No** | infeasible | n/a | ICE/DTLS/SCTP require browser/native engine | n/a | not real |

### 10.2 Option A — `react-native-webrtc`

Verified current registry versions:

- [`react-native-webrtc` 124.0.8](https://registry.npmjs.org/react-native-webrtc/latest)
- [`@config-plugins/react-native-webrtc` 15.0.2](https://registry.npmjs.org/%40config-plugins%2Freact-native-webrtc/latest)

The upstream README states that the module contains native code, is not available in Expo Go by default, and can be used through `expo-dev-client` plus the out-of-tree config plugin. It supports DataChannels on iOS and Android. [react-native-webrtc upstream](https://github.com/react-native-webrtc/react-native-webrtc)

Expo explains why: Expo Go has a fixed set of compiled native libraries; adding a library not already included requires a development build. Expo explicitly uses `react-native-webview` as an example of a native library that works only because it is prebundled. [Expo development-build FAQ](https://docs.expo.dev/develop/development-builds/faq/)

Consequences:

- **Expo Go:** no.
- **Development/EAS build:** yes, using the config plugin and a rebuilt binary.
- **Protocol fit:** strong. It exposes `RTCPeerConnection`, DataChannels, offer/answer, ICE candidates, binary sends, and close. [react-native-webrtc basic usage](https://github.com/react-native-webrtc/react-native-webrtc/blob/master/Documentation/BasicUsage.md)
- **Engineering:** port current TypeScript state machine and crypto/trust; adapt API differences and test `bufferedAmountLowThreshold` behavior in the pinned module.
- **Performance:** best candidate because PTY bytes avoid the WebView string bridge; still crosses React Native/native boundaries.
- **Background:** does not grant indefinite iOS background execution. Native WebRTC is not itself an allowed background mode for a shell app.
- **Hard conflict:** fails requirement 7's end-of-build Expo Go run.

**RECOMMEND:** keep it as the second `SessionTransport` backend after the Expo Go milestone, not as the initial implementation.

### 10.3 Option B — WebRTC inside `react-native-webview`

Expo SDK 57 is current, uses React Native 0.86, supports iOS 16.4+, and lists `react-native-webview` among third-party libraries built into Expo Go. [Expo SDK 57 reference](https://docs.expo.dev/versions/latest/), [Expo Go third-party libraries](https://docs.expo.dev/versions/v57.0.0/sdk/third-party-overview/)

Use the Expo-pinned version, not unconstrained npm latest:

- **RECOMMEND:** `react-native-webview` **13.16.1** through `npx expo install react-native-webview`; Expo marks it “Included in Expo Go.” [Expo SDK 57 WebView docs](https://docs.expo.dev/versions/v57.0.0/sdk/webview/)
- Registry latest is 14.0.1 as of the verification date, but that is not what current Expo Go bundles. [npm registry](https://registry.npmjs.org/react-native-webview/latest)

Apple states that WebRTC functions work in WKWebView from iOS 14.3 onward. [WWDC21: Explore WKWebView additions](https://developer.apple.com/videos/play/wwdc2021/10032/)

Therefore a WebView document can own:

- `WebSocket` signalling;
- `RTCPeerConnection`, ICE, DTLS, and both DataChannels;
- current canonical signed-signal TypeScript;
- replay correlation and live-offset merge;
- upload framing/backpressure;
- optionally xterm rendering, which avoids carrying output bytes across the RN bridge.

#### Feasible worker topology

```text
React Native UI/data layer
  |  string-only messages (JSON envelope; bounded base64 for binary)
  v
dedicated persistent WebView at a trusted HTTPS origin
  - auth signalling WebSocket
  - trust/signature codec
  - RTCPeerConnection
  - spawn.pty + spawn.ctl
  - replay/live merge
  | DTLS/SCTP (direct, STUN, or TURN)
  v
spawnd / spawn-worker / PTY
```

The RN-WebView bridge is string-only. `window.ReactNativeWebView.postMessage` accepts one string; the native `onMessage` receives `event.nativeEvent.data`. [React Native WebView guide](https://github.com/react-native-webview/react-native-webview/blob/master/docs/Guide.md), [reference](https://github.com/react-native-webview/react-native-webview/blob/master/docs/Reference.md)

This makes per-16-KiB base64 output messages possible but copy-heavy: base64 expands by ~4/3, then JSON/string and JS/runtime copies add overhead. It is likely fine for interactive terminals, but high-rate `cat`/build output and 20 MiB upload would stress the boundary.

**RECOMMEND:** if the terminal renderer itself is WebView/xterm-based, keep live PTY bytes and replay entirely inside that same visible WebView and bridge only state, haptics requests, control UI commands, selection/clipboard, upload progress, and diagnostics. This is the highest-throughput Expo-Go design and is still not a remote web wrapper: RN owns navigation, lists, overlays, gestures, and native chrome while WebKit supplies the terminal canvas and WebRTC engine.

Upload needs an explicit topology decision. The existing browser uploader owns a `Blob`, hashes it, then reads only one 49,152-byte slice into an `ArrayBuffer` for each DataChannel frame. (`web/src/components/terminal/useSessionSocket.ts:600-639`, `web/src/components/terminal/useSessionSocket.ts:707-750`)

- A visible terminal WebView can use an HTML `<input type="file">`; React Native WebView documents iOS file upload and native single/multiple file selection. The resulting `File` stays inside WebKit and can use the current bounded `Blob.slice` pipeline. [React Native WebView file-upload guide](https://github.com/react-native-webview/react-native-webview/blob/master/docs/Guide.md#add-support-for-file-upload)
- A file chosen by an RN-native document picker is only a native URI/handle. The string-only WebView bridge provides no documented zero-copy transfer of that handle into WebKit. Sending the full 20 MiB as one base64 JSON message would expand the payload to roughly 26.7 MiB before JSON/runtime copies and is unacceptable.
- If native RN selection is mandatory in Expo Go, stream base64 in independently bounded bridge chunks (for example, at most 48 KiB raw), ACK and cap the number of unconsumed chunks, hash incrementally in the worker, and only then run `upload_start`. That is a **new bridge protocol**, not the existing DataChannel protocol, and cancellation must clear both bridge and RTC-side state.

**RECOMMEND:** for the Expo-Go milestone, invoke the system file picker through a visible WebView `<input type="file">` and keep file hashing/chunking inside WebKit. If product design insists that RN own the picker, treat bounded chunked RN→worker transfer and 20 MiB memory/throughput testing as a release gate; never inject a whole-file base64 string.

If RN must render terminal cells, bridge output in bounded aggregates:

- worker accumulates ordered PTY chunks;
- flush once per animation frame or at 32 KiB raw, whichever occurs first;
- base64 one aggregate plus generation and offset-after;
- RN ACKs the bridge batch sequence;
- worker pauses bridge emission above a small bounded unacked budget and requests a replay refresh if overflowed;
- never change the actual `spawn.pty` ordering or protocol.

Those batch values are a new bridge policy, not existing wire values, and require a device throughput spike.

#### Authentication caveat

WebView page-load custom headers do not automatically become headers on later WebSocket traffic. The existing signalling endpoint supports bearer header, cookie, or query token, but browser `WebSocket` cannot set an arbitrary Authorization header. (`server/spawn_server/ws/browser.py:123-156`)

Viable approaches:

1. Load an HTTPS same-origin worker page after establishing its `spawn_session` cookie in that WebView; WebSocket then authenticates by cookie.
2. Supply a short-lived access token to worker JS and use the existing `?token=` fallback. This is implemented but exposes the token in a URL and must avoid logs/history.
3. `sharedCookiesEnabled` exists, but RN HTTP cookie sharing and WebView cookie semantics need an on-device test; do not assume an RN fetch login automatically seeds WKWebView.

**RECOMMEND:** serve a minimal, immutable, HTTPS worker page from the spawn web origin and authenticate it by HttpOnly same-origin cookie. Do not put a long-lived bearer token in injected JavaScript.

#### Secure context and Ed25519 caveat

Web Crypto `SubtleCrypto` is a secure-context API, so inline/file/opaque origins are not an adequate assumption. The W3C interface is marked `SecureContext`. [Web Cryptography Level 2](https://www.w3.org/TR/WebCryptoAPI/)

WebKit added Ed25519 Web Crypto support in Safari/iOS 17. [WebKit Safari 17 features](https://webkit.org/blog/14445/webkit-features-in-safari-17-0/)

Expo SDK 57 still supports iOS 16.4+, so an allowed device may have WebRTC in WKWebView but no `crypto.subtle` Ed25519. That matters because spawnd requires signed offers by default. (`daemon/src/run.rs:1013-1022`)

**UNKNOWN:** whether the owner's physical iPhone runs iOS 17+ and whether Expo Go's exact WKWebView build passes current `generateKey/importKey/sign/verify({name:"Ed25519"})` behavior, strict raw-key export, IndexedDB `CryptoKey` persistence, TURN, `bufferedamountlow`, Blob/ArrayBuffer delivery, and background/foreground recovery. Resolve with one mandatory physical-device transport spike before full implementation.

Fallback if iOS 16.4 must connect:

- `@noble/ed25519` **3.1.0** is already pinned by the web app (`web/package.json:20`) and current in the npm registry. [noble-ed25519](https://github.com/paulmillr/noble-ed25519), [registry](https://registry.npmjs.org/%40noble%2Fed25519/latest)
- Synchronous noble signing needs `@noble/hashes` **2.3.0** (registry current) SHA-512; RN also needs a secure random provider. Both noble packages are pure JavaScript and work in Expo Go. The upstream README calls out the RN polyfills. [noble RN guidance](https://github.com/paulmillr/noble-ed25519), [hashes registry](https://registry.npmjs.org/%40noble%2Fhashes/latest)
- Expo SDK 57 includes `expo-crypto` **~57.0.1** in Expo Go with native `getRandomValues`, random UUID, SHA-512 digest, and random bytes. [Expo Crypto](https://docs.expo.dev/versions/v57.0.0/sdk/crypto/)
- Store the 32-byte identity seed with `expo-secure-store` **~57.0.1**, which is included in Expo Go, and perform the one-off offer-sign operation in RN, returning only the 64-byte signature to the WebView. This prevents persistent raw key storage in WebView, though the seed exists in the RN JS heap during signing and is weaker than a nonextractable WebCrypto key. [Expo SecureStore](https://docs.expo.dev/versions/v57.0.0/sdk/securestore/), [registry](https://registry.npmjs.org/expo-secure-store/latest)

**RECOMMEND:** prefer native WebCrypto on iOS 17+ and fail a startup capability test visibly. Implement the noble/SecureStore signer only if iOS 16.4 support is a product requirement; do not silently fall back to unsigned signalling because the daemon will reject it and the security downgrade is material.

#### Hidden-worker lifecycle caveat

A WebView should not be CSS `display:none` if its JS/WebRTC must remain active. Keep a mounted, tiny/offscreen/transparent native view or co-locate transport with the visible terminal. Even then, iOS background suspension and WebContent process eviction apply. The WebView reference explicitly documents `onContentProcessDidTerminate` and possible background memory reclamation. [React Native WebView reference](https://github.com/react-native-webview/react-native-webview/blob/master/docs/Reference.md)

**Expo Go:** yes, verified for the WebView module. **End-to-end viability:** high but not yet proven for this exact signed, dual-channel protocol; the physical-device spike is a release gate.

### 10.4 Option C — WebSocket relay through the server

No such path exists. The current server deliberately closes terminal bytes/control/upload on `/ws/browser`; the daemon control WS no longer carries PTY content; the migration removed the former relay/history/snapshot/transcript paths. (`server/spawn_server/ws/browser.py:344-390`, `docs/SESSIOND.md:254-261`, `docs/TRUST.md:163-183`)

This would require at least:

1. a new authenticated per-session content WS protocol or a breaking relaxation of `/ws/browser`;
2. browser↔server binary/control framing, per-viewer queues, bounds, backpressure, request IDs, and reconnect semantics;
3. server↔daemon content frames on `/ws/daemon` or a second daemon socket;
4. daemon bridging into `SessionHandle` input/replay/resize/upload with ownership/generation fencing;
5. cross-process server routing/Redis binary handling or sticky single-worker affinity;
6. upload/replay bounds and cancellation across two extra failure domains;
7. observability/rate limiting without logging content;
8. protocol/version rollout across server, daemon, web, and mobile;
9. new trust documentation and migration/purge implications.

Latency gains an extra mobile→server→daemon hop instead of direct/TURN DTLS. Server bandwidth scales with all terminal output, replay, and uploads. More importantly, plaintext would terminate at spawn-server unless a new application-layer E2E encryption/key-exchange/framing protocol were designed. That reverses the current cryptographic claim that server/TURN cannot read PTY/replay/upload content. (`docs/TRUST.md:35-39`, `docs/TRUST.md:50-81`, `docs/TRUST.md:88-105`)

Using WebSocket TLS alone is not enough: TLS terminates at the server. Wrapping an inner encrypted stream could restore content confidentiality, but then the project must design authenticated session keys, nonce/counter persistence, replay/ordering, rekey/resume, encrypted control/errors, and endpoint key binding on top of the relay. WebRTC already supplies the required direct authenticated encryption.

**RECOMMEND:** do not build a server relay to satisfy Expo Go. It is more work than the WebView worker, adds operational cost and latency, and violates the explicit endpoint-only architecture unless paired with a substantial new cryptographic protocol.

### 10.5 Other real options

#### Direct RN WebSocket to daemon

There is no public per-session daemon WebSocket listener, TLS identity, route discovery, or NAT traversal path. Daemons commonly sit behind home/mobile NAT. Adding it duplicates ICE/TURN's reachability problem and creates a new internet-facing host service. Not viable as the general app path.

#### WebTransport/QUIC

Neither server nor daemon implements WebTransport, it does not supply peer NAT traversal, and a browser-facing WebTransport server still terminates at a reachable HTTPS origin. A direct host deployment needs certificates/discovery/public reachability; a central deployment becomes another relay. It offers no simple Expo-Go escape hatch.

#### External browser/PWA handoff

Would run WebRTC but fails first-class native overlay/navigation/integration requirements and cannot provide a robust RN data bridge. It is not a full native-app transport.

#### Local VPN/tunnel products

A user-managed Tailscale/WireGuard route could make a direct daemon socket reachable, but cannot be a product-wide prerequisite and would still require a new daemon transport/auth protocol. Useful only as a future operator-specific mode.

## 11. Recommended swappable transport contract

The mobile data/terminal layers must not import `react-native-webview` or `react-native-webrtc` directly. They should depend on one contract whose semantics match the existing generation fences and replay barrier.

```ts
export type SessionTransportState =
  | { phase: "idle" }
  | { phase: "signaling"; attempt: number }
  | { phase: "negotiating"; rtcSessionId: string; trust: SignalingTrustLevel }
  | { phase: "bootstrapping"; rtcSessionId: string }
  | { phase: "ready"; rtcSessionId: string; connection: ConnectionInfo }
  | { phase: "suspended" }
  | { phase: "closed"; reason: string; retrying: boolean }
  | { phase: "failed"; code: string; retryable: boolean };

export type TerminalOutput = {
  generation: number;
  bytes: Uint8Array;
  offsetAfter: number;
};

export type ReplaySeed = {
  generation: number;
  bytes: Uint8Array;
  ptyOffset: number | null;
  historyAnchor: { epoch: string; offset: number } | null;
};

export interface SessionTransport {
  readonly state: SessionTransportState;
  readonly signalingTrust: "verified" | "first_contact" | "raw" | null;

  connect(input: {
    sessionId: string;
    initialSize: { cols: number; rows: number };
  }): Promise<void>;

  close(reason?: string): Promise<void>;
  suspend(): Promise<void>;
  resume(): Promise<void>;

  sendInput(bytes: Uint8Array): boolean;
  resize(cols: number, rows: number): boolean;
  takeControl(cols: number, rows: number): boolean;
  requestSnapshot(lines: number): Promise<ReplaySeed>;

  upload(
    source: UploadSource,
    options: {
      uploadId: string;
      name: string;
      mimeType: string;
      destination: "attachments" | "cwd";
      signal?: AbortSignal;
      onProgress?: (sent: number, total: number) => void;
      onFinalDispatched: () => Promise<void>;
    },
  ): Promise<{ uploadId: string; path: string; totalBytes: number; sha256: string }>;

  onState(listener: (state: SessionTransportState) => void): Unsubscribe;
  onOutput(listener: (event: TerminalOutput) => void): Unsubscribe;
  onReplay(listener: (seed: ReplaySeed) => void): Unsubscribe;
  onDisplayState(listener: (state: {
    owner: boolean;
    cols: number | null;
    rows: number | null;
    viewers: number;
  }) => void): Unsubscribe;
  onExit(listener: (exit: { exitCode: number | null; signal: string | null }) => void): Unsubscribe;
}
```

Required abstraction semantics:

- One monotonic local `generation` per `connect` attempt; discard every late event from an older generation.
- `ready` means both channels + daemon ready + replay applied, never merely WS open.
- `sendInput` queues at most 64 KiB for current generation or returns `false`; once ready it splits larger input into ordered messages no larger than 64 KiB.
- `onOutput` is authoritative ordered binary; no UI string conversion.
- Replay is an explicit event with `ptyOffset`; transport performs initial duplicate/gap merge before ready.
- `resize`/`takeControl` map to `spawn.ctl`; no caller may send these over signalling.
- Upload preserves stable ID, final-dispatch boundary, and typed `outcome_unknown`.
- `close` is idempotent and attempts bound `rtc.close` before teardown.
- The UI knows only connection/trust/path/RTT and does not know WebView versus native WebRTC.

For the WebView backend, add a private bridge protocol:

```ts
type NativeToWorker =
  | { type: "connect"; bridgeGeneration: number; sessionId: string; cols: number; rows: number }
  | { type: "input"; bridgeGeneration: number; sequence: number; dataB64: string }
  | { type: "control"; bridgeGeneration: number; requestId: string; operation: string; parameters: object }
  | { type: "close"; bridgeGeneration: number }
  | { type: "app_state"; bridgeGeneration: number; state: "active" | "inactive" | "background" };

type WorkerToNative =
  | { type: "capabilities"; webRtc: boolean; subtle: boolean; ed25519: boolean }
  | { type: "state"; bridgeGeneration: number; state: SessionTransportState }
  | { type: "output"; bridgeGeneration: number; batchSequence: number; offsetAfter: number; dataB64: string }
  | { type: "replay"; bridgeGeneration: number; ptyOffset: number | null; dataB64: string }
  | { type: "display_state"; bridgeGeneration: number; owner: boolean; cols: number | null; rows: number | null; viewers: number }
  | { type: "upload_progress"; bridgeGeneration: number; uploadId: string; sent: number; total: number }
  | { type: "fatal"; bridgeGeneration: number; code: string; detail: string };
```

Every bridge message must have exact fields, a byte bound before JSON parse, exact generation, and monotonic sequence where effects/bytes are involved. Never accept executable JS strings as bridge commands.

## 12. Physical-iPhone spike and acceptance gates

Before implementation agents build the whole terminal stack, one small Expo SDK 57 app in Expo Go must prove all of these on the owner's physical iPhone:

1. `react-native-webview` 13.16.1 loads a pinned HTTPS worker document.
2. Worker reports `isSecureContext`, `crypto.getRandomValues`, `crypto.subtle`, Ed25519 generate/import/export/sign/verify.
3. Worker creates `RTCPeerConnection` and both ordered reliable DataChannels.
4. Signed offer codec passes the exact session-offer fixture bytes and signature.
5. Real daemon verifies offer and browser verifies signed answer.
6. Direct/STUN and forced-TURN connections both work.
7. Both channels open; daemon `ready`; history 400; live offset merge has no duplicate/gap.
8. Typing control bytes, UTF-8, 100 KiB paste, arrows, Shift+Tab, Ctrl-C, plain Enter, and `ESC CR` are exact.
9. Continuous high-rate output for at least 30 seconds does not unbound bridge/native memory; report sustained bytes/s, peak queued/unacked bytes, and frame time.
10. The largest daemon-produced replay (up to 8 MiB) parses/assembles within bounds, and a codec test rejects aggregate metadata above the independent 12 MiB client cap.
11. 20 MiB upload exercises WebView file selection (or, if chosen, bounded RN→worker chunk transfer), high/low `bufferedAmount`, progress, cancel, completion, and post-final disconnect ambiguity.
12. Wi-Fi↔cellular transition triggers bounded close/reconnect/replay.
13. Screen lock, app background for 30 seconds, foreground, WebContent termination simulation, and memory warning all recover by fresh replay.
14. HttpOnly cookie reaches signalling WS without exposing a long-lived token to worker JS/logs.
15. WebView unmount/remount does not allow old generation bytes/effects into the new terminal.

**UNKNOWN:** exact RN↔WKWebView throughput and memory ceiling for the chosen terminal rendering topology. No documentation substitutes for this spike because the bridge is string-only and the workload is binary/bursty.

**UNKNOWN:** whether the app will officially support iOS 16.4. Expo SDK 57 does, while WebKit Ed25519 starts at iOS 17. The owner must choose one of: require iOS 17+, ship the noble/SecureStore signing backend, or move the milestone from Expo Go to a development build with another native crypto/WebRTC design.

## 13. Final decision

**RECOMMEND:** implement a dedicated WebView-based session transport for the Expo Go milestone, preferably co-located with the terminal renderer so raw PTY/replay bytes—and uploads selected through its file input—remain inside WebKit. Use an HTTPS trusted origin, cookie authentication, the current revision-2 signed-signal codec, exact generation fencing, full replay barrier, and explicit AppState teardown/reconnect. RN owns all navigation, overlays, tabs, lists, gestures, native controls, and haptics.

**RECOMMEND:** implement `SessionTransport` first and make the WebView backend one adapter. After the Expo Go acceptance milestone, add `react-native-webrtc` 124.0.8 through `@config-plugins/react-native-webrtc` 15.0.2 in development/EAS builds behind the same interface. This gives a lower-copy path without rewriting terminal UI/data semantics.

**RECOMMEND:** reject the server WebSocket relay as the default. It does not exist, would be a multi-component protocol project, adds central bandwidth/latency, and would make PTY/replay/upload server-readable unless a new E2E cryptographic layer were also designed.

The orchestrator has one genuine product decision: **minimum iOS 17 versus an Expo-Go-compatible pure-JS Ed25519 signer for iOS 16.4**. Everything else can proceed behind the transport abstraction while the physical-device WebView spike validates WebRTC/DataChannel and bridge performance.
