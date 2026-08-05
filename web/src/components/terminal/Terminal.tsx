"use client";

import { ClipboardAddon } from "@xterm/addon-clipboard";
import { FitAddon } from "@xterm/addon-fit";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal as XTerm } from "@xterm/xterm";
import { LatencyHud, latencyHudEnabled } from "./latency-hud";
import { PredictiveEcho } from "./predictive-echo";
import "@xterm/xterm/css/xterm.css";
import { useQuery } from "@tanstack/react-query";
import Image from "next/image";
import {
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { AgentConnectionInfo } from "@/components/terminal/ConnectionChip";
import { CommittedHistoryOverlay } from "@/components/terminal/committed-history";
import { PostRenderLiveWriteBuffer } from "@/components/terminal/live-write-buffer";
import { useAgentSocket } from "@/components/terminal/useAgentSocket";
// Terminal configuration shared with the conformance harness
// (tools/term-conformance/); see xterm-config.mjs before changing options.
import {
  activateUnicodeVersion,
  TERMINAL_FONT_FAMILY,
  TERMINAL_FONT_SIZE,
  TERMINAL_LINE_HEIGHT,
  TERMINAL_SCROLLBACK_LINES,
  TERMINAL_SCROLLBACK_THEME,
  TERMINAL_SNAPSHOT_LINES,
  TERMINAL_THEME,
  XTERM_EMULATION_OPTIONS,
} from "@/components/terminal/xterm-config.mjs";
import { DirectAgentUploadError } from "@/lib/agent-ctl";
import { agents, hosts } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { resolveSignedRtcTrust, type SignedRtcTrustDecision } from "@/lib/signed-rtc-trust";
import type { DisplayControlState } from "@/lib/ws";

const TERMINAL_LINE_HEIGHT_PX = TERMINAL_FONT_SIZE * TERMINAL_LINE_HEIGHT;
// Defer the deep (10k-line) endpoint replay warm so connecting can paint the
// small endpoint-provided seed first.
const SCROLLBACK_WARM_DELAY_MS = 1_200;
// Endpoint replay requests can time out without a reply; clear the in-flight
// flag eventually or scrollback fetches would wedge for the whole session.
const SCROLLBACK_SNAPSHOT_TIMEOUT_MS = 6_000;
// The cache refresh debounces on output, but a continuously-streaming agent
// would postpone it forever — bound how stale the cache is allowed to get.
const SCROLLBACK_REFRESH_MAX_WAIT_MS = 2_500;
// Before an offset-anchored PTY stream is active, refresh less aggressively;
// opening scrollback still asks the endpoint for the full depth once.
const SCROLLBACK_UNANCHORED_REFRESH_DEBOUNCE_MS = 5_000;
const SCROLLBACK_UNANCHORED_REFRESH_MAX_WAIT_MS = 20_000;
const SCROLLBACK_UNANCHORED_CACHE_LINES = 2_000;
// Recent live DataChannel chunks kept for replay on top of offset-anchored
// snapshots. Replay responses and live bytes use separate mandatory endpoint
// DataChannels, so a fresh capture can lag chunks already rendered locally;
// replaying chunks past the capture's stream offset makes re-renders exact.
const SCROLLBACK_DC_REPLAY_BUFFER_BYTES = 4 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const MAX_UPLOAD_RECONCILIATIONS = 8;
const UPLOAD_RECONCILIATION_STORAGE_PREFIX = "spawn.upload-reconciliation.v1";
const UPLOAD_RECONCILIATION_EVENT = "spawn:upload-reconciliation";
const TOUCH_VELOCITY_SAMPLE_MS = 120;
const TOUCH_MOMENTUM_BOOST = 1.25;
const TOUCH_MOMENTUM_MAX_PX_PER_MS = 4;
const TOUCH_MOMENTUM_MIN_START_PX_PER_MS = 0.08;
const TOUCH_MOMENTUM_STOP_PX_PER_MS = 0.02;
const TOUCH_MOMENTUM_TIME_CONSTANT_MS = 450;
const TOUCH_TAP_SLOP_PX = 8;
const ALT_ENTER = "\x1b\r";
const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";

type TouchVelocitySample = { time: number; y: number };
type MobileReturnMode = "submit" | "newline";
type ImagePasteMode = "deferred" | "bracketed-path";
type PendingAttachmentStatus = "uploading" | "ready" | "error";
type ScrollAnchor = { viewportY: number; atBottom: boolean };
type TerminalGeometry = { cols: number; rows: number };
type ScrollbackSnapshotPurpose = "overlay" | "cache";

type PendingAttachment = {
  id: string;
  name: string;
  previewUrl: string;
  promptText: string | null;
  status: PendingAttachmentStatus;
  controller: AbortController;
};

type UploadReconciliation = {
  uploadId: string;
  fileName: string;
  message: string;
  recordedAt: number;
  phase: "reserved" | "blocked" | "outcome_unknown";
};

type UploadReconciliationState = {
  records: UploadReconciliation[];
  fault: string | null;
};

type UploadReconciliationRuntime = {
  memory: Map<string, UploadReconciliation[]>;
  faults: Map<string, string>;
};

function uploadReconciliationRuntime(): UploadReconciliationRuntime {
  const root = globalThis as typeof globalThis & {
    __spawnUploadReconciliationRuntime?: UploadReconciliationRuntime;
  };
  root.__spawnUploadReconciliationRuntime ??= {
    memory: new Map<string, UploadReconciliation[]>(),
    faults: new Map<string, string>(),
  };
  return root.__spawnUploadReconciliationRuntime;
}

class UploadReconciliationBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UploadReconciliationBlockedError";
  }
}

export interface TerminalHandle {
  /** Raw stdin into the agent (binary frame). */
  sendInput: (bytes: Uint8Array | string) => void;
  /** Tell the agent the new TTY size. */
  resize: (cols: number, rows: number) => void;
  /** Force a re-fit against the current container size. */
  fit: () => void;
  /** Last known terminal geometry. */
  getSize: () => TerminalGeometry;
  /** Capture diagnostics, force a full refit + reseed, capture again.
   *  Returns the before/after bundle for saving. */
  refreshDiagnostics: () => Promise<Record<string, unknown>>;
  /** Upload a file directly over the bound spawn.ctl channel. */
  uploadFile: (
    file: File,
    options?: { destination?: "attachments" | "cwd"; uploadId?: string },
  ) => Promise<{ path: string; uploadId: string }>;
  /** Focus the terminal so keystrokes flow there (raw mode). */
  focus: () => void;
  /** Submit the current terminal draft, appending pending image refs first. */
  submit: () => void;
  /** User-gesture clipboard paste helper for mobile browsers. */
  pasteFromClipboard: () => Promise<void>;
  /** Paste data supplied by a native browser paste event. */
  pasteDataTransfer: (data: DataTransfer) => void;
  /** Paste plain text supplied by a native editable fallback. */
  pasteText: (text: string) => void;
  /** Promote this browser to the shared PTY geometry controller. */
  takeControl: () => void;
  /** Open the native file picker to upload files to this agent. */
  openUpload: () => void;
}

export interface TerminalProps {
  agentId: string;
  /** When false, keystrokes don't go to the WS; the Composer handles it. */
  rawInput?: boolean;
  /** On mobile soft keyboards, Return can be reserved for multiline prompts. */
  mobileReturnMode?: MobileReturnMode;
  /** Raw sequence sent for mobile keyboard Return when it means prompt newline. */
  mobileReturnBytes?: string;
  /** How uploaded images should be handed to the terminal application. */
  imagePasteMode?: ImagePasteMode;
  /** Server-side shared terminal display ownership changed. */
  onDisplayControl?: (state: DisplayControlState) => void;
  /** Claim the shared display on attach (default). Viewers get a dimmed
   *  terminal with a centered take-control button either way. */
  autoTakeControl?: boolean;
  /** Foreground (interactive) vs parked in a warm pool. A parked instance
   *  (active=false) stays connected but passive: it never resizes the PTY or
   *  takes control, so it can't disturb another client. Re-activating it
   *  reclaims control and fits to its container. Default true. */
  active?: boolean;
  /** Live transport snapshot (path kind, RTT) for connection indicators. */
  onConnectionInfo?: (info: AgentConnectionInfo) => void;
  onExit?: (exitCode: number | null, signal: string | null) => void;
}

/**
 * Mounts xterm.js in a container, pipes its output through the per-agent
 * WebSocket, and applies fit + resize handling. The component is a ref-forwarding
 * shell so the parent (terminal page) can poke it from the Composer / ModifierBar.
 */
