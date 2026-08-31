import { openSessionSignal } from "@/data/realtime/session-signal";
import { loadMemoizedCarriedEndorsements } from "@/data/trust/carried-endorsements";
import {
  DEVICE_NOT_TRUSTED_CODE,
  DEVICE_NOT_TRUSTED_MESSAGE,
  type DeviceHostTrustResult,
  invalidateDeviceHostTrust,
  probeDeviceHostTrustResult,
} from "@/data/trust/device-trust";
import { randomBytes } from "@/lib/crypto/bootstrap";
import { bytesToUuid, encodeHex } from "@/lib/crypto/bytes";
import {
  encodeBridgeBytes,
  TERMINAL_BRIDGE_VERSION,
  type WorkerToNativeMessage,
} from "@/terminal/transport/bridge";
import { chunkPtyInput, PTY_INPUT_MAX_BYTES } from "@/terminal/transport/ctl-codec";
import { HostControlTransportError } from "@/terminal/transport/host-ctl-codec";
import { SessionUploadCoordinator } from "@/terminal/transport/session-upload";
import {
  browserIdentityWire,
  signWorkerRequest,
  verifyAnswerFrame,
} from "@/terminal/transport/signed-signalling";
import {
  INITIAL_CONNECTION_STATE,
  type ReadinessGate,
  reconnectDelay,
  reduceConnection,
} from "@/terminal/transport/state-machine";
import type {
  ConnectionInfo,
  DisplayControlState,
  ScrollState,
  SessionTransport,
  SessionTransportOptions,
  SignalChannelLike,
  TransportError,
  TransportState,
  UploadHandle,
  UploadRequest,
  WorkerDiagnostic,
} from "@/terminal/transport/types";
import {
  iceServersNeedRefresh,
  readTransportPolicy,
  sanitizeIceServers,
} from "@/terminal/transport/types";
import { terminalMetrics } from "@/theme";

/**
 * A daemon that refuses an offer — an unpinned browser key, a stale binding —
 * drops it without replying, and ICE itself can stall with no event at all.
 * Without a deadline the surface sits on "Connecting" forever, which is
 * indistinguishable from a slow network and tells the operator nothing.
 */
export const CONNECT_TIMEOUT_MS = 25_000;
export const CONNECT_TIMEOUT_MESSAGE =
  "The host did not answer in time. It may be offline, or it may not have approved this device.";
export const LOST_CONNECTION_MESSAGE =
  "SPAWN D lost the connection to this host and could not restore it.";
const RECONNECT_BUDGET_MS = 3 * 60_000;
let cachedLoopbackCapability: boolean | null = null;

type StateListener = (state: TransportState) => void;
type ErrorListener = (error: TransportError) => void;
type TitleListener = (title: string) => void;
type BellListener = () => void;
type ScrollListener = (scroll: ScrollState) => void;
type DiagnosticListener = (diagnostic: WorkerDiagnostic) => void;
type DisplayListener = (display: DisplayControlState) => void;
type ConnectionInfoListener = (info: ConnectionInfo) => void;

interface ConfigFrame extends Record<string, unknown> {
  type?: unknown;
  enabled?: unknown;
  ice_servers?: unknown;
  ice_transport_policy?: unknown;
  binding_nonce_required?: unknown;
}

interface CachedRtcConfig {
  iceServers: Array<Record<string, unknown>>;
  iceTransportPolicy: "all" | "relay";
}

function frameRecord(value: unknown): ConfigFrame | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as ConfigFrame)
    : null;
}

