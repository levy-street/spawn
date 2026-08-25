import { openSessionSignal } from "@/data/realtime/session-signal";
import { loadCarriedEndorsements } from "@/data/trust/carried-endorsements";
import {
  DEVICE_NOT_TRUSTED_CODE,
  DEVICE_NOT_TRUSTED_MESSAGE,
  probeDeviceHostTrust,
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
import { readTransportPolicy } from "@/terminal/transport/types";
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

type StateListener = (state: TransportState) => void;
type ErrorListener = (error: TransportError) => void;
type TitleListener = (title: string) => void;
type BellListener = () => void;
type ScrollListener = (scroll: ScrollState) => void;
type DiagnosticListener = (diagnostic: WorkerDiagnostic) => void;
type DisplayListener = (display: DisplayControlState) => void;

interface ConfigFrame extends Record<string, unknown> {
  type?: unknown;
  enabled?: unknown;
  ice_servers?: unknown;
  ice_transport_policy?: unknown;
  binding_nonce_required?: unknown;
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
  #bridgeUnsubscribe: (() => void) | null = null;
  #browserKey: string | null = null;
  #pendingInput: Uint8Array[] = [];
  #pendingInputBytes = 0;
  #inputSequence = 0;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #connectTimer: ReturnType<typeof setTimeout> | null = null;
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

  constructor(private readonly options: SessionTransportOptions) {
    this.sessionId = options.sessionId;
    this.#uploadCoordinator = new SessionUploadCoordinator(options.bridge);
  }

  get state(): TransportState {
    return this.#state;
  }

  async open(): Promise<void> {
    if (this.#state === "ready") return;
    if (this.#state === "failed") throw new Error("Terminal transport is in a failed state.");
    if (this.#opening) return this.#opening;
    this.#opening = new Promise<void>((resolve, reject) => {
      this.#resolveOpen = resolve;
      this.#rejectOpen = reject;
    });
    try {
      this.#browserKey = await browserIdentityWire();
      this.#bridgeUnsubscribe = this.options.bridge.onMessage((message) => {
        void this.#handleWorkerMessage(message);
      });
      this.options.bridge.send({
        v: TERMINAL_BRIDGE_VERSION,
        type: "init",
        mode: "session",
        scopeId: this.sessionId,
        browserIdentityPublicKey: this.#browserKey,
        hostIdentityPublicKey: this.options.hostIdentityPublicKey,
        cols: this.options.initialSize.cols,
        rows: this.options.initialSize.rows,
        theme: this.options.theme,
        fontSize: this.options.fontSize ?? terminalMetrics.fontSize,
      });
      this.#machine = reduceConnection(this.#machine, { type: "open" });
      this.#setState(this.#machine.phase);
      this.#armConnectWatchdog();
      this.#preflightTrust();
      this.#startSignal();
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
    clearTimeout(this.#reconnectTimer ?? undefined);
    this.#reconnectTimer = null;
    this.#clearConnectWatchdog();
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
  on(
    ev: "state" | "error" | "title" | "bell" | "scroll" | "diagnostic" | "display",
    fn:
      | StateListener
      | ErrorListener
      | TitleListener
      | BellListener
      | ScrollListener
      | DiagnosticListener
      | DisplayListener,
  ): () => void {
    const listeners = this.#listenersFor(ev);
    listeners.add(fn as never);
    return () => listeners.delete(fn as never);
  }

  #listenersFor(
    ev: "state" | "error" | "title" | "bell" | "scroll" | "diagnostic" | "display",
  ): Set<never> {
    return {
      state: this.#stateListeners,
      error: this.#errorListeners,
      title: this.#titleListeners,
      bell: this.#bellListeners,
      scroll: this.#scrollListeners,
      diagnostic: this.#diagnosticListeners,
      display: this.#displayListeners,
    }[ev] as Set<never>;
  }

  #startSignal(): void {
    this.#retireSignal();
    const openSignal = this.options.openSignal ?? openSessionSignal;
    this.#signal = openSignal(this.sessionId);
    this.#signalUnsubscribe = this.#signal.onFrame((frame) => this.#handleSignalFrame(frame));
  }

  #retireSignal(): void {
    this.#signalUnsubscribe?.();
    this.#signalUnsubscribe = null;
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
      this.#machine = reduceConnection(this.#machine, { type: "signal-open" });
      this.#setState(this.#machine.phase);
      this.options.bridge.send({
        v: TERMINAL_BRIDGE_VERSION,
        type: "connect",
        rtcSessionId: newUuid(),
        bindingNonce: encodeHex(randomBytes(16)),
        iceServers: frame.ice_servers,
        iceTransportPolicy: readTransportPolicy(frame.ice_transport_policy),
        forceRelay: this.options.forceRelay ?? false,
      });
      return;
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
        this.#signal?.send(message.frame);
        break;
      case "sign-request":
        try {
          const [signature, carriedEndorsements] = await Promise.all([
            signWorkerRequest(message),
            (this.options.loadCarriedEndorsements ?? loadCarriedEndorsements)().catch(() => {
              // Endorsements are best-effort; direct pins can still admit this signed offer.
              return [];
            }),
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
    const delay = this.#machine.reconnectDelayMs ?? reconnectDelay(0);
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.#machine = reduceConnection(this.#machine, { type: "retry" });
      this.#setState("signalling");
      this.#armConnectWatchdog();
      this.#startSignal();
    }, delay);
  }

  #armConnectWatchdog(): void {
    this.#clearConnectWatchdog();
    this.#connectTimer = setTimeout(() => {
      this.#connectTimer = null;
      if (this.#state === "ready" || this.#state === "closed" || this.#state === "failed") return;
      this.#fail("connect_timeout", CONNECT_TIMEOUT_MESSAGE);
    }, this.options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS);
  }

  #clearConnectWatchdog(): void {
    if (this.#connectTimer === null) return;
    clearTimeout(this.#connectTimer);
    this.#connectTimer = null;
  }

  /**
   * Runs alongside signalling rather than gating it: a trusted device pays no
   * latency, and an unapproved one gets the real reason in a few hundred
   * milliseconds instead of waiting out the watchdog.
   */
  #preflightTrust(): void {
    const hostId = this.options.hostId;
    if (hostId === undefined) return;
    const probe = this.options.probeTrust ?? probeDeviceHostTrust;
    void probe(hostId).then((trust) => {
      if (trust !== "untrusted") return;
      if (this.#state === "ready" || this.#state === "closed" || this.#state === "failed") return;
      this.#fail(DEVICE_NOT_TRUSTED_CODE, DEVICE_NOT_TRUSTED_MESSAGE);
    });
  }

  #fail(code: string, message: string): void {
    if (this.#state === "failed" || this.#state === "closed") return;
    this.#clearConnectWatchdog();
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