export const Terminal = forwardRef<TerminalHandle, TerminalProps>(function Terminal(
  {
    agentId,
    rawInput = false,
    mobileReturnMode = "submit",
    mobileReturnBytes = ALT_ENTER,
    imagePasteMode = "deferred",
    onDisplayControl,
    onConnectionInfo,
    autoTakeControl = true,
    active = true,
    onExit,
  },
  ref,
) {
  const terminalViewportRef = useRef<HTMLDivElement>(null);
  const terminalSurfaceRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const fitTerminalRef = useRef<(preserveScroll: boolean) => void>(() => {});
  const displayOwnerRef = useRef<boolean | null>(null);
  const displayGeometryRef = useRef<TerminalGeometry | null>(null);
  const [controlState, setControlState] = useState<DisplayControlState | null>(null);
  const firstControlSeenRef = useRef(false);
  const autoTakeControlRef = useRef(autoTakeControl);
  autoTakeControlRef.current = autoTakeControl;
  // Foreground/parked state for the warm pool. A parked instance stays
  // connected but never fits or resizes (see fitTerminal), so moving its host
  // into an offscreen park can't churn the PTY geometry.
  const activeRef = useRef(active);
  const activePrevRef = useRef(active);
  const takeControlNowRef = useRef<() => boolean>(() => false);
  // GPU renderer for the FOREGROUND terminal only. The DOM renderer rebuilds
  // row elements and forces style/layout/paint after every echo — measurable
  // extra frames of felt keystroke latency. Parked terminals release their
  // addon so the warm pool can never exhaust the browser's WebGL context
  // budget; a lost context falls back to the DOM renderer silently.
  const webglAddonRef = useRef<WebglAddon | null>(null);
  const scrollbackWebglAddonRef = useRef<WebglAddon | null>(null);
  const attachGpuRenderer = useCallback((term: XTerm, ref: { current: WebglAddon | null }) => {
    if (ref.current) return;
    try {
      const webgl = new WebglAddon();
      term.loadAddon(webgl);
      // addon-webgl's dispose throws when the renderer never finished
      // initializing (strict-mode dev double-mounts, lost contexts) and is
      // reachable from term.dispose()'s addon sweep — make every dispose
      // path exception-safe while preserving xterm's deregistration wrapper.
      const wrappedDispose = webgl.dispose.bind(webgl);
      webgl.dispose = () => {
        try {
          wrappedDispose();
        } catch {
          // Partially-initialized renderer; the terminal survives on DOM.
        }
      };
      webgl.onContextLoss(() => {
        webgl.dispose();
        if (ref.current === webgl) ref.current = null;
      });
      ref.current = webgl;
    } catch {
      // No WebGL available (headless GL blocklist, exhausted contexts):
      // xterm keeps its DOM renderer.
      ref.current = null;
    }
  }, []);
  const syncWebglRenderer = useCallback(
    (wantGpu: boolean) => {
      if (!wantGpu || !wantsGpuRenderer()) {
        webglAddonRef.current?.dispose();
        webglAddonRef.current = null;
        return;
      }
      const term = termRef.current;
      if (!term) return;
      attachGpuRenderer(term, webglAddonRef);
    },
    [attachGpuRenderer],
  );
  // The scrollback overlay must render with the SAME renderer as the live
  // terminal: WebGL rounds glyph cells to whole device pixels while the DOM
  // renderer lays out fractional CSS pixels, so mixing them makes scrolled
  // content sit at visibly different font metrics than the live screen. The
  // addon lives only while the overlay is actually revealed — one extra
  // context at most, so the warm pool and multi-pane screens pay nothing.
  const syncScrollbackWebglRenderer = useCallback(
    (visible: boolean) => {
      if (!visible || !wantsGpuRenderer()) {
        scrollbackWebglAddonRef.current?.dispose();
        scrollbackWebglAddonRef.current = null;
        return;
      }
      const term = scrollbackTermRef.current;
      if (term) attachGpuRenderer(term, scrollbackWebglAddonRef);
    },
    [attachGpuRenderer],
  );
  const syncWebglRendererRef = useRef(syncWebglRenderer);
  syncWebglRendererRef.current = syncWebglRenderer;
  useEffect(() => {
    const was = activePrevRef.current;
    activePrevRef.current = active;
    activeRef.current = active;
    syncWebglRenderer(active);
    if (active && !was) {
      // Brought to the foreground from a parked state: reclaim control and fit
      // to the now-visible container. Two rAFs let the host's appendChild move
      // and the container's layout settle before we measure + resize.
      requestAnimationFrame(() => requestAnimationFrame(() => takeControlNowRef.current()));
      // Catch up on the refreshes the parked quiescence skipped.
      if (scrollbackCacheDirtyRef.current) {
        scheduleScrollbackCacheRefreshRef.current(250);
      }
    }
  }, [active, syncWebglRenderer]);
  // Mosh-style predictive local echo: printable keystrokes paint immediately
  // in an overlay at the cursor and reconcile against the authoritative echo
  // a round trip later. The buffer is never touched (see predictive-echo.ts).
  const latencyHudRef = useRef<LatencyHud | null>(null);
  const predictorRef = useRef(new PredictiveEcho());
  const predictionOverlayRef = useRef<HTMLDivElement>(null);
  const syncPredictionOverlay = useCallback(() => {
    const overlay = predictionOverlayRef.current;
    if (!overlay) return;
    const term = termRef.current;
    const pending = predictorRef.current.pendingText;
    const buffer = term?.buffer.active;
    const screen = containerRef.current?.querySelector(".xterm-screen");
    const surface = terminalSurfaceRef.current;
    if (
      !term ||
      !buffer ||
      !screen ||
      !surface ||
      pending.length === 0 ||
      !activeRef.current ||
      scrollbackVisibleRef.current ||
      buffer.type === "alternate" ||
      buffer.viewportY < buffer.baseY
    ) {
      overlay.style.display = "none";
      return;
    }
    const screenRect = screen.getBoundingClientRect();
    const surfaceRect = surface.getBoundingClientRect();
    if (screenRect.width <= 0 || term.cols <= 0 || term.rows <= 0) {
      overlay.style.display = "none";
      return;
    }
    const cellWidth = screenRect.width / term.cols;
    const rowHeight =
      terminalRowHeightRef.current > 0
        ? terminalRowHeightRef.current
        : screenRect.height / term.rows;
    const x = screenRect.left - surfaceRect.left + buffer.cursorX * cellWidth;
    const y = screenRect.top - surfaceRect.top + buffer.cursorY * rowHeight;
    overlay.textContent = pending;
    overlay.style.transform = `translate(${x}px, ${y}px)`;
    overlay.style.lineHeight = `${rowHeight}px`;
    overlay.style.display = "block";
  }, []);
  const syncPredictionOverlayRef = useRef(syncPredictionOverlay);
  syncPredictionOverlayRef.current = syncPredictionOverlay;
  const reconcilePrediction = useCallback(() => {
    const predictor = predictorRef.current;
    if (predictor.pendingText.length === 0) return;
    const term = termRef.current;
    const buffer = term?.buffer.active;
    if (!term || !buffer) {
      predictor.clear();
      return;
    }
    const line = buffer.getLine(buffer.baseY + buffer.cursorY);
    const textBeforeCursor =
      line?.translateToString(
        false,
        Math.max(0, buffer.cursorX - predictor.pendingText.length),
        buffer.cursorX,
      ) ?? "";
    predictor.reconcile(
      { row: buffer.baseY + buffer.cursorY, col: buffer.cursorX },
      textBeforeCursor,
      performance.now(),
    );
    syncPredictionOverlayRef.current();
  }, []);
  const reconcilePredictionRef = useRef(reconcilePrediction);
  reconcilePredictionRef.current = reconcilePrediction;
  const predictionSweepRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const schedulePredictionSweep = useCallback(() => {
    if (predictionSweepRef.current) clearTimeout(predictionSweepRef.current);
    predictionSweepRef.current = setTimeout(() => {
      predictionSweepRef.current = null;
      reconcilePredictionRef.current();
      if (predictorRef.current.pendingText.length > 0) schedulePredictionSweep();
    }, 2_500);
  }, []);
  const clearPrediction = useCallback(() => {
    predictorRef.current.clear();
    syncPredictionOverlayRef.current();
  }, []);
  const layoutTerminalSurfaceRef = useRef<(pinToBottom?: boolean) => void>(() => {});
  const viewerPanFrameActiveRef = useRef(false);
  const onDataDisposableRef = useRef<{ dispose: () => void } | null>(null);
  const lastSizeRef = useRef<TerminalGeometry>({ cols: 80, rows: 24 });
  const uploadStatusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragDepthRef = useRef(0);
  const rawInputRef = useRef(rawInput);
  const mobileReturnModeRef = useRef<MobileReturnMode>(mobileReturnMode);
  const mobileReturnBytesRef = useRef(mobileReturnBytes);
  const lastMobileReturnAtRef = useRef(0);
  const coarsePointerRef = useRef(false);
  const touchScrollRef = useRef<{
    active: boolean;
    startX: number;
    startY: number;
    lastX: number;
    lastY: number;
    lastTime: number;
    movedPx: number;
    velocityPxPerMs: number;
    samples: TouchVelocitySample[];
    activePointerId: number | null;
    pointerCaptured: boolean;
    pendingTapFocus: boolean;
    momentumFrame: number | null;
    momentumLastTime: number;
    scrollRemainderPx: number;
    openedScrollback: boolean;
  }>({
    active: false,
    startX: 0,
    startY: 0,
    lastX: 0,
    lastY: 0,
    lastTime: 0,
    movedPx: 0,
    velocityPxPerMs: 0,
    samples: [],
    activePointerId: null,
    pointerCaptured: false,
    pendingTapFocus: false,
    momentumFrame: null,
    momentumLastTime: 0,
    scrollRemainderPx: 0,
    openedScrollback: false,
  });
  const [exitBanner, setExitBanner] = useState<string | null>(null);
  const [uploadStatus, setUploadStatus] = useState<string | null>(null);
  const [uploadReconciliations, setUploadReconciliations] = useState<UploadReconciliation[]>([]);
  const [uploadReconciliationFault, setUploadReconciliationFault] = useState<string | null>(null);
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const pendingAttachmentsRef = useRef<PendingAttachment[]>([]);
  const [dropActive, setDropActive] = useState(false);
  const [socketInitialSize, setSocketInitialSize] = useState<{
    cols: number;
    rows: number;
  } | null>(null);
  const socketStartedRef = useRef(false);
  const scrollbackOverlayRef = useRef<HTMLDivElement>(null);
  const scrollbackTerminalHostRef = useRef<HTMLDivElement>(null);
  const scrollbackTermRef = useRef<XTerm | null>(null);
  const scrollbackVisibleRef = useRef(false);
  const scrollbackReadyRef = useRef(false);
  const scrollbackSnapshotInFlightRef = useRef(false);
  const scrollbackSnapshotPurposeRef = useRef<ScrollbackSnapshotPurpose | null>(null);
  const scrollbackSnapshotTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollbackSnapshotBytesRef = useRef<Uint8Array | null>(null);
  const scrollbackCachedSnapshotBytesRef = useRef<Uint8Array | null>(null);
  const scrollbackRenderedSnapshotBytesRef = useRef<Uint8Array | null>(null);
  const scrollbackRenderGenerationRef = useRef(0);
  const scrollbackCacheDirtyRef = useRef(true);
  const scrollbackLiveBytesAtRef = useRef(0);
  const scrollbackSnapshotRequestedAtRef = useRef(0);
  const scrollbackOverlayHasSnapshotRef = useRef(false);
  const scrollbackPendingDeltaPxRef = useRef(0);
  const scrollbackUserScrollGenerationRef = useRef(0);
  const scrollbackDesiredScrollTopRef = useRef<number | null>(null);
  const scrollbackRestoreLineRef = useRef<number | null>(null);
  const scrollbackCacheRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollbackCacheRefreshDeadlineRef = useRef<number | null>(null);
  const scrollbackLastUserScrollAtRef = useRef(0);
  // The most recent scrolled-up overlay view (rows + position), remembered as
  // the reader scrolls. Diagnostics read this so a refresh reports what the
  // user was looking at even if the overlay closed in the instant before the
  // click — the overlay buffer itself scrolls to the bottom on close, so it
  // cannot be recovered from there.
  const lastScrolledViewRef = useRef<{
    at: number;
    viewportY: number;
    baseY: number;
    length: number;
    rows: string[];
  } | null>(null);
  // Resize->repaint instrumentation: when a resize is sent, mark the time;
  // record when the app's repaint bytes first arrive and when they settle, so
  // the reshape lag is measured (and surfaced in diagnostics), not guessed.
  const resizeMarkRef = useRef<{
    sentAt: number;
    cols: number;
    rows: number;
    firstByteAt: number | null;
    lastByteAt: number | null;
  } | null>(null);
  const resizeSettleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resizeTimingsRef = useRef<
    Array<{ at: string; cols: number; rows: number; toFirstByteMs: number; toSettleMs: number }>
  >([]);
  const markResizeSentRef = useRef((cols: number, rows: number) => {
    resizeMarkRef.current = { sentAt: Date.now(), cols, rows, firstByteAt: null, lastByteAt: null };
  });
  // Committed-history delta mode: the worker streams every committed line
  // over spawn.ctl and the hidden overlay terminal becomes a pure view of the
  // worker's log (raw PTY bytes never touch it). Engaged the moment any
  // response or event carries a history anchor; the legacy snapshot/replay
  // pipeline below stays for old workers that cannot stream deltas.
  const committedHistoryRef = useRef<CommittedHistoryOverlay | null>(null);
  const historyStreamActiveRef = useRef(false);
  const serializeAddonRef = useRef<SerializeAddon | null>(null);
  // Set when a wheel-open is waiting for the controller's write queue to
  // drain; consumed by finishDeltaReveal.
  const scrollbackRevealPendingRef = useRef(false);
  const finishDeltaRevealRef = useRef<() => void>(() => {});
  const updateScrollbackRevealRef = useRef<(overlay: HTMLElement) => void>(() => {});
  // Daemon-stamped DataChannel stream offset for each snapshot payload.
  const scrollbackSnapshotOffsetsRef = useRef(new WeakMap<Uint8Array, number>());
  const scrollbackRenderInFlightRef = useRef(false);
  // Set when the terminal width changes: the next anchored snapshot rewrites
  // the live buffer so seeded history reflows at the new width.
  const historyReseedPendingRef = useRef(false);
  // Whether the live buffer's current seed came from an exact worker stream
  // (vs a plain endpoint replay without geometry markers).
  const liveSeedWasExactRef = useRef(false);
  // Last trustworthy reader position (buffer line of the viewport top),
  // recorded only while no rewrite is collapsing the buffer. Rebuilt content
  // only grows at the bottom, so a line anchor keeps the reader's lines
  // steady; positions are tracked in xterm's internal line space because raw
  // DOM scrollTop writes race with xterm's own viewport syncing under
  // concurrent writes.
  const scrollbackStableLineRef = useRef<number | null>(null);
  const recentDcChunksRef = useRef<{ offsetAfter: number; bytes: Uint8Array }[]>([]);
  const recentDcChunksSizeRef = useRef(0);
  const dcActiveRef = useRef(false);
  // xterm's reset/seed write is asynchronous. Keep live bytes behind that
  // barrier so a DataChannel message cannot be consumed and then erased by
  // the still-running initial replay.
  const liveSeedWriteInFlightRef = useRef(false);
  const pendingLiveSeedWritesRef = useRef(
    new PostRenderLiveWriteBuffer(SCROLLBACK_DC_REPLAY_BUFFER_BYTES),
  );
  const liveSeedCoveredOffsetRef = useRef<number | null>(null);
  const flushPendingLiveSeedWritesRef = useRef<() => void>(() => {});
  const liveViewportPinFrameRef = useRef<number | null>(null);
  const pinLiveViewportToBottomRef = useRef<() => void>(() => {});
  const renderScrollbackSnapshotRef = useRef<(bytes: Uint8Array | null, reveal: boolean) => void>(
    () => {},
  );
  const requestScrollbackSnapshotRef = useRef<(initialDeltaY?: number) => boolean>(() => false);
  const requestSnapshotRef = useRef<(purpose: ScrollbackSnapshotPurpose) => boolean>(() => false);
  const scheduleScrollbackCacheRefreshRef = useRef<(delayMs?: number) => void>(() => {});
  const scrollbackWheelHandlerRef = useRef<(event: WheelEvent) => boolean>(() => true);
  // True once a snapshot/history proved this agent ships exact worker
  // replays; used to widen the overlay fetch budget (the daemon maps lines
  // to a byte budget, and TUI redraw churn dwarfs line-based sizing).
  const exactStreamRef = useRef(false);
  const invalidateScrollbackForResizeRef = useRef<() => void>(() => {});
  const terminalRowHeightRef = useRef(TERMINAL_LINE_HEIGHT_PX);
  const [scrollbackVisible, setScrollbackVisible] = useState(false);
  const [scrollbackReady, setScrollbackReady] = useState(false);

  const applyScrollbackOverlayVisibility = useCallback((visible: boolean) => {
    const overlay = scrollbackOverlayRef.current;
    if (!overlay) return;
    overlay.style.visibility = visible ? "visible" : "hidden";
    overlay.setAttribute("aria-hidden", visible ? "false" : "true");
  }, []);

  const setScrollbackReadyState = useCallback(
    (ready: boolean) => {
      applyScrollbackOverlayVisibility(scrollbackVisibleRef.current && ready);
      if (scrollbackReadyRef.current === ready) return;
      scrollbackReadyRef.current = ready;
      setScrollbackReady(ready);
    },
    [applyScrollbackOverlayVisibility],
  );

  const getScrollbackViewport = useCallback(() => {
    return scrollbackTerminalHostRef.current?.querySelector<HTMLElement>(".xterm-viewport") ?? null;
  }, []);

  // Snapshot the overlay's currently-visible rows while it is scrolled up, so
  // a diagnostics refresh can report the reader's view even after the overlay
  // has closed (which resets its buffer to the live edge). Cheap — one screen
  // of translateToString — and only runs when there is scrolled history to
  // capture.
  const rememberScrolledView = useCallback(() => {
    const historyTerm = scrollbackTermRef.current;
    const buffer = historyTerm?.buffer.active;
    if (!historyTerm || !buffer || buffer.viewportY >= buffer.baseY) return;
    const rows: string[] = [];
    for (let i = 0; i < historyTerm.rows; i += 1) {
      rows.push(buffer.getLine(buffer.viewportY + i)?.translateToString(true) ?? "");
    }
    lastScrolledViewRef.current = {
      at: Date.now(),
      viewportY: buffer.viewportY,
      baseY: buffer.baseY,
      length: buffer.length,
      rows,
    };
  }, []);

  const recordScrollbackUserPosition = useCallback(
    (overlay: HTMLElement) => {
      scrollbackUserScrollGenerationRef.current += 1;
      scrollbackDesiredScrollTopRef.current = overlay.scrollTop;
      scrollbackLastUserScrollAtRef.current = Date.now();
      if (!scrollbackRenderInFlightRef.current) {
        scrollbackStableLineRef.current =
          scrollbackTermRef.current?.buffer.active.viewportY ?? null;
      }
      rememberScrolledView();
    },
    [rememberScrolledView],
  );

  // Live DataChannel chunks newer than the snapshot's capture offset. The
  // first replayed chunk may straddle the offset; slice off the part the
  // capture already contains. Returns null when the ring buffer no longer
  // reaches back to the offset — a replay would leave a hole, and callers
  // that rewrite authoritative content must not proceed on stale bytes.
  const takeDcReplaySlices = useCallback((bytes: Uint8Array): Uint8Array[] | null => {
    const anchor = scrollbackSnapshotOffsetsRef.current.get(bytes);
    if (anchor === undefined) return [];
    const slices: Uint8Array[] = [];
    let covered = false;
    for (const chunk of recentDcChunksRef.current) {
      if (chunk.offsetAfter <= anchor) {
        covered = true;
        continue;
      }
      const start = chunk.offsetAfter - chunk.bytes.length;
      if (start <= anchor) {
        covered = true;
        slices.push(anchor > start ? chunk.bytes.subarray(anchor - start) : chunk.bytes);
      } else if (!covered && slices.length === 0) {
        scrollbackCacheDirtyRef.current = true;
        scheduleScrollbackCacheRefreshRef.current();
        return null;
      } else {
        slices.push(chunk.bytes);
      }
    }
    return slices;
  }, []);

  const syncLiveTerminalFromSnapshot = useCallback(
    (bytes: Uint8Array | null, opts?: { force?: boolean }): boolean => {
      const term = termRef.current;
      if (
        !term ||
        !bytes ||
        scrollbackCacheDirtyRef.current ||
        scrollbackCachedSnapshotBytesRef.current !== bytes
      ) {
        return false;
      }
      // An alternate-screen app (vim, htop, full-screen TUIs) owns the live
      // viewport and repaints incrementally; rewriting it from a flattened
      // snapshot would desync the buffer and cursor from the app's state.
      if (term.buffer.active.type === "alternate") return false;

      const text = decodeUtf8(bytes);
      const exact = parseExactReplay(text) !== null;
      // Exact worker streams keep the live terminal byte-exact by
      // construction (it consumes every live byte even while the overlay is
      // open), so there is nothing to reconcile on overlay close — and a
      // rewrite would replay recently-scrolled lines into a buffer that
      // already contains them, duplicating history. Only a forced reseed
      // (width change reflow) rewrites, and it clears first for the same
      // reason.
      if (exact && !opts?.force) return false;

      // Compute the replay BEFORE writing anything: if the ring buffer can't
      // cover the gap between the snapshot's capture offset and now (e.g.
      // the overlay was open for a long stretch of heavy output), rewriting
      // would roll the live terminal back to overlay-open-time content. The
      // live terminal kept receiving every byte, so skipping is always safe.
      const replaySlices = takeDcReplaySlices(bytes);
      if (replaySlices === null) return false;

      const { cols, rows } = lastSizeRef.current;
      try {
        term.resize(cols, rows);
      } catch {
        // The live terminal can be mid-dispose during route changes; the next
        // socket history frame will seed the replacement instance.
      }
      // Clear via escape sequences instead of term.reset(): reset() also
      // wipes terminal modes (bracketed paste, mouse reporting, application
      // cursor keys) that the agent still believes are active, garbling
      // input until the next full repaint. The 3J matters: without wiping
      // local scrollback, the seed's replayed output would duplicate lines
      // the buffer already scrolled in.
      predictorRef.current.clear();
      const ops: SequencedWrite[] = [
        { data: "\x1b[0m\x1b[H\x1b[2J\x1b[3J" },
        ...liveSeedWriteOps(text),
      ];
      writeSequenced(term, [...ops, ...replaySlices.map((slice) => ({ data: slice }))], () => {
        term.scrollToBottom();
        syncPredictionOverlayRef.current();
      });
      return true;
    },
    [takeDcReplaySlices],
  );

  // xterm's Viewport translates DOM scrollTop into buffer lines by dividing
  // by its measured row height. While the overlay host is hidden or
  // mid-relayout that height can be 0, and 0/0 poisons the buffer's scroll
  // offset (ydisp) with NaN — which never heals because every public scroll
  // API is delta-based (NaN + n = NaN), leaving the overlay wedged shut
  // under the reader (upstream xterm.js Viewport bug, observed on 5.5.0
  // under slow-frame conditions). Reset the internal offset directly;
  // pinned-version internals, degrades to a no-op if they move.
  const healScrollbackScrollState = useCallback(() => {
    const historyTerm = scrollbackTermRef.current;
    if (!historyTerm || Number.isFinite(historyTerm.buffer.active.viewportY)) return;
    const buffer = (
      historyTerm as unknown as {
        _core?: { _bufferService?: { buffer?: { ydisp?: unknown } } };
      }
    )._core?._bufferService?.buffer;
    if (buffer && typeof buffer.ydisp === "number" && !Number.isFinite(buffer.ydisp)) {
      buffer.ydisp = 0;
    }
  }, []);

  const hideScrollbackOverlay = useCallback(() => {
    if (!scrollbackVisibleRef.current) return;
    syncLiveTerminalFromSnapshot(scrollbackRenderedSnapshotBytesRef.current);
    scrollbackVisibleRef.current = false;
    scrollbackRevealPendingRef.current = false;
    committedHistoryRef.current?.conceal();
    syncScrollbackWebglRenderer(false);
    scrollbackRenderInFlightRef.current = false;
    scrollbackOverlayRef.current?.setAttribute("aria-busy", "false");
    scrollbackStableLineRef.current = null;
    scrollbackSnapshotBytesRef.current = null;
    scrollbackOverlayHasSnapshotRef.current = false;
    scrollbackPendingDeltaPxRef.current = 0;
    scrollbackDesiredScrollTopRef.current = null;
    scrollbackUserScrollGenerationRef.current += 1;
    setScrollbackReadyState(false);
    setScrollbackVisible(false);
    scrollbackTermRef.current?.scrollToBottom();
    termRef.current?.scrollToBottom();
    // Selecting text focuses the overlay terminal; hand focus back to the
    // live terminal so typing resumes. Skip on touch devices, where focusing
    // would pop the virtual keyboard.
    if (
      !coarsePointerRef.current &&
      scrollbackTerminalHostRef.current?.contains(document.activeElement)
    ) {
      termRef.current?.focus();
    }
    if (scrollbackCacheDirtyRef.current) scheduleScrollbackCacheRefreshRef.current(100);
  }, [setScrollbackReadyState, syncLiveTerminalFromSnapshot, syncScrollbackWebglRenderer]);

  const updateScrollbackReveal = useCallback(
    (_overlay: HTMLElement) => {
      // While a reset+rewrite is in flight the buffer is transiently
      // collapsed; deciding visibility against it would blink the overlay
      // out under the reader. The render's own completion callback re-runs
      // this with the rebuilt buffer.
      if (scrollbackRenderInFlightRef.current) return;
      healScrollbackScrollState();
      const buffer = scrollbackTermRef.current?.buffer.active;
      const reveal = buffer ? buffer.baseY > 0 && buffer.viewportY < buffer.baseY : false;
      setScrollbackReadyState(reveal);
      if (reveal) rememberScrolledView();
    },
    [healScrollbackScrollState, rememberScrolledView, setScrollbackReadyState],
  );
  updateScrollbackRevealRef.current = updateScrollbackReveal;

  // Delta-mode reveal completion: the controller's write queue drained after a
  // wheel-open (history + live-screen tail are in the buffer), so position at
  // the live edge, apply the wheel deltas banked while rendering, and reveal.
  const finishDeltaReveal = useCallback(() => {
    const overlay = getScrollbackViewport();
    const historyTerm = scrollbackTermRef.current;
    if (!overlay || !historyTerm || !scrollbackVisibleRef.current) return;
    healScrollbackScrollState();
    scrollbackOverlayHasSnapshotRef.current = true;
    historyTerm.scrollToBottom();
    const pendingDelta = scrollbackPendingDeltaPxRef.current;
    const pendingLines = Math.trunc(pendingDelta / Math.max(1, terminalRowHeightRef.current));
    if (pendingLines !== 0) historyTerm.scrollLines(pendingLines);
    scrollbackPendingDeltaPxRef.current = 0;
    scrollbackDesiredScrollTopRef.current = overlay.scrollTop;
    scrollbackStableLineRef.current = historyTerm.buffer.active.viewportY;
    updateScrollbackReveal(overlay);
  }, [getScrollbackViewport, healScrollbackScrollState, updateScrollbackReveal]);
  finishDeltaRevealRef.current = finishDeltaReveal;

  // Rebuild the delta-mode overlay from a v2 replay's history text. The
  // screen chunk is ignored: the reveal tail is painted from the local live
  // terminal, which is always fresher than any capture.
  const seedCommittedHistory = useCallback(
    (bytes: Uint8Array, anchor: { epoch: string; offset: number }) => {
      const controller = committedHistoryRef.current;
      if (!controller) return;
      const storied = parseHistoryReplay(parseExactReplay(decodeUtf8(bytes)));
      const { cols, rows } = lastSizeRef.current;
      controller.seed(storied ? storied.history : "", anchor, { cols, rows });
    },
    [],
  );

  const renderScrollbackSnapshot = useCallback(
    (bytes: Uint8Array | null, reveal: boolean) => {
      const historyTerm = scrollbackTermRef.current;
      if (!bytes || !historyTerm) return;
      // Delta mode owns the hidden terminal; a legacy rewrite would corrupt
      // the controller's anchored buffer.
      if (historyStreamActiveRef.current) return;
      const renderAlreadyInFlight = scrollbackRenderInFlightRef.current;
      const generation = scrollbackRenderGenerationRef.current + 1;
      scrollbackRenderGenerationRef.current = generation;
      scrollbackRenderInFlightRef.current = true;
      scrollbackOverlayRef.current?.setAttribute("aria-busy", "true");

      // A visible re-render must preserve the reader's place even when the
      // idle-gate didn't stage an explicit restore. Measure the distance
      // from the bottom before the rewrite collapses the buffer — unless a
      // previous rewrite is still in flight, in which case the live buffer
      // is untrustworthy and the last stable position wins.
      if (
        scrollbackVisibleRef.current &&
        scrollbackOverlayHasSnapshotRef.current &&
        scrollbackRestoreLineRef.current === null
      ) {
        if (renderAlreadyInFlight) {
          scrollbackRestoreLineRef.current = scrollbackStableLineRef.current;
        } else {
          scrollbackRestoreLineRef.current = historyTerm.buffer.active.viewportY;
        }
      }

      const { cols, rows } = lastSizeRef.current;
      const text = decodeUtf8(bytes);
      historyTerm.reset();
      // Legacy (pre-delta) workers get a static render of the capture: the
      // overlay is correct at open time and refreshed on the next open. No
      // live bytes, ring slices, or convergence tracking ever touch this
      // terminal — that machinery was the source of the mangled-history
      // class the committed-history stream eliminated.
      writeSequenced(historyTerm, overlayWriteOps(text, { cols, rows }), () => {
        // Two frames let xterm's renderer settle the viewport height, but
        // ALL scroll mutations happen atomically in the final frame: a
        // half-applied scrollToBottom from a render superseded mid-sequence
        // used to pin the overlay to the bottom, which the next render then
        // captured as the position to preserve, hiding the overlay under an
        // actively-reading user.
        requestAnimationFrame(() => {
          if (scrollbackRenderGenerationRef.current !== generation) return;
          requestAnimationFrame(() => {
            if (scrollbackRenderGenerationRef.current !== generation) return;
            scrollbackRenderInFlightRef.current = false;
            scrollbackOverlayRef.current?.setAttribute("aria-busy", "false");
            scrollbackRenderedSnapshotBytesRef.current = bytes;
            const overlay = getScrollbackViewport();
            if (!overlay) return;
            if (!reveal && !scrollbackVisibleRef.current) {
              historyTerm.scrollToBottom();
              overlay.scrollTop = maxElementScrollTop(overlay);
              return;
            }
            scrollbackOverlayHasSnapshotRef.current = true;
            healScrollbackScrollState();
            const restoreLine = scrollbackRestoreLineRef.current;
            scrollbackRestoreLineRef.current = null;
            if (restoreLine !== null) {
              historyTerm.scrollToLine(restoreLine);
            } else {
              historyTerm.scrollToBottom();
            }
            const pendingDelta = scrollbackPendingDeltaPxRef.current;
            const pendingLines = Math.trunc(
              pendingDelta / Math.max(1, terminalRowHeightRef.current),
            );
            if (pendingLines !== 0) historyTerm.scrollLines(pendingLines);
            scrollbackPendingDeltaPxRef.current = 0;
            scrollbackDesiredScrollTopRef.current = overlay.scrollTop;
            scrollbackStableLineRef.current = historyTerm.buffer.active.viewportY;
            updateScrollbackReveal(overlay);
          });
        });
      });
    },
    [getScrollbackViewport, healScrollbackScrollState, updateScrollbackReveal],
  );
  renderScrollbackSnapshotRef.current = renderScrollbackSnapshot;

  const showUploadStatus = useCallback((message: string) => {
    setUploadStatus(message);
    if (uploadStatusTimerRef.current) clearTimeout(uploadStatusTimerRef.current);
    uploadStatusTimerRef.current = setTimeout(() => {
      setUploadStatus(null);
      uploadStatusTimerRef.current = null;
    }, 3000);
  }, []);

  const syncUploadReconciliations = useCallback(() => {
    const state = loadUploadReconciliationState(agentId);
    setUploadReconciliations(state.records);
    setUploadReconciliationFault(state.fault);
  }, [agentId]);

  useEffect(() => syncUploadReconciliations(), [syncUploadReconciliations]);

  useEffect(() => {
    const sync = (event: Event) => {
      if (!(event instanceof CustomEvent) || event.detail?.agentId !== agentId) return;
      syncUploadReconciliations();
    };
    window.addEventListener(UPLOAD_RECONCILIATION_EVENT, sync);
    return () => window.removeEventListener(UPLOAD_RECONCILIATION_EVENT, sync);
  }, [agentId, syncUploadReconciliations]);

  const reserveUploadReconciliation = useCallback(
    (uploadId: string, fileName: string) =>
      reserveUploadReconciliationSlot(agentId, uploadId, fileName),
    [agentId],
  );

  const promoteUploadReconciliation = useCallback(
    (uploadId: string, fileName: string, message: string) =>
      promoteUploadReconciliationSlot(agentId, uploadId, fileName, message),
    [agentId],
  );

  const assertUploadReconciliation = useCallback(
    (uploadId: string) => assertUploadReconciliationActive(agentId, uploadId),
    [agentId],
  );

  const dismissUploadReconciliation = useCallback(
    (uploadId: string, recoverFault = false) => {
      try {
        dismissUploadReconciliationSlot(agentId, uploadId, recoverFault);
      } catch {
        // The store emitted a fault event and retained the record. A later
        // explicit dismissal after storage recovers is the only safe unlock.
      }
    },
    [agentId],
  );

  const updatePendingAttachments = useCallback(
    (updater: (attachments: PendingAttachment[]) => PendingAttachment[]) => {
      setPendingAttachments((current) => {
        const next = updater(current);
        pendingAttachmentsRef.current = next;
        return next;
      });
    },
    [],
  );

  const removePendingAttachment = useCallback(
    (id: string) => {
      updatePendingAttachments((attachments) => {
        const next = attachments.filter((attachment) => attachment.id !== id);
        attachments
          .filter((attachment) => attachment.id === id)
          .forEach((attachment) => {
            attachment.controller.abort();
            URL.revokeObjectURL(attachment.previewUrl);
          });
        return next;
      });
    },
    [updatePendingAttachments],
  );

  const takeReadyAttachmentPrefix = useCallback(() => {
    const ready = pendingAttachmentsRef.current.filter(
      (attachment) => attachment.status === "ready" && attachment.promptText,
    );
    if (ready.length === 0) return "";

    const readyIds = new Set(ready.map((attachment) => attachment.id));
    updatePendingAttachments((attachments) => {
      attachments
        .filter((attachment) => readyIds.has(attachment.id))
        .forEach((attachment) => {
          URL.revokeObjectURL(attachment.previewUrl);
        });
      return attachments.filter((attachment) => !readyIds.has(attachment.id));
    });

    return `${ready.map((attachment) => attachment.promptText).join(" ")} `;
  }, [updatePendingAttachments]);

  const appendAttachmentsForSubmit = useCallback(
    (data: string) => {
      if (!isReturnKeyData(data)) return data;
      const attachmentPrefix = takeReadyAttachmentPrefix();
      return attachmentPrefix ? ` ${attachmentPrefix}${data}` : data;
    },
    [takeReadyAttachmentPrefix],
  );

  const takeControlNow = useCallback((): boolean => {
    hideScrollbackOverlay();
    const term = termRef.current;
    if (!term) return false;
    displayOwnerRef.current = true;
    displayGeometryRef.current = null;
    setControlState((prev) => (prev ? { ...prev, owner: true } : prev)); // optimistic
    layoutTerminalSurfaceRef.current(false);
    try {
      fitRef.current?.fit();
    } catch {
      // Keep the current size if fit is unavailable.
    }
    const { cols, rows } = term;
    const last = lastSizeRef.current;
    lastSizeRef.current = { cols, rows };
    if (cols !== last.cols || rows !== last.rows) {
      invalidateScrollbackForResizeRef.current();
    }
    markResizeSentRef.current(cols, rows);
    socketRef.current.sendJson({ type: "take_control", cols, rows });
    term.focus();
    return true;
  }, [hideScrollbackOverlay]);
  takeControlNowRef.current = takeControlNow;

  const applyDisplayControl = useCallback(
    (state: DisplayControlState) => {
      const geometry =
        typeof state.cols === "number" && typeof state.rows === "number"
          ? { cols: state.cols, rows: state.rows }
          : null;
      displayOwnerRef.current = state.owner;
      displayGeometryRef.current = geometry;
      onDisplayControl?.(state);

      // Opening a terminal claims the shared display by default — but only
      // off the FIRST state after mount. Reacting to later ownership changes
      // would make two open tabs steal control from each other forever; a
      // dimmed viewer re-takes via the centered button instead.
      const isFirstControl = !firstControlSeenRef.current;
      firstControlSeenRef.current = true;
      if (isFirstControl && !state.owner && autoTakeControlRef.current) {
        setControlState({ ...state, owner: true }); // optimistic; server confirms
        // The control frame can beat xterm mount; retry briefly rather than
        // silently staying an optimistic "owner" whose PTY is still sized
        // for another session (which renders as clipped/garbled output).
        const attemptTake = (tries: number) => {
          if (takeControlNowRef.current()) return;
          if (tries < 30) {
            requestAnimationFrame(() => attemptTake(tries + 1));
          } else {
            setControlState(state); // give up: reflect the real viewer state
          }
        };
        requestAnimationFrame(() => attemptTake(0));
        return;
      }
      setControlState(state);

      requestAnimationFrame(() => {
        const term = termRef.current;
        if (!term) return;

        if (state.owner) {
          fitTerminalRef.current(true);
          // Ownership is confirmed asynchronously; a refit that landed
          // before this message recorded its size locally but never sent it
          // (resize only goes out while owner). Converge the PTY on our
          // geometry unconditionally — the daemon dedupes same-size resizes.
          const { cols, rows } = lastSizeRef.current;
          socketRef.current.sendJson({ type: "resize", cols, rows });
          return;
        }

        if (!geometry) return;
        if (!coarsePointerRef.current) {
          fitTerminalRef.current(true);
          return;
        }
        const buffer = term.buffer.active;
        const atBottom = buffer.viewportY >= buffer.baseY;
        const viewportY = buffer.viewportY;
        const last = lastSizeRef.current;
        try {
          term.resize(geometry.cols, geometry.rows);
        } catch {
          return;
        }
        lastSizeRef.current = geometry;
        if (geometry.cols !== last.cols || geometry.rows !== last.rows) {
          invalidateScrollbackForResizeRef.current();
        }
        layoutTerminalSurfaceRef.current(atBottom);
        requestAnimationFrame(() => layoutTerminalSurfaceRef.current(atBottom));
        if (atBottom) {
          term.scrollToBottom();
        } else {
          term.scrollToLine(Math.max(0, Math.min(term.buffer.active.baseY, viewportY)));
        }
      });
    },
    [onDisplayControl],
  );

  const handleUploadSaved = useCallback(
    (path: string, clientId?: string | null) => {
      const targetId = clientId
        ? pendingAttachmentsRef.current.find((attachment) => attachment.id === clientId)?.id
        : pendingAttachmentsRef.current.find((attachment) => attachment.status === "uploading")?.id;
      if (!targetId) {
        // A removed/unmounted attachment owns an aborted generation. Ignore a
        // completion that raced cancellation instead of resurrecting UI state.
        if (clientId) return;
        showUploadStatus(`Uploaded ${compactPath(path)}`);
        termRef.current?.focus();
        return;
      }

      if (imagePasteMode === "bracketed-path") {
        removePendingAttachment(targetId);
        socketRef.current.sendBinary(bracketedPaste(shellSingleQuote(path)));
        showUploadStatus("Image pasted");
        termRef.current?.focus();
        return;
      }

      const promptText = `@${compactPath(path)}`;
      updatePendingAttachments((attachments) => {
        return attachments.map((attachment) =>
          attachment.id === targetId ? { ...attachment, promptText, status: "ready" } : attachment,
        );
      });
      showUploadStatus("Image attached");
    },
    [imagePasteMode, removePendingAttachment, showUploadStatus, updatePendingAttachments],
  );

  flushPendingLiveSeedWritesRef.current = () => {
    const term = termRef.current;
    if (!term) {
      pendingLiveSeedWritesRef.current.clear();
      liveSeedWriteInFlightRef.current = false;
      return;
    }
    const geometry = lastSizeRef.current;
    const pending = pendingLiveSeedWritesRef.current.drain(
      liveSeedCoveredOffsetRef.current,
      geometry,
    );
    if (pending.kind === "refresh") {
      liveSeedWriteInFlightRef.current = false;
      historyReseedPendingRef.current = true;
      scrollbackCacheDirtyRef.current = true;
      if (!requestSnapshotRef.current("cache")) {
        scheduleScrollbackCacheRefreshRef.current(100);
      }
      pinLiveViewportToBottomRef.current();
      return;
    }
    liveSeedCoveredOffsetRef.current = pending.coveredOffset;
    if (pending.chunks.length === 0) {
      liveSeedWriteInFlightRef.current = false;
      pinLiveViewportToBottomRef.current();
      // Echo bytes that raced the seed flush bypassed the per-write
      // reconcile; settle any outstanding predictions now.
      reconcilePredictionRef.current();
      return;
    }
    writeSequenced(
      term,
      pending.chunks.map((data) => ({ data })),
      () => flushPendingLiveSeedWritesRef.current(),
    );
  };

  // Signed-signaling trust inputs. Terminal only receives agentId, so it
  // derives the account, the agent's host, and that host's server-claimed key
  // and fingerprint (all react-query cached and shared with the pages). The
  // claimed values are untrusted; the local pin gate decides how to use them.
  const { user: authUser } = useAuth();
  const agentIdentityQuery = useQuery({
    queryKey: ["agent", agentId],
    queryFn: () => agents.get(agentId),
    staleTime: 30_000,
  });
  const signalingHostId = agentIdentityQuery.data?.host_id ?? null;
  const hostIdentityQuery = useQuery({
    queryKey: ["host", signalingHostId],
    queryFn: () => hosts.get(signalingHostId as string),
    enabled: signalingHostId !== null,
    staleTime: 30_000,
  });
  const signalingAccountId = authUser?.id ?? null;
  // Liveness for the trust capability. The epoch ends the moment the signed-in
  // account changes, so a negotiation that spans a logout or account switch
  // must abort instead of completing under the previous account's pin and
  // signing identity.
  const liveAccountIdRef = useRef<string | null>(signalingAccountId);
  liveAccountIdRef.current = signalingAccountId;
  const claimedHostPublicKey = hostIdentityQuery.data?.host_public_key ?? null;
  const claimedHostFingerprint = hostIdentityQuery.data?.host_key_fingerprint ?? null;
  // Trust can only be evaluated once the account and hostId are known, and the
  // first connection must not race the host record: until the claimed key
  // query settles (success or error — a keyless host legitimately resolves to
  // null), the socket stays disabled. Connecting earlier would both reach a
  // pinned host before its pin is checked and tear the connection down again
  // the moment the claimed key lands, killing anything in flight on it.
  const signalingIdentityKnown =
    signalingAccountId !== null &&
    signalingHostId !== null &&
    (hostIdentityQuery.isSuccess || hostIdentityQuery.isError);
  const resolveTrust = useCallback(
    (): Promise<SignedRtcTrustDecision> =>
      resolveSignedRtcTrust({
        accountId: signalingAccountId as string,
        hostId: signalingHostId as string,
        claimedHostPublicKey,
        claimedHostFingerprint,
        isActive: () => liveAccountIdRef.current === signalingAccountId,
      }),
    [signalingAccountId, signalingHostId, claimedHostPublicKey, claimedHostFingerprint],
  );

  const socket = useAgentSocket({
    agentId,
    enabled: socketInitialSize !== null && signalingIdentityKnown,
    resolveSignedRtcTrust: signalingIdentityKnown ? resolveTrust : undefined,
    initialSize: socketInitialSize,
    onData: (bytes, dcOffsetAfter) => {
      if (typeof dcOffsetAfter === "number") {
        dcActiveRef.current = true;
        recentDcChunksRef.current.push({ offsetAfter: dcOffsetAfter, bytes });
        recentDcChunksSizeRef.current += bytes.length;
        while (
          recentDcChunksSizeRef.current > SCROLLBACK_DC_REPLAY_BUFFER_BYTES &&
          recentDcChunksRef.current.length > 1
        ) {
          const evicted = recentDcChunksRef.current.shift();
          if (evicted) recentDcChunksSizeRef.current -= evicted.bytes.length;
        }
      } else if (dcActiveRef.current) {
        // An unanchored endpoint replay cannot be ordered by PTY offset.
        dcActiveRef.current = false;
        recentDcChunksRef.current = [];
        recentDcChunksSizeRef.current = 0;
      }
      // An anchored cache stays exact as long as the DC replay ring can still
      // bridge from its capture offset (renders replay ring bytes on top).
      // Only mark it stale once the uncovered span nears the ring's capacity
      // — refreshing on a wall-clock cadence instead re-downloaded and
      // re-rendered megabytes of history every few seconds of streaming,
      // starving interactive echo.
      scrollbackLiveBytesAtRef.current = Date.now();
      // Resize->repaint timing: attribute the output burst that follows a
      // resize to that resize; finalize once it settles (250ms quiet).
      const rm = resizeMarkRef.current;
      if (rm) {
        const now = Date.now();
        if (rm.firstByteAt === null) rm.firstByteAt = now;
        rm.lastByteAt = now;
        if (resizeSettleTimerRef.current) clearTimeout(resizeSettleTimerRef.current);
        resizeSettleTimerRef.current = setTimeout(() => {
          resizeSettleTimerRef.current = null;
          const m = resizeMarkRef.current;
          resizeMarkRef.current = null;
          if (m && m.firstByteAt !== null && m.lastByteAt !== null) {
            resizeTimingsRef.current.push({
              at: new Date().toISOString(),
              cols: m.cols,
              rows: m.rows,
              toFirstByteMs: Math.round(m.firstByteAt - m.sentAt),
              toSettleMs: Math.round(m.lastByteAt - m.sentAt),
            });
            while (resizeTimingsRef.current.length > 12) resizeTimingsRef.current.shift();
          }
        }, 250);
      }
      // Delta mode keeps the overlay exact from the committed-history stream;
      // legacy (pre-delta) workers render a fresh capture per overlay open,
      // so raw live bytes never touch the hidden terminal on either path.
      committedHistoryRef.current?.liveScreenChanged();
      const closeHudSample = latencyHudRef.current?.noteEcho(performance.now()) ?? null;
      if (liveSeedWriteInFlightRef.current) {
        pendingLiveSeedWritesRef.current.enqueue(bytes, dcOffsetAfter, lastSizeRef.current);
      } else {
        termRef.current?.write(bytes, () => {
          pinLiveViewportToBottomRef.current();
          reconcilePredictionRef.current();
          if (closeHudSample) {
            requestAnimationFrame(() => closeHudSample(performance.now()));
          }
        });
      }
    },
    onHistory: (bytes, dcOffset, historyAnchor) => {
      const term = termRef.current;
      if (!term) return;
      clearPrediction();
      if (typeof dcOffset === "number") {
        scrollbackSnapshotOffsetsRef.current.set(bytes, dcOffset);
      }
      if (historyAnchor) {
        // Delta-capable worker: the connect seed anchors the committed-line
        // overlay; the scheduled deep refresh below re-seeds at full depth.
        historyStreamActiveRef.current = true;
        seedCommittedHistory(bytes, historyAnchor);
      }
      pendingLiveSeedWritesRef.current.clear();
      liveSeedCoveredOffsetRef.current = typeof dcOffset === "number" ? dcOffset : null;
      liveSeedWriteInFlightRef.current = true;
      const exactChunks = parseExactReplay(decodeUtf8(bytes));
      if (exactChunks) exactStreamRef.current = true;
      // Remember whether the endpoint seed included exact geometry markers;
      // a later exact replay can heal a plain seed.
      liveSeedWasExactRef.current = exactChunks !== null;
      const lastChunk = exactChunks?.[exactChunks.length - 1];
      if (lastChunk) {
        const { cols, rows } = lastSizeRef.current;
        if (lastChunk.cols !== cols || lastChunk.rows !== rows) {
          // The seed renders at the agent's previous PTY geometry (set by
          // another window/session). The owner assertion converges the PTY,
          // but no LOCAL size change follows, so nothing else would trigger
          // the rewrap — request a reseed from a fresh checkpoint.
          historyReseedPendingRef.current = true;
        }
      }
      // Alt-screen detection scoped to the state the stream ends in;
      // historical alt apps in older chunks must not count.
      const altActive = lastChunk
        ? lastChunk.data.lastIndexOf("\x1b[?1049h") > lastChunk.data.lastIndexOf("\x1b[?1049l")
        : containsAlternateBufferSwitch(bytes);
      // Cache the seed for the live-terminal heal machinery and schedule one
      // deep refresh: in delta mode its response re-seeds the overlay at full
      // depth; in legacy mode the overlay renders fresh per open instead.
      scrollbackCachedSnapshotBytesRef.current = altActive ? null : bytes;
      scrollbackCacheDirtyRef.current = true;
      scheduleScrollbackCacheRefreshRef.current(SCROLLBACK_WARM_DELAY_MS);
      term.reset();
      writeSequenced(term, liveSeedWriteOps(decodeUtf8(bytes)), () => {
        term.scrollToBottom();
        flushPendingLiveSeedWritesRef.current();
      });
    },
    onDisplayControl: applyDisplayControl,
    onSnapshot: (bytes, _plain, dcOffset, historyAnchor) => {
      const snapshotIsExact = parseExactReplay(decodeUtf8(bytes)) !== null;
      if (snapshotIsExact) {
        exactStreamRef.current = true;
        if (!liveSeedWasExactRef.current) {
          // The connect-time seed was plain, but the endpoint stream is now
          // provably exact: heal from a proper checkpoint capture.
          historyReseedPendingRef.current = true;
        }
      }
      if (scrollbackSnapshotTimeoutRef.current) {
        clearTimeout(scrollbackSnapshotTimeoutRef.current);
        scrollbackSnapshotTimeoutRef.current = null;
      }
      scrollbackSnapshotInFlightRef.current = false;
      scrollbackSnapshotPurposeRef.current = null;
      scrollbackCachedSnapshotBytesRef.current = bytes;
      if (typeof dcOffset === "number") {
        // Offset-anchored snapshot: renders are made exact by replaying live
        // DataChannel bytes past the capture offset, so the cache converges
        // immediately.
        scrollbackSnapshotOffsetsRef.current.set(bytes, dcOffset);
        scrollbackCacheDirtyRef.current = false;
      } else {
        // Replay and live PTY bytes travel over separate DataChannels, so
        // arrival order is not capture order. If
        // live bytes arrived since this snapshot was requested, the capture
        // may not contain them — keep the cache dirty and converge with a
        // follow-up refresh rather than risk rolling the live terminal back.
        const dirty =
          scrollbackLiveBytesAtRef.current !== 0 &&
          scrollbackLiveBytesAtRef.current >= scrollbackSnapshotRequestedAtRef.current;
        scrollbackCacheDirtyRef.current = dirty;
        if (dirty) scheduleScrollbackCacheRefreshRef.current();
      }
      // Reseeds prefer an anchored capture. A plain endpoint replay can be
      // accepted only through the cache-clean gate while the stream is quiet.
      const anchorOk = typeof dcOffset === "number" || !dcActiveRef.current;
      if (historyReseedPendingRef.current && anchorOk && !scrollbackVisibleRef.current) {
        // A width change left seeded history wrapped at the old width;
        // rewrite the live buffer from this anchored capture so it reflows.
        // Stays pending until a rewrite actually succeeds (alternate-screen
        // apps, replay-coverage gaps, and captures whose PTY geometry hasn't
        // converged to ours yet all defer it to a later snapshot).
        const chunks = parseExactReplay(decodeUtf8(bytes));
        const finalChunk = chunks?.[chunks.length - 1];
        const geometryReady =
          !finalChunk ||
          (finalChunk.cols === lastSizeRef.current.cols &&
            finalChunk.rows === lastSizeRef.current.rows);
        if (geometryReady && syncLiveTerminalFromSnapshot(bytes, { force: true })) {
          historyReseedPendingRef.current = false;
          liveSeedWasExactRef.current = snapshotIsExact;
        }
      }
      if (historyAnchor) {
        // Delta mode: this snapshot is a seed/heal for the committed-line
        // overlay. The controller re-anchors from it; deltas keep it exact
        // afterwards, so the cache is clean by construction.
        historyStreamActiveRef.current = true;
        scrollbackCacheDirtyRef.current = false;
        seedCommittedHistory(bytes, historyAnchor);
        return;
      }
      // Legacy (pre-delta) worker: the overlay renders only while open, from
      // the capture its open requested. Nothing pre-renders in the
      // background, and nothing rewrites under the reader afterwards.
      if (scrollbackVisibleRef.current && bytes !== scrollbackRenderedSnapshotBytesRef.current) {
        scrollbackSnapshotBytesRef.current = bytes;
        renderScrollbackSnapshotRef.current(bytes, true);
      }
    },
    onSnapshotError: (message) => {
      // Unlatch immediately instead of waiting out the request timeout, so
      // the next refresh/overlay attempt isn't blocked behind a dead request.
      console.warn(`scrollback snapshot refused: ${message}`);
      if (scrollbackSnapshotTimeoutRef.current) {
        clearTimeout(scrollbackSnapshotTimeoutRef.current);
        scrollbackSnapshotTimeoutRef.current = null;
      }
      scrollbackSnapshotInFlightRef.current = false;
      scrollbackSnapshotPurposeRef.current = null;
    },
    onHistoryDelta: (epoch, offset, bytes) => {
      historyStreamActiveRef.current = true;
      committedHistoryRef.current?.applyDelta(epoch, offset, bytes);
    },
    onHistoryWipe: (epoch) => {
      historyStreamActiveRef.current = true;
      committedHistoryRef.current?.applyWipe(epoch);
    },
    onHistoryGap: () => {
      committedHistoryRef.current?.applyGap();
    },
    onExit: (code, sig) => {
      const banner = `\r\n\x1b[33m[agent exited code=${code ?? "?"}${
        sig ? ` signal=${sig}` : ""
      }]\x1b[0m\r\n`;
      termRef.current?.write(banner);
      setExitBanner(`Agent exited (code=${code ?? "?"}${sig ? `, signal=${sig}` : ""})`);
      onExit?.(code, sig);
    },
  });

  // Stash the socket in a ref so the once-on-mount bootstrap useEffect can
  // reach it without re-running every render.
  const socketRef = useRef(socket);
  socketRef.current = socket;

  // Surface the live transport for connection indicators without forcing the
  // callback identity into effect deps (screen panes pass inline closures).
  const onConnectionInfoRef = useRef(onConnectionInfo);
  onConnectionInfoRef.current = onConnectionInfo;
  useEffect(() => {
    onConnectionInfoRef.current?.({
      socketState: socket.state,
      v2: socket.v2,
      dcOpen: socket.dcOpen,
      signedRtcRefusal: socket.signedRtcRefusal,
      ...socket.connInfo,
    });
  }, [socket.state, socket.v2, socket.dcOpen, socket.signedRtcRefusal, socket.connInfo]);

  // Only surface "waiting for the direct channel" after a grace period —
  // the DC normally opens within a second or two of attach.
  const [channelPending, setChannelPending] = useState(false);
  useEffect(() => {
    const pending = socket.v2 && socket.state === "open" && !socket.dcOpen;
    if (!pending) {
      setChannelPending(false);
      return;
    }
    const timer = setTimeout(() => setChannelPending(true), 1_500);
    return () => clearTimeout(timer);
  }, [socket.v2, socket.state, socket.dcOpen]);
  rawInputRef.current = rawInput;
  mobileReturnModeRef.current = mobileReturnMode;
  mobileReturnBytesRef.current = mobileReturnBytes;

  const requestSnapshot = useCallback((purpose: ScrollbackSnapshotPurpose) => {
    if (socketRef.current.state !== "open" || scrollbackSnapshotInFlightRef.current) return false;

    scrollbackSnapshotInFlightRef.current = true;
    scrollbackSnapshotPurposeRef.current = purpose;
    scrollbackSnapshotRequestedAtRef.current = Date.now();
    const sent = socketRef.current.sendJson({
      type: "snapshot",
      lines:
        purpose === "cache" && !dcActiveRef.current
          ? SCROLLBACK_UNANCHORED_CACHE_LINES
          : // TERMINAL_SNAPSHOT_LINES equals the daemon's MAX_HISTORY_LINES,
            // which it maps to its full replay budget (the whole retained
            // log). Anything above it fails request validation outright, and
            // the snapshot silently never arrives ("can't scroll").
            TERMINAL_SNAPSHOT_LINES,
      plain: false,
    });
    if (!sent) {
      scrollbackSnapshotInFlightRef.current = false;
      scrollbackSnapshotPurposeRef.current = null;
      return false;
    }
    if (scrollbackSnapshotTimeoutRef.current) clearTimeout(scrollbackSnapshotTimeoutRef.current);
    scrollbackSnapshotTimeoutRef.current = setTimeout(() => {
      scrollbackSnapshotTimeoutRef.current = null;
      scrollbackSnapshotInFlightRef.current = false;
      scrollbackSnapshotPurposeRef.current = null;
    }, SCROLLBACK_SNAPSHOT_TIMEOUT_MS);
    return true;
  }, []);
  requestSnapshotRef.current = requestSnapshot;

  const scheduleScrollbackCacheRefresh = useCallback(
    (delayMs?: number) => {
      // Debounce on output, but bound the postponement: an agent that streams
      // faster than the debounce window would otherwise starve the refresh
      // forever, leaving the scrollback cache minutes stale.
      const unanchoredMode = !dcActiveRef.current;
      const debounce =
        delayMs ?? (unanchoredMode ? SCROLLBACK_UNANCHORED_REFRESH_DEBOUNCE_MS : 350);
      const maxWait = unanchoredMode
        ? SCROLLBACK_UNANCHORED_REFRESH_MAX_WAIT_MS
        : SCROLLBACK_REFRESH_MAX_WAIT_MS;
      const now = Date.now();
      if (scrollbackCacheRefreshDeadlineRef.current === null) {
        scrollbackCacheRefreshDeadlineRef.current = now + maxWait;
      }
      const fireIn = Math.min(
        debounce,
        Math.max(0, scrollbackCacheRefreshDeadlineRef.current - now),
      );
      if (scrollbackCacheRefreshTimerRef.current) {
        clearTimeout(scrollbackCacheRefreshTimerRef.current);
      }
      scrollbackCacheRefreshTimerRef.current = setTimeout(() => {
        scrollbackCacheRefreshTimerRef.current = null;
        scrollbackCacheRefreshDeadlineRef.current = null;
        if (!scrollbackCacheDirtyRef.current) return;
        // Parked warm-pool instances stay quiescent: a background snapshot
        // fetch plus hidden-terminal rebuild steals main-thread time from
        // whichever terminal the user is actually typing into. The cache
        // stays dirty and one refresh runs on foregrounding instead.
        if (!activeRef.current) return;
        // No refresh under an open overlay: the open render is made exact by
        // replaying DataChannel bytes past the capture offset, and direct
        // live appends keep it complete from then on — a mid-read rewrite
        // would only flash and reflow content under the reader.
        if (scrollbackVisibleRef.current) return;
        if (!requestSnapshot("cache") && scrollbackSnapshotInFlightRef.current) {
          // Another capture is pending; try again once it resolves or times out.
          scheduleScrollbackCacheRefreshRef.current(500);
        }
      }, fireIn);
    },
    [requestSnapshot],
  );
  scheduleScrollbackCacheRefreshRef.current = scheduleScrollbackCacheRefresh;

  const requestScrollbackSnapshot = useCallback(
    (initialDeltaY = 0) => {
      if (initialDeltaY !== 0) {
        scrollbackPendingDeltaPxRef.current += initialDeltaY;
      }

      if (!scrollbackVisibleRef.current) {
        scrollbackVisibleRef.current = true;
        scrollbackOverlayHasSnapshotRef.current = false;
        scrollbackSnapshotBytesRef.current = null;
        scrollbackRenderedSnapshotBytesRef.current = null;
        // Null = start at the live edge; renders that overlap the open
        // scroll to bottom plus whatever wheel deltas banked.
        scrollbackStableLineRef.current = null;
        // Renderer parity with the live terminal from the first painted
        // frame; released again when the overlay closes.
        syncScrollbackWebglRenderer(true);
        setScrollbackReadyState(false);
        setScrollbackVisible(true);
      }

      if (historyStreamActiveRef.current) {
        // Delta mode: the hidden terminal already holds the exact committed
        // history. Reveal paints the live-screen tail below it; when no seed
        // has anchored yet, the controller requests one and the seed's render
        // completes this reveal.
        scrollbackRevealPendingRef.current = true;
        committedHistoryRef.current?.reveal();
        return true;
      }

      // Legacy (pre-delta) worker: every open fetches and renders a fresh
      // capture; onSnapshot completes the reveal when it lands.
      requestSnapshot("overlay");
      return true;
    },
    [requestSnapshot, setScrollbackReadyState, syncScrollbackWebglRenderer],
  );
  requestScrollbackSnapshotRef.current = requestScrollbackSnapshot;

  // A resize changes checkpoint geometry, so any cached replay is laid out at
  // the old width. Drop the rendered copy and fetch a fresh checkpoint at the new
  // geometry instead of presenting stale-width history.
  const invalidateScrollbackForResize = useCallback(() => {
    if (historyStreamActiveRef.current) {
      // Delta mode: committed history is flowing text — xterm reflows it on
      // resize with nothing refetched. Only the tail repaints.
      const { cols, rows } = lastSizeRef.current;
      committedHistoryRef.current?.resize(cols, rows);
      return;
    }
    scrollbackCacheDirtyRef.current = true;
    scrollbackRenderedSnapshotBytesRef.current = null;
    if (scrollbackVisibleRef.current) {
      requestSnapshot("overlay");
    } else {
      scheduleScrollbackCacheRefresh();
    }
  }, [requestSnapshot, scheduleScrollbackCacheRefresh]);
  invalidateScrollbackForResizeRef.current = invalidateScrollbackForResize;

  useLayoutEffect(() => {
    const host = scrollbackTerminalHostRef.current;
    if (!host || scrollbackTermRef.current) return;

    const historyTerm = new XTerm({
      ...XTERM_EMULATION_OPTIONS,
      cursorBlink: false,
      disableStdin: true,
      fontFamily: TERMINAL_FONT_FAMILY,
      fontSize: TERMINAL_FONT_SIZE,
      lineHeight: TERMINAL_LINE_HEIGHT,
      scrollback: TERMINAL_SNAPSHOT_LINES,
      smoothScrollDuration: 0,
      theme: { ...TERMINAL_SCROLLBACK_THEME },
    });
    historyTerm.loadAddon(new WebLinksAddon());
    activateUnicodeVersion(historyTerm, Unicode11Addon);
    historyTerm.open(host);
    scrollbackTermRef.current = historyTerm;
    committedHistoryRef.current = new CommittedHistoryOverlay({
      term: () => scrollbackTermRef.current,
      serializeLiveScreen: () => {
        const addon = serializeAddonRef.current;
        if (!addon || !termRef.current) return "";
        try {
          return addon.serialize({ scrollback: 0, excludeModes: true, excludeAltBuffer: true });
        } catch {
          return "";
        }
      },
      requestSeed: () => {
        scrollbackCacheDirtyRef.current = true;
        if (scrollbackVisibleRef.current) {
          requestSnapshotRef.current("overlay");
        } else {
          scheduleScrollbackCacheRefreshRef.current();
        }
      },
      onRendered: () => {
        if (scrollbackRevealPendingRef.current) {
          scrollbackRevealPendingRef.current = false;
          finishDeltaRevealRef.current();
          return;
        }
        if (scrollbackVisibleRef.current) {
          const overlay = getScrollbackViewport();
          if (overlay) updateScrollbackRevealRef.current(overlay);
        }
      },
    });
    // Route wheel through the shared scrollback logic (close-at-bottom,
    // snapshot refresh) instead of xterm's native buffer scrolling.
    historyTerm.attachCustomWheelEventHandler((event) => scrollbackWheelHandlerRef.current(event));
    const copySelectionOnMouseUp = () => {
      const selection = historyTerm.getSelection();
      if (!selection) return;
      void navigator.clipboard?.writeText(selection).catch(() => {});
    };
    host.addEventListener("mouseup", copySelectionOnMouseUp);
    const viewport = getScrollbackViewport();
    if (viewport) {
      viewport.style.scrollbarWidth = "none";
      viewport.style.touchAction = "none";
      viewport.style.overscrollBehavior = "contain";
    }
    return () => {
      host.removeEventListener("mouseup", copySelectionOnMouseUp);
      committedHistoryRef.current?.dispose();
      committedHistoryRef.current = null;
      scrollbackWebglAddonRef.current?.dispose();
      scrollbackWebglAddonRef.current = null;
      historyTerm.dispose();
      if (scrollbackTermRef.current === historyTerm) scrollbackTermRef.current = null;
    };
  }, [getScrollbackViewport]);

  useEffect(() => {
    if (socket.state !== "open") return;
    if (!scrollbackCachedSnapshotBytesRef.current || scrollbackCacheDirtyRef.current) {
      scheduleScrollbackCacheRefresh(SCROLLBACK_WARM_DELAY_MS);
    }
  }, [scheduleScrollbackCacheRefresh, socket.state]);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(pointer: coarse)");
    const update = () => {
      coarsePointerRef.current = media.matches;
    };
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    return () => {
      if (scrollbackCacheRefreshTimerRef.current) {
        clearTimeout(scrollbackCacheRefreshTimerRef.current);
        scrollbackCacheRefreshTimerRef.current = null;
      }
      pendingAttachmentsRef.current.forEach((attachment) => {
        attachment.controller.abort();
        URL.revokeObjectURL(attachment.previewUrl);
      });
      pendingAttachmentsRef.current = [];
    };
  }, []);

  // Bootstrap xterm.js once on mount.
  useEffect(() => {
    if (!terminalViewportRef.current || !terminalSurfaceRef.current || !containerRef.current) {
      return;
    }
    const term = new XTerm({
      ...XTERM_EMULATION_OPTIONS,
      cursorBlink: true,
      fontFamily: TERMINAL_FONT_FAMILY,
      fontSize: TERMINAL_FONT_SIZE,
      lineHeight: TERMINAL_LINE_HEIGHT,
      // Keep a large local buffer for endpoint replay and non-wheel access.
      // Wheel/touch scrollback is rendered from fresh worker snapshots so it
      // reflects the current worker checkpoint rather than browser replay artifacts.
      scrollback: TERMINAL_SCROLLBACK_LINES,
      scrollOnUserInput: true,
      smoothScrollDuration: 0,
      theme: { ...TERMINAL_THEME },
    });
    const fit = new FitAddon();
    const links = new WebLinksAddon();
    const clipboard = new ClipboardAddon();
    const serialize = new SerializeAddon();
    term.loadAddon(fit);
    term.loadAddon(links);
    term.loadAddon(clipboard);
    term.loadAddon(serialize);
    serializeAddonRef.current = serialize;
    activateUnicodeVersion(term, Unicode11Addon);

    term.open(containerRef.current);
    termRef.current = term;
    fitRef.current = fit;
    // The renderer addon needs the opened element; the active-state effect
    // has already run by the time this bootstrap effect mounts.
    syncWebglRendererRef.current(activeRef.current);
    if (latencyHudEnabled() && terminalSurfaceRef.current) {
      latencyHudRef.current = new LatencyHud();
      latencyHudRef.current.attach(terminalSurfaceRef.current);
    }
    const terminalViewport = terminalViewportRef.current;
    const terminalSurface = terminalSurfaceRef.current;
    const terminalElement = containerRef.current;
    const terminalTouchTarget = terminalViewport;
    terminalViewport.style.touchAction = "none";
    terminalElement.style.touchAction = "none";
    terminalTouchTarget.style.touchAction = "none";

    const rememberRowHeight = (rowHeight: number) => {
      if (rowHeight <= 0) return terminalRowHeightRef.current;
      if (Math.abs(rowHeight - terminalRowHeightRef.current) >= 0.25) {
        terminalRowHeightRef.current = rowHeight;
      }
      return terminalRowHeightRef.current;
    };

    const getViewport = () => terminalElement.querySelector<HTMLElement>(".xterm-viewport");

    const getRowHeight = () => {
      const canvas = terminalElement.querySelector<HTMLCanvasElement>(".xterm-screen canvas");
      const canvasHeight = canvas?.getBoundingClientRect().height ?? 0;
      if (canvasHeight > 0 && term.rows > 0) return rememberRowHeight(canvasHeight / term.rows);
      return terminalRowHeightRef.current;
    };

    const usesViewerPanFrame = () => {
      return (
        coarsePointerRef.current &&
        displayOwnerRef.current === false &&
        displayGeometryRef.current !== null
      );
    };

    const getTerminalPixelSize = () => {
      const canvas = terminalElement.querySelector<HTMLCanvasElement>(".xterm-screen canvas");
      const canvasRect = canvas?.getBoundingClientRect();
      const elementRect = terminalElement.getBoundingClientRect();
      return {
        width: Math.max(
          1,
          Math.ceil(canvasRect && canvasRect.width > 0 ? canvasRect.width : elementRect.width),
        ),
        height: Math.max(
          1,
          Math.ceil(canvasRect && canvasRect.height > 0 ? canvasRect.height : elementRect.height),
        ),
      };
    };

    const maxFrameScrollLeft = () => {
      return Math.max(0, terminalViewport.scrollWidth - terminalViewport.clientWidth);
    };

    const maxFrameScrollTop = () => {
      return Math.max(0, terminalViewport.scrollHeight - terminalViewport.clientHeight);
    };

    const viewerPanFrameIsAtBottom = () => {
      const maxTop = maxFrameScrollTop();
      return maxTop <= 0 || terminalViewport.scrollTop >= maxTop - 1;
    };

    const layoutTerminalSurface = (pinToBottom = false) => {
      if (!usesViewerPanFrame()) {
        viewerPanFrameActiveRef.current = false;
        terminalSurface.style.width = "100%";
        terminalSurface.style.height = "100%";
        terminalElement.style.width = "100%";
        terminalElement.style.height = "100%";
        terminalViewport.scrollLeft = 0;
        terminalViewport.scrollTop = 0;
        return;
      }

      const wasActive = viewerPanFrameActiveRef.current;
      const shouldPinToBottom = pinToBottom && (!wasActive || viewerPanFrameIsAtBottom());
      viewerPanFrameActiveRef.current = true;
      const size = getTerminalPixelSize();
      terminalSurface.style.width = `${size.width}px`;
      terminalSurface.style.height = `${size.height}px`;
      terminalElement.style.width = `${size.width}px`;
      terminalElement.style.height = `${size.height}px`;

      if (shouldPinToBottom) {
        terminalViewport.scrollTop = maxFrameScrollTop();
      } else {
        terminalViewport.scrollTop = Math.min(terminalViewport.scrollTop, maxFrameScrollTop());
      }
      terminalViewport.scrollLeft = Math.min(terminalViewport.scrollLeft, maxFrameScrollLeft());
    };
    layoutTerminalSurfaceRef.current = layoutTerminalSurface;

    const scrollViewerPanFrame = (deltaX: number, deltaY: number) => {
      if (!usesViewerPanFrame()) return { movedX: false, movedY: false };
      const maxLeft = maxFrameScrollLeft();
      const maxTop = maxFrameScrollTop();
      if (maxLeft <= 0 && maxTop <= 0) return { movedX: false, movedY: false };

      const beforeLeft = terminalViewport.scrollLeft;
      const beforeTop = terminalViewport.scrollTop;
      terminalViewport.scrollLeft = Math.max(0, Math.min(maxLeft, beforeLeft + deltaX));
      terminalViewport.scrollTop = Math.max(0, Math.min(maxTop, beforeTop + deltaY));

      return {
        movedX: Math.abs(terminalViewport.scrollLeft - beforeLeft) >= 0.5,
        movedY: Math.abs(terminalViewport.scrollTop - beforeTop) >= 0.5,
      };
    };

    const scrollTerminalViewportPixels = (deltaY: number) => {
      const viewport = getViewport();
      if (!viewport) return false;
      return scrollElementPixels(viewport, deltaY);
    };

    const maxScrollTop = (viewport: HTMLElement) => {
      return Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    };

    // xterm advances its buffer viewport when output appends at the bottom,
    // but under a slow render frame its native scroll element can remain one
    // or two rows behind. Because this UI renders historical navigation in a
    // separate endpoint-backed overlay, the live terminal must stay pinned to
    // the current PTY tail. Reconcile after xterm consumes a write and
    // coalesce streaming chunks to one refresh per animation frame.
    pinLiveViewportToBottomRef.current = () => {
      if (liveViewportPinFrameRef.current !== null) return;
      liveViewportPinFrameRef.current = requestAnimationFrame(() => {
        if (termRef.current !== term) {
          liveViewportPinFrameRef.current = null;
          return;
        }
        const reconcile = () => {
          term.scrollToBottom();
          const viewport = getViewport();
          if (viewport) viewport.scrollTop = maxScrollTop(viewport);
          term.refresh(0, term.rows - 1);
        };
        reconcile();
        // A native scroll event already queued from the slow frame can run
        // after the first correction and restore the stale scrollTop. Verify
        // once more on the following frame; streaming writes arriving in
        // between are coalesced into this same final reconciliation.
        liveViewportPinFrameRef.current = requestAnimationFrame(() => {
          liveViewportPinFrameRef.current = null;
          if (termRef.current === term) reconcile();
        });
      });
    };

    const alignViewportToRows = () => {
      const viewport = getViewport();
      if (!viewport) return false;
      const rowHeight = getRowHeight();
      const maxTop = maxScrollTop(viewport);
      if (rowHeight <= 0 || maxTop <= 0) return false;

      const snapped = Math.max(
        0,
        Math.min(maxTop, Math.round(viewport.scrollTop / rowHeight) * rowHeight),
      );
      if (Math.abs(snapped - viewport.scrollTop) < 0.5) return false;
      viewport.scrollTop = snapped;
      return true;
    };

    const activeBufferIsAlternate = () => term.buffer.active.type === "alternate";

    const overlayIsAtBottom = (_overlay: HTMLElement) => {
      // Mid-rewrite the buffer is collapsed and everything looks like
      // "bottom"; never close the overlay off that reading.
      if (scrollbackRenderInFlightRef.current) return false;
      const buffer = scrollbackTermRef.current?.buffer.active;
      return buffer ? buffer.viewportY >= buffer.baseY : true;
    };

    let overlayWheelRemainderPx = 0;
    const scrollOverlayPixels = (deltaY: number) => {
      const overlay = getScrollbackViewport();
      const historyTerm = scrollbackTermRef.current;
      if (!overlay || !historyTerm || deltaY === 0) return false;
      // Scrolling the buffer while a rewrite is collapsing it is a lost
      // update; bank the delta and let the render's completion apply it on
      // top of the restored position.
      if (scrollbackRenderInFlightRef.current) {
        scrollbackPendingDeltaPxRef.current += deltaY;
        scrollbackLastUserScrollAtRef.current = Date.now();
        return true;
      }
      // Scroll through xterm's internal line state: raw DOM scrollTop writes
      // race with the viewport syncing xterm performs on concurrent writes.
      healScrollbackScrollState();
      overlayWheelRemainderPx += deltaY;
      const rowHeight = Math.max(1, terminalRowHeightRef.current);
      const lines = Math.trunc(overlayWheelRemainderPx / rowHeight);
      if (lines === 0) return true;
      overlayWheelRemainderPx -= lines * rowHeight;
      const before = historyTerm.buffer.active.viewportY;
      historyTerm.scrollLines(lines);
      const moved = historyTerm.buffer.active.viewportY !== before;
      if (moved) recordScrollbackUserPosition(overlay);
      updateScrollbackReveal(overlay);
      return moved;
    };

    const handleScrollbackOverlayWheel = (amount: number) => {
      const overlay = getScrollbackViewport();
      if (!overlay) {
        requestScrollbackSnapshotRef.current(amount);
        return true;
      }

      if (amount > 0 && overlayIsAtBottom(overlay)) {
        hideScrollbackOverlay();
        return true;
      }

      const moved = scrollOverlayPixels(amount);
      if (moved && amount > 0 && overlayIsAtBottom(overlay)) {
        hideScrollbackOverlay();
      } else if (!moved && (scrollbackTermRef.current?.buffer.active.baseY ?? 0) <= 0) {
        requestScrollbackSnapshotRef.current(amount);
      }
      return true;
    };

    // The overlay receives pointer events directly (text selection, links),
    // so its wheel events no longer reach the live terminal underneath.
    // Route them through the same scrollback logic.
    scrollbackWheelHandlerRef.current = (event) => {
      if (event.ctrlKey) return true;
      const amount = wheelEventToPixels(event, term.rows);
      if (amount === 0) return true;
      handleScrollbackOverlayWheel(amount);
      event.preventDefault();
      event.stopPropagation();
      return false;
    };

    term.attachCustomWheelEventHandler((event) => {
      if (event.ctrlKey) return true;
      const amount = wheelEventToPixels(event, term.rows);
      if (amount === 0) return true;

      if (scrollbackVisibleRef.current) {
        handleScrollbackOverlayWheel(amount);
        event.preventDefault();
        event.stopPropagation();
        return false;
      }

      if (usesViewerPanFrame()) {
        const frameScroll = scrollViewerPanFrame(
          event.shiftKey ? amount : wheelEventToPixelsX(event),
          amount,
        );
        if (frameScroll.movedX || frameScroll.movedY) {
          event.preventDefault();
          event.stopPropagation();
          return false;
        }
      }

      if (amount < 0) {
        requestScrollbackSnapshotRef.current(amount);
        event.preventDefault();
        event.stopPropagation();
        return false;
      }

      if (activeBufferIsAlternate()) {
        event.preventDefault();
        event.stopPropagation();
        return false;
      }

      return true;
    });

    const canScrollViewport = (deltaY: number) => {
      const viewport = getViewport();
      if (!viewport || deltaY === 0) return false;
      const maxTop = maxScrollTop(viewport);
      if (maxTop <= 0) return false;
      return deltaY > 0 ? viewport.scrollTop < maxTop - 0.5 : viewport.scrollTop > 0.5;
    };

    const applyTouchScrollDelta = (deltaX: number, deltaY: number) => {
      const state = touchScrollRef.current;

      if (scrollbackVisibleRef.current) {
        if (deltaY > 0) {
          const overlay = getScrollbackViewport();
          if (overlay && overlayIsAtBottom(overlay)) {
            hideScrollbackOverlay();
            state.scrollRemainderPx = 0;
            return false;
          }
        }
        state.scrollRemainderPx = 0;
        const moved = scrollOverlayPixels(deltaY);
        const overlay = getScrollbackViewport();
        if (moved && deltaY > 0 && overlay && overlayIsAtBottom(overlay)) {
          hideScrollbackOverlay();
        }
        return moved || scrollbackSnapshotInFlightRef.current;
      }

      if (coarsePointerRef.current && usesViewerPanFrame()) {
        const frameScroll = scrollViewerPanFrame(deltaX, deltaY);
        if (frameScroll.movedX || frameScroll.movedY) {
          state.scrollRemainderPx = 0;
          return true;
        }
      }

      if (deltaY < 0) {
        requestScrollbackSnapshotRef.current(deltaY);
        state.openedScrollback = true;
        state.scrollRemainderPx = 0;
        return true;
      }

      if (activeBufferIsAlternate()) {
        state.scrollRemainderPx = 0;
        return true;
      }

      if (!scrollTerminalViewportPixels(deltaY)) {
        state.scrollRemainderPx = 0;
        return canScrollViewport(deltaY);
      }

      state.scrollRemainderPx = 0;
      return true;
    };

    const stopTouchMomentum = () => {
      const state = touchScrollRef.current;
      if (state.momentumFrame !== null) {
        cancelAnimationFrame(state.momentumFrame);
        state.momentumFrame = null;
      }
      state.momentumLastTime = 0;
      state.scrollRemainderPx = 0;
      if (!scrollbackVisibleRef.current && !usesViewerPanFrame()) alignViewportToRows();
    };

    const sendMobilePromptNewline = () => {
      if (
        !rawInputRef.current ||
        mobileReturnModeRef.current !== "newline" ||
        !coarsePointerRef.current
      ) {
        return false;
      }
      lastMobileReturnAtRef.current = performance.now();
      hideScrollbackOverlay();
      socketRef.current.sendBinary(mobileReturnBytesRef.current);
      if (term.textarea) term.textarea.value = "";
      return true;
    };

    const interceptMobileReturn = (event: Event) => {
      if (!sendMobilePromptNewline()) return false;
      event.preventDefault();
      event.stopImmediatePropagation();
      return true;
    };

    const pushTouchSample = (time: number, y: number) => {
      const state = touchScrollRef.current;
      state.samples.push({ time, y });
      const oldest = time - TOUCH_VELOCITY_SAMPLE_MS;
      while (state.samples.length > 2 && state.samples[0] && state.samples[0].time < oldest) {
        state.samples.shift();
      }
    };

    const estimateTouchVelocity = () => {
      const { samples, velocityPxPerMs } = touchScrollRef.current;
      if (samples.length < 2) return velocityPxPerMs;
      const first = samples[0];
      const last = samples[samples.length - 1];
      if (!first || !last) return velocityPxPerMs;
      const elapsed = last.time - first.time;
      if (elapsed <= 0) return velocityPxPerMs;
      return (first.y - last.y) / elapsed;
    };

    const stepTouchMomentum = (time: number) => {
      const state = touchScrollRef.current;
      if (state.active) return;

      if (state.momentumLastTime === 0) {
        state.momentumLastTime = time;
        state.momentumFrame = requestAnimationFrame(stepTouchMomentum);
        return;
      }

      const lastTime = state.momentumLastTime;
      const dt = Math.min(32, Math.max(0, time - lastTime));
      state.momentumLastTime = time;

      const deltaY = state.velocityPxPerMs * dt;
      if (
        Math.abs(state.velocityPxPerMs) < TOUCH_MOMENTUM_STOP_PX_PER_MS ||
        Math.abs(deltaY) < 0.1
      ) {
        stopTouchMomentum();
        return;
      }

      if (!applyTouchScrollDelta(0, deltaY)) {
        stopTouchMomentum();
        return;
      }

      state.velocityPxPerMs *= Math.exp(-dt / TOUCH_MOMENTUM_TIME_CONSTANT_MS);
      state.momentumFrame = requestAnimationFrame(stepTouchMomentum);
    };

    const startTouchScroll = (x: number, y: number, time: number) => {
      stopTouchMomentum();
      touchScrollRef.current.active = true;
      touchScrollRef.current.startX = x;
      touchScrollRef.current.startY = y;
      touchScrollRef.current.lastX = x;
      touchScrollRef.current.lastY = y;
      touchScrollRef.current.lastTime = time;
      touchScrollRef.current.movedPx = 0;
      touchScrollRef.current.velocityPxPerMs = 0;
      touchScrollRef.current.samples = [{ time, y }];
      touchScrollRef.current.pendingTapFocus = false;
      touchScrollRef.current.pointerCaptured = false;
      touchScrollRef.current.scrollRemainderPx = 0;
      touchScrollRef.current.openedScrollback = false;
    };

    const moveTouchScroll = (x: number, y: number, time: number) => {
      const state = touchScrollRef.current;
      if (!state.active) return;

      state.movedPx = Math.max(state.movedPx, Math.hypot(x - state.startX, y - state.startY));
      const deltaX = state.lastX - x;
      const deltaY = state.lastY - y;
      state.lastX = x;
      state.lastY = y;
      if (deltaX === 0 && deltaY === 0) return;

      const dt = Math.max(1, time - state.lastTime);
      state.lastTime = time;
      pushTouchSample(time, y);
      const instantVelocity = deltaY / dt;
      const sampledVelocity = estimateTouchVelocity();
      state.velocityPxPerMs = sampledVelocity * 0.75 + instantVelocity * 0.25;

      applyTouchScrollDelta(deltaX, deltaY);
    };

    const endTouchScroll = () => {
      const state = touchScrollRef.current;
      if (!state.active) return;
      const wasTap = state.movedPx <= TOUCH_TAP_SLOP_PX;
      state.active = false;
      if (wasTap) {
        state.velocityPxPerMs = 0;
        state.samples = [];
        state.scrollRemainderPx = 0;
        state.pendingTapFocus = rawInputRef.current;
        return;
      }
      state.pendingTapFocus = false;
      if (state.openedScrollback) {
        state.openedScrollback = false;
        state.velocityPxPerMs = 0;
        state.samples = [];
        state.scrollRemainderPx = 0;
        return;
      }
      state.velocityPxPerMs = clamp(
        estimateTouchVelocity() * TOUCH_MOMENTUM_BOOST,
        -TOUCH_MOMENTUM_MAX_PX_PER_MS,
        TOUCH_MOMENTUM_MAX_PX_PER_MS,
      );
      state.samples = [];
      if (Math.abs(state.velocityPxPerMs) >= TOUCH_MOMENTUM_MIN_START_PX_PER_MS) {
        state.momentumLastTime = 0;
        state.momentumFrame = requestAnimationFrame(stepTouchMomentum);
      } else {
        state.scrollRemainderPx = 0;
        if (!usesViewerPanFrame()) alignViewportToRows();
      }
    };

    const stopXtermTouchMove = (event: TouchEvent) => {
      if (event.touches.length !== 1) return;
      const state = touchScrollRef.current;
      const touch = event.touches[0];
      if (state.active && touch) {
        const movedPx = Math.hypot(touch.clientX - state.startX, touch.clientY - state.startY);
        if (movedPx <= TOUCH_TAP_SLOP_PX) return;
      }
      if (event.cancelable) event.preventDefault();
      event.stopPropagation();
    };

    const onBeforeInput = (event: InputEvent) => {
      if (event.inputType === "insertLineBreak" || event.inputType === "insertParagraph") {
        interceptMobileReturn(event);
      }
    };

    const onInput = (event: Event) => {
      const textarea = event.currentTarget as HTMLTextAreaElement | null;
      if (!textarea || !/[\r\n]/.test(textarea.value)) return;
      const justSent = performance.now() - lastMobileReturnAtRef.current < 150;
      textarea.value = textarea.value.replaceAll(/\r?\n/g, "");
      if (!justSent) interceptMobileReturn(event);
    };

    let pointerTouchActive = false;
    let lastPointerTouchAt = 0;
    const markPointerTouch = () => {
      lastPointerTouchAt = performance.now();
    };
    const shouldIgnoreFallbackTouch = () => {
      return pointerTouchActive || performance.now() - lastPointerTouchAt < 350;
    };

    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType !== "touch" || !event.isPrimary) return;
      pointerTouchActive = true;
      markPointerTouch();
      touchScrollRef.current.activePointerId = event.pointerId;
      startTouchScroll(event.clientX, event.clientY, event.timeStamp || performance.now());
      try {
        terminalTouchTarget.setPointerCapture(event.pointerId);
        touchScrollRef.current.pointerCaptured = true;
      } catch {
        touchScrollRef.current.pointerCaptured = false;
      }
    };

    const onPointerMove = (event: PointerEvent) => {
      if (
        event.pointerType !== "touch" ||
        touchScrollRef.current.activePointerId !== event.pointerId
      ) {
        return;
      }
      markPointerTouch();
      const events = event.getCoalescedEvents?.() ?? [event];
      for (const e of events) {
        moveTouchScroll(e.clientX, e.clientY, e.timeStamp || performance.now());
      }
      if (touchScrollRef.current.movedPx <= TOUCH_TAP_SLOP_PX) return;
      if (event.cancelable) event.preventDefault();
      event.stopPropagation();
    };

    const onPointerEnd = (event: PointerEvent) => {
      if (
        event.pointerType !== "touch" ||
        touchScrollRef.current.activePointerId !== event.pointerId
      ) {
        return;
      }
      const hadCapture = touchScrollRef.current.pointerCaptured;
      pointerTouchActive = false;
      markPointerTouch();
      touchScrollRef.current.activePointerId = null;
      touchScrollRef.current.pointerCaptured = false;
      if (hadCapture) {
        try {
          terminalTouchTarget.releasePointerCapture(event.pointerId);
        } catch {
          // ignore
        }
      }
      endTouchScroll();
      if (touchScrollRef.current.pendingTapFocus) return;
      if (event.cancelable) event.preventDefault();
      event.stopPropagation();
    };

    const onTouchStart = (event: TouchEvent) => {
      if (shouldIgnoreFallbackTouch()) return;
      if (event.touches.length !== 1) {
        touchScrollRef.current.active = false;
        touchScrollRef.current.velocityPxPerMs = 0;
        touchScrollRef.current.samples = [];
        return;
      }
      const touch = event.touches[0];
      startTouchScroll(
        touch?.clientX ?? 0,
        touch?.clientY ?? 0,
        event.timeStamp || performance.now(),
      );
    };

    const onTouchMove = (event: TouchEvent) => {
      if (shouldIgnoreFallbackTouch()) {
        stopXtermTouchMove(event);
        return;
      }
      const touch = event.touches[0];
      if (!touch || event.touches.length !== 1) return;
      moveTouchScroll(touch.clientX, touch.clientY, event.timeStamp || performance.now());
      if (touchScrollRef.current.movedPx <= TOUCH_TAP_SLOP_PX) return;
      if (event.cancelable) event.preventDefault();
      event.stopPropagation();
    };

    const onTouchEnd = () => {
      if (shouldIgnoreFallbackTouch()) return;
      endTouchScroll();
    };

    const onClick = (event: MouseEvent) => {
      if (!touchScrollRef.current.pendingTapFocus) return;
      touchScrollRef.current.pendingTapFocus = false;
      hideScrollbackOverlay();
      term.focus();
      event.preventDefault();
      event.stopPropagation();
    };

    term.attachCustomKeyEventHandler((event) => {
      if (event.key !== "Enter" && event.key !== "Return") return true;
      // Plain terminals can't distinguish Shift+Enter from Enter; send the
      // ESC+CR sequence TUIs like Claude Code bind to "insert newline" (the
      // same mapping their /terminal-setup installs in iTerm/VS Code).
      // Suppress EVERY event of the press, not just keydown: returning false
      // does not preventDefault, so the browser still fires keypress for the
      // same Enter and xterm's keypress path would emit a plain \r right
      // after our sequence — newline followed by an accidental submit.
      if (event.shiftKey && rawInputRef.current) {
        if (event.type === "keydown") {
          event.preventDefault();
          hideScrollbackOverlay();
          // Also mute the textarea input fallback (virtual keyboards) for
          // this press so it cannot double-send.
          lastMobileReturnAtRef.current = performance.now();
          socketRef.current.sendBinary(ALT_ENTER);
        }
        return false;
      }
      if (event.type !== "keydown") return true;
      return !interceptMobileReturn(event);
    });
    term.textarea?.addEventListener("beforeinput", onBeforeInput, { capture: true });
    term.textarea?.addEventListener("input", onInput, { capture: true });

    const copyLiveSelectionOnMouseUp = () => {
      const selection = term.getSelection();
      if (!selection) return;
      void navigator.clipboard?.writeText(selection).catch(() => {});
    };
    terminalElement.addEventListener("mouseup", copyLiveSelectionOnMouseUp);

    // The scrollback overlay accepts pointer events for text selection and
    // links, so the touch-scroll machinery must listen there too — touch
    // events over the visible overlay no longer reach the live viewport.
    const touchTargets: HTMLElement[] = scrollbackOverlayRef.current
      ? [terminalTouchTarget, scrollbackOverlayRef.current]
      : [terminalTouchTarget];
    const usePointerEvents = window.PointerEvent !== undefined;
    for (const target of touchTargets) {
      target.addEventListener("click", onClick, { capture: true });
      if (usePointerEvents) {
        target.addEventListener("pointerdown", onPointerDown, {
          capture: true,
          passive: false,
        });
        target.addEventListener("pointermove", onPointerMove, {
          capture: true,
          passive: false,
        });
        target.addEventListener("pointerup", onPointerEnd, { capture: true });
        target.addEventListener("pointercancel", onPointerEnd, { capture: true });
        target.addEventListener("lostpointercapture", onPointerEnd, { capture: true });
      }
      target.addEventListener("touchstart", onTouchStart, {
        capture: true,
        passive: true,
      });
      target.addEventListener("touchmove", onTouchMove, {
        capture: true,
        passive: false,
      });
      target.addEventListener("touchend", onTouchEnd, { capture: true });
      target.addEventListener("touchcancel", onTouchEnd, { capture: true });
    }

    const captureScrollAnchor = (): ScrollAnchor => {
      const buffer = term.buffer.active;
      return {
        viewportY: buffer.viewportY,
        atBottom: buffer.viewportY >= buffer.baseY,
      };
    };

    const restoreScrollAnchor = (anchor: ScrollAnchor) => {
      if (anchor.atBottom) {
        term.scrollToBottom();
      } else {
        const baseY = term.buffer.active.baseY;
        term.scrollToLine(Math.max(0, Math.min(baseY, anchor.viewportY)));
      }
      alignViewportToRows();
    };

    const notifyResizeIfChanged = () => {
      const { cols, rows } = term;
      if (!socketStartedRef.current) {
        socketStartedRef.current = true;
        lastSizeRef.current = { cols, rows };
        setSocketInitialSize({ cols, rows });
        return;
      }
      const last = lastSizeRef.current;
      if (cols === last.cols && rows === last.rows) return;
      lastSizeRef.current = { cols, rows };
      invalidateScrollbackForResizeRef.current();
      markResizeSentRef.current(cols, rows);
      if (displayOwnerRef.current === true) {
        socketRef.current.sendJson({ type: "resize", cols, rows });
      }
      // History already written into the live buffer keeps its old wrap after
      // a width change. Once a fresh offset-anchored checkpoint arrives,
      // rewrite the live buffer so history reflows at the new width too.
      historyReseedPendingRef.current = true;
    };

    const fitTerminal = (preserveScroll: boolean) => {
      // Parked (background) instance: never fit or resize. Its host may be in
      // an offscreen park at a different size; fitting would churn the PTY
      // geometry and disturb whoever is actually looking at this agent. It
      // reclaims + fits when re-activated (see the `active` effect).
      if (!activeRef.current) return;
      const anchor = preserveScroll ? captureScrollAnchor() : null;
      const followerGeometry =
        coarsePointerRef.current && displayOwnerRef.current === false
          ? displayGeometryRef.current
          : null;
      if (followerGeometry) {
        const last = lastSizeRef.current;
        try {
          term.resize(followerGeometry.cols, followerGeometry.rows);
        } catch {
          return;
        }
        lastSizeRef.current = followerGeometry;
        if (followerGeometry.cols !== last.cols || followerGeometry.rows !== last.rows) {
          invalidateScrollbackForResizeRef.current();
        }
        layoutTerminalSurface(anchor?.atBottom ?? true);
        requestAnimationFrame(() => layoutTerminalSurface(anchor?.atBottom ?? true));
        if (anchor) {
          restoreScrollAnchor(anchor);
          requestAnimationFrame(() => restoreScrollAnchor(anchor));
        } else {
          if (!usesViewerPanFrame()) alignViewportToRows();
        }
        return;
      }
      layoutTerminalSurface(false);
      try {
        fit.fit();
      } catch {
        return;
      }
      layoutTerminalSurface(false);
      if (anchor) {
        restoreScrollAnchor(anchor);
        requestAnimationFrame(() => restoreScrollAnchor(anchor));
      } else {
        alignViewportToRows();
      }
      notifyResizeIfChanged();
    };
    fitTerminalRef.current = fitTerminal;

    // Initial fit + resize notification.
    requestAnimationFrame(() => {
      fitTerminal(false);
    });

    // Container resize -> refit -> tell server.
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleFit = () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        resizeTimer = null;
        requestAnimationFrame(() => fitTerminal(true));
      }, 80);
    };

    const ro = new ResizeObserver(() => {
      scheduleFit();
    });
    ro.observe(terminalViewport);

    // ResizeObserver only fires on size changes; two mount-time races leave
    // the terminal misfitted at a stable size until something (like toggling
    // the sidebar) nudges the container: the monospace font finishing its
    // load after the initial fit measured fallback-font cell metrics, and a
    // background tab's throttled layout settling only on refocus.
    const onVisibility = () => {
      if (document.visibilityState === "visible") scheduleFit();
    };
    document.addEventListener("visibilitychange", onVisibility);
    document.fonts?.ready
      .then(() => {
        scheduleFit();
      })
      .catch(() => {});

    return () => {
      ro.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      term.attachCustomKeyEventHandler(() => true);
      term.textarea?.removeEventListener("beforeinput", onBeforeInput, { capture: true });
      term.textarea?.removeEventListener("input", onInput, { capture: true });
      terminalElement.removeEventListener("mouseup", copyLiveSelectionOnMouseUp);
      for (const target of touchTargets) {
        target.removeEventListener("click", onClick, { capture: true });
        if (usePointerEvents) {
          target.removeEventListener("pointerdown", onPointerDown, { capture: true });
          target.removeEventListener("pointermove", onPointerMove, { capture: true });
          target.removeEventListener("pointerup", onPointerEnd, { capture: true });
          target.removeEventListener("pointercancel", onPointerEnd, { capture: true });
          target.removeEventListener("lostpointercapture", onPointerEnd, {
            capture: true,
          });
        }
        target.removeEventListener("touchstart", onTouchStart, { capture: true });
        target.removeEventListener("touchmove", onTouchMove, { capture: true });
        target.removeEventListener("touchend", onTouchEnd, { capture: true });
        target.removeEventListener("touchcancel", onTouchEnd, { capture: true });
      }
      scrollbackWheelHandlerRef.current = () => true;
      stopTouchMomentum();
      if (resizeTimer) clearTimeout(resizeTimer);
      onDataDisposableRef.current?.dispose();
      if (uploadStatusTimerRef.current) clearTimeout(uploadStatusTimerRef.current);
      if (liveViewportPinFrameRef.current !== null) {
        cancelAnimationFrame(liveViewportPinFrameRef.current);
        liveViewportPinFrameRef.current = null;
      }
      pendingLiveSeedWritesRef.current.clear();
      liveSeedCoveredOffsetRef.current = null;
      liveSeedWriteInFlightRef.current = false;
      latencyHudRef.current?.detach();
      latencyHudRef.current = null;
      if (predictionSweepRef.current) {
        clearTimeout(predictionSweepRef.current);
        predictionSweepRef.current = null;
      }
      predictorRef.current.clear();
      webglAddonRef.current?.dispose();
      webglAddonRef.current = null;
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      fitTerminalRef.current = () => {};
      layoutTerminalSurfaceRef.current = () => {};
      pinLiveViewportToBottomRef.current = () => {};
    };
    // Bootstrap effect: deliberately runs once on mount; the socket is read
    // through `socketRef`, so it doesn't need to be in deps.
  }, [
    getScrollbackViewport,
    healScrollbackScrollState,
    hideScrollbackOverlay,
    recordScrollbackUserPosition,
    updateScrollbackReveal,
  ]);

  const uploadImages = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      showUploadStatus(
        files.length === 1 ? "Uploading image..." : `Uploading ${files.length} images...`,
      );
      let sent = 0;
      for (const file of files) {
        if (file.size > MAX_UPLOAD_BYTES) {
          showUploadStatus(`${file.name || "Image"} is larger than 20 MB.`);
          continue;
        }
        const clientId = makeClientId();
        const controller = new AbortController();
        const previewUrl = URL.createObjectURL(file);
        updatePendingAttachments((attachments) => [
          ...attachments,
          {
            id: clientId,
            name: file.name || defaultImageName(file),
            previewUrl,
            promptText: null,
            status: "uploading",
            controller,
          },
        ]);
        try {
          reserveUploadReconciliation(clientId, file.name || "Image");
          const result = await socket.uploadFile(file, {
            uploadId: clientId,
            name: file.name || defaultImageName(file),
            mimeType: mimeTypeForFile(file),
            destination: "attachments",
            signal: controller.signal,
            beforeUploadStart: () => assertUploadReconciliation(clientId),
            beforeFinalDispatch: () =>
              promoteUploadReconciliation(
                clientId,
                file.name || "Image",
                "The final upload frame was dispatched without a durable acknowledgement yet.",
              ),
          });
          dismissUploadReconciliation(clientId);
          if (controller.signal.aborted) continue;
          sent += 1;
          handleUploadSaved(result.path, result.uploadId);
        } catch (error) {
          const outcomeUnknown =
            error instanceof DirectAgentUploadError && error.code === "outcome_unknown";
          // Removing an attachment is silent only while cancellation still
          // proves there was no endpoint effect. Once the final chunk was
          // dispatched, the same abort can race publication; keep the removed
          // attachment gone, but retain the reconciliation warning.
          if (controller.signal.aborted && !outcomeUnknown) {
            dismissUploadReconciliation(clientId);
            continue;
          }
          const message =
            error instanceof Error && error.message
              ? error.message
              : `${file.name || "Image"} could not be uploaded.`;
          if (outcomeUnknown) {
            try {
              promoteUploadReconciliation(clientId, file.name || "Image", message);
            } catch {
              // The pre-final record remains in the same-window fallback and
              // the storage fault keeps all further endpoint effects locked.
            }
          } else if (error instanceof UploadReconciliationBlockedError) {
            showUploadStatus(message);
          } else {
            dismissUploadReconciliation(clientId);
            showUploadStatus(message);
          }
          updatePendingAttachments((attachments) =>
            attachments.map((attachment) =>
              attachment.id === clientId ? { ...attachment, status: "error" } : attachment,
            ),
          );
        }
      }
      if (sent > 0) {
        termRef.current?.focus();
      }
    },
    [
      handleUploadSaved,
      assertUploadReconciliation,
      dismissUploadReconciliation,
      promoteUploadReconciliation,
      reserveUploadReconciliation,
      showUploadStatus,
      socket,
      updatePendingAttachments,
    ],
  );

  const uploadFilesToCwd = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      showUploadStatus(
        files.length === 1 ? "Uploading file..." : `Uploading ${files.length} files...`,
      );
      let sent = 0;
      for (const file of files) {
        if (file.size > MAX_UPLOAD_BYTES) {
          showUploadStatus(`${file.name || "File"} is larger than 20 MB.`);
          continue;
        }
        const uploadId = makeClientId();
        try {
          reserveUploadReconciliation(uploadId, file.name || "File");
          const result = await socket.uploadFile(file, {
            uploadId,
            destination: "cwd",
            name: file.name || "file",
            mimeType: mimeTypeForUpload(file),
            beforeUploadStart: () => assertUploadReconciliation(uploadId),
            beforeFinalDispatch: () =>
              promoteUploadReconciliation(
                uploadId,
                file.name || "File",
                "The final upload frame was dispatched without a durable acknowledgement yet.",
              ),
          });
          dismissUploadReconciliation(uploadId);
          sent += 1;
          showUploadStatus(`Uploaded ${compactPath(result.path)}`);
        } catch (error) {
          const message =
            error instanceof Error && error.message
              ? error.message
              : `${file.name || "File"} could not be uploaded.`;
          if (error instanceof DirectAgentUploadError && error.code === "outcome_unknown") {
            try {
              promoteUploadReconciliation(uploadId, file.name || "File", message);
            } catch {
              // Preserve the already-recorded ambiguity and storage lock.
            }
          } else if (error instanceof UploadReconciliationBlockedError) {
            showUploadStatus(message);
          } else {
            dismissUploadReconciliation(uploadId);
            showUploadStatus(message);
          }
        }
      }
      if (sent > 0) {
        termRef.current?.focus();
      }
    },
    [
      dismissUploadReconciliation,
      assertUploadReconciliation,
      promoteUploadReconciliation,
      reserveUploadReconciliation,
      showUploadStatus,
      socket,
    ],
  );

  const pasteFromClipboard = useCallback(async () => {
    const clipboard = navigator.clipboard;
    if (!clipboard) {
      showUploadStatus(clipboardBlockedMessage());
      termRef.current?.focus();
      return;
    }

    let readError = false;

    if (typeof clipboard.read === "function") {
      try {
        const items = await clipboard.read();
        const files: File[] = [];
        let text = "";

        for (const item of items) {
          const imageType = item.types.find((type) => type.startsWith("image/"));
          if (imageType) {
            const blob = await item.getType(imageType);
            files.push(
              new File([blob], defaultClipboardImageName(imageType), {
                type: imageType,
              }),
            );
            continue;
          }

          if (!text && item.types.includes("text/plain")) {
            text = await (await item.getType("text/plain")).text();
          }
        }

        if (files.length > 0) {
          await uploadImages(files);
          return;
        }

        if (text) {
          termRef.current?.paste(text);
          termRef.current?.focus();
          return;
        }
      } catch {
        readError = true;
      }
    }

    try {
      const text = typeof clipboard.readText === "function" ? await clipboard.readText() : "";
      if (text) {
        termRef.current?.paste(text);
        termRef.current?.focus();
        return;
      }

      showUploadStatus(readError ? clipboardBlockedMessage() : "Clipboard is empty.");
      termRef.current?.focus();
    } catch {
      showUploadStatus(clipboardBlockedMessage());
      termRef.current?.focus();
    }
  }, [showUploadStatus, uploadImages]);

  const pasteText = useCallback((text: string) => {
    if (!text) return;
    termRef.current?.paste(text);
    termRef.current?.focus();
  }, []);

  const pasteDataTransfer = useCallback(
    (data: DataTransfer) => {
      const files = imageFilesFromDataTransfer(data);
      if (files.length > 0) {
        void uploadImages(files);
        return;
      }

      pasteText(data.getData("text/plain") || data.getData("text"));
    },
    [pasteText, uploadImages],
  );

  // Wire raw keystrokes to the socket only when rawInput is enabled.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    onDataDisposableRef.current?.dispose();
    onDataDisposableRef.current = null;
    if (!rawInput) return;
    const enc = new TextEncoder();
    onDataDisposableRef.current = term.onData((d) => {
      hideScrollbackOverlay();
      const filtered = stripDeviceAttributeResponses(d);
      const mapped = rewriteMobileReturn(
        filtered,
        mobileReturnModeRef.current,
        coarsePointerRef.current,
        mobileReturnBytesRef.current,
      );
      if (mapped !== filtered) lastMobileReturnAtRef.current = performance.now();
      const withAttachments = appendAttachmentsForSubmit(mapped);
      if (withAttachments) socket.sendBinary(enc.encode(withAttachments));
      if (latencyHudRef.current && withAttachments === d && /^[\x20-\x7e]$/.test(d)) {
        latencyHudRef.current.noteKeystroke(performance.now());
      }
      // Predictive echo is opt-in (localStorage.spawnPredictEcho = "on"):
      // below ~30ms RTT the overlay flashes for a frame or two without
      // buying perceptible snappiness. It earns its keep on high-RTT links
      // (mobile, remote networks). Predict only pristine keystrokes against
      // a settled buffer — mid-seed the cursor is wherever the rewrite walk
      // happens to be, so an anchor read then is garbage.
      if (
        withAttachments === d &&
        !liveSeedWriteInFlightRef.current &&
        localStorage.getItem("spawnPredictEcho") === "on"
      ) {
        const buffer = term.buffer.active;
        const predicted = predictorRef.current.predict(
          d,
          { row: buffer.baseY + buffer.cursorY, col: buffer.cursorX },
          term.cols,
          performance.now(),
        );
        if (predicted) schedulePredictionSweep();
        if (predicted || predictorRef.current.pendingText.length === 0) {
          syncPredictionOverlayRef.current();
        }
      }
    });
    return () => {
      onDataDisposableRef.current?.dispose();
      onDataDisposableRef.current = null;
    };
  }, [
    appendAttachmentsForSubmit,
    hideScrollbackOverlay,
    rawInput,
    socket,
    schedulePredictionSweep,
  ]);

  // Resend the last known size on (re)connection so the daemon's PTY matches.
  useEffect(() => {
    if (socket.state === "open" && displayOwnerRef.current === true) {
      const { cols, rows } = lastSizeRef.current;
      socket.sendJson({ type: "resize", cols, rows });
    }
  }, [socket.state, socket.sendJson]);

  useImperativeHandle(
    ref,
    () => ({
      sendInput: (data) => {
        hideScrollbackOverlay();
        socket.sendBinary(data);
      },
      resize: (cols, rows) => {
        const last = lastSizeRef.current;
        lastSizeRef.current = { cols, rows };
        if (cols !== last.cols || rows !== last.rows) {
          invalidateScrollbackForResizeRef.current();
        }
        if (displayOwnerRef.current === true) {
          socket.sendJson({ type: "resize", cols, rows });
        } else {
          socket.sendJson({ type: "take_control", cols, rows });
        }
      },
      fit: () => {
        fitTerminalRef.current(true);
      },
      getSize: () => lastSizeRef.current,
      refreshDiagnostics: async () => {
        const capture = () => {
          const term = termRef.current;
          const host = terminalViewportRef.current;
          const hostRect = host?.getBoundingClientRect();
          const screenRect = host?.querySelector(".xterm-screen")?.getBoundingClientRect();
          const buf = term?.buffer.active;
          const tail: string[] = [];
          if (term && buf) {
            const start = Math.max(0, buf.baseY - 5);
            for (let i = start; i < buf.baseY + term.rows; i += 1) {
              tail.push(buf.getLine(i)?.translateToString(true) ?? "");
            }
          }
          // What the user is actually looking at — decided from ground truth,
          // not a single boolean that can flip in the instant before the
          // click. In priority order:
          //   1. overlay genuinely on-screen and scrolled up  -> its live rows
          //   2. overlay just closed, but the reader was scrolled up a moment
          //      ago                                          -> remembered rows
          //      (the overlay buffer resets to the live edge on close, so it
          //      can't be recovered from there — hence lastScrolledViewRef)
          //   3. the live terminal is itself scrolled up      -> its rows
          //   4. otherwise                                    -> the live edge
          const overlayOnScreen = scrollbackOverlayRef.current?.style.visibility === "visible";
          const historyTerm = scrollbackTermRef.current;
          const historyBuf = historyTerm?.buffer.active;
          const overlayScrolledUp =
            !!historyBuf && historyBuf.baseY > 0 && historyBuf.viewportY < historyBuf.baseY;
          const liveScrolledUp = !!buf && buf.viewportY < buf.baseY;
          const remembered = lastScrolledViewRef.current;
          const rememberedAgeMs = remembered ? Date.now() - remembered.at : null;
          const rememberedFresh = rememberedAgeMs !== null && rememberedAgeMs < 12_000;
          const rowsFrom = (t: XTerm, b: NonNullable<typeof buf>) => {
            const out: string[] = [];
            for (let i = 0; i < t.rows; i += 1) {
              out.push(b.getLine(b.viewportY + i)?.translateToString(true) ?? "");
            }
            return out;
          };
          let viewSource: string;
          let visibleRows: string[] = [];
          if (overlayOnScreen && overlayScrolledUp && historyTerm && historyBuf) {
            viewSource = "scrollback-overlay";
            visibleRows = rowsFrom(historyTerm, historyBuf);
          } else if (!overlayOnScreen && rememberedFresh && remembered) {
            viewSource = "scrollback-overlay-recent";
            visibleRows = remembered.rows;
          } else if (liveScrolledUp && term && buf) {
            viewSource = "live-scrolled";
            visibleRows = rowsFrom(term, buf);
          } else {
            viewSource = "live";
            if (term && buf) visibleRows = rowsFrom(term, buf);
          }
          return {
            at: new Date().toISOString(),
            term: term ? { cols: term.cols, rows: term.rows } : null,
            lastSize: { ...lastSizeRef.current },
            viewSource,
            visibleRows,
            hostRect: hostRect
              ? { w: Math.round(hostRect.width), h: Math.round(hostRect.height) }
              : null,
            screenRect: screenRect
              ? { w: Math.round(screenRect.width), h: Math.round(screenRect.height) }
              : null,
            buffer: buf
              ? {
                  type: buf.type,
                  baseY: buf.baseY,
                  viewportY: buf.viewportY,
                  length: buf.length,
                }
              : null,
            displayOwner: displayOwnerRef.current,
            socketState: socketRef.current.state,
            dcActive: dcActiveRef.current,
            exactStream: exactStreamRef.current,
            overlay: {
              // flagVisible is the transient ref; onScreen is the DOM truth.
              // If they disagree, the flag raced the click.
              flagVisible: scrollbackVisibleRef.current,
              onScreen: overlayOnScreen,
              scrolledUp: overlayScrolledUp,
              buffer: historyBuf
                ? {
                    viewportY: historyBuf.viewportY,
                    baseY: historyBuf.baseY,
                    length: historyBuf.length,
                  }
                : null,
              sinceLastScrollMs: scrollbackLastUserScrollAtRef.current
                ? Date.now() - scrollbackLastUserScrollAtRef.current
                : null,
              rememberedAgeMs,
              cacheDirty: scrollbackCacheDirtyRef.current,
              reseedPending: historyReseedPendingRef.current,
              renderInFlight: scrollbackRenderInFlightRef.current,
            },
            fonts: document.fonts?.status ?? "unknown",
            dpr: window.devicePixelRatio,
            viewport: { w: window.innerWidth, h: window.innerHeight },
            visibility: document.visibilityState,
            // Recent resize->repaint latencies (ms): toFirstByte is the app's
            // first response, toSettle is when the repaint burst went quiet.
            resizeTimings: resizeTimingsRef.current.slice(-12),
            tail,
          };
        };
        const before = capture();
        // A refresh heals the frame; it must NOT yank the reader's viewport.
        // Drop the remembered scroll so the post-heal `after` snapshot reports
        // the healed state rather than replaying the old position.
        lastScrolledViewRef.current = null;
        fitTerminalRef.current(true);
        if (displayOwnerRef.current === true) {
          const { cols, rows } = lastSizeRef.current;
          socketRef.current.sendJson({ type: "resize", cols, rows });
        }
        if (scrollbackVisibleRef.current) {
          // Scrolled up: re-render the overlay in place from a fresh capture.
          // Never rewrite the live buffer under an open overlay.
          invalidateScrollbackForResizeRef.current();
          await new Promise((resolve) => setTimeout(resolve, 2200));
        } else {
          // At the live edge: drive a fresh authoritative reseed to
          // convergence. The reseed only applies a snapshot that lands "clean"
          // (no live bytes since it was requested), so without a PTY offset
          // anchor a single 5s-debounced
          // request almost never lands inside the window, and the panel looks
          // unrefreshed until a manual scroll. Keep requesting promptly until
          // one converges (or we give up); only clean snapshots apply, so this
          // can never roll the live terminal back.
          historyReseedPendingRef.current = true;
          const deadline = Date.now() + 6000;
          while (
            historyReseedPendingRef.current &&
            !scrollbackVisibleRef.current &&
            socketRef.current.state === "open" &&
            Date.now() < deadline
          ) {
            if (!scrollbackSnapshotInFlightRef.current) {
              scrollbackCacheDirtyRef.current = true;
              requestSnapshotRef.current("cache");
            }
            await new Promise((resolve) => setTimeout(resolve, 300));
          }
        }
        const after = capture();
        return {
          kind: "terminal-refresh-diagnostics",
          agentId,
          userAgent: navigator.userAgent,
          before,
          after,
        };
      },
      uploadFile: async (file, options) => {
        const uploadId = options?.uploadId ?? makeClientId();
        const fileName = file.name || "file";
        try {
          reserveUploadReconciliation(uploadId, fileName);
          const result = await socket.uploadFile(file, {
            name: fileName,
            mimeType: mimeTypeForUpload(file),
            destination: options?.destination ?? "attachments",
            uploadId,
            beforeUploadStart: () => assertUploadReconciliation(uploadId),
            beforeFinalDispatch: () =>
              promoteUploadReconciliation(
                uploadId,
                fileName,
                "The final upload frame was dispatched without a durable acknowledgement yet.",
              ),
          });
          dismissUploadReconciliation(uploadId);
          return { path: result.path, uploadId: result.uploadId };
        } catch (error) {
          if (error instanceof DirectAgentUploadError && error.code === "outcome_unknown") {
            try {
              promoteUploadReconciliation(uploadId, fileName, error.message);
            } catch {
              // Preserve the already-recorded ambiguity and storage lock.
            }
          } else if (!(error instanceof UploadReconciliationBlockedError)) {
            dismissUploadReconciliation(uploadId);
          }
          throw error;
        }
      },
      focus: () => termRef.current?.focus(),
      submit: () => {
        hideScrollbackOverlay();
        socket.sendBinary(appendAttachmentsForSubmit("\r"));
        termRef.current?.focus();
      },
      pasteFromClipboard,
      pasteDataTransfer,
      pasteText,
      takeControl: () => takeControlNowRef.current(),
      openUpload: () => fileInputRef.current?.click(),
    }),
    [
      appendAttachmentsForSubmit,
      assertUploadReconciliation,
      dismissUploadReconciliation,
      hideScrollbackOverlay,
      pasteDataTransfer,
      pasteFromClipboard,
      pasteText,
      promoteUploadReconciliation,
      reserveUploadReconciliation,
      socket,
      agentId,
    ],
  );

  const onDragEnter = (event: DragEvent<HTMLDivElement>) => {
    if (!hasFileTransfer(event.dataTransfer)) return;
    event.preventDefault();
    dragDepthRef.current += 1;
    setDropActive(true);
  };

  const onPasteCapture = (event: ClipboardEvent<HTMLDivElement>) => {
    const files = imageFilesFromDataTransfer(event.clipboardData);
    if (files.length === 0) return;
    event.preventDefault();
    pasteDataTransfer(event.clipboardData);
  };

  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!hasFileTransfer(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    const files = filesFromDataTransfer(event.dataTransfer);
    if (files.length === 0) return;
    event.preventDefault();
    dragDepthRef.current = 0;
    setDropActive(false);
    // Dropped images feed the prompt like a local terminal drop (attachment
    // chip / pasted path per agent kind); only non-image files take the
    // save-to-working-directory path, keeping plain uploads intentional.
    const images = files.filter(isImageFile);
    const others = files.filter((file) => !isImageFile(file));
    if (images.length > 0) void uploadImages(images);
    if (others.length > 0) void uploadFilesToCwd(others);
  };

  const onFileInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    void uploadFilesToCwd(files);
  };

  const onDragLeave = (event: DragEvent<HTMLDivElement>) => {
    if (!hasFileTransfer(event.dataTransfer)) return;
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDropActive(false);
  };

  return (
    <div
      role="application"
      aria-label="Agent terminal"
      className="relative size-full touch-none bg-[var(--color-terminal-bg)]"
      onPasteCapture={onPasteCapture}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div
        ref={terminalViewportRef}
        className="absolute inset-0 overflow-hidden touch-none bg-[var(--color-terminal-bg)]"
        style={{
          overscrollBehavior: "contain",
          scrollbarWidth: "none",
        }}
      >
        <div
          ref={terminalSurfaceRef}
          className="relative size-full min-h-full min-w-full bg-[var(--color-terminal-bg)]"
        >
          <div
            ref={containerRef}
            data-testid="terminal-live-host"
            className="size-full touch-none"
          />
          {/* Predictive local echo: unconfirmed keystrokes render here at the
              cursor until the authoritative echo confirms them. Dotted
              underline marks them as provisional, mosh-style. */}
          <div
            ref={predictionOverlayRef}
            data-testid="terminal-prediction-overlay"
            aria-hidden
            className="pointer-events-none absolute left-0 top-0 z-[5]"
            style={{
              display: "none",
              fontFamily: TERMINAL_FONT_FAMILY,
              fontSize: `${TERMINAL_FONT_SIZE}px`,
              whiteSpace: "pre",
              color: "#e5e5e5",
              opacity: 0.75,
              textDecoration: "underline dotted",
              textUnderlineOffset: "3px",
            }}
          />
        </div>
      </div>
      <div
        ref={scrollbackOverlayRef}
        data-testid="terminal-scrollback-overlay"
        aria-hidden={!scrollbackVisible}
        className="pointer-events-auto absolute inset-0 z-10 touch-none bg-[var(--color-terminal-bg)] text-[#e5e5e5]"
        style={{
          visibility: scrollbackVisible && scrollbackReady ? "visible" : "hidden",
        }}
      >
        <div
          ref={scrollbackTerminalHostRef}
          className="size-full touch-none"
          style={{
            WebkitOverflowScrolling: "touch",
            overscrollBehavior: "contain",
          }}
        />
      </div>
      {(uploadReconciliations.length > 0 || uploadReconciliationFault) && (
        <div
          data-testid="upload-reconciliation"
          role="alert"
          className="pointer-events-auto absolute left-2 top-2 z-40 flex max-w-[min(32rem,calc(100%-1rem))] flex-col gap-2 rounded-md border border-amber-500/60 bg-background/95 p-2 text-xs text-foreground shadow-lg backdrop-blur"
        >
          {uploadReconciliationFault && (
            <div data-testid="upload-reconciliation-fault" className="font-medium text-amber-700">
              {uploadReconciliationFault} New uploads are locked until storage recovers
              {uploadReconciliations.length > 0
                ? " and you dismiss the retained record after checking it."
                : "."}
            </div>
          )}
          {uploadReconciliations.map((record) => (
            <div key={record.uploadId} className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="min-w-0 flex-1">
                {record.phase === "outcome_unknown" ? (
                  <>
                    <strong>{record.fileName}</strong> may have been published. Check the endpoint
                    destination before retrying; this upload will not retry automatically.
                  </>
                ) : (
                  <>
                    <strong>{record.fileName}</strong> was reserved but its final frame was not
                    dispatched. Check the endpoint before clearing this safety lock.
                  </>
                )}
              </span>
              <button
                type="button"
                className="rounded border border-border bg-card px-2 py-1 hover:bg-accent"
                onClick={() => termRef.current?.focus()}
              >
                Check in terminal
              </button>
              <button
                type="button"
                className="rounded border border-border bg-card px-2 py-1 hover:bg-accent"
                aria-label={`Dismiss ${record.fileName} after checking`}
                title={record.message}
                onClick={() => dismissUploadReconciliation(record.uploadId, true)}
              >
                I checked — dismiss
              </button>
            </div>
          ))}
        </div>
      )}
      {pendingAttachments.length > 0 && (
        <div className="pointer-events-auto absolute bottom-2 left-2 z-20 flex max-w-[calc(100%-1rem)] gap-2 overflow-x-auto rounded-md border border-border bg-background/90 p-1 shadow-lg backdrop-blur">
          {pendingAttachments.map((attachment) => (
            <div
              key={attachment.id}
              className="relative h-14 w-14 shrink-0 overflow-hidden rounded border border-border bg-card"
              title={attachment.name}
            >
              <Image
                src={attachment.previewUrl}
                alt={attachment.name}
                fill
                unoptimized
                sizes="56px"
                className="object-cover"
              />
              {attachment.status !== "ready" && (
                <div className="absolute inset-0 grid place-items-center bg-black/55 text-[9px] uppercase text-white">
                  {attachment.status === "uploading" ? "..." : "err"}
                </div>
              )}
              <button
                type="button"
                aria-label={`Remove ${attachment.name}`}
                className="absolute right-0.5 top-0.5 grid size-5 place-items-center rounded bg-black/70 text-xs text-white"
                onClick={() => removePendingAttachment(attachment.id)}
              >
                x
              </button>
            </div>
          ))}
        </div>
      )}
      {dropActive && (
        <div className="pointer-events-none absolute inset-0 z-20 grid place-items-center border-2 border-dashed border-primary/70 bg-background/35 backdrop-blur-[1px]">
          <div className="rounded-md border border-border bg-card/95 px-3 py-2 text-sm text-foreground shadow-lg">
            Drop images into the prompt &middot; other files save to the working directory
          </div>
        </div>
      )}
      {/* Upload is triggered from the surface header (openUpload on the
          handle); the picker input stays here since the file logic lives in
          the terminal. Drag-and-drop onto the terminal still works. */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={onFileInputChange}
      />
      {/* Viewer mode: another session owns the shared display. Dim the
          terminal (output stays visible underneath) and put take-control
          front and center; input is blocked until control is claimed. */}
      {controlState && !controlState.owner && (
        <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-2.5 bg-background/60 backdrop-blur-[1px]">
          <span className="rounded bg-black/50 px-2 py-0.5 text-xs text-muted-foreground">
            Another session has control
            {typeof controlState.cols === "number" && typeof controlState.rows === "number"
              ? ` · ${controlState.cols}x${controlState.rows}`
              : ""}
            {controlState.viewers > 1 ? ` · ${controlState.viewers} viewers` : ""}
          </span>
          <button
            type="button"
            onClick={() => takeControlNow()}
            className="rounded-lg border border-border bg-popover px-4 py-2 text-sm font-medium shadow-lg shadow-black/40 transition-colors hover:bg-accent"
          >
            Take control
          </button>
        </div>
      )}
      {/* Live region stays mounted so screen readers hear transitions; the
          visible chip only appears when there is something worth saying —
          a healthy "open" connection is the norm, not news. */}
      <div
        className={
          socket.state !== "open" || channelPending || exitBanner || uploadStatus
            ? "pointer-events-none absolute right-2 top-2 rounded bg-black/60 px-2 py-0.5 text-[10px] text-muted-foreground"
            : "sr-only"
        }
        aria-live="polite"
      >
        {[
          socket.state !== "open" ? socket.state : null,
          channelPending ? "connecting direct channel…" : null,
          exitBanner,
          uploadStatus,
        ]
          .filter(Boolean)
          .join(" · ")}
      </div>
    </div>
  );
});

