import { openHostSignal } from "@/data/realtime/host-signal";
import { randomBytes } from "@/lib/crypto/bootstrap";
import { bytesToUuid, encodeHex } from "@/lib/crypto/bytes";
import { TERMINAL_BRIDGE_VERSION, type WorkerToNativeMessage } from "@/terminal/transport/bridge";
import {
  browserIdentityWire,
  signWorkerRequest,
  verifyAnswerFrame,
} from "@/terminal/transport/signed-signalling";
import type {
  HostTransport,
  HostTransportOptions,
  SignalChannelLike,
  TransportError,
  TransportState,
  WorkerDiagnostic,
} from "@/terminal/transport/types";
import { terminalDark, terminalMetrics } from "@/theme";

const MAX_PENDING_REQUESTS = 32;
const REQUEST_TIMEOUT_MS = 15_000;

interface FrameRecord extends Record<string, unknown> {
  type?: unknown;
  enabled?: unknown;
  ice_servers?: unknown;
  binding_nonce_required?: unknown;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

function record(value: unknown): FrameRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as FrameRecord)
    : null;
}

function newUuid(): string {
  const bytes = randomBytes(16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  return bytesToUuid(bytes);
}

class WebViewHostTransport implements HostTransport {
  readonly hostId: string;
  #state: TransportState = "idle";
  #browserKey: string | null = null;
  #signal: SignalChannelLike | null = null;
  #signalUnsubscribe: (() => void) | null = null;
  #bridgeUnsubscribe: (() => void) | null = null;
  #opening: Promise<void> | null = null;
  #resolveOpen: (() => void) | null = null;
  #rejectOpen: ((error: Error) => void) | null = null;
  readonly #pending = new Map<string, PendingRequest>();
  readonly #stateListeners = new Set<(state: TransportState) => void>();
  readonly #errorListeners = new Set<(error: TransportError) => void>();
  readonly #diagnosticListeners = new Set<(diagnostic: WorkerDiagnostic) => void>();

  constructor(private readonly options: HostTransportOptions) {
    this.hostId = options.hostId;
  }

  get state(): TransportState {
    return this.#state;
  }

  async open(): Promise<void> {
    if (this.#state === "ready") return;
    if (this.#state === "failed") throw new Error("Host transport is in a failed state.");
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
        mode: "host",
        scopeId: this.hostId,
        browserIdentityPublicKey: this.#browserKey,
        hostIdentityPublicKey: this.options.hostIdentityPublicKey,
        cols: 80,
        rows: 24,
        theme: terminalDark,
        fontSize: terminalMetrics.fontSize,
      });
      this.#setState("signalling");
      this.#startSignal();
    } catch (error) {
      this.#fail(
        "host_open",
        error instanceof Error ? error.message : "Host transport failed to open.",
      );
    }
    return this.#opening;
  }

  close(): void {
    if (this.#state === "closed") return;
    try {
      this.options.bridge.send({ v: TERMINAL_BRIDGE_VERSION, type: "close" });
    } catch {
      // A terminated WebContent process has nothing left to close.
    }
    this.#retireSignal();
    this.#bridgeUnsubscribe?.();
    this.#bridgeUnsubscribe = null;
    this.#setState("closed");
    this.#rejectOpen?.(new Error("Host transport closed before becoming ready."));
    this.#settleOpening();
    for (const [requestId, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Host transport closed."));
      this.#pending.delete(requestId);
    }
  }

  request<T>(operation: string, payload?: unknown): Promise<T> {
    if (this.#state !== "ready") return Promise.reject(new Error("Host transport is not ready."));
    if (this.#pending.size >= MAX_PENDING_REQUESTS) {
      return Promise.reject(new Error("Too many pending host-control requests."));
    }
    const requestId = newUuid();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(requestId);
        this.cancel(requestId);
        reject(new Error("Host-control request acknowledgement was not received."));
      }, REQUEST_TIMEOUT_MS);
      this.#pending.set(requestId, { resolve: (value) => resolve(value as T), reject, timer });
      this.options.bridge.send({
        v: TERMINAL_BRIDGE_VERSION,
        type: "host-request",
        requestId,
        operation,
        ...(payload === undefined ? {} : { payload }),
      });
    });
  }

  cancel(requestId: string): void {
    this.options.bridge.send({ v: TERMINAL_BRIDGE_VERSION, type: "host-cancel", requestId });
  }

  on(ev: "state", fn: (state: TransportState) => void): () => void;
  on(ev: "error", fn: (error: TransportError) => void): () => void;
  on(ev: "diagnostic", fn: (diagnostic: WorkerDiagnostic) => void): () => void;
  on(
    ev: "state" | "error" | "diagnostic",
    fn:
      | ((state: TransportState) => void)
      | ((error: TransportError) => void)
      | ((diagnostic: WorkerDiagnostic) => void),
  ): () => void {
    if (ev === "state") {
      const listener = fn as (state: TransportState) => void;
      this.#stateListeners.add(listener);
      return () => this.#stateListeners.delete(listener);
    }
    if (ev === "error") {
      const listener = fn as (error: TransportError) => void;
      this.#errorListeners.add(listener);
      return () => this.#errorListeners.delete(listener);
    }
    const listener = fn as (diagnostic: WorkerDiagnostic) => void;
    this.#diagnosticListeners.add(listener);
    return () => this.#diagnosticListeners.delete(listener);
  }

  #startSignal(): void {
    this.#retireSignal();
    const openSignal = this.options.openSignal ?? openHostSignal;
    this.#signal = openSignal(this.hostId);
    this.#signalUnsubscribe = this.#signal.onFrame((frame) => this.#handleSignalFrame(frame));
  }

  #retireSignal(): void {
    this.#signalUnsubscribe?.();
    this.#signalUnsubscribe = null;
    this.#signal?.close();
    this.#signal = null;
  }

  #handleSignalFrame(value: unknown): void {
    const frame = record(value);
    if (!frame) return;
    if (frame.type === "rtc.config") {
      if (
        frame.enabled !== true ||
        frame.binding_nonce_required !== true ||
        !Array.isArray(frame.ice_servers)
      ) {
        this.#fail("rtc_config", "Host RTC configuration is disabled or weakly bound.");
        return;
      }
      this.#setState("connecting");
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
          scopeType: "host",
          scopeId: this.hostId,
          protocol: "spawn.host.ctl",
          protocolVersion: 1,
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
        error instanceof Error ? error.message : "Host RTC answer verification failed.",
      );
    }
  }

  async #handleWorkerMessage(message: WorkerToNativeMessage): Promise<void> {
    switch (message.type) {
      case "state":
        this.#setState(message.state);
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
        }
        break;
      case "host-response": {
        const pending = this.#pending.get(message.requestId);
        if (!pending) break;
        clearTimeout(pending.timer);
        this.#pending.delete(message.requestId);
        if (message.ok) pending.resolve(message.result);
        else
          pending.reject(
            new Error(
              message.error?.detail ?? message.error?.code ?? "Host-control request failed.",
            ),
          );
        break;
      }
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
            message.diagnostic.detail ?? "WKWebView cannot create host WebRTC control.",
          );
        }
        break;
      case "error":
        this.#emitError({
          code: message.code,
          message: message.message,
          retryable: message.retryable,
          ...(message.detail === undefined ? {} : { detail: message.detail }),
        });
        if (!message.retryable) this.#setState("failed");
        break;
      default:
        break;
    }
  }

  #setState(state: TransportState): void {
    if (this.#state === state) return;
    this.#state = state;
    for (const listener of this.#stateListeners) listener(state);
    if (state === "ready") {
      this.#resolveOpen?.();
      this.#settleOpening();
    }
  }

  #fail(code: string, message: string): void {
    this.#emitError({ code, message, retryable: false });
    this.#setState("failed");
    this.#rejectOpen?.(new Error(message));
    this.#settleOpening();
    this.#retireSignal();
  }

  #emitError(error: TransportError): void {
    for (const listener of this.#errorListeners) listener(error);
  }

  #settleOpening(): void {
    this.#opening = null;
    this.#resolveOpen = null;
    this.#rejectOpen = null;
  }
}

export function createHostTransport(options: HostTransportOptions): HostTransport {
  return new WebViewHostTransport(options);
}
