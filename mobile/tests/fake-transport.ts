import type {
  DisplayControlState,
  ScrollState,
  SessionTransport,
  TransportError,
  TransportState,
  UploadHandle,
  UploadProgress,
  UploadRequest,
  UploadResult,
  WorkerDiagnostic,
} from "@/terminal/transport/types";

type StateListener = (state: TransportState) => void;
type ErrorListener = (error: TransportError) => void;
type TitleListener = (title: string) => void;
type BellListener = () => void;
type ScrollListener = (state: ScrollState) => void;
type DiagnosticListener = (diagnostic: WorkerDiagnostic) => void;
type DisplayListener = (display: DisplayControlState) => void;

export class FakeUploadHandle implements UploadHandle {
  readonly result: Promise<UploadResult>;
  private stateValue: UploadProgress["state"] = "queued";
  private sentBytesValue = 0;
  private readonly progressListeners = new Set<(progress: UploadProgress) => void>();
  private readonly resolveResult: (result: UploadResult) => void;
  private readonly rejectResult: (error: TransportError) => void;

  constructor(
    readonly uploadId: string,
    private readonly request: UploadRequest,
  ) {
    let resolveResult!: (result: UploadResult) => void;
    let rejectResult!: (error: TransportError) => void;
    this.result = new Promise<UploadResult>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    this.resolveResult = resolveResult;
    this.rejectResult = rejectResult;
  }

  get state(): UploadProgress["state"] {
    return this.stateValue;
  }

  cancel(): void {
    this.progress({ state: "cancelled" });
  }

  onProgress(listener: (progress: UploadProgress) => void): () => void {
    this.progressListeners.add(listener);
    return () => this.progressListeners.delete(listener);
  }

  progress(update: { state?: UploadProgress["state"]; sentBytes?: number }): void {
    this.stateValue = update.state ?? this.stateValue;
    this.sentBytesValue = update.sentBytes ?? this.sentBytesValue;
    this.emit({
      uploadId: this.uploadId,
      state: this.stateValue,
      sentBytes: this.sentBytesValue,
      totalBytes: this.request.totalBytes,
    });
  }

  complete(path: string): void {
    this.stateValue = "complete";
    this.sentBytesValue = this.request.totalBytes;
    const result: UploadResult = {
      uploadId: this.uploadId,
      path,
      totalBytes: this.request.totalBytes,
      sha256: this.request.sha256,
    };
    this.emit({
      uploadId: this.uploadId,
      state: this.stateValue,
      sentBytes: this.sentBytesValue,
      totalBytes: this.request.totalBytes,
      path,
    });
    this.resolveResult(result);
  }

  fail(error: TransportError): void {
    this.stateValue = "failed";
    this.emit({
      uploadId: this.uploadId,
      state: this.stateValue,
      sentBytes: this.sentBytesValue,
      totalBytes: this.request.totalBytes,
      error,
    });
    this.rejectResult(error);
  }

  private emit(progress: UploadProgress): void {
    for (const listener of this.progressListeners) listener(progress);
  }
}

/** A stateful SessionTransport double with explicit event controls and call recording. */
export class FakeSessionTransport implements SessionTransport {
  private stateValue: TransportState = "idle";
  private readonly stateListeners = new Set<StateListener>();
  private readonly errorListeners = new Set<ErrorListener>();
  private readonly titleListeners = new Set<TitleListener>();
  private readonly bellListeners = new Set<BellListener>();
  private readonly scrollListeners = new Set<ScrollListener>();
  private readonly diagnosticListeners = new Set<DiagnosticListener>();
  private readonly displayListeners = new Set<DisplayListener>();
  readonly writes: Uint8Array[] = [];
  readonly resizes: Array<{ cols: number; rows: number }> = [];
  takeControlCalls = 0;
  readonly replayRequests: Array<number | undefined> = [];
  readonly uploads: Array<{ request: UploadRequest; handle: FakeUploadHandle }> = [];
  openCalls = 0;
  closeCalls = 0;

  constructor(
    readonly sessionId = "30000000-0000-4000-8000-000000000001",
    private readonly autoReady = true,
  ) {}

  get state(): TransportState {
    return this.stateValue;
  }

  async open(): Promise<void> {
    this.openCalls += 1;
    this.setState(this.autoReady ? "ready" : "connecting");
  }

  close(): void {
    this.closeCalls += 1;
    this.setState("closed");
  }

  write(bytes: Uint8Array): void {
    this.writes.push(bytes.slice());
  }

  resize(cols: number, rows: number): void {
    this.resizes.push({ cols, rows });
  }

  takeControl(): void {
    this.takeControlCalls += 1;
  }

  requestReplay(fromOffset?: number): void {
    this.replayRequests.push(fromOffset);
  }

  upload(request: UploadRequest): FakeUploadHandle {
    const uploadId = request.uploadId ?? `fake-upload-${this.uploads.length + 1}`;
    const handle = new FakeUploadHandle(uploadId, request);
    this.uploads.push({ request, handle });
    return handle;
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
    switch (ev) {
      case "state":
        return this.subscribe(this.stateListeners, fn as StateListener);
      case "error":
        return this.subscribe(this.errorListeners, fn as ErrorListener);
      case "title":
        return this.subscribe(this.titleListeners, fn as TitleListener);
      case "bell":
        return this.subscribe(this.bellListeners, fn as BellListener);
      case "scroll":
        return this.subscribe(this.scrollListeners, fn as ScrollListener);
      case "diagnostic":
        return this.subscribe(this.diagnosticListeners, fn as DiagnosticListener);
      case "display":
        return this.subscribe(this.displayListeners, fn as DisplayListener);
    }
  }

  emitDisplay(display: DisplayControlState): void {
    for (const listener of this.displayListeners) listener(display);
  }

  setState(state: TransportState): void {
    this.stateValue = state;
    for (const listener of this.stateListeners) listener(state);
  }

  emitError(error: TransportError): void {
    for (const listener of this.errorListeners) listener(error);
  }

  emitTitle(title: string): void {
    for (const listener of this.titleListeners) listener(title);
  }

  emitBell(): void {
    for (const listener of this.bellListeners) listener();
  }

  emitScroll(state: ScrollState): void {
    for (const listener of this.scrollListeners) listener(state);
  }

  emitDiagnostic(diagnostic: WorkerDiagnostic): void {
    for (const listener of this.diagnosticListeners) listener(diagnostic);
  }

  private subscribe<T>(listeners: Set<T>, listener: T): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }
}