function wheelEventToPixels(event: WheelEvent, rows: number): number {
  return event.deltaMode === WheelEvent.DOM_DELTA_LINE
    ? event.deltaY * TERMINAL_LINE_HEIGHT_PX
    : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
      ? event.deltaY * rows * TERMINAL_LINE_HEIGHT_PX
      : event.deltaY;
}

function uploadReconciliationStorageKey(agentId: string): string {
  return `${UPLOAD_RECONCILIATION_STORAGE_PREFIX}:${agentId}`;
}

function uploadReconciliationStorageFault(): string {
  return "Upload reconciliation storage is unavailable.";
}

function blockReservedUploadReconciliations(
  records: UploadReconciliation[],
): UploadReconciliation[] {
  const recordedAt = Date.now();
  return records.map((record) =>
    record.phase === "reserved"
      ? {
          ...record,
          message: "Upload durability failed before final dispatch.",
          recordedAt,
          phase: "blocked" as const,
        }
      : record,
  );
}

function dispatchUploadReconciliationEvent(agentId: string): void {
  try {
    window.dispatchEvent(new CustomEvent(UPLOAD_RECONCILIATION_EVENT, { detail: { agentId } }));
  } catch {
    // The in-memory latch is authoritative for the current call even if a
    // hostile/broken event target prevents another mounted instance syncing.
  }
}

