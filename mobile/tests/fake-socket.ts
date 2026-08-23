export type FakeSocketSendData = Parameters<WebSocket["send"]>[0];

function requestedProtocol(protocols?: string | string[]): string {
  if (Array.isArray(protocols)) return protocols[0] ?? "";
  return protocols ?? "";
}

/** A controllable WebSocket double for injected factories or global installation. */
export class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly CONNECTING = FakeWebSocket.CONNECTING;
  readonly OPEN = FakeWebSocket.OPEN;
  readonly CLOSING = FakeWebSocket.CLOSING;
  readonly CLOSED = FakeWebSocket.CLOSED;
  readonly extensions = "";
  readonly url: string;
  protocol: string;
  binaryType: BinaryType = "blob";
  bufferedAmount = 0;
  readyState = FakeWebSocket.CONNECTING;
  onopen: WebSocket["onopen"] = null;
  onmessage: WebSocket["onmessage"] = null;
  onerror: WebSocket["onerror"] = null;
  onclose: WebSocket["onclose"] = null;
  readonly sent: FakeSocketSendData[] = [];
  readonly closeCalls: Array<{ code: number; reason: string }> = [];

  constructor(url: string | URL, protocols?: string | string[], selectedProtocol?: string) {
    this.url = url.toString();
    this.protocol = selectedProtocol ?? requestedProtocol(protocols);
  }

  asWebSocket(): WebSocket {
    return this as unknown as WebSocket;
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.call(this.asWebSocket(), { type: "open" } as Event);
  }

  message(data: unknown): void {
    this.onmessage?.call(this.asWebSocket(), { data, type: "message" } as MessageEvent);
  }

  error(): void {
    this.onerror?.call(this.asWebSocket(), { type: "error" } as Event);
  }

  serverClose(code = 1000, reason = ""): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.call(this.asWebSocket(), { code, reason, type: "close" } as CloseEvent);
  }

  send(data: FakeSocketSendData): void {
    if (this.readyState !== FakeWebSocket.OPEN) {
      throw new Error("FakeWebSocket is not open");
    }
    this.sent.push(data);
  }

  close(code = 1000, reason = ""): void {
    this.closeCalls.push({ code, reason });
    this.serverClose(code, reason);
  }
}

export interface FakeWebSocketInstallation {
  instances: FakeWebSocket[];
  restore(): void;
}

export function installFakeWebSocket(selectedProtocol?: string): FakeWebSocketInstallation {
  const original = globalThis.WebSocket;
  const instances: FakeWebSocket[] = [];

  class InstalledFakeWebSocket extends FakeWebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols, selectedProtocol);
      instances.push(this);
    }
  }

  globalThis.WebSocket = InstalledFakeWebSocket as unknown as typeof WebSocket;
  let installed = true;
  return {
    instances,
    restore() {
      if (!installed) return;
      installed = false;
      globalThis.WebSocket = original;
    },
  };
}
