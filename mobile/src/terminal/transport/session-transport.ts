import { randomBytes } from "@/lib/crypto/bootstrap";
import { bytesToUuid } from "@/lib/crypto/bytes";
import { activeDeviceIdentityAccount } from "@/lib/crypto/identity";
import {
  encodeBridgeBytes,
  TERMINAL_BRIDGE_VERSION,
  type WorkerToNativeMessage,
} from "@/terminal/transport/bridge";
import { chunkPtyInput } from "@/terminal/transport/ctl-codec";
import { HostControlTransportError } from "@/terminal/transport/host-ctl-codec";
import {
  type HostTransportLease,
  retainHostTransport,
} from "@/terminal/transport/host-transport-registry";
import { SessionUploadCoordinator } from "@/terminal/transport/session-upload";
import type {
  AgentNotice,
  ConnectionInfo,
  DisplayControlState,
  ScrollState,
  SessionTransport,
  SessionTransportOptions,
  TransportError,
  TransportState,
  UploadHandle,
  UploadRequest,
  WorkerDiagnostic,
} from "@/terminal/transport/types";
import { CONNECT_TIMEOUT_MS } from "@/terminal/transport/types";
import { terminalMetrics } from "@/theme";

export {
  CONNECT_TIMEOUT_MESSAGE,
  CONNECT_TIMEOUT_MS,
  LOST_CONNECTION_MESSAGE,
} from "@/terminal/transport/types";