function readUploadReconciliationHistoryFallback(
  agentId: string,
): { records: UploadReconciliation[]; fault: string } | null {
  let state: unknown;
  try {
    state = window.history.state;
  } catch {
    return null;
  }
  if (typeof state !== "object" || state === null) return null;
  const fallbacks = (state as Record<string, unknown>).__spawnUploadReconciliationFallback;
  if (typeof fallbacks !== "object" || fallbacks === null) return null;
  const fallback = (fallbacks as Record<string, unknown>)[agentId];
  if (typeof fallback !== "object" || fallback === null) return null;
  const records = (fallback as Record<string, unknown>).records;
  const fault = (fallback as Record<string, unknown>).fault;
  if (!Array.isArray(records) || typeof fault !== "string") return null;
  return { records: records as UploadReconciliation[], fault };
}

function writeUploadReconciliationHistoryFallback(
  agentId: string,
  fallback: UploadReconciliationState | null,
): void {
  try {
    const current =
      typeof window.history.state === "object" && window.history.state !== null
        ? window.history.state
        : {};
    const existing =
      typeof current.__spawnUploadReconciliationFallback === "object" &&
      current.__spawnUploadReconciliationFallback !== null
        ? current.__spawnUploadReconciliationFallback
        : {};
    const fallbacks = { ...existing };
    if (fallback) fallbacks[agentId] = fallback;
    else delete fallbacks[agentId];
    window.history.replaceState(
      { ...current, __spawnUploadReconciliationFallback: fallbacks },
      document.title,
    );
  } catch {
    // sessionStorage or the in-memory latch still owns safety. This fallback
    // must never replace the typed upload-blocking error with a DOM exception.
  }
}

