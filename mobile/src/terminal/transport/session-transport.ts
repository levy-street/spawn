import { openSessionSignal } from "@/data/realtime/session-signal";
import { randomBytes } from "@/lib/crypto/bootstrap";
import { bytesToUuid, encodeHex } from "@/lib/crypto/bytes";
import {
  encodeBridgeBytes,
  TERMINAL_BRIDGE_VERSION,
  type WorkerToNativeMessage,
} from "@/terminal/transport/bridge";
import { chunkPtyInput, PTY_INPUT_MAX_BYTES } from "@/terminal/transport/ctl-codec";
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
import { terminalMetrics } from "@/theme";

type StateListener = (state: TransportState) => void;
type ErrorListener = (error: TransportError) => void;
type TitleListener = (title: string) => void;
type BellListener = () => void;
type ScrollListener = (scroll: ScrollState) => void;
type DiagnosticListener = (diagnostic: WorkerDiagnostic) => void;

interface ConfigFrame extends Record<string, unknown> {
  type?: unknown;
  enabled?: unknown;
  ice_servers?: unknown;
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
  on(
    ev: "state" | "error" | "title" | "bell" | "scroll" | "diagnostic",
    fn:
      | StateListener
      | ErrorListener
      | TitleListener
      | BellListener
      | ScrollListener
      | DiagnosticListener,
  ): () => void {
    const listeners = this.#listenersFor(ev);
    listeners.add(fn as never);
    return () => listeners.delete(fn as never);
  }

  #listenersFor(ev: "state" | "error" | "title" | "bell" | "scroll" | "diagnostic"): Set<never> {
    return {
      state: this.#stateListeners,
      error: this.#errorListeners,
      title: this.#titleListeners,
      bell: this.#bellListeners,
      scroll: this.#scrollListeners,
      diagnostic: this.#diagnosticListeners,
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
          const signature = await signWorkerRequest(message);
          this.options.bridge.send({
            v: TERMINAL_BRIDGE_VERSION,
            type: "sign-response",
            requestId: message.requestId,
            signature,
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
    this.#machine = reduceConnection(this.#machine, { type: "disconnect" });
    this.#setState("reconnecting");
    const delay = this.#machine.reconnectDelayMs ?? reconnectDelay(0);
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.#machine = reduceConnection(this.#machine, { type: "retry" });
      this.#setState("signalling");
      this.#startSignal();
    }, delay);
  }

  #fail(code: string, message: string): void {
    const error = { code, message, retryable: false } satisfies TransportError;
    this.#emitError(error);
    this.#machine = reduceConnection(this.#machine, { type: "fail" });
    this.#setState("failed");
    this.#rejectOpen?.(new Error(message));
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
