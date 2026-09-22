import type { CarriedEndorsement } from "@/data/trust/carried-endorsements";
import type {
  AgentNotice,
  ConnectionInfo,
  ScrollState,
  TransportState,
  UploadState,
  WorkerDiagnostic,
} from "@/terminal/transport/types";
import type { TerminalTheme } from "@/theme";

export const TERMINAL_BRIDGE_VERSION = 1 as const;
export const BRIDGE_EVENT_BATCH_MS = 8;
export const BRIDGE_EVENT_BATCH_BYTES = 32 * 1024;
export const BRIDGE_MAX_QUEUED_BYTES = 4 * 1024 * 1024;

export interface SignalTranscriptRequest {
  signalKind: "offer" | "answer";
  protocolVersion: 1 | 2;
  sessionId: string;
  scopeType: "session" | "host";
  scopeId: string;
  senderRole: "browser" | "daemon";
  intendedPeerIdentityPublicKey: string;
  sdp: string;
}

type NativeMessage = { v: typeof TERMINAL_BRIDGE_VERSION };

export interface PairAttachment {
  attachmentId: string;
  sessionId: string;
  viewId: string;
}
export interface PairChannelMessage {
  attachmentId: string;
  channel: "pty" | "ctl";
  event: "open" | "data" | "close" | "ack" | "send" | "received";
  data?: string;
  binary?: boolean;
  sequence?: number;
  bytes?: number;
}

export type NativeToWorkerMessage =
  | (NativeMessage & { type: "host-consumer-open" | "host-consumer-close"; consumerId: string })
  | (NativeMessage & { type: "host-consumer-received"; consumerId: string; sequence: number })
  | (NativeMessage & {
      type: "host-consumer-command";
      consumerId: string;
      command:
        | { type: "host-request"; requestId: string; operation: string; payload?: unknown }
        | { type: "host-cancel"; requestId: string };
    })
  | (NativeMessage & PairAttachment & { type: "pair-attach" })
  | (NativeMessage & PairAttachment & { type: "pair-view" })
  | (NativeMessage & PairChannelMessage & { type: "pair-command" | "pair-event" })
  | (NativeMessage & {
      type: "init";
      mode: "session" | "host";
      scopeId: string;
      browserIdentityPublicKey: string;
      hostIdentityPublicKey: string;
      cols: number;
      rows: number;
      theme: TerminalTheme;
      fontSize: number;
      cachedLoopback?: boolean;
      skipLoopbackProbe?: boolean;
    })
  | (NativeMessage & {
      type: "connect";
      rtcSessionId: string;
      bindingNonce: string;
      iceServers: readonly unknown[];
      /** The server's `ice_transport_policy`: "relay" when it offers no direct path. */
      iceTransportPolicy: "all" | "relay";
      forceRelay: boolean;
      forceRebuild?: boolean;
    })
  | (NativeMessage & { type: "signal-frame"; frame: unknown })
  | (NativeMessage & {
      type: "sign-response";
      requestId: string;
      signature?: string;
      carriedEndorsements?: readonly CarriedEndorsement[];
      error?: string;
    })
  | (NativeMessage & { type: "input"; sequence: number; data: string })
  | (NativeMessage & { type: "resize"; cols: number; rows: number })
  | (NativeMessage & { type: "fit" })
  | (NativeMessage & { type: "take-control" })
  | (NativeMessage & { type: "set-theme"; theme: TerminalTheme })
  | (NativeMessage & { type: "set-font-size"; fontSize: number })
  | (NativeMessage & { type: "scroll"; target: "top" | "bottom"; lines?: number })
  | (NativeMessage & { type: "set-follow"; follow: boolean })
  | (NativeMessage & { type: "search"; query: string; direction: "next" | "prev" })
  | (NativeMessage & { type: "copy-selection"; requestId: string })
  | (NativeMessage & {
      type: "clipboard-response";
      requestId: string;
      text?: string;
      error?: string;
    })
  | (NativeMessage & { type: "focus" })
  | (NativeMessage & { type: "blur" })
  | (NativeMessage & { type: "request-replay"; fromOffset?: number })
  | (NativeMessage & {
      type: "network-changed";
      iceServers?: readonly unknown[];
      iceTransportPolicy?: "all" | "relay";
    })
  | (NativeMessage & {
      type: "upload-start";
      uploadId: string;
      name: string;
      mimeType: string;
      destination: "attachments" | "cwd";
      totalBytes: number;
      sha256: string;
    })
  | (NativeMessage & {
      type: "upload-chunk";
      uploadId: string;
      sequence: number;
      last: boolean;
      data: string;
    })
  | (NativeMessage & { type: "upload-cancel"; uploadId: string })
  | (NativeMessage & {
      type: "host-request";
      requestId: string;
      operation: string;
      payload?: unknown;
    })
  | (NativeMessage & { type: "host-cancel"; requestId: string })
  | (NativeMessage & { type: "close" });

type WorkerMessage = {
  v: typeof TERMINAL_BRIDGE_VERSION;
  /** Session events remain bound to the attachment that emitted them. */
  attachmentId?: string | null;
};