function loadUploadReconciliationState(agentId: string): UploadReconciliationState {
  if (typeof window === "undefined") return { records: [], fault: null };
  const runtime = uploadReconciliationRuntime();
  const historyFallback = readUploadReconciliationHistoryFallback(agentId);
  const memory = mergeUploadReconciliations(
    runtime.memory.get(agentId) ?? [],
    historyFallback?.records ?? [],
  );
  if (historyFallback) runtime.faults.set(agentId, historyFallback.fault);
  try {
    const raw = window.sessionStorage.getItem(uploadReconciliationStorageKey(agentId));
    let stored: UploadReconciliation[] = [];
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error("invalid reconciliation store");
      stored = parsed.map((record) => {
        if (
          typeof record !== "object" ||
          record === null ||
          typeof record.uploadId !== "string" ||
          typeof record.fileName !== "string" ||
          typeof record.message !== "string" ||
          typeof record.recordedAt !== "number" ||
          (record.phase !== undefined &&
            record.phase !== "reserved" &&
            record.phase !== "blocked" &&
            record.phase !== "outcome_unknown")
        ) {
          throw new Error("invalid reconciliation record");
        }
        return {
          uploadId: record.uploadId,
          fileName: record.fileName,
          message: record.message,
          recordedAt: record.recordedAt,
          phase: record.phase ?? "outcome_unknown",
        };
      });
    }
    const records = mergeUploadReconciliations(memory, stored);
    if (records.length > MAX_UPLOAD_RECONCILIATIONS) {
      runtime.faults.set(
        agentId,
        "Upload reconciliation capacity was exceeded; no records were discarded.",
      );
    }
    runtime.memory.set(agentId, records);
    return { records, fault: runtime.faults.get(agentId) ?? null };
  } catch {
    const fault = uploadReconciliationStorageFault();
    const blocked = blockReservedUploadReconciliations(memory);
    runtime.memory.set(agentId, blocked);
    runtime.faults.set(agentId, fault);
    writeUploadReconciliationHistoryFallback(agentId, { records: blocked, fault });
    return { records: blocked, fault };
  }
}