type StateListener = (state: TransportState) => void;
type ErrorListener = (error: TransportError) => void;
type TitleListener = (title: string) => void;
type BellListener = () => void;
type AgentNoticeListener = (notice: AgentNotice | null) => void;
type ScrollListener = (scroll: ScrollState) => void;
type DiagnosticListener = (diagnostic: WorkerDiagnostic) => void;
type DisplayListener = (display: DisplayControlState) => void;
type ConnectionInfoListener = (info: ConnectionInfo) => void;
type PairEvent = Extract<WorkerToNativeMessage, { type: "pair-command" | "pair-event" }>;
const MAX_PENDING_VIEW_EVENTS = 512;
const MAX_PENDING_VIEW_EVENT_BYTES = 2 * 1024 * 1024;
function newUuid(): string {
  const bytes = randomBytes(16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  return bytesToUuid(bytes);
}

/** A terminal view owns its channels; its daemon lease owns the connection. */
class WebViewSessionTransport implements SessionTransport {
  readonly sessionId: string;
  readonly #accountId = activeDeviceIdentityAccount();
  readonly #viewId = newUuid();
  #state: TransportState = "idle";
  #lease: HostTransportLease | null = null;
  #attachmentId: string | null = null;
  #workerStarted = false;
  #pendingViewEvents: PairEvent[] = [];
  #pendingViewBytes = 0;
  #displayOwner = false;
  #lastError: TransportError | null = null;
  #inputSequence = 0;
  #subscriptions: Array<() => void> = [];
  #retry: ReturnType<typeof setTimeout> | null = null;
  #deadline: ReturnType<typeof setTimeout> | null = null;
  #opening: Promise<void> | null = null;
  #resolveOpen: (() => void) | null = null;
  #rejectOpen: ((error: Error) => void) | null = null;
  readonly #uploadCoordinator: SessionUploadCoordinator;
  readonly #stateListeners = new Set<StateListener>();
  readonly #errorListeners = new Set<ErrorListener>();
  readonly #titleListeners = new Set<TitleListener>();
  readonly #bellListeners = new Set<BellListener>();
  readonly #agentNoticeListeners = new Set<AgentNoticeListener>();
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
  get daemonState(): TransportState {
    return this.#lease?.shared.transport.state ?? "idle";
  }
  prepare(): void {
    if (this.#lease) return;
    if (!this.options.hostId) throw new Error("Terminal attachment requires its host ID.");
    this.#lease = retainHostTransport(
      { hostId: this.options.hostId, hostIdentityPublicKey: this.options.hostIdentityPublicKey },
      false,
    );
    this.#setState("connecting");
    const shared = this.#lease.shared;
    this.#subscriptions.push(
      shared.bridge.onMessage((message) => {
        if (activeDeviceIdentityAccount() !== this.#accountId) return;
        if (message.type === "pair-event" && message.attachmentId === this.#attachmentId) {
          if (!this.#workerStarted) {
            // Open the channels while the terminal document loads. Receive
            // credits stay outstanding until that document consumes the data;
            // this additional native queue is bounded and attachment-scoped.
            const bytes = new TextEncoder().encode(message.data ?? "").byteLength;
            if (
              this.#pendingViewEvents.length >= MAX_PENDING_VIEW_EVENTS ||
              this.#pendingViewBytes + bytes > MAX_PENDING_VIEW_EVENT_BYTES
            ) {
              this.#retryAttachment();
              return;
            }
            this.#pendingViewEvents.push(message);
            this.#pendingViewBytes += bytes;
          } else {
            try {
              this.options.bridge.send(message);
            } catch {
              this.#retryAttachment();
            }
          }
        } else if (message.type === "connection-info") {
          for (const listener of this.#connectionInfoListeners) listener(message.info);
        }
      }),
      shared.transport.on("state", () => this.#syncConnection()),
      shared.transport.on("error", (error) => {
        this.#lastError = error;
        this.#emitError(error);
      }),
    );
    this.#syncConnection();
  }
  networkChanged(): void {
    // The app-owned daemon surface handles network changes once for every view.
  }
  async open(): Promise<void> {
    if (this.#state === "ready") return;
    if (this.#opening) return this.#opening;
    this.prepare();
    const shared = this.#lease?.shared;
    if (!shared) throw new Error("The daemon connection lease is unavailable.");
    const opening = new Promise<void>((resolve, reject) => {
      this.#resolveOpen = resolve;
      this.#rejectOpen = reject;
    });
    this.#opening = opening;
    if (this.#workerStarted) {
      this.#syncConnection();
      return opening;
    }
    this.#workerStarted = true;
    try {
      this.#subscriptions.push(
        this.options.bridge.onMessage((message) => this.#handleWorkerMessage(message)),
      );
      this.options.bridge.send({
        v: TERMINAL_BRIDGE_VERSION,
        type: "init",
        mode: "session",
        scopeId: this.sessionId,
        browserIdentityPublicKey: "",
        hostIdentityPublicKey: this.options.hostIdentityPublicKey,
        cols: this.options.initialSize.cols,
        rows: this.options.initialSize.rows,
        theme: this.options.theme,
        fontSize: this.options.fontSize ?? terminalMetrics.fontSize,
        skipLoopbackProbe: true,
      });
      if (this.#attachmentId) this.#startView();
      else this.#syncConnection();
    } catch (error) {
      this.#rejectOpen?.(error instanceof Error ? error : new Error("Terminal bridge failed."));
      this.close();
    }
    return opening;
  }
  close(): void {
    if (this.#state === "closed") return;
    this.#workerStarted = false;
    this.#detach();
    for (const unsubscribe of this.#subscriptions.splice(0)) unsubscribe();
    try {
      this.options.bridge.send({ v: TERMINAL_BRIDGE_VERSION, type: "close" });
    } catch {
      /* Process already retired. */
    }
    this.#lease?.release();
    this.#lease = null;
    this.#uploadCoordinator.close();
    this.#setState("closed");
    this.#rejectOpen?.(new Error("Terminal view closed before becoming ready."));
    this.#settleOpening();
  }
  write(bytes: Uint8Array): void {
    if (
      this.#state !== "ready" ||
      !this.#displayOwner ||
      activeDeviceIdentityAccount() !== this.#accountId
    )
      return;
    for (const chunk of chunkPtyInput(bytes))
      this.options.bridge.send({
        v: TERMINAL_BRIDGE_VERSION,
        type: "input",
        sequence: ++this.#inputSequence,
        data: encodeBridgeBytes(chunk),
      });
  }
  resize(cols: number, rows: number): void {
    if (
      !Number.isInteger(cols) ||
      cols < 20 ||
      cols > 400 ||
      !Number.isInteger(rows) ||
      rows < 5 ||
      rows > 200
    )
      return;
    this.options.bridge.send({ v: TERMINAL_BRIDGE_VERSION, type: "resize", cols, rows });
  }
  takeControl(): void {
    if (this.#state === "ready")
      this.options.bridge.send({ v: TERMINAL_BRIDGE_VERSION, type: "take-control" });
  }
  requestReplay(fromOffset?: number): void {
    if (this.#state === "ready")
      this.options.bridge.send({
        v: TERMINAL_BRIDGE_VERSION,
        type: "request-replay",
        ...(fromOffset === undefined ? {} : { fromOffset }),
      });
  }
  upload(request: UploadRequest): UploadHandle {
    return this.#uploadCoordinator.create(request, this.#state === "ready");
  }
  on(ev: "state", fn: StateListener): () => void;
  on(ev: "error", fn: ErrorListener): () => void;
  on(ev: "title", fn: TitleListener): () => void;
  on(ev: "bell", fn: BellListener): () => void;
  on(ev: "agent-notice", fn: AgentNoticeListener): () => void;
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
      | "agent-notice"
      | "scroll"
      | "diagnostic"
      | "display"
      | "connection-info",
    fn:
      | StateListener
      | ErrorListener
      | TitleListener
      | BellListener
      | AgentNoticeListener
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
      | "agent-notice"
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
      "agent-notice": this.#agentNoticeListeners,
      scroll: this.#scrollListeners,
      diagnostic: this.#diagnosticListeners,
      display: this.#displayListeners,
      "connection-info": this.#connectionInfoListeners,
    }[ev] as Set<never>;
  }

  #syncConnection(): void {
    if (!this.#lease) return;
    if (activeDeviceIdentityAccount() !== this.#accountId) {
      this.close();
      return;
    }
    if (this.#lease.shared.transport.state !== "ready") {
      this.#detach();
      if (this.#lease.shared.transport.state === "failed") {
        const error = this.#lease.shared.transport.lastError ?? this.#lastError;
        if (error) {
          this.#lastError = error;
          this.#emitError(error);
        }
        this.#setState("failed");
        this.#rejectOpen?.(
          new HostControlTransportError(
            error?.code ?? "daemon_failed",
            error?.message ?? "The daemon connection failed.",
          ),
        );
        this.#settleOpening();
      } else this.#setState("reconnecting");
      return;
    }
    if (this.#attachmentId || this.#retry) return;
    const attachment = { attachmentId: newUuid(), sessionId: this.sessionId, viewId: this.#viewId };
    this.#attachmentId = attachment.attachmentId;
    this.#setState("connecting");
    try {
      if (this.#workerStarted) this.#startView();
      this.#lease.shared.bridge.send({
        v: TERMINAL_BRIDGE_VERSION,
        type: "pair-attach",
        ...attachment,
      });
      this.#deadline = setTimeout(
        () => this.#retryAttachment(),
        this.options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS,
      );
    } catch {
      this.#retryAttachment();
    }
  }
  #startView(): void {
    const attachmentId = this.#attachmentId;
    if (!attachmentId) return;
    this.options.bridge.send({
      v: TERMINAL_BRIDGE_VERSION,
      type: "pair-view",
      attachmentId,
      sessionId: this.sessionId,
      viewId: this.#viewId,
    });
    const pending = this.#pendingViewEvents.splice(0);
    this.#pendingViewBytes = 0;
    for (const message of pending) {
      if (this.#attachmentId !== attachmentId) break;
      this.options.bridge.send(message);
    }
  }
  #detach(): void {
    clearTimeout(this.#retry ?? undefined);
    this.#retry = null;
    clearTimeout(this.#deadline ?? undefined);
    this.#deadline = null;
    const id = this.#attachmentId;
    this.#attachmentId = null;
    this.#pendingViewEvents.splice(0);
    this.#pendingViewBytes = 0;
    this.#displayOwner = false;
    this.#uploadCoordinator.close();
    if (!id) return;
    try {
      this.#lease?.shared.bridge.send({
        v: TERMINAL_BRIDGE_VERSION,
        type: "pair-command",
        attachmentId: id,
        channel: "ctl",
        event: "close",
      });
    } catch {
      /* Shared worker may have been retired. */
    }
    try {
      this.options.bridge.send({
        v: TERMINAL_BRIDGE_VERSION,
        type: "pair-event",
        attachmentId: id,
        channel: "ctl",
        event: "close",
      });
    } catch {
      /* View may have been retired. */
    }
  }
  #retryAttachment(): void {
    this.#detach();
    if (!this.#lease) return;
    this.#setState("reconnecting");
    this.#retry = setTimeout(() => {
      this.#retry = null;
      this.#syncConnection();
    }, 500);
  }
  #handleWorkerMessage(message: WorkerToNativeMessage): void {
    if (!this.#workerStarted || activeDeviceIdentityAccount() !== this.#accountId) return;
    // WebView messages can arrive after the parent has already reattached.
    // Readiness and control must belong to that fresh attachment, even if the
    // terminal WebView itself survived the connection loss.
    if (
      (message.attachmentId !== undefined && message.attachmentId !== this.#attachmentId) ||
      (["state", "display", "upload-progress"].includes(message.type) &&
        (!this.#attachmentId || message.attachmentId !== this.#attachmentId))
    )
      return;
    switch (message.type) {
      case "pair-command":
        if (message.attachmentId === this.#attachmentId) {
          try {
            this.#lease?.shared.bridge.send(message);
          } catch {
            this.#retryAttachment();
          }
        }
        break;
      case "state":
        if (
          message.state === "ready" &&
          this.#attachmentId &&
          this.#lease?.shared.transport.state === "ready"
        ) {
          clearTimeout(this.#deadline ?? undefined);
          this.#deadline = null;
          this.#setState("ready");
          this.#resolveOpen?.();
          this.#settleOpening();
          this.#uploadCoordinator.startPending();
        } else if (message.state === "reconnecting" && this.#attachmentId) this.#retryAttachment();
        break;
      case "title":
        for (const listener of this.#titleListeners) listener(message.title);
        break;
      case "bell":
        for (const listener of this.#bellListeners) listener();
        break;
      case "agent-notice":
        for (const listener of this.#agentNoticeListeners) listener(message.notice);
        break;
      case "display": {
        this.#displayOwner = message.owner;
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
        break;
      case "upload-progress":
        this.#uploadCoordinator.handleProgress(message);
        break;
      case "error":
        this.#emitError({
          code: message.code,
          message: message.message,
          retryable: message.retryable,
        });
        break;
      default:
        break;
    }
  }
  #setState(next: TransportState): void {
    if (next === this.#state) return;
    this.#state = next;
    for (const listener of this.#stateListeners) listener(next);
  }
  #settleOpening(): void {
    this.#opening = null;
    this.#resolveOpen = null;
    this.#rejectOpen = null;
  }
  #emitError(error: TransportError): void {
    for (const listener of this.#errorListeners) listener(error);
  }
}
export function createSessionTransport(options: SessionTransportOptions): SessionTransport {
  return new WebViewSessionTransport(options);
}