export type WorkerToNativeMessage =
  | (WorkerMessage & {
      type: "host-consumer-event";
      consumerId: string;
      message: unknown;
      sequence?: number;
    })
  | (WorkerMessage & PairChannelMessage & { type: "pair-command" | "pair-event" })
  | (WorkerMessage & { type: "ready"; renderer: "webgl" | "dom" | null })
  | (WorkerMessage & { type: "state"; state: TransportState; gate?: string })
  | (WorkerMessage & { type: "signal-frame"; frame: unknown })
  | (WorkerMessage & {
      type: "sign-request";
      requestId: string;
      transcript: SignalTranscriptRequest;
    })
  | (WorkerMessage & {
      type: "display";
      owner: boolean;
      viewers: number;
      cols?: number;
      rows?: number;
    })
  | (WorkerMessage & { type: "title"; title: string })
  | (WorkerMessage & { type: "bell" })
  | (WorkerMessage & { type: "agent-notice"; notice: AgentNotice | null })
  | (WorkerMessage & { type: "scroll-state"; scroll: ScrollState })
  | (WorkerMessage & { type: "selection"; text: string; requestId?: string })
  | (WorkerMessage & { type: "native-selection"; active: boolean })
  | (WorkerMessage & { type: "link"; url: string })
  | (WorkerMessage & { type: "clipboard-read"; requestId: string })
  | (WorkerMessage & { type: "clipboard-write"; requestId: string; text: string })
  | (WorkerMessage & { type: "diagnostic"; diagnostic: WorkerDiagnostic })
  | (WorkerMessage & { type: "connection-info"; info: ConnectionInfo })
  | (WorkerMessage & {
      type: "upload-progress";
      uploadId: string;
      state: UploadState;
      sentBytes: number;
      totalBytes: number;
      nextSequence?: number;
      path?: string;
      sha256?: string;
      error?: { code: string; message: string; retryable: boolean };
    })
  | (WorkerMessage & {
      type: "host-response";
      requestId: string;
      ok: boolean;
      result?: unknown;
      error?: { code: string; detail?: string };
    })
  | (WorkerMessage & {
      type: "error";
      code: string;
      message: string;
      retryable: boolean;
      detail?: unknown;
    });

export class BridgeProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BridgeProtocolError";
  }
}

interface BridgeRecord extends Record<string, unknown> {
  v?: unknown;
  type?: unknown;
}

function isRecord(value: unknown): value is BridgeRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseEnvelope(raw: string): BridgeRecord {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new BridgeProtocolError("Worker bridge message is not valid JSON.");
  }
  if (!isRecord(value)) throw new BridgeProtocolError("Worker bridge message must be an object.");
  if (value.v !== TERMINAL_BRIDGE_VERSION) {
    throw new BridgeProtocolError(`Unsupported worker bridge version: ${String(value.v)}.`);
  }
  if (typeof value.type !== "string") {
    throw new BridgeProtocolError("Worker bridge message is missing its type.");
  }
  return value;
}

export function serializeNativeMessage(message: NativeToWorkerMessage): string {
  if (message.v !== TERMINAL_BRIDGE_VERSION) {
    throw new BridgeProtocolError("Cannot serialize a mismatched native bridge version.");
  }
  return JSON.stringify(message);
}

export function serializeWorkerMessage(message: WorkerToNativeMessage): string {
  if (message.v !== TERMINAL_BRIDGE_VERSION) {
    throw new BridgeProtocolError("Cannot serialize a mismatched worker bridge version.");
  }
  return JSON.stringify(message);
}

export function parseNativeMessage(raw: string): NativeToWorkerMessage {
  const value = parseEnvelope(raw);
  if (!NATIVE_MESSAGE_TYPES.has(value.type as string)) {
    throw new BridgeProtocolError(`Unknown native bridge message: ${String(value.type)}.`);
  }
  return value as unknown as NativeToWorkerMessage;
}

export function parseWorkerMessage(raw: string): WorkerToNativeMessage {
  const value = parseEnvelope(raw);
  if (!WORKER_MESSAGE_TYPES.has(value.type as string)) {
    throw new BridgeProtocolError(`Unknown worker bridge message: ${String(value.type)}.`);
  }
  return value as unknown as WorkerToNativeMessage;
}

const NATIVE_MESSAGE_TYPES = new Set([
  "host-consumer-open",
  "host-consumer-close",
  "host-consumer-command",
  "host-consumer-received",
  "pair-attach",
  "pair-view",
  "pair-command",
  "pair-event",
  "init",
  "connect",
  "signal-frame",
  "sign-response",
  "input",
  "resize",
  "fit",
  "take-control",
  "set-theme",
  "set-font-size",
  "scroll",
  "set-follow",
  "search",
  "copy-selection",
  "clipboard-response",
  "focus",
  "blur",
  "request-replay",
  "network-changed",
  "upload-start",
  "upload-chunk",
  "upload-cancel",
  "host-request",
  "host-cancel",
  "close",
]);