function persistUploadReconciliations(
  agentId: string,
  records: UploadReconciliation[],
  recordsOnFailure: UploadReconciliation[],
  clearFault = false,
): void {
  if (typeof window === "undefined") {
    throw new UploadReconciliationBlockedError(uploadReconciliationStorageFault());
  }
  if (records.length > MAX_UPLOAD_RECONCILIATIONS) {
    throw new UploadReconciliationBlockedError(
      "Upload reconciliation capacity is full. Check and dismiss an existing upload first.",
    );
  }
  const runtime = uploadReconciliationRuntime();
  const existingFault = runtime.faults.get(agentId) ?? null;
  try {
    const key = uploadReconciliationStorageKey(agentId);
    if (records.length === 0) window.sessionStorage.removeItem(key);
    else window.sessionStorage.setItem(key, JSON.stringify(records));
    runtime.memory.set(agentId, records);
    if (clearFault) {
      runtime.faults.delete(agentId);
      writeUploadReconciliationHistoryFallback(agentId, null);
    } else if (existingFault) {
      runtime.faults.set(agentId, existingFault);
      writeUploadReconciliationHistoryFallback(agentId, {
        records,
        fault: existingFault,
      });
    } else {
      writeUploadReconciliationHistoryFallback(agentId, null);
    }
    dispatchUploadReconciliationEvent(agentId);
  } catch {
    const blocked = blockReservedUploadReconciliations(recordsOnFailure);
    runtime.memory.set(agentId, blocked);
    const fault = uploadReconciliationStorageFault();
    runtime.faults.set(agentId, fault);
    writeUploadReconciliationHistoryFallback(agentId, {
      records: blocked,
      fault,
    });
    dispatchUploadReconciliationEvent(agentId);
    throw new UploadReconciliationBlockedError(fault);
  }
}