function newUuid(): string {
  const bytes = randomBytes(16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  return bytesToUuid(bytes);
}

class WebViewSessionTransport implements SessionTransport {
  readonly sessionId: string;
  #state: TransportState = "idle";
  #machine = INITIAL_CONNECTION_STATE;
  #signal: SignalChannelLike | null = null;
  #signalUnsubscribe: (() => void) | null = null;
  #signalStateUnsubscribe: (() => void) | null = null;
  #bridgeUnsubscribe: (() => void) | null = null;
  #browserKey: string | null = null;
  #cachedConfig: CachedRtcConfig | null = null;
  #activeRtcSessionId: string | null = null;
  #activeBindingNonce: string | null = null;
  #activeBindingGeneration: number | null = null;
  #signalHasOpened = false;
  #workerStarted = false;
  #prepared = false;
  #preparePromise: Promise<void> | null = null;
  #endorsements: Promise<
    readonly import("@/data/trust/carried-endorsements").CarriedEndorsement[]
  > = Promise.resolve([]);
  #hasEverReady = false;
  /** True once this host has refused an offer from this device. */
  #refused = false;
  #reconnectStartedAt: number | null = null;
  #configWaiters = new Set<() => void>();
  #pendingInput: Uint8Array[] = [];
  #pendingInputBytes = 0;
  #inputSequence = 0;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #connectTimer: ReturnType<typeof setTimeout> | null = null;
  #resumeTimer: ReturnType<typeof setTimeout> | null = null;
  #opening: Promise<void> | null = null;
  #resolveOpen: (() => void) | null = null;
  #rejectOpen: ((error: Error) => void) | null = null;
  readonly #uploadCoordinator: SessionUploadCoordinator;
  readonly #stateListeners = new Set<StateListener>();
  readonly #errorListeners = new Set<ErrorListener>();
  readonly #titleListeners = new Set<TitleListener>();
  readonly #bellListeners = new Set<BellListener>();
  readonly #scrollListeners = new Set<ScrollListener>();
  readonly #diagnosticListeners = new Set<DiagnosticListener>();
  readonly #displayListeners = new Set<DisplayListener>();
  readonly #connectionInfoListeners = new Set<ConnectionInfoListener>();

  constructor(private readonly options: SessionTransportOptions) {
    this.sessionId = options.sessionId;
    this.#uploadCoordinator = new SessionUploadCoordinator(options.bridge);
  }

  get state(): TransportState {
    return this.#state;
  }

  prepare(): void {
    if (this.#prepared) return;
    this.#prepared = true;
    this.#machine = reduceConnection(this.#machine, { type: "open" });
    this.#setState(this.#machine.phase);
    this.#loadEndorsements(this.#preflightTrust());
    this.#startSignal();
    this.#preparePromise = browserIdentityWire().then((browserKey) => {
      this.#browserKey = browserKey;
    });
  }

  networkChanged(): void {
    if (!this.#workerStarted || this.#state === "closed" || this.#state === "failed") return;
    this.#refreshConfigBefore(() => {
      if (!this.#workerStarted || this.#state === "closed" || this.#state === "failed") return;
      this.options.bridge.send({
        v: TERMINAL_BRIDGE_VERSION,
        type: "network-changed",
        ...(this.#cachedConfig
          ? {
              iceServers: this.#cachedConfig.iceServers,
              iceTransportPolicy: this.#cachedConfig.iceTransportPolicy,
            }
          : {}),
      });
    });
  }

  async open(): Promise<void> {
    if (this.#state === "ready") return;
    if (this.#state === "failed") throw new Error("Terminal transport is in a failed state.");
    if (this.#opening) return this.#opening;
    this.#opening = new Promise<void>((resolve, reject) => {
      this.#resolveOpen = resolve;
      this.#rejectOpen = reject;
    });
    this.prepare();
    const opening = this.#opening;
    try {
      await this.#preparePromise;
      if (this.#opening !== opening || ["closed", "failed"].includes(this.#state)) {
        return opening;
      }
      this.#bridgeUnsubscribe?.();
      this.#bridgeUnsubscribe = this.options.bridge.onMessage((message) => {
        void this.#handleWorkerMessage(message);
      });
      this.options.bridge.send({
        v: TERMINAL_BRIDGE_VERSION,
        type: "init",
        mode: "session",
        scopeId: this.sessionId,
        browserIdentityPublicKey: this.#browserKey ?? "",
        hostIdentityPublicKey: this.options.hostIdentityPublicKey,
        cols: this.options.initialSize.cols,
        rows: this.options.initialSize.rows,
        theme: this.options.theme,
        fontSize: this.options.fontSize ?? terminalMetrics.fontSize,
        ...(cachedLoopbackCapability === null ? {} : { cachedLoopback: cachedLoopbackCapability }),
      });
      this.#workerStarted = true;
      this.#armConnectWatchdog();
      if (this.#cachedConfig && this.#machine.phase === "signalling") {
        this.#startPeer(this.#cachedConfig);
      }
    } catch (error) {
      this.#fail(
        "transport_open",
        error instanceof Error ? error.message : "Terminal transport failed to open.",
      );
    }
    return this.#opening;
  }

  close(): void {
    if (this.#state === "closed") return;
    this.#clearReconnect();
    this.#clearConnectWatchdog();
    clearTimeout(this.#resumeTimer ?? undefined);
    this.#resumeTimer = null;
    try {
      this.options.bridge.send({ v: TERMINAL_BRIDGE_VERSION, type: "close" });
    } catch {
      // A terminated WebContent process has nothing left to close.
    }
    this.#retireSignal();
    this.#bridgeUnsubscribe?.();
    this.#bridgeUnsubscribe = null;
    this.#pendingInput.splice(0);
    this.#pendingInputBytes = 0;
    this.#workerStarted = false;
    this.#prepared = false;
    this.#preparePromise = null;
    this.#machine = reduceConnection(this.#machine, { type: "close" });
    this.#setState("closed");
    this.#rejectOpen?.(new Error("Terminal transport closed before becoming ready."));
    this.#settleOpening();
    this.#uploadCoordinator.close();
  }

  write(bytes: Uint8Array): void {
    if (bytes.byteLength === 0) return;
    if (this.#state !== "ready") {
      if (this.#pendingInputBytes + bytes.byteLength > PTY_INPUT_MAX_BYTES) {
        this.#emitError({
          code: "input_buffer_full",
          message: "Pending terminal input exceeds 64 KiB.",
          retryable: true,
        });
        return;
      }
      const copy = bytes.slice();
      this.#pendingInput.push(copy);
      this.#pendingInputBytes += copy.byteLength;
      return;
    }
    for (const chunk of chunkPtyInput(bytes)) this.#sendInput(chunk);
  }

  resize(cols: number, rows: number): void {
    if (
      !Number.isSafeInteger(cols) ||
      cols < 20 ||
      cols > 400 ||
      !Number.isSafeInteger(rows) ||
      rows < 5 ||
      rows > 200
    ) {
      this.#emitError({
        code: "invalid_resize",
        message: "Terminal grid is outside protocol bounds.",
        retryable: false,
      });
      return;
    }
    this.options.bridge.send({ v: TERMINAL_BRIDGE_VERSION, type: "resize", cols, rows });
  }

  takeControl(): void {
    this.options.bridge.send({ v: TERMINAL_BRIDGE_VERSION, type: "take-control" });
  }

  requestReplay(fromOffset?: number): void {
    this.options.bridge.send(
      fromOffset === undefined
        ? { v: TERMINAL_BRIDGE_VERSION, type: "request-replay" }
        : { v: TERMINAL_BRIDGE_VERSION, type: "request-replay", fromOffset },
    );
  }

  upload(request: UploadRequest): UploadHandle {
    return this.#uploadCoordinator.create(request, this.#state === "ready");
  }

  on(ev: "state", fn: StateListener): () => void;
  on(ev: "error", fn: ErrorListener): () => void;
  on(ev: "title", fn: TitleListener): () => void;
  on(ev: "bell", fn: BellListener): () => void;
  on(ev: "scroll", fn: ScrollListener): () => void;
  on(ev: "diagnostic", fn: DiagnosticListener): () => void;
  on(ev: "display", fn: DisplayListener): () => void;
  on(ev: "connection-info", fn: ConnectionInfoListener): () => void;
  on(
    ev:
      | "state"
      | "error"
      | "title"
      | "bell"
      | "scroll"
      | "diagnostic"
      | "display"
      | "connection-info",
    fn:
      | StateListener
      | ErrorListener
      | TitleListener
      | BellListener
      | ScrollListener
      | DiagnosticListener
      | DisplayListener
      | ConnectionInfoListener,
  ): () => void {
    const listeners = this.#listenersFor(ev);
    listeners.add(fn as never);
    return () => listeners.delete(fn as never);
  }

  #listenersFor(
    ev:
      | "state"
      | "error"
      | "title"
      | "bell"
      | "scroll"
      | "diagnostic"
      | "display"
      | "connection-info",
  ): Set<never> {
    return {
      state: this.#stateListeners,
      error: this.#errorListeners,
      title: this.#titleListeners,
      bell: this.#bellListeners,
      scroll: this.#scrollListeners,
      diagnostic: this.#diagnosticListeners,
      display: this.#displayListeners,
      "connection-info": this.#connectionInfoListeners,
    }[ev] as Set<never>;
  }

  #startSignal(): void {
    this.#retireSignal();
    const openSignal = this.options.openSignal ?? openSessionSignal;
    this.#signal = openSignal(this.sessionId);
    this.#signalUnsubscribe = this.#signal.onFrame((frame) => this.#handleSignalFrame(frame));
    this.#signalStateUnsubscribe =
      this.#signal.onState?.((state) => this.#handleSignalState(state)) ?? null;
    if (this.#signal.state === "open") this.#signalHasOpened = true;
  }

  #retireSignal(): void {
    this.#signalUnsubscribe?.();
    this.#signalUnsubscribe = null;
    this.#signalStateUnsubscribe?.();
    this.#signalStateUnsubscribe = null;
    this.#signal?.close();
    this.#signal = null;
  }

  #handleSignalFrame(value: unknown): void {
    const frame = frameRecord(value);
    if (!frame) return;
    if (frame.type === "rtc.config") {
      if (
        frame.enabled !== true ||
        frame.binding_nonce_required !== true ||
        !Array.isArray(frame.ice_servers)
      ) {
        this.#fail(
          "rtc_config",
          "Server RTC configuration is disabled or does not require nonce binding.",
        );
        return;
      }
      const iceServers = sanitizeIceServers(frame.ice_servers);
      if (frame.ice_servers.length > 0 && iceServers.length === 0) {
        this.#fail("rtc_config", "Server RTC configuration did not contain a safe ICE server.");
        return;
      }
      this.#cachedConfig = {
        iceServers,
        iceTransportPolicy: readTransportPolicy(frame.ice_transport_policy),
      };
      for (const waiter of this.#configWaiters) waiter();
      this.#configWaiters.clear();
      if (this.#workerStarted && this.#machine.phase === "signalling") {
        this.#startPeer(this.#cachedConfig);
      }
      return;
    }
    if (frame.type === "rtc.status") {
      const matchesActiveBinding =
        frame["session_id"] === this.#activeRtcSessionId &&
        frame["binding_nonce"] === this.#activeBindingNonce;
      if (matchesActiveBinding && Number.isSafeInteger(frame["binding_generation"])) {
        this.#activeBindingGeneration = frame["binding_generation"] as number;
      }
      if (
        matchesActiveBinding &&
        frame["status"] === "unavailable" &&
        this.#cachedConfig &&
        this.#workerStarted
      ) {
        clearTimeout(this.#resumeTimer ?? undefined);
        this.#resumeTimer = null;
        this.#startPeer(this.#cachedConfig, true);
        return;
      }
      if (
        matchesActiveBinding &&
        ["resumed", "rebound", "connected", "negotiating"].includes(String(frame["status"]))
      ) {
        clearTimeout(this.#resumeTimer ?? undefined);
        this.#resumeTimer = null;
      }
      if (matchesActiveBinding && frame["status"] === "failed") this.#handleRtcRefusal();
    }
    try {
      const verified = verifyAnswerFrame(
        value,
        this.options.hostIdentityPublicKey,
        this.#browserKey ?? "",
        {
          scopeType: "session",
          scopeId: this.sessionId,
          protocol: "spawn.pty",
          protocolVersion: 2,
        },
      );
      this.options.bridge.send({
        v: TERMINAL_BRIDGE_VERSION,
        type: "signal-frame",
        frame: verified,
      });
    } catch (error) {
      this.#fail(
        "signal_verification",
        error instanceof Error ? error.message : "RTC answer verification failed.",
      );
    }
  }

  #startPeer(config: CachedRtcConfig, forceRebuild = false): void {
    this.#machine = reduceConnection(this.#machine, { type: "signal-open" });
    this.#setState(this.#machine.phase);
    this.#activeRtcSessionId = newUuid();
    this.#activeBindingNonce = encodeHex(randomBytes(16));
    this.#activeBindingGeneration = null;
    this.options.bridge.send({
      v: TERMINAL_BRIDGE_VERSION,
      type: "connect",
      rtcSessionId: this.#activeRtcSessionId,
      bindingNonce: this.#activeBindingNonce,
      iceServers: config.iceServers,
      iceTransportPolicy: config.iceTransportPolicy,
      forceRelay: this.options.forceRelay ?? false,
      ...(forceRebuild ? { forceRebuild: true } : {}),
    });
  }

  #handleSignalState(state: string): void {
    if (state === "open") {
      if (
        this.#signalHasOpened &&
        this.#state === "ready" &&
        this.#activeRtcSessionId &&
        this.#activeBindingNonce &&
        this.#activeBindingGeneration
      ) {
        this.#signal?.send({
          type: "rtc.resume",
          session_id: this.#activeRtcSessionId,
          binding_nonce: this.#activeBindingNonce,
          binding_generation: this.#activeBindingGeneration,
          scope_type: "session",
          scope_id: this.sessionId,
          protocol: "spawn.pty",
          protocol_version: 2,
        });
        clearTimeout(this.#resumeTimer ?? undefined);
        this.#resumeTimer = setTimeout(() => {
          this.#resumeTimer = null;
          if (this.#state === "ready" && this.#cachedConfig && this.#workerStarted) {
            this.#startPeer(this.#cachedConfig, true);
          }
        }, 2_000);
      }
      this.#signalHasOpened = true;
      return;
    }
    if (state !== "failed" && state !== "unauthenticated") return;
    const close = this.#signal?.closeInfo;
    const message =
      close?.code === 4003
        ? "Update SPAWN D to reconnect to this terminal."
        : state === "unauthenticated" || close?.code === 1008
          ? "You've been signed out."
          : close?.reason || "The signalling connection failed.";
    this.#fail("signal_failed", message);
  }

  #refreshConfigBefore(callback: () => void): void {
    if (
      !this.#cachedConfig ||
      !iceServersNeedRefresh(this.#cachedConfig.iceServers) ||
      this.#signal?.state !== "open"
    ) {
      callback();
      return;
    }
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      this.#configWaiters.delete(finish);
      callback();
    };
    const timer = setTimeout(finish, 2_000);
    this.#configWaiters.add(finish);
    try {
      this.#signal.send({ type: "rtc.config.request" });
    } catch {
      finish();
    }
  }

  async #handleWorkerMessage(message: WorkerToNativeMessage): Promise<void> {
    switch (message.type) {
      case "state":
        if (message.gate && isReadinessGate(message.gate)) {
          this.#machine = reduceConnection(this.#machine, { type: "gate", gate: message.gate });
          this.#setState(this.#machine.phase);
        } else if (message.state === "ready") {
          this.#setState("ready");
        } else if (message.state === "reconnecting") {
          this.#scheduleReconnect();
        } else {
          this.#setState(message.state);
        }
        break;
      case "signal-frame":
        try {
          this.#signal?.send(message.frame);
        } catch {
          // The data plane can outlive signalling; its restart fallback will
          // rebuild after the socket's ordinary reconnect path recovers.
        }
        break;
      case "sign-request":
        try {
          const [signature, carriedEndorsements] = await Promise.all([
            signWorkerRequest(message),
            this.#endorsements,
          ]);
          this.options.bridge.send({
            v: TERMINAL_BRIDGE_VERSION,
            type: "sign-response",
            requestId: message.requestId,
            signature,
            ...(carriedEndorsements.length > 0 ? { carriedEndorsements } : {}),
          });
        } catch (error) {
          this.options.bridge.send({
            v: TERMINAL_BRIDGE_VERSION,
            type: "sign-response",
            requestId: message.requestId,
            error: error instanceof Error ? error.message : "Signal signing failed.",
          });
          this.#fail("signal_signing", "RTC offer signing failed.");
        }
        break;
      case "title":
        for (const listener of this.#titleListeners) listener(message.title);
        break;
      case "bell":
        for (const listener of this.#bellListeners) listener();
        break;
      case "display": {
        const display: DisplayControlState = {
          owner: message.owner,
          viewers: message.viewers,
          cols: message.cols ?? null,
          rows: message.rows ?? null,
        };
        for (const listener of this.#displayListeners) listener(display);
        break;
      }
      case "scroll-state":
        for (const listener of this.#scrollListeners) listener(message.scroll);
        break;
      case "diagnostic":
        if (message.diagnostic.peerConnection && message.diagnostic.dataChannel) {
          cachedLoopbackCapability = message.diagnostic.loopback;
        }
        for (const listener of this.#diagnosticListeners) listener(message.diagnostic);
        if (
          !message.diagnostic.isSecureContext ||
          !message.diagnostic.peerConnection ||
          !message.diagnostic.dataChannel ||
          !message.diagnostic.loopback
        ) {
          this.#fail(
            "worker_capability",
            message.diagnostic.detail ?? "WKWebView cannot create a secure WebRTC DataChannel.",
          );
        }
        break;
      case "connection-info":
        for (const listener of this.#connectionInfoListeners) listener(message.info);
        break;
      case "upload-progress":
        this.#uploadCoordinator.handleProgress(message);
        break;
      case "error":
        this.#emitError({
          code: message.code,
          message: message.message,
          retryable: message.retryable,
          ...(message.detail === undefined ? {} : { detail: message.detail }),
        });
        if (!message.retryable) this.#fail(message.code, message.message);
        break;
      default:
        break;
    }
  }

  #setState(next: TransportState): void {
    if (this.#state === next) return;
    this.#state = next;
    for (const listener of this.#stateListeners) listener(next);
    if (next !== "ready") return;
    this.#hasEverReady = true;
    this.#reconnectStartedAt = null;
    this.#clearConnectWatchdog();
    this.#resolveOpen?.();
    this.#settleOpening();
    for (const bytes of this.#pendingInput.splice(0)) {
      for (const chunk of chunkPtyInput(bytes)) this.#sendInput(chunk);
    }
    this.#pendingInputBytes = 0;
    this.#uploadCoordinator.startPending();
  }

  #settleOpening(): void {
    this.#opening = null;
    this.#resolveOpen = null;
    this.#rejectOpen = null;
  }

  #sendInput(bytes: Uint8Array): void {
    this.options.bridge.send({
      v: TERMINAL_BRIDGE_VERSION,
      type: "input",
      sequence: ++this.#inputSequence,
      data: encodeBridgeBytes(bytes),
    });
  }

  #scheduleReconnect(): void {
    if (this.#state === "closed" || this.#state === "failed" || this.#reconnectTimer) return;
    this.#clearConnectWatchdog();
    this.#machine = reduceConnection(this.#machine, { type: "disconnect" });
    this.#setState("reconnecting");
    this.#reconnectStartedAt ??= Date.now();
    const delay = this.#machine.reconnectDelayMs ?? reconnectDelay(0);
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      // A transport that failed or closed while this was pending is done: it
      // has no surface listening, and reopening signalling here would race the
      // one that replaced it.
      if (this.#state === "failed" || this.#state === "closed") return;
      this.#machine = reduceConnection(this.#machine, { type: "retry" });
      this.#setState("signalling");
      this.#loadEndorsements(this.#preflightTrust());
      this.#armConnectWatchdog();
      this.#startSignal();
    }, delay);
  }

  #armConnectWatchdog(): void {
    this.#clearConnectWatchdog();
    this.#connectTimer = setTimeout(() => {
      this.#connectTimer = null;
      if (this.#state === "ready" || this.#state === "closed" || this.#state === "failed") return;
      if (
        this.#hasEverReady &&
        Date.now() - (this.#reconnectStartedAt ?? Date.now()) < RECONNECT_BUDGET_MS
      ) {
        this.#scheduleReconnect();
        return;
      }
      this.#fail(
        "connect_timeout",
        this.#hasEverReady ? LOST_CONNECTION_MESSAGE : CONNECT_TIMEOUT_MESSAGE,
      );
    }, this.options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS);
  }

  #clearConnectWatchdog(): void {
    if (this.#connectTimer === null) return;
    clearTimeout(this.#connectTimer);
    this.#connectTimer = null;
  }

  #clearReconnect(): void {
    if (this.#reconnectTimer === null) return;
    clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
  }

  /**
   * The endorsement edges the next offer will carry.
   *
   * Read once per attempt, not once per transport. The edge that admits a
   * refused device is written by the approval that *follows* the refusal, so a
   * set frozen when the terminal opened is the one set that can never work:
   * every reconnect re-sent the same empty proof, the host refused it again,
   * and the terminal only recovered when the operator left the session and
   * came back to build a fresh transport.
   *
   * A directly pinned device needs no edges at all — until a host refuses it
   * anyway, which is exactly the moment the host's view of this device and the
   * server's have diverged, and the chain is the only thing left that can
   * close the gap.
   */
  #loadEndorsements(trust: Promise<DeviceHostTrustResult>): void {
    this.#endorsements = trust
      .then((result) =>
        result.directlyPinned && !this.#refused
          ? []
          : (this.options.loadCarriedEndorsements ?? loadMemoizedCarriedEndorsements)(),
      )
      .catch(() => []);
  }

  /**
   * The host answered a signed offer, and the answer was no.
   *
   * Both memoized views of this device's own admission are wrong the moment
   * that lands: the verdict the screen is showing, and the edges the next
   * offer would carry. Dropping them is what lets an approval granted seconds
   * later take effect on the next attempt — and re-probing is what turns a
   * device that really is unapproved into the approval ceremony instead of an
   * indefinite "Reconnecting".
   */
  #handleRtcRefusal(): void {
    this.#refused = true;
    invalidateDeviceHostTrust(this.options.hostId);
  }

  /**
   * Runs alongside signalling rather than gating it: a trusted device pays no
   * latency, and an unapproved one gets the real reason in a few hundred
   * milliseconds instead of waiting out the watchdog.
   */
  #preflightTrust(): Promise<DeviceHostTrustResult> {
    const hostId = this.options.hostId;
    if (hostId === undefined) {
      return Promise.resolve({ status: "unknown", directlyPinned: false });
    }
    const result = (
      this.options.probeTrustResult
        ? this.options.probeTrustResult(hostId)
        : this.options.probeTrust
          ? this.options.probeTrust(hostId).then((status) => ({ status, directlyPinned: false }))
          : probeDeviceHostTrustResult(hostId)
    ).catch(() => ({ status: "unknown" as const, directlyPinned: false }));
    void result.then(({ status }) => {
      if (status !== "untrusted") return;
      if (this.#state === "ready" || this.#state === "closed" || this.#state === "failed") return;
      this.#fail(DEVICE_NOT_TRUSTED_CODE, DEVICE_NOT_TRUSTED_MESSAGE);
    });
    return result;
  }

  #fail(code: string, message: string): void {
    if (this.#state === "failed" || this.#state === "closed") return;
    this.#clearConnectWatchdog();
    this.#clearReconnect();
    const error = { code, message, retryable: false } satisfies TransportError;
    this.#emitError(error);
    this.#machine = reduceConnection(this.#machine, { type: "fail" });
    this.#setState("failed");
    // The rejection must carry the code: a caller that rewraps a bare Error
    // erases device_not_trusted, and with it the approval ceremony.
    this.#rejectOpen?.(new HostControlTransportError(code, message));
    this.#settleOpening();
    this.#retireSignal();
  }

  #emitError(error: TransportError): void {
    for (const listener of this.#errorListeners) listener(error);
  }
}

function isReadinessGate(value: string): value is ReadinessGate {
  return (
    value === "bindingAccepted" ||
    value === "ptyOpen" ||
    value === "ctlOpen" ||
    value === "daemonReady" ||
    value === "historyReady"
  );
}

export function createSessionTransport(options: SessionTransportOptions): SessionTransport {
  return new WebViewSessionTransport(options);
}