const WORKER_MESSAGE_TYPES = new Set([
  "host-consumer-event",
  "pair-command",
  "pair-event",
  "ready",
  "state",
  "display",
  "signal-frame",
  "sign-request",
  "title",
  "bell",
  "agent-notice",
  "scroll-state",
  "selection",
  "native-selection",
  "link",
  "clipboard-read",
  "clipboard-write",
  "diagnostic",
  "connection-info",
  "upload-progress",
  "host-response",
  "error",
]);

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function encodeBridgeBytes(bytes: Uint8Array): string {
  let encoded = "";
  for (let offset = 0; offset < bytes.byteLength; offset += 3) {
    const a = bytes[offset] ?? 0;
    const b = bytes[offset + 1] ?? 0;
    const c = bytes[offset + 2] ?? 0;
    encoded += BASE64_ALPHABET[a >> 2];
    encoded += BASE64_ALPHABET[((a & 3) << 4) | (b >> 4)];
    encoded += offset + 1 < bytes.byteLength ? BASE64_ALPHABET[((b & 15) << 2) | (c >> 6)] : "=";
    encoded += offset + 2 < bytes.byteLength ? BASE64_ALPHABET[c & 63] : "=";
  }
  return encoded;
}

export function decodeBridgeBytes(encoded: string): Uint8Array {
  if (
    encoded.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
  ) {
    throw new BridgeProtocolError("Bridge byte field is not canonical base64.");
  }
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  const output = new Uint8Array((encoded.length / 4) * 3 - padding);
  let write = 0;
  for (let offset = 0; offset < encoded.length; offset += 4) {
    const a = BASE64_ALPHABET.indexOf(encoded[offset] ?? "");
    const b = BASE64_ALPHABET.indexOf(encoded[offset + 1] ?? "");
    const c = encoded[offset + 2] === "=" ? 0 : BASE64_ALPHABET.indexOf(encoded[offset + 2] ?? "");
    const d = encoded[offset + 3] === "=" ? 0 : BASE64_ALPHABET.indexOf(encoded[offset + 3] ?? "");
    if (a < 0 || b < 0 || c < 0 || d < 0) throw new BridgeProtocolError("Invalid base64 byte.");
    if (write < output.byteLength) output[write++] = (a << 2) | (b >> 4);
    if (write < output.byteLength) output[write++] = ((b & 15) << 4) | (c >> 2);
    if (write < output.byteLength) output[write++] = ((c & 3) << 6) | d;
  }
  return output;
}

type WorkerListener = (message: WorkerToNativeMessage) => void;

export class WorkerBridge {
  readonly #listeners = new Set<WorkerListener>();
  #sender: ((raw: string) => void) | null = null;
  #ready = false;
  #readiness: Promise<void> | null = null;
  #resolveReady: (() => void) | null = null;
  #rejectReady: ((error: Error) => void) | null = null;

  attach(sender: (raw: string) => void, ready = true): () => void {
    this.#clearReadiness();
    this.#sender = sender;
    this.#ready = ready;
    return () => {
      if (this.#sender !== sender) return;
      this.#sender = null;
      this.#ready = false;
      this.#clearReadiness();
    };
  }

  setReady(sender: (raw: string) => void, ready: boolean): void {
    // A late load event from the outgoing owner cannot activate its successor.
    if (this.#sender !== sender) return;
    this.#ready = ready;
    if (ready) this.#resolveReady?.();
    else this.#clearReadiness();
  }

  whenReady(): Promise<void> {
    if (!this.#sender)
      return Promise.reject(new BridgeProtocolError("Terminal worker is not attached."));
    if (this.#ready) return Promise.resolve();
    this.#readiness ??= new Promise<void>((resolve, reject) => {
      this.#resolveReady = resolve;
      this.#rejectReady = reject;
    });
    return this.#readiness;
  }

  #clearReadiness(): void {
    this.#rejectReady?.(new BridgeProtocolError("Terminal worker document was retired."));
    this.#readiness = null;
    this.#resolveReady = null;
    this.#rejectReady = null;
  }

  send(message: NativeToWorkerMessage): void {
    if (!this.#sender) throw new BridgeProtocolError("Terminal worker is not attached.");
    if (!this.#ready) throw new BridgeProtocolError("Terminal worker document is not ready.");
    this.#sender(serializeNativeMessage(message));
  }

  receive(raw: string): void {
    const message = parseWorkerMessage(raw);
    for (const listener of this.#listeners) listener(message);
  }

  onMessage(listener: WorkerListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}

export class WorkerEventCoalescer {
  readonly #ordered: WorkerToNativeMessage[] = [];
  readonly #latest = new Map<string, WorkerToNativeMessage>();

  push(message: WorkerToNativeMessage): void {
    if (
      message.type === "state" ||
      message.type === "scroll-state" ||
      message.type === "selection" ||
      message.type === "native-selection"
    ) {
      this.#latest.set(message.type, message);
    } else {
      this.#ordered.push(message);
    }
  }

  flush(): WorkerToNativeMessage[] {
    const messages = [...this.#ordered, ...this.#latest.values()];
    this.#ordered.splice(0);
    this.#latest.clear();
    return messages;
  }
}