function reserveUploadReconciliationSlot(
  agentId: string,
  uploadId: string,
  fileName: string,
): void {
  const state = loadUploadReconciliationState(agentId);
  if (state.fault) {
    const blocked = blockReservedUploadReconciliations(state.records);
    const existing = blocked.find((record) => record.uploadId === uploadId);
    const records = existing
      ? blocked
      : blocked.length < MAX_UPLOAD_RECONCILIATIONS
        ? [
            ...blocked,
            {
              uploadId,
              fileName,
              message: "Upload durability is unavailable; no endpoint effect was admitted.",
              recordedAt: Date.now(),
              phase: "blocked" as const,
            },
          ]
        : state.records;
    const runtime = uploadReconciliationRuntime();
    runtime.memory.set(agentId, records);
    runtime.faults.set(agentId, state.fault);
    writeUploadReconciliationHistoryFallback(agentId, { records, fault: state.fault });
    dispatchUploadReconciliationEvent(agentId);
    throw new UploadReconciliationBlockedError(state.fault);
  }
  if (state.records.some((record) => record.uploadId === uploadId)) {
    throw new UploadReconciliationBlockedError("This upload already has a reconciliation record.");
  }
  if (state.records.length >= MAX_UPLOAD_RECONCILIATIONS) {
    throw new UploadReconciliationBlockedError(
      "Upload reconciliation capacity is full. Check and dismiss an existing upload first.",
    );
  }
  const next = [
    ...state.records,
    {
      uploadId,
      fileName,
      message: "The upload was reserved before any endpoint effect.",
      recordedAt: Date.now(),
      phase: "reserved" as const,
    },
  ];
  // A failed first write still retains the identity in same-window memory,
  // blocks endpoint dispatch, and survives SPA unmount/remount.
  uploadReconciliationRuntime().memory.set(agentId, next);
  persistUploadReconciliations(agentId, next, next);
}

function promoteUploadReconciliationSlot(
  agentId: string,
  uploadId: string,
  fileName: string,
  message: string,
): void {
  const state = loadUploadReconciliationState(agentId);
  const existing = state.records.find((record) => record.uploadId === uploadId);
  if (state.fault) {
    dispatchUploadReconciliationEvent(agentId);
    throw new UploadReconciliationBlockedError(state.fault);
  }
  if (!existing) {
    throw new UploadReconciliationBlockedError(
      "The upload safety reservation was lost; the final frame was not dispatched.",
    );
  }
  if (existing.phase === "blocked") {
    throw new UploadReconciliationBlockedError(
      "This upload was blocked by a reconciliation storage fault; its final frame was not dispatched.",
    );
  }
  const next = state.records.map((record) =>
    record.uploadId === uploadId
      ? {
          ...record,
          fileName,
          message,
          recordedAt: Date.now(),
          phase: "outcome_unknown" as const,
        }
      : record,
  );
  // Persist ambiguity before the final frame. On failure the durable reserved
  // record remains and the caller throws before DataChannel dispatch.
  persistUploadReconciliations(agentId, next, state.records);
}

function assertUploadReconciliationActive(agentId: string, uploadId: string): void {
  const state = loadUploadReconciliationState(agentId);
  const record = state.records.find((candidate) => candidate.uploadId === uploadId);
  if (state.fault) {
    dispatchUploadReconciliationEvent(agentId);
    throw new UploadReconciliationBlockedError(state.fault);
  }
  if (!record || record.phase === "blocked") {
    throw new UploadReconciliationBlockedError(
      "This upload no longer has an active durable safety reservation.",
    );
  }
}

function dismissUploadReconciliationSlot(
  agentId: string,
  uploadId: string,
  recoverFault: boolean,
): void {
  const state = loadUploadReconciliationState(agentId);
  const next = state.records.filter((record) => record.uploadId !== uploadId);
  persistUploadReconciliations(agentId, next, state.records, recoverFault);
}

function mergeUploadReconciliations(
  first: UploadReconciliation[],
  second: UploadReconciliation[],
): UploadReconciliation[] {
  const records = new Map<string, UploadReconciliation>();
  for (const record of [...first, ...second]) {
    const existing = records.get(record.uploadId);
    if (!existing || existing.recordedAt <= record.recordedAt) {
      records.set(record.uploadId, record);
    }
  }
  return [...records.values()].sort((left, right) => left.recordedAt - right.recordedAt);
}

function wheelEventToPixelsX(event: WheelEvent): number {
  return event.deltaMode === WheelEvent.DOM_DELTA_LINE
    ? event.deltaX * TERMINAL_LINE_HEIGHT_PX
    : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
      ? event.deltaX * TERMINAL_LINE_HEIGHT_PX
      : event.deltaX;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function maxElementScrollTop(element: HTMLElement): number {
  return Math.max(0, element.scrollHeight - element.clientHeight);
}

function scrollElementPixels(element: HTMLElement, deltaY: number): boolean {
  const maxTop = maxElementScrollTop(element);
  if (maxTop <= 0 || deltaY === 0) return false;
  const before = element.scrollTop;
  const next = Math.max(0, Math.min(maxTop, before + deltaY));
  if (Math.abs(next - before) < 0.5) return false;
  element.scrollTop = next;
  return true;
}

function wrapSnapshotForXterm(input: string): string {
  return `\x1b[?7l${input}\x1b[?7h`;
}

/** Renderer preference for the live terminal. GPU (WebGL) by default for
 *  real users; automation contexts (`navigator.webdriver` — Playwright, CI)
 *  keep the DOM renderer, whose `.xterm-rows` text the e2e suites assert on.
 *  `localStorage.spawnRenderer` overrides both ways: "gpu" forces the WebGL
 *  addon under automation, "dom" is the escape hatch for machines where
 *  WebGL glitches. */
function wantsGpuRenderer(): boolean {
  let preference: string | null = null;
  try {
    preference = window.localStorage.getItem("spawnRenderer");
  } catch {
    // Storage can be unavailable (privacy modes); fall through to default.
  }
  if (preference === "gpu") return true;
  if (preference === "dom") return false;
  return !navigator.webdriver;
}

/** One geometry-tagged span of a worker replay stream. */
type ReplayChunk = { cols: number; rows: number; data: string };

/**
 * In-band sentinel (an APC string, invisible if written to a terminal) that
 * opens a committed-line-history replay: the worker recorded history as lines
 * committed the moment they scrolled off screen, so the history section
 * renders as flowing styled text — never geometry-walked, never reflowed —
 * and the final chunk is a self-contained repaint of the live screen.
 */
const REPLAY_HISTORY_SENTINEL = "\x1b_sp:h1\x1b\\";

/** Split a committed-line worker replay into its history text and its live
 *  screen chunk; null for legacy (raw-byte, geometry-walked) replays. */
function parseHistoryReplay(
  chunks: ReplayChunk[] | null,
): { history: string; screen: ReplayChunk } | null {
  if (!chunks || chunks.length !== 2 || !chunks[0].data.startsWith(REPLAY_HISTORY_SENTINEL)) {
    return null;
  }
  return {
    history: chunks[0].data.slice(REPLAY_HISTORY_SENTINEL.length),
    screen: chunks[1],
  };
}

/**
 * Emitted between the history text and the screen repaint: scrolls every
 * viewport row the history writes occupied up into the scrollback region, so
 * the absolute-addressed screen repaint that follows paints a blank viewport
 * instead of overwriting the newest history lines. Computed at write time —
 * wrapping against the live overlay width decides how many rows are occupied.
 */
function flushViewportIntoScrollback(term: XTerm): string {
  const buffer = term.buffer.active;
  const occupied = buffer.cursorY + (buffer.cursorX > 0 ? 1 : 0);
  if (occupied <= 0) return "";
  return `\x1b[${term.rows};1H${"\n".repeat(occupied)}`;
}

/**
 * Worker-backed agents ship snapshots as exact terminal byte streams,
 * self-described by geometry markers (`CSI 8 ; rows ; cols t`): one at the
 * head, one at every recorded PTY resize. Returns the geometry-tagged chunks,
 * or null when the endpoint returned a plain replay without geometry markers.
 * xterm.js does not implement CSI 8 t itself, so the
 * consumer applies each chunk's geometry via term.resize() between writes.
 */
function parseExactReplay(text: string): ReplayChunk[] | null {
  if (!text.startsWith("\x1b[8;")) return null;
  // biome-ignore lint/complexity/useRegexLiterals: a constructor avoids embedding ESC in a regex literal
  const marker = new RegExp("\\x1b\\[8;(\\d{1,5});(\\d{1,5})t", "g");
  const first = marker.exec(text);
  if (!first || first.index !== 0) return null;
  const chunks: ReplayChunk[] = [];
  let current: RegExpExecArray | null = first;
  while (current) {
    const start = marker.lastIndex;
    const next = marker.exec(text);
    chunks.push({
      rows: Number(current[1]),
      cols: Number(current[2]),
      data: text.slice(start, next ? next.index : undefined),
    });
    current = next;
  }
  return chunks;
}

/** A queued terminal write, optionally preceded by a geometry change. A
 *  function `data` is resolved at write time against the terminal's current
 *  buffer state (after all earlier queued writes have been consumed). */
type SequencedWrite = {
  resize?: { cols: number; rows: number };
  data: string | Uint8Array | ((term: XTerm) => string);
};

/**
 * Write in order, applying each op's resize only after every earlier write
 * has been consumed — xterm applies resize() immediately while write() is
 * queued, so interleaving them without sequencing renders bytes at the wrong
 * geometry. `done` rides the final write's completion.
 */
function writeSequenced(term: XTerm, ops: SequencedWrite[], done: () => void) {
  let index = 0;
  const step = () => {
    if (index >= ops.length) {
      done();
      return;
    }
    const op = ops[index];
    index += 1;
    if (op.resize) {
      try {
        term.resize(op.resize.cols, op.resize.rows);
      } catch {
        // Mid-dispose during route changes; the write below is a no-op too.
      }
    }
    term.write(typeof op.data === "function" ? op.data(term) : op.data, step);
  };
  step();
}

/** Sequenced ops for the scrollback overlay (a display-only terminal that is
 *  safe to resize). Committed-line replays render their history as flowing
 *  text at `finalSize` — no geometry walk, so nothing already rendered ever
 *  reflows — then flush the viewport and paint the live screen. Legacy exact
 *  replays get per-chunk geometry; plain endpoint replays get a fallback
 *  reformat. All shapes end at `finalSize`. */
function overlayWriteOps(
  text: string,
  finalSize: { cols: number; rows: number },
): SequencedWrite[] {
  const exact = parseExactReplay(text);
  if (!exact) {
    return [{ resize: finalSize, data: formatSnapshotForXterm(text) }];
  }
  const storied = parseHistoryReplay(exact);
  if (storied) {
    const ops: SequencedWrite[] = [
      { resize: finalSize, data: storied.history },
      { data: flushViewportIntoScrollback },
      {
        resize: { cols: storied.screen.cols, rows: storied.screen.rows },
        data: storied.screen.data,
      },
    ];
    if (storied.screen.cols !== finalSize.cols || storied.screen.rows !== finalSize.rows) {
      ops.push({ resize: finalSize, data: "" });
    }
    return ops;
  }
  const ops: SequencedWrite[] = exact.map((chunk) => ({
    resize: { cols: chunk.cols, rows: chunk.rows },
    data: chunk.data,
  }));
  const last = exact[exact.length - 1];
  if (last.cols !== finalSize.cols || last.rows !== finalSize.rows) {
    ops.push({ resize: finalSize, data: "" });
  }
  return ops;
}

/** Sequenced ops for seeding the LIVE terminal, which is fit-sized and must
 *  never be geometry-walked (resizing it reflows the buffer and desyncs it
 *  from its container). Exact worker replays end with a self-contained chunk
 *  — a full idempotent repaint at the current PTY geometry — so the final
 *  chunk alone seeds the screen. Plain endpoint replay is reformatted. */
function liveSeedWriteOps(text: string): SequencedWrite[] {
  const exact = parseExactReplay(text);
  if (!exact) {
    return [{ data: formatSnapshotForXterm(text) }];
  }
  return [{ data: exact[exact.length - 1].data }];
}

function formatSnapshotForXterm(input: string): string {
  const normalized = input.replaceAll(/\r\n/g, "\n").replaceAll("\r", "\n");
  // Plain snapshots can terminate the final row with a newline; writing it would
  // scroll the terminal one row past the content and desync subsequent
  // app-relative drawing by one row (e.g. input echo landing on the status
  // bar row). Leave the cursor on the last content row instead.
  const trimmed = normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
  return wrapSnapshotForXterm(trimmed.split("\n").join("\r\n"));
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function containsAlternateBufferSwitch(bytes: Uint8Array): boolean {
  const text = decodeUtf8(bytes);
  return ["1049", "1047", "1048"].some(
    (mode) => text.includes(`\u001b[?${mode}h`) || text.includes(`\u001b[?${mode}l`),
  );
}

function stripDeviceAttributeResponses(data: string): string {
  // xterm.js answers terminal identity queries via `onData`; forwarding those
  // back to the agent after replay can echo fragments like "0;276;0c".
  let filtered = "";
  for (let i = 0; i < data.length; i += 1) {
    if (
      data.charCodeAt(i) === 0x1b &&
      data[i + 1] === "[" &&
      (data[i + 2] === "?" || data[i + 2] === ">")
    ) {
      let end = i + 3;
      while (isCsiParameter(data[end])) end += 1;
      if (data[end] === "c") {
        i = end;
        continue;
      }
    }
    filtered += data[i];
  }
  return filtered;
}

function rewriteMobileReturn(
  data: string,
  mobileReturnMode: MobileReturnMode,
  isCoarsePointer: boolean,
  mobileReturnBytes: string,
): string {
  if (mobileReturnMode !== "newline" || !isCoarsePointer || !isReturnKeyData(data)) {
    return data;
  }

  // Keep plain Enter/submit available through the mobile accessory bar's Send button.
  return mobileReturnBytes;
}

function isReturnKeyData(data: string): boolean {
  return data === "\r" || data === "\n" || data === "\r\n";
}

function bracketedPaste(text: string): string {
  return `${BRACKETED_PASTE_START}${text}${BRACKETED_PASTE_END}`;
}

function shellSingleQuote(path: string): string {
  if (/^[A-Za-z0-9_./:-]+$/.test(path)) return path;
  return `'${path.replaceAll("'", "'\\''")}'`;
}

function isCsiParameter(char: string | undefined): boolean {
  return char === ";" || (char !== undefined && char >= "0" && char <= "9");
}

function imageFilesFromDataTransfer(data: DataTransfer): File[] {
  const files = filesFromDataTransfer(data).filter(isImageFile);
  if (files.length > 0) return files;

  return Array.from(data.items)
    .filter((item) => item.kind === "file" && isImageMimeOrName(item.type))
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null && isImageFile(file));
}

function filesFromDataTransfer(data: DataTransfer): File[] {
  const files = Array.from(data.files).filter((file) => file.size > 0 || file.name !== "");
  if (files.length > 0) return files;

  return Array.from(data.items)
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
}

function hasFileTransfer(data: DataTransfer): boolean {
  return (
    Array.from(data.files).some((file) => file.size > 0 || file.name !== "") ||
    Array.from(data.items).some((item) => item.kind === "file")
  );
}

function isImageFile(file: File): boolean {
  return isImageMimeOrName(file.type || file.name);
}

function isImageMimeOrName(value: string): boolean {
  return (
    value.startsWith("image/") || /\.(png|jpe?g|gif|webp|heic|heif|bmp|tiff?|svg)$/i.test(value)
  );
}

function mimeTypeForFile(file: File): string {
  if (file.type.startsWith("image/")) return file.type;
  const name = file.name.toLowerCase();
  if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
  if (name.endsWith(".gif")) return "image/gif";
  if (name.endsWith(".webp")) return "image/webp";
  if (name.endsWith(".heic")) return "image/heic";
  if (name.endsWith(".heif")) return "image/heif";
  if (name.endsWith(".bmp")) return "image/bmp";
  if (name.endsWith(".tif") || name.endsWith(".tiff")) return "image/tiff";
  if (name.endsWith(".svg")) return "image/svg+xml";
  return "image/png";
}

function mimeTypeForUpload(file: File): string {
  return file.type || "application/octet-stream";
}

function defaultImageName(file: File): string {
  const extension = mimeTypeForFile(file).split("/")[1]?.replace("svg+xml", "svg") || "png";
  return `image.${extension}`;
}

function defaultClipboardImageName(mimeType: string): string {
  const extension = mimeType.split("/")[1]?.replace("svg+xml", "svg") || "png";
  return `clipboard.${extension}`;
}

function clipboardBlockedMessage(): string {
  if (typeof window !== "undefined" && !window.isSecureContext) {
    return "Clipboard tap needs HTTPS; use native Paste on the paste key.";
  }
  return "Clipboard tap was blocked; use native Paste on the paste key.";
}

function makeClientId(): string {
  return crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function compactPath(path: string): string {
  const marker = "/.spawn/attachments/";
  const idx = path.indexOf(marker);
  if (idx === -1) return path;
  return `.spawn/attachments/${path.slice(idx + marker.length)}`;
}
