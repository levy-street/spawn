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
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import {
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useDaemonConnection } from "@/components/hosts/DaemonConnectionsProvider";
import { ConnectingOverlay } from "@/components/terminal/ConnectingOverlay";
import type { SessionConnectionInfo } from "@/components/terminal/ConnectionChip";
import {
  LiveTerminalWriteBuffer,
  PostRenderLiveWriteBuffer,
} from "@/components/terminal/live-write-buffer";
import { openTerminalLink } from "@/components/terminal/terminal-link";
import { type UploadTrack, uploadRatio } from "@/components/terminal/upload-progress";
import { UploadProgressBar } from "@/components/terminal/upload-progress-bar";
import { type SocketState, useSessionSocket } from "@/components/terminal/useSessionSocket";
// Terminal configuration shared with the conformance harness
// (tools/term-conformance/); see xterm-config.mjs before changing options.
import {
  activateUnicodeVersion,
  TERMINAL_FONT_FAMILY,
  TERMINAL_FONT_SIZE,
  TERMINAL_LINE_HEIGHT,
  TERMINAL_SCROLLBACK_LINES,
  TERMINAL_SNAPSHOT_LINES,
  terminalTheme,
  XTERM_EMULATION_OPTIONS,
} from "@/components/terminal/xterm-config.mjs";
import { AGENT_NOTICE_ROWS, type AgentNotice, detectAgentNotice } from "@/lib/agent-notice";
import { type Host, hosts, type Session, sessions } from "@/lib/api";
import { cachedListItem } from "@/lib/cached-list-item";
import { appleArrowBytes, detectAppleModifiers } from "@/lib/keyboard-chords";
import { DirectSessionUploadError } from "@/lib/session-ctl";
import { getResolvedTheme, subscribeToTheme } from "@/lib/theme";
import { viewportInset } from "@/lib/viewport";
import type { DisplayControlState } from "@/lib/ws";

const TERMINAL_LINE_HEIGHT_PX = TERMINAL_FONT_SIZE * TERMINAL_LINE_HEIGHT;
// Defer the deep (10k-line) endpoint replay warm so connecting can paint the
// small endpoint-provided seed first.
const SCROLLBACK_WARM_DELAY_MS = 1_200;
// How long after a resize the viewport may still be reflowing. Within this
// window the pin and destructive rewrites treat the reader's edge position as
// unknown and hold off. Covers the gap between rapid mobile-keyboard resizes.
const RESIZE_QUIET_MS = 350;
// A visualViewport inset larger than this (on a coarse pointer) is treated as
// the on-screen keyboard rather than URL-bar chrome jitter. Above it the
// terminal freezes its row count and pans instead of reflowing, so the soft
// keyboard opening/closing never rewraps history or churns the PTY geometry.
const KEYBOARD_MIN_INSET_PX = 120;
// Endpoint replay requests can time out without a reply; clear the in-flight
// flag eventually or scrollback fetches would wedge for the whole session.
const SCROLLBACK_SNAPSHOT_TIMEOUT_MS = 6_000;
// The cache refresh debounces on output, but a continuously-streaming app
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
// Match the mobile terminal's live-write cadence for applications that do not
// bracket redraws with DEC synchronized-output mode. Bracketed redraws are
// held until CSI ? 2026 l, preventing xterm from painting partial frames.
const LIVE_WRITE_IDLE_DELAY_MS = 8;
/** How long after output settles the screen is read for an agent notice. */
const AGENT_NOTICE_SCAN_MS = 400;
const LIVE_WRITE_BATCH_BYTES = 32 * 1024;
const LIVE_WRITE_SYNC_TIMEOUT_MS = 1_000;
const LIVE_WRITE_SYNC_MAX_BYTES = 4 * 1024 * 1024;
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

const SOCKET_STATE_COPY: Record<SocketState, string> = {
  idle: "waiting",
  connecting: "reconnecting",
  open: "connected",
  closed: "reconnecting",
  error: "connection error",
  unauthorized: "signed out",
  disabled: "transport disabled by this server",
};

type TouchVelocitySample = { time: number; y: number };

/**
 * Where a touch drag's vertical pixels go. Decided once per gesture, the
 * moment it clears the tap slop, and held until the finger lifts (momentum
 * included) so a flick never changes hands halfway down.
 *
 * "terminal" is this terminal's own scrollback; "page" is the pane stack it
 * sits in. A terminal that cannot use the drag — the alternate buffer, which
 * has no scrollback at all, or a normal buffer already at the end the finger
 * is pulling toward — hands it to the stack instead of swallowing it. On
 * mobile that handoff is the only way to scroll the stack: bar a 36px header,
 * a pane is terminal from edge to edge.
 */
type TouchScrollRoute = "undecided" | "terminal" | "page";
type MobileReturnMode = "submit" | "newline";
type ImagePasteMode = "deferred" | "bracketed-path";
type PendingAttachmentStatus = "uploading" | "ready" | "error";
type ScrollAnchor = { viewportY: number; atBottom: boolean };
type TerminalGeometry = { cols: number; rows: number };

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
  /** Raw stdin into the session PTY (binary frame). */
  sendInput: (bytes: Uint8Array | string) => void;
  /** Tell the daemon the new TTY size. */
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
  /** Open the native file picker to upload files to this session. */
  openUpload: () => void;
  /** Scroll the viewport back to the live edge (bottom of the buffer). */
  snapToLiveEdge: () => void;
}

export interface TerminalProps {
  sessionId: string;
  /** When false, the Composer handles keystrokes instead of the terminal input channel. */
  rawInput?: boolean;
  /** On mobile soft keyboards, Return can be reserved for multiline prompts. */
  mobileReturnMode?: MobileReturnMode;
  /** Raw sequence sent for mobile keyboard Return when it means prompt newline. */
  mobileReturnBytes?: string;
  /** How uploaded images should be handed to the terminal application. */
  imagePasteMode?: ImagePasteMode;
  /** Daemon-confirmed terminal display ownership changed. */
  onDisplayControl?: (state: DisplayControlState) => void;
  /** Foreground (interactive) vs parked in a warm pool. A parked instance
   *  (active=false) stays connected but passive: it never resizes the PTY or
   *  takes control, so it can't disturb another client. Re-activating it
   *  focuses its view within the owning device and fits its container. Default true. */
  active?: boolean;
  /** Live transport snapshot (path kind, RTT) for connection indicators. */
  onConnectionInfo?: (info: SessionConnectionInfo) => void;
  onExit?: (exitCode: number | null, signal: string | null) => void;
  /** A notice the agent in this session paints into its own status bar —
   *  read off the rendered screen here, never off the wire. Called with null
   *  when the notice leaves the screen. */
  onAgentNotice?: (notice: AgentNotice | null) => void;
}

/**
 * Mounts xterm.js in a container, pipes its output through the per-session
 * WebSocket, and applies fit + resize handling. The component is a ref-forwarding
 * shell so the parent (terminal page) can poke it from the Composer / ModifierBar.
 */
export const Terminal = forwardRef<TerminalHandle, TerminalProps>(function Terminal(
  {
    sessionId,
    rawInput = false,
    mobileReturnMode = "submit",
    mobileReturnBytes = ALT_ENTER,
    imagePasteMode = "deferred",
    onDisplayControl,
    onConnectionInfo,
    active = true,
    onExit,
    onAgentNotice,
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
  // Foreground/parked state for the warm pool. A parked instance stays
  // connected but never fits or resizes (see fitTerminal), so moving its host
  // into an offscreen park can't churn the PTY geometry.
  const activeRef = useRef(active);
  const activePrevRef = useRef(active);
  const takeControlNowRef = useRef<() => boolean>(() => false);
  const focusViewRef = useRef<() => boolean>(() => false);
  // GPU renderer for the FOREGROUND terminal only. The DOM renderer rebuilds
  // row elements and forces style/layout/paint after every echo — measurable
  // extra frames of felt keystroke latency. Parked terminals release their
  // addon so the warm pool can never exhaust the browser's WebGL context
  // budget; a lost context falls back to the DOM renderer silently.
  const webglAddonRef = useRef<WebglAddon | null>(null);
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
      requestAnimationFrame(() => requestAnimationFrame(() => focusViewRef.current()));
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
  const lastSentSizeRef = useRef<string | null>(null);
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
    route: TouchScrollRoute;
    pageScroller: HTMLElement | null;
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
    route: "undecided",
    pageScroller: null,
  });
  const [exitBanner, setExitBanner] = useState<string | null>(null);
  const [uploadStatus, setUploadStatus] = useState<string | null>(null);
  // Whether this terminal has ever had bytes rendered into it. It is what the
  // connecting overlay watches: an empty pane is worth explaining, a pane with
  // output in it is not worth covering. Latched once and never cleared — a
  // later reconnect belongs to the status chip, not to a full-pane card.
  const [painted, setPainted] = useState(false);
  const paintedRef = useRef(false);
  const markPainted = useCallback(() => {
    if (paintedRef.current) return;
    paintedRef.current = true;
    setPainted(true);
  }, []);
  const [uploadReconciliations, setUploadReconciliations] = useState<UploadReconciliation[]>([]);
  const [uploadReconciliationFault, setUploadReconciliationFault] = useState<string | null>(null);
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const pendingAttachmentsRef = useRef<PendingAttachment[]>([]);
  // Byte progress of every upload in flight, keyed by upload id. Drives the
  // hairline across the top of the terminal; see UploadProgressBar.
  const [uploadTracks, setUploadTracks] = useState<Record<string, UploadTrack>>({});
  const [dropActive, setDropActive] = useState(false);
  // Live-edge tracking drives the "jump to latest" button. `atLiveEdge` is the
  // rendered state; the ref mirrors it for synchronous reads inside output
  // handlers without a stale closure. `newOutputWhileAway` upgrades the button
  // to signal that content arrived below while the reader is scrolled up.
  const [atLiveEdge, setAtLiveEdge] = useState(true);
  const [newOutputWhileAway, setNewOutputWhileAway] = useState(false);
  const atLiveEdgeRef = useRef(true);
  const refreshLiveEdgeRef = useRef<() => void>(() => {});
  // A ring of recent buffer-shaping ops (seed / reseed / snapshot / resize) so
  // a refresh+diagnostics capture shows the sequence that led to a corrupted
  // render — the async races (a write or reseed landing mid-reflow) that the
  // synchronous e2e mock cannot reproduce.
  const opLogRef = useRef<Array<{ t: number; op: string; info: string }>>([]);
  const pushOp = useCallback((op: string, info = "") => {
    const log = opLogRef.current;
    log.push({ t: Date.now(), op, info });
    if (log.length > 48) log.shift();
  }, []);
  const [socketInitialSize, setSocketInitialSize] = useState<{
    cols: number;
    rows: number;
  } | null>(null);
  const socketStartedRef = useRef(false);
  // Set once the deep post-connect snapshot has rebuilt the live buffer at
  // full history depth (the connect seed carries only a shallow prefix).
  const unifiedDeepSeededRef = useRef(false);

  // Restyle both terminals in place when the theme changes. Terminals are kept
  // warm across navigation and portaled from the root, so tearing them down to
  // pick up a colour would drop the session — and this component is outside
  // the tree the settings dialog lives in, hence the external subscription
  // rather than a prop.
  useEffect(() => {
    const applyThemeToTerminals = () => {
      const live = termRef.current;
      if (live) live.options.theme = { ...terminalTheme(getResolvedTheme()) };
    };
    applyThemeToTerminals();
    return subscribeToTheme(applyThemeToTerminals);
  }, []);
  const scrollbackSnapshotInFlightRef = useRef(false);
  const scrollbackSnapshotTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollbackCachedSnapshotBytesRef = useRef<Uint8Array | null>(null);
  const scrollbackRenderedSnapshotBytesRef = useRef<Uint8Array | null>(null);
  const scrollbackCacheDirtyRef = useRef(true);
  const scrollbackLiveBytesAtRef = useRef(0);
  const scrollbackSnapshotRequestedAtRef = useRef(0);
  const scrollbackCacheRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollbackCacheRefreshDeadlineRef = useRef<number | null>(null);
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
  // Timestamp (performance.now) until which a resize reflow may still be
  // settling. A reflow transiently collapses the viewport onto the bottom, so
  // for this brief window the instantaneous "is the reader at the live edge?"
  // check is untrustworthy: the pin and destructive rewrites hold off, rather
  // than yank a reader who is actually up in history. The mobile on-screen
  // keyboard, which resizes constantly, is what made this routine.
  const resizeQuietUntilRef = useRef(0);
  const resizeTimingsRef = useRef<
    Array<{ at: string; cols: number; rows: number; toFirstByteMs: number; toSettleMs: number }>
  >([]);
  const markResizeSentRef = useRef((cols: number, rows: number) => {
    resizeMarkRef.current = { sentAt: Date.now(), cols, rows, firstByteAt: null, lastByteAt: null };
  });
  const serializeAddonRef = useRef<SerializeAddon | null>(null);
  // Daemon-stamped DataChannel stream offset for each snapshot payload.
  const scrollbackSnapshotOffsetsRef = useRef(new WeakMap<Uint8Array, number>());
  // Set when the terminal width changes: the next anchored snapshot rewrites
  // the live buffer so seeded history reflows at the new width.
  const historyReseedPendingRef = useRef(false);
  // Whether the live buffer's current seed came from an exact worker stream
  // (vs a plain endpoint replay without geometry markers).
  const liveSeedWasExactRef = useRef(false);
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
  const liveTerminalWritesRef = useRef(new LiveTerminalWriteBuffer());
  const liveTerminalWriteIdleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const liveTerminalWriteSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const liveTerminalWriteInFlightRef = useRef(false);
  const liveTerminalWriteFlushPendingRef = useRef(false);
  const flushLiveTerminalWritesRef = useRef<() => void>(() => {});
  const scheduleLiveTerminalWritesRef = useRef<() => void>(() => {});
  const enqueueLiveTerminalWriteRef = useRef<(bytes: Uint8Array, onWritten?: () => void) => void>(
    () => {},
  );
  const liveViewportPinFrameRef = useRef<number | null>(null);
  const pinLiveViewportToBottomRef = useRef<() => void>(() => {});
  const requestSnapshotRef = useRef<() => boolean>(() => false);
  const scheduleScrollbackCacheRefreshRef = useRef<(delayMs?: number) => void>(() => {});
  // True once a snapshot/history proved this session ships exact worker
  // replays; used to widen the overlay fetch budget (the daemon maps lines
  // to a byte budget, and TUI redraw churn dwarfs line-based sizing).
  const exactStreamRef = useRef(false);
  const invalidateScrollbackForResizeRef = useRef<() => void>(() => {});
  const terminalRowHeightRef = useRef(TERMINAL_LINE_HEIGHT_PX);
  const [_scrollbackVisible, _setScrollbackVisible] = useState(false);
  const [_scrollbackReady, _setScrollbackReady] = useState(false);

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

  // Geometry changed: captures taken at the old size are stale. The next
  // heal/top-up fetches at current geometry; history itself reflows natively.
  const invalidateSnapshotCacheForResize = useCallback(() => {
    scrollbackCacheDirtyRef.current = true;
    scrollbackRenderedSnapshotBytesRef.current = null;
    scheduleScrollbackCacheRefreshRef.current();
  }, []);
  invalidateScrollbackForResizeRef.current = invalidateSnapshotCacheForResize;

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
      pushOp(
        "reseed",
        `${cols}x${rows} exact=${exact} force=${!!opts?.force} slices=${replaySlices.length}`,
      );
      try {
        term.resize(cols, rows);
      } catch {
        // The live terminal can be mid-dispose during route changes; the next
        // socket history frame will seed the replacement instance.
      }
      // Clear via escape sequences instead of term.reset(): reset() also
      // wipes terminal modes (bracketed paste, mouse reporting, application
      // cursor keys) that the app still believes are active, garbling
      // input until the next full repaint. The 3J matters: without wiping
      // local scrollback, the seed's replayed output would duplicate lines
      // the buffer already scrolled in. The character sets, margins, origin
      // mode and autowrap are restored first: the previous screen's tail
      // sets the app's scroll region and may leave a line-drawing set
      // active, and 2J/3J leave both in force, so the history written next
      // would scroll inside that region, or map to box glyphs, and never
      // reach scrollback intact (#58). The daemon's own baseline, minus SGR
      // and cursor, which the screen chunk restores itself, and minus the
      // G2/G3 return, which the replay head carries (#61).
      predictorRef.current.clear();
      const ops: SequencedWrite[] = [
        { data: "\x1b[0m\x1b(B\x1b)B\x0f\x1b[r\x1b[?6l\x1b[?7h\x1b[H\x1b[2J\x1b[3J" },
        ...liveSeedWriteOps(text),
      ];
      writeSequenced(term, [...ops, ...replaySlices.map((slice) => ({ data: slice }))], () => {
        term.scrollToBottom();
        syncPredictionOverlayRef.current();
      });
      return true;
    },
    [takeDcReplaySlices, pushOp],
  );

  const showUploadStatus = useCallback((message: string) => {
    setUploadStatus(message);
    if (uploadStatusTimerRef.current) clearTimeout(uploadStatusTimerRef.current);
    uploadStatusTimerRef.current = setTimeout(() => {
      setUploadStatus(null);
      uploadStatusTimerRef.current = null;
    }, 3000);
  }, []);

  const syncUploadReconciliations = useCallback(() => {
    const state = loadUploadReconciliationState(sessionId);
    setUploadReconciliations(state.records);
    setUploadReconciliationFault(state.fault);
  }, [sessionId]);

  useEffect(() => syncUploadReconciliations(), [syncUploadReconciliations]);

  useEffect(() => {
    const sync = (event: Event) => {
      if (!(event instanceof CustomEvent) || event.detail?.sessionId !== sessionId) return;
      syncUploadReconciliations();
    };
    window.addEventListener(UPLOAD_RECONCILIATION_EVENT, sync);
    return () => window.removeEventListener(UPLOAD_RECONCILIATION_EVENT, sync);
  }, [sessionId, syncUploadReconciliations]);

  const reserveUploadReconciliation = useCallback(
    (uploadId: string, fileName: string) =>
      reserveUploadReconciliationSlot(sessionId, uploadId, fileName),
    [sessionId],
  );

  const promoteUploadReconciliation = useCallback(
    (uploadId: string, fileName: string, message: string) =>
      promoteUploadReconciliationSlot(sessionId, uploadId, fileName, message),
    [sessionId],
  );

  const assertUploadReconciliation = useCallback(
    (uploadId: string) => assertUploadReconciliationActive(sessionId, uploadId),
    [sessionId],
  );

  const dismissUploadReconciliation = useCallback(
    (uploadId: string, recoverFault = false) => {
      try {
        dismissUploadReconciliationSlot(sessionId, uploadId, recoverFault);
      } catch {
        // The store emitted a fault event and retained the record. A later
        // explicit dismissal after storage recovers is the only safe unlock.
      }
    },
    [sessionId],
  );

  const beginUploadTrack = useCallback((id: string, total: number) => {
    setUploadTracks((current) => ({ ...current, [id]: { sent: 0, total } }));
  }, []);

  const advanceUploadTrack = useCallback((id: string, sent: number, total: number) => {
    // Only track uploads that are still open: a late chunk callback from an
    // aborted upload must not resurrect the bar.
    setUploadTracks((current) => (current[id] ? { ...current, [id]: { sent, total } } : current));
  }, []);

  const endUploadTrack = useCallback((id: string) => {
    setUploadTracks((current) => {
      if (!(id in current)) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });
  }, []);

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

  // Input and control actions return the reader to the live edge — the
  // one-buffer equivalent of the old "close the scrollback overlay".
  const snapToLiveEdge = useCallback(() => {
    termRef.current?.scrollToBottom();
    refreshLiveEdgeRef.current();
  }, []);

  const requestDisplayControl = useCallback((operation: "take_control" | "focus_view"): boolean => {
    const term = termRef.current;
    if (!term) return false;
    // Followers may be panning a virtual surface sized for another device.
    // Measure this viewport without changing the displayed terminal or its lease.
    const surfaces = [terminalSurfaceRef.current, containerRef.current].filter(
      (surface): surface is HTMLDivElement => surface !== null,
    );
    const styles = surfaces.map((surface) => [surface.style.width, surface.style.height]);
    const viewport = terminalViewportRef.current;
    const scroll = { left: viewport?.scrollLeft ?? 0, top: viewport?.scrollTop ?? 0 };
    let size = { cols: term.cols, rows: term.rows };
    try {
      for (const surface of surfaces) {
        surface.style.width = "100%";
        surface.style.height = "100%";
      }
      size = fitRef.current?.proposeDimensions() ?? size;
    } finally {
      surfaces.forEach((surface, index) => {
        [surface.style.width, surface.style.height] = styles[index];
      });
      if (viewport) {
        viewport.scrollLeft = scroll.left;
        viewport.scrollTop = scroll.top;
      }
    }
    return socketRef.current.sendJson({ type: operation, cols: size.cols, rows: size.rows });
  }, []);
  const takeControlNow = useCallback(
    () => requestDisplayControl("take_control"),
    [requestDisplayControl],
  );
  takeControlNowRef.current = takeControlNow;
  focusViewRef.current = () => requestDisplayControl("focus_view");

  const applyDisplayControl = useCallback(
    (state: DisplayControlState) => {
      const geometry =
        typeof state.cols === "number" && typeof state.rows === "number"
          ? { cols: state.cols, rows: state.rows }
          : null;
      displayOwnerRef.current = state.owner;
      displayGeometryRef.current = geometry;
      onDisplayControl?.(state);

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
        // Following the owner's geometry can change our width; that owes a
        // history reseed just like a local fit (see notifyResizeIfChanged).
        if (geometry.cols !== last.cols) {
          historyReseedPendingRef.current = true;
          resizeQuietUntilRef.current = performance.now() + RESIZE_QUIET_MS;
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
        const pasted = bracketedPaste(shellSingleQuote(path));
        socketRef.current.sendBinary(pasted);
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
      if (!requestSnapshotRef.current()) {
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

  const queryClient = useQueryClient();
  const sessionIdentityQuery = useQuery({
    queryKey: ["session", sessionId],
    queryFn: () => sessions.get(sessionId),
    staleTime: 30_000,
    ...cachedListItem<Session>(queryClient, ["sessions"], sessionId),
  });
  const signalingHostId = sessionIdentityQuery.data?.host_id ?? null;
  const hostIdentityQuery = useQuery({
    queryKey: ["host", signalingHostId],
    queryFn: () => hosts.get(signalingHostId as string),
    enabled: signalingHostId !== null,
    staleTime: 30_000,
    ...cachedListItem<Host>(queryClient, ["hosts"], signalingHostId ?? ""),
  });

  /*
   * The screen is scanned for an agent's own status-bar notice a beat after
   * output settles, never per byte: the notice is a stable line the agent
   * keeps painting, so a trailing scan catches it and a change-only callback
   * keeps the pane quiet. Only the live rows can hold a status bar, and only
   * on the normal buffer — a full-screen app on the alternate buffer is not
   * an agent's prompt.
   */
  const onAgentNoticeRef = useRef(onAgentNotice);
  onAgentNoticeRef.current = onAgentNotice;
  const agentNoticeRef = useRef<AgentNotice | null>(null);
  const agentNoticeTimerRef = useRef<number | null>(null);
  const reportAgentNotice = useCallback((notice: AgentNotice | null) => {
    if (agentNoticeRef.current === notice) return;
    agentNoticeRef.current = notice;
    onAgentNoticeRef.current?.(notice);
  }, []);
  const scanAgentNotice = useCallback(() => {
    const term = termRef.current;
    if (!term) return;
    const buffer = term.buffer.active;
    if (buffer.type === "alternate") {
      reportAgentNotice(null);
      return;
    }
    const end = buffer.baseY + term.rows;
    const rows: string[] = [];
    for (let y = Math.max(0, end - AGENT_NOTICE_ROWS); y < end; y += 1) {
      rows.push(buffer.getLine(y)?.translateToString(true) ?? "");
    }
    reportAgentNotice(detectAgentNotice(rows));
  }, [reportAgentNotice]);
  const scheduleAgentNoticeScan = useCallback(() => {
    if (!onAgentNoticeRef.current || agentNoticeTimerRef.current !== null) return;
    agentNoticeTimerRef.current = window.setTimeout(() => {
      agentNoticeTimerRef.current = null;
      scanAgentNotice();
    }, AGENT_NOTICE_SCAN_MS);
  }, [scanAgentNotice]);
  useEffect(
    () => () => {
      if (agentNoticeTimerRef.current !== null) window.clearTimeout(agentNoticeTimerRef.current);
    },
    [],
  );

  flushLiveTerminalWritesRef.current = () => {
    if (liveTerminalWriteIdleTimerRef.current) {
      clearTimeout(liveTerminalWriteIdleTimerRef.current);
      liveTerminalWriteIdleTimerRef.current = null;
    }
    if (liveTerminalWritesRef.current.synchronized) {
      liveTerminalWriteFlushPendingRef.current = true;
      return;
    }
    if (liveTerminalWriteSyncTimerRef.current) {
      clearTimeout(liveTerminalWriteSyncTimerRef.current);
      liveTerminalWriteSyncTimerRef.current = null;
    }
    if (liveTerminalWriteInFlightRef.current) {
      liveTerminalWriteFlushPendingRef.current = true;
      return;
    }
    liveTerminalWriteFlushPendingRef.current = false;
    const term = termRef.current;
    if (!term) {
      liveTerminalWritesRef.current.clear();
      return;
    }
    const batch = liveTerminalWritesRef.current.take(LIVE_WRITE_BATCH_BYTES);
    if (!batch) return;
    liveTerminalWriteInFlightRef.current = true;
    term.write(batch.bytes, () => {
      liveTerminalWriteInFlightRef.current = false;
      scheduleAgentNoticeScan();
      try {
        for (const onWritten of batch.onWritten) onWritten();
      } finally {
        if (liveTerminalWritesRef.current.size === 0) {
          liveTerminalWriteFlushPendingRef.current = false;
        } else if (liveTerminalWritesRef.current.synchronized) {
          // The synchronized-output timeout installed by enqueue remains the
          // recovery path if the application never sends its closing marker.
        } else if (
          liveTerminalWriteFlushPendingRef.current ||
          liveTerminalWritesRef.current.size >= LIVE_WRITE_BATCH_BYTES
        ) {
          flushLiveTerminalWritesRef.current();
        } else {
          scheduleLiveTerminalWritesRef.current();
        }
      }
    });
  };

  scheduleLiveTerminalWritesRef.current = () => {
    if (liveTerminalWritesRef.current.size === 0 || liveTerminalWritesRef.current.synchronized) {
      return;
    }
    if (liveTerminalWriteIdleTimerRef.current) {
      clearTimeout(liveTerminalWriteIdleTimerRef.current);
    }
    liveTerminalWriteIdleTimerRef.current = setTimeout(() => {
      liveTerminalWriteIdleTimerRef.current = null;
      flushLiveTerminalWritesRef.current();
    }, LIVE_WRITE_IDLE_DELAY_MS);
  };

  enqueueLiveTerminalWriteRef.current = (bytes, onWritten) => {
    const state = liveTerminalWritesRef.current.enqueue(bytes, onWritten);
    if (state.synchronized) {
      if (liveTerminalWriteIdleTimerRef.current) {
        clearTimeout(liveTerminalWriteIdleTimerRef.current);
        liveTerminalWriteIdleTimerRef.current = null;
      }
      if (!liveTerminalWriteSyncTimerRef.current) {
        liveTerminalWriteSyncTimerRef.current = setTimeout(() => {
          liveTerminalWriteSyncTimerRef.current = null;
          liveTerminalWritesRef.current.releaseSynchronization();
          flushLiveTerminalWritesRef.current();
        }, LIVE_WRITE_SYNC_TIMEOUT_MS);
      }
      if (liveTerminalWritesRef.current.size >= LIVE_WRITE_SYNC_MAX_BYTES) {
        clearTimeout(liveTerminalWriteSyncTimerRef.current);
        liveTerminalWriteSyncTimerRef.current = null;
        liveTerminalWritesRef.current.releaseSynchronization();
        flushLiveTerminalWritesRef.current();
      }
      return;
    }
    if (liveTerminalWriteSyncTimerRef.current) {
      clearTimeout(liveTerminalWriteSyncTimerRef.current);
      liveTerminalWriteSyncTimerRef.current = null;
    }
    if (state.completedSynchronizedOutput) {
      flushLiveTerminalWritesRef.current();
      return;
    }
    if (liveTerminalWritesRef.current.size >= LIVE_WRITE_BATCH_BYTES) {
      flushLiveTerminalWritesRef.current();
      return;
    }
    scheduleLiveTerminalWritesRef.current();
  };

  const daemonConnection = useDaemonConnection(signalingHostId);
  const subscribeDaemon = useCallback(
    (listener: () => void) => daemonConnection?.subscribe(listener) ?? (() => {}),
    [daemonConnection],
  );
  const daemonReady = useSyncExternalStore(
    subscribeDaemon,
    () => daemonConnection?.getSnapshot().state === "ready",
    () => false,
  );
  const socket = useSessionSocket({
    connection: daemonConnection,
    sessionId,
    sessionStatus: sessionIdentityQuery.data,
    enabled:
      socketInitialSize !== null &&
      daemonConnection !== null &&
      sessionIdentityQuery.data?.status !== "exited" &&
      sessionIdentityQuery.data?.status !== "killed",
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
      const closeHudSample = latencyHudRef.current?.noteEcho(performance.now()) ?? null;
      markPainted();
      if (liveSeedWriteInFlightRef.current) {
        pendingLiveSeedWritesRef.current.enqueue(bytes, dcOffsetAfter, lastSizeRef.current);
      } else {
        enqueueLiveTerminalWriteRef.current(bytes, () => {
          pinLiveViewportToBottomRef.current();
          reconcilePredictionRef.current();
          // Output landed below a reader who is scrolled up (the pin is a
          // no-op unless already at the edge): light up the jump button.
          if (!atLiveEdgeRef.current) setNewOutputWhileAway(true);
          if (closeHudSample) {
            requestAnimationFrame(() => closeHudSample(performance.now()));
          }
        });
      }
    },
    onHistory: (bytes, dcOffset, historyAnchor) => {
      const term = termRef.current;
      if (!term) return;
      // A reconnect seed or pty_gap recovery replaces the prior offset
      // timeline. Never replay bytes retained against the old anchor on top.
      recentDcChunksRef.current = [];
      recentDcChunksSizeRef.current = 0;
      dcActiveRef.current = typeof dcOffset === "number";
      markPainted();
      clearPrediction();
      if (typeof dcOffset === "number") {
        scrollbackSnapshotOffsetsRef.current.set(bytes, dcOffset);
      }
      if (historyAnchor) {
        // Delta-capable worker; the scheduled deep refresh below rebuilds
        // the live buffer at full history depth.
      }
      pendingLiveSeedWritesRef.current.clear();
      if (liveTerminalWriteIdleTimerRef.current) {
        clearTimeout(liveTerminalWriteIdleTimerRef.current);
        liveTerminalWriteIdleTimerRef.current = null;
      }
      if (liveTerminalWriteSyncTimerRef.current) {
        clearTimeout(liveTerminalWriteSyncTimerRef.current);
        liveTerminalWriteSyncTimerRef.current = null;
      }
      liveTerminalWritesRef.current.clear();
      liveTerminalWriteFlushPendingRef.current = false;
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
          // The seed renders at the session's previous PTY geometry (set by
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
      reportAgentNotice(null);
      unifiedDeepSeededRef.current = false;
      pushOp(
        "seed",
        `${lastSizeRef.current.cols}x${lastSizeRef.current.rows} exact=${liveSeedWasExactRef.current} reseedPending=${historyReseedPendingRef.current}`,
      );
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
      if (historyReseedPendingRef.current && anchorOk) {
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
        // A reseed clears and rewrites the whole buffer, so never run it under
        // a reader who is up in history: defer until they are back at the live
        // edge (the pending flag keeps the heal owed). Skip during the
        // resize-quiet window too, where the at-edge reading is transiently
        // wrong mid-reflow.
        const liveTerm = termRef.current;
        const atEdge =
          !liveTerm || liveTerm.buffer.active.viewportY >= liveTerm.buffer.active.baseY;
        const reflowQuiet = performance.now() >= resizeQuietUntilRef.current;
        if (
          atEdge &&
          reflowQuiet &&
          geometryReady &&
          syncLiveTerminalFromSnapshot(bytes, { force: true })
        ) {
          historyReseedPendingRef.current = false;
          liveSeedWasExactRef.current = snapshotIsExact;
        }
      }
      if (historyAnchor) {
        // Delta mode: this snapshot is a seed/heal for the committed-line
        // overlay. The controller re-anchors from it; deltas keep it exact
        // afterwards, so the cache is clean by construction.
        scrollbackCacheDirtyRef.current = false;
        // The connect seed carried a shallow history prefix; this is the
        // full-depth capture. Rebuild the live buffer from it once — xterm
        // cannot prepend, so depth only ever arrives via a rebuild. Guarded
        // to the bottom-pinned viewport so a reader already scrolled back is
        // never yanked; the offset-exact replay slices inside the sync keep
        // every live byte.
        if (!unifiedDeepSeededRef.current) {
          const liveTerm = termRef.current;
          const atBottom =
            !liveTerm || liveTerm.buffer.active.viewportY >= liveTerm.buffer.active.baseY;
          // Same guards as the width heal: only top up depth at the live edge,
          // and not mid-reflow. If the reader is up in history the top-up
          // waits for the next snapshot after they return to the bottom.
          const reflowQuiet = performance.now() >= resizeQuietUntilRef.current;
          if (atBottom && reflowQuiet && syncLiveTerminalFromSnapshot(bytes, { force: true })) {
            unifiedDeepSeededRef.current = true;
          }
        }
        return;
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
    },
    onExit: (code, sig) => {
      const banner = `\r\n\x1b[33m[session exited code=${code ?? "?"}${
        sig ? ` signal=${sig}` : ""
      }]\x1b[0m\r\n`;
      enqueueLiveTerminalWriteRef.current(new TextEncoder().encode(banner));
      flushLiveTerminalWritesRef.current();
      markPainted();
      setExitBanner(`Session exited (code=${code ?? "?"}${sig ? `, signal=${sig}` : ""})`);
      onExit?.(code, sig);
    },
  });
  useEffect(() => {
    if (
      socket.dcOpen &&
      active &&
      document.hasFocus() &&
      containerRef.current?.contains(document.activeElement)
    ) {
      focusViewRef.current();
    }
  }, [socket.dcOpen, active]);
  useEffect(() => {
    // The channel dropping is how a restart reaches this pane: the process
    // that painted the notice is gone with it, and the new one repaints its
    // own if it has one.
    if (!socket.dcOpen) reportAgentNotice(null);
  }, [socket.dcOpen, reportAgentNotice]);

  // Stash the socket in a ref so the once-on-mount bootstrap useEffect can
  // reach it without re-running every render.
  const socketRef = useRef(socket);
  socketRef.current = socket;

  // Surface the live transport for connection indicators without forcing the
  // callback identity into effect deps (workspace panes pass inline closures).
  const onConnectionInfoRef = useRef(onConnectionInfo);
  onConnectionInfoRef.current = onConnectionInfo;
  useEffect(() => {
    onConnectionInfoRef.current?.({
      socketState: socket.state,
      v3: socket.v3,
      dcOpen: socket.dcOpen,
      signedRtcRefusal: socket.signedRtcRefusal,
      signalingTrust: socket.signalingTrust,
      // Lets a refusal surface deep-link its safe next step (the host page).
      hostId: signalingHostId,
      ...socket.connInfo,
    });
  }, [
    socket.state,
    socket.v3,
    socket.dcOpen,
    socket.signedRtcRefusal,
    socket.signalingTrust,
    socket.connInfo,
    signalingHostId,
  ]);

  // Only surface "waiting for the direct channel" after a grace period —
  // the DC normally opens within a second or two of attach.
  const [channelPending, setChannelPending] = useState(false);
  useEffect(() => {
    const pending = socket.v3 && socket.state === "open" && !socket.dcOpen;
    if (!pending) {
      setChannelPending(false);
      return;
    }
    const timer = setTimeout(() => setChannelPending(true), 1_500);
    return () => clearTimeout(timer);
  }, [socket.v3, socket.state, socket.dcOpen]);
  const [showReconnectBanner, setShowReconnectBanner] = useState(false);
  useEffect(() => {
    if (!painted || socket.dcOpen) {
      setShowReconnectBanner(false);
      return;
    }
    const timer = setTimeout(() => setShowReconnectBanner(true), 2_000);
    return () => clearTimeout(timer);
  }, [painted, socket.dcOpen]);
  rawInputRef.current = rawInput;
  mobileReturnModeRef.current = mobileReturnMode;
  mobileReturnBytesRef.current = mobileReturnBytes;

  const requestSnapshot = useCallback(() => {
    if (!socketRef.current.dcOpen || scrollbackSnapshotInFlightRef.current) return false;

    scrollbackSnapshotInFlightRef.current = true;
    scrollbackSnapshotRequestedAtRef.current = Date.now();
    const sent = socketRef.current.sendJson({
      type: "snapshot",
      lines: !dcActiveRef.current
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
      return false;
    }
    if (scrollbackSnapshotTimeoutRef.current) clearTimeout(scrollbackSnapshotTimeoutRef.current);
    scrollbackSnapshotTimeoutRef.current = setTimeout(() => {
      scrollbackSnapshotTimeoutRef.current = null;
      scrollbackSnapshotInFlightRef.current = false;
    }, SCROLLBACK_SNAPSHOT_TIMEOUT_MS);
    return true;
  }, []);
  requestSnapshotRef.current = requestSnapshot;

  const scheduleScrollbackCacheRefresh = useCallback(
    (delayMs?: number) => {
      // Debounce on output, but bound the postponement: an app that streams
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
        if (!activeRef.current || document.hidden) return;
        if (!requestSnapshot() && scrollbackSnapshotInFlightRef.current) {
          // Another capture is pending; try again once it resolves or times out.
          scheduleScrollbackCacheRefreshRef.current(500);
        }
      }, fireIn);
    },
    [requestSnapshot],
  );
  scheduleScrollbackCacheRefreshRef.current = scheduleScrollbackCacheRefresh;

  useEffect(() => {
    if (!socket.dcOpen || document.hidden) return;
    if (!scrollbackCachedSnapshotBytesRef.current || scrollbackCacheDirtyRef.current) {
      scheduleScrollbackCacheRefresh(SCROLLBACK_WARM_DELAY_MS);
    }
  }, [scheduleScrollbackCacheRefresh, socket.dcOpen]);

  useEffect(() => {
    const onVisibilityChange = () => {
      if (
        !document.hidden &&
        activeRef.current &&
        socketRef.current.dcOpen &&
        scrollbackCacheDirtyRef.current
      ) {
        scheduleScrollbackCacheRefreshRef.current(0);
      } else if (document.hidden && scrollbackCacheRefreshTimerRef.current) {
        clearTimeout(scrollbackCacheRefreshTimerRef.current);
        scrollbackCacheRefreshTimerRef.current = null;
        scrollbackCacheRefreshDeadlineRef.current = null;
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

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
    // Whether ⌘ is on this keyboard at all. Read once here rather than per
    // press: the keyboard does not change under a mounted terminal.
    const appleModifiers = detectAppleModifiers();
    const activateTerminalLink = (_event: MouseEvent, uri: string): void => {
      openTerminalLink(uri);
    };
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
      theme: { ...terminalTheme(getResolvedTheme()) },
      linkHandler: { activate: activateTerminalLink },
    });
    const fit = new FitAddon();
    const links = new WebLinksAddon(activateTerminalLink);
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
    // Track whether the viewport sits at the live edge so the "jump to latest"
    // button can appear only when the reader has scrolled up. State is written
    // only on transitions. Detection is doubled up for reliability across
    // renderers/paths: xterm's onScroll (buffer-level, gives the new ydisp) and
    // a DOM scroll listener on the xterm viewport element.
    const setLiveEdge = (atBottom: boolean) => {
      if (atBottom === atLiveEdgeRef.current) return;
      atLiveEdgeRef.current = atBottom;
      setAtLiveEdge(atBottom);
      if (atBottom) setNewOutputWhileAway(false);
    };
    const refreshLiveEdge = () => {
      const t = termRef.current;
      if (!t) return;
      const buf = t.buffer.active;
      setLiveEdge(buf.viewportY >= buf.baseY);
    };
    refreshLiveEdgeRef.current = refreshLiveEdge;
    const scrollDisposable = term.onScroll((ydisp) => {
      const t = termRef.current;
      const atBottom = t ? ydisp >= t.buffer.active.baseY : true;
      setLiveEdge(atBottom);
      // A pin queued by the preceding live write becomes stale the instant
      // the reader scrolls away. Without cancelling it, the delayed frame can
      // override the newer wheel/trackpad gesture and jump back down.
      if (!atBottom && liveViewportPinFrameRef.current !== null) {
        cancelAnimationFrame(liveViewportPinFrameRef.current);
        liveViewportPinFrameRef.current = null;
      }
    });
    const xtermViewportEl = containerRef.current?.querySelector<HTMLElement>(".xterm-viewport");
    xtermViewportEl?.addEventListener("scroll", refreshLiveEdge, { passive: true });
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

    // How much of the layout the on-screen keyboard is covering right now.
    // visualViewport shrinks (and can offset) under the keyboard while the
    // layout viewport may not, so this is the authoritative signal — read
    // through viewportInset(), which discounts the same shrink when it comes
    // from pinch zoom rather than a keyboard.
    const readKeyboardInset = () => {
      const vv = window.visualViewport;
      if (!vv) return 0;
      return viewportInset({
        visualHeight: vv.height,
        offsetTop: vv.offsetTop,
        scale: vv.scale,
        layoutHeight: window.innerHeight,
      }).keyboard;
    };

    // The soft keyboard is up. In this state we must NOT refit: shrinking the
    // row count to fit above the keyboard reflows the whole buffer (rewrapping
    // history, manufacturing blank bands) and churns the PTY geometry — the two
    // things that keep the scrollback heal from ever firing on mobile. Instead
    // we freeze the geometry and pan the (now taller-than-viewport) terminal so
    // the live input line stays visible above the keyboard.
    const keyboardPanActive = () =>
      coarsePointerRef.current && readKeyboardInset() > KEYBOARD_MIN_INSET_PX;

    const usesViewerPanFrame = () => {
      if (!coarsePointerRef.current) return false;
      if (displayOwnerRef.current === false && displayGeometryRef.current !== null) {
        return true;
      }
      return keyboardPanActive();
    };

    /** `.xterm`'s padding — the inset that keeps glyphs off the pane edge. */
    const terminalInset = () => {
      const xterm = terminalElement.querySelector<HTMLElement>(".xterm");
      if (!xterm) return { x: 0, y: 0 };
      const style = window.getComputedStyle(xterm);
      const px = (value: string) => Number.parseFloat(value) || 0;
      return {
        x: px(style.paddingLeft) + px(style.paddingRight),
        y: px(style.paddingTop) + px(style.paddingBottom),
      };
    };

    const getTerminalPixelSize = () => {
      const canvas = terminalElement.querySelector<HTMLCanvasElement>(".xterm-screen canvas");
      const canvasRect = canvas?.getBoundingClientRect();
      const elementRect = terminalElement.getBoundingClientRect();
      // The canvas is the grid alone; the pan frame has to carry the inset
      // around it too, or panning to the edge clips it. The element rect
      // already includes the inset.
      const inset = terminalInset();
      const useCanvas = canvasRect && canvasRect.width > 0 && canvasRect.height > 0;
      return {
        width: Math.max(1, Math.ceil(useCanvas ? canvasRect.width + inset.x : elementRect.width)),
        height: Math.max(
          1,
          Math.ceil(useCanvas ? canvasRect.height + inset.y : elementRect.height),
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

    /** Is there frame left to pan in the direction this drag is pulling? */
    const canPanFrameVertically = (deltaY: number) => {
      const maxTop = maxFrameScrollTop();
      if (maxTop <= 0 || deltaY === 0) return false;
      return deltaY > 0
        ? terminalViewport.scrollTop < maxTop - 0.5
        : terminalViewport.scrollTop > 0.5;
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
    // or two rows behind. Reconcile after xterm consumes a write and coalesce
    // streaming chunks to one refresh per animation frame.
    pinLiveViewportToBottomRef.current = () => {
      // The reader may legitimately be scrolled up in this buffer. Pin only
      // from the bottom — the pin exists to heal a slow-frame lag behind
      // streaming output, not to enforce position. During a reflow the
      // viewport transiently reads as bottom, so also hold off until the
      // resize-quiet window closes, or the pin would yank a scrolled-up
      // reader on every mobile-keyboard resize.
      if (performance.now() < resizeQuietUntilRef.current) return;
      if (term.buffer.active.viewportY < term.buffer.active.baseY) return;
      if (liveViewportPinFrameRef.current !== null) return;
      liveViewportPinFrameRef.current = requestAnimationFrame(() => {
        const canReconcile = () =>
          termRef.current === term &&
          performance.now() >= resizeQuietUntilRef.current &&
          term.buffer.active.viewportY >= term.buffer.active.baseY;
        if (!canReconcile()) {
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
          // The reader can move between either maintenance frame and the next
          // one. Re-check at execution time; the original at-bottom decision
          // is no longer authority to move their viewport.
          if (canReconcile()) reconcile();
        });
      });
    };

    const alignViewportToRows = () => {
      const viewport = getViewport();
      if (!viewport) return false;
      const rowHeight = getRowHeight();
      const maxTop = maxScrollTop(viewport);
      if (rowHeight <= 0 || maxTop <= 0) return false;

      let snapped = Math.max(
        0,
        Math.min(maxTop, Math.round(viewport.scrollTop / rowHeight) * rowHeight),
      );
      // The bottom is rarely a row multiple; a row-snap here would park the
      // viewport a few sub-row pixels shy of the live edge forever. Within
      // the last row, the edge wins.
      if (maxTop - snapped < rowHeight) snapped = maxTop;
      if (Math.abs(snapped - viewport.scrollTop) < 0.5) return false;
      viewport.scrollTop = snapped;
      return true;
    };

    const activeBufferIsAlternate = () => term.buffer.active.type === "alternate";

    // History lives in this terminal's own buffer: wheel is native xterm
    // scrolling (and native arrow-key conversion in the alternate buffer).
    // Only ctrl-zoom and the viewer pan frame are intercepted.
    term.attachCustomWheelEventHandler((event) => {
      if (event.ctrlKey) return true;
      const amount = wheelEventToPixels(event, term.rows);
      if (amount === 0) return true;

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

      return true;
    });

    const canScrollViewport = (deltaY: number) => {
      const viewport = getViewport();
      if (!viewport || deltaY === 0) return false;
      const maxTop = maxScrollTop(viewport);
      if (maxTop <= 0) return false;
      return deltaY > 0 ? viewport.scrollTop < maxTop - 0.5 : viewport.scrollTop > 0.5;
    };

    /**
     * The scroller the pane stack lives in, found by walking out of the portal
     * this terminal is rendered into. Resolved per gesture rather than cached:
     * the pane moves between the mobile stack and the desktop grid, and only
     * one of those layouts has a scrolling ancestor at all.
     */
    const findPageScroller = () => {
      let node: HTMLElement | null = terminalElement.parentElement;
      while (node) {
        const overflowY = window.getComputedStyle(node).overflowY;
        if ((overflowY === "auto" || overflowY === "scroll") && maxElementScrollTop(node) > 1) {
          return node;
        }
        node = node.parentElement;
      }
      return null;
    };

    /**
     * Can this terminal itself use a drag of `deltaY`? The same order the
     * gesture is actually applied in: pan the frozen frame, then this
     * terminal's scrollback. False means nothing here moves and the pane
     * stack should have it.
     */
    const terminalCanTakeDrag = (deltaY: number) => {
      if (coarsePointerRef.current && usesViewerPanFrame() && canPanFrameVertically(deltaY)) {
        return true;
      }
      // The alternate buffer has no scrollback — a full-screen TUI owns the
      // whole grid, which is most of what runs in these panes.
      if (activeBufferIsAlternate()) return false;
      return canScrollViewport(deltaY);
    };

    /**
     * Settle the route from the gesture's NET travel, not the last frame's
     * delta: which end of the scrollback a drag is pulling toward is the whole
     * question, and a few pixels of jitter at the start point the wrong way.
     * Called once the drag clears the tap slop; sub-slop pixels stay with the
     * terminal, where they have always gone.
     */
    const routeTouchScroll = (netDeltaY: number) => {
      const state = touchScrollRef.current;
      if (state.route !== "undecided" || netDeltaY === 0) return state.route;
      if (terminalCanTakeDrag(netDeltaY)) {
        state.route = "terminal";
      } else {
        state.route = "page";
        state.pageScroller = findPageScroller();
      }
      return state.route;
    };

    const applyTouchScrollDelta = (deltaX: number, deltaY: number) => {
      const state = touchScrollRef.current;
      state.scrollRemainderPx = 0;

      if (state.route === "page") {
        const scroller = state.pageScroller;
        return scroller ? scrollElementPixels(scroller, deltaY) : false;
      }

      if (coarsePointerRef.current && usesViewerPanFrame()) {
        const frameScroll = scrollViewerPanFrame(deltaX, deltaY);
        if (frameScroll.movedX || frameScroll.movedY) return true;
      }

      if (activeBufferIsAlternate()) return false;

      if (!scrollTerminalViewportPixels(deltaY)) return canScrollViewport(deltaY);

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
      // Row-snapping is the terminal's own tidy-up; a drag that went to the
      // pane stack must not jog this terminal's viewport on the way out.
      if (state.route !== "page" && !usesViewerPanFrame()) alignViewportToRows();
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
      snapToLiveEdge();
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
      touchScrollRef.current.route = "undecided";
      touchScrollRef.current.pageScroller = null;
    };

    const moveTouchScroll = (x: number, y: number, time: number) => {
      const state = touchScrollRef.current;
      if (!state.active) return;

      state.movedPx = Math.max(state.movedPx, Math.hypot(x - state.startX, y - state.startY));
      if (state.movedPx > TOUCH_TAP_SLOP_PX) routeTouchScroll(state.startY - y);
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
        if (state.route !== "page" && !usesViewerPanFrame()) alignViewportToRows();
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
      snapToLiveEdge();
      term.focus();
      event.preventDefault();
      event.stopPropagation();
    };

    term.attachCustomKeyEventHandler((event) => {
      // A Mac's ⌥ and ⌘ arrows: a word at a time, and the ends of the line.
      // xterm.js spells the first one for the wrong platform in this bundle
      // and does not send the second at all, so both are stated in
      // `appleArrowBytes`. Suppress the whole press rather than just the
      // keydown, for the reason spelled out under Shift+Enter below.
      const arrow = appleModifiers ? appleArrowBytes(event) : null;
      if (arrow && rawInputRef.current) {
        if (event.type === "keydown") {
          event.preventDefault();
          snapToLiveEdge();
          socketRef.current.sendBinary(arrow);
        }
        return false;
      }
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
          snapToLiveEdge();
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

    const touchTargets: HTMLElement[] = [terminalTouchTarget];
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
      const colsChanged = cols !== last.cols;
      pushOp("resize", `${last.cols}x${last.rows}→${cols}x${rows}${colsChanged ? " cols" : ""}`);
      lastSizeRef.current = { cols, rows };
      // A genuine fit changed the grid, so it just reflowed: open the
      // reflow-quiet window here rather than on every fitTerminal() call, so a
      // no-op fit (e.g. the keyboard closing back to the same rows) never
      // needlessly blocks the heal.
      resizeQuietUntilRef.current = performance.now() + RESIZE_QUIET_MS;
      invalidateScrollbackForResizeRef.current();
      markResizeSentRef.current(cols, rows);
      if (displayOwnerRef.current === true) {
        socketRef.current.sendJson({ type: "resize", cols, rows });
      }
      // Only a WIDTH change rewraps history, so only a width change owes a
      // reseed. A rows-only change — above all a mobile on-screen keyboard
      // opening and closing, which fires constantly — must not, or every
      // toggle would rewrite the whole buffer.
      if (colsChanged) historyReseedPendingRef.current = true;
    };

    const fitTerminal = (preserveScroll: boolean) => {
      // Parked (background) instance: never fit or resize. Its host may be in
      // an offscreen park at a different size; fitting would churn the PTY
      // geometry and disturb whoever is actually looking at this session. It
      // reclaims + fits when re-activated (see the `active` effect).
      if (!activeRef.current) return;
      const anchor = preserveScroll ? captureScrollAnchor() : null;
      // Soft keyboard up: freeze the geometry and pan instead of refitting.
      // Shrinking rows to fit above the keyboard would reflow the whole buffer
      // (rewrapping history, spilling blank bands) and churn the PTY size on
      // every open/close — the exact churn that jams the scrollback heal on
      // mobile. No fit()/resize() here means no reflow, no PTY notify, and the
      // reflow-quiet window stays closed so the heal keeps running.
      if (keyboardPanActive()) {
        layoutTerminalSurface(anchor?.atBottom ?? true);
        requestAnimationFrame(() => layoutTerminalSurface(anchor?.atBottom ?? true));
        return;
      }
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
          // A real reflow just happened: hold the pin and destructive rewrites
          // off until it settles.
          resizeQuietUntilRef.current = performance.now() + RESIZE_QUIET_MS;
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

    // The on-screen keyboard shrinks visualViewport; depending on the browser
    // (notably iOS Safari) the layout viewport — and thus the ResizeObserver
    // above — may not move at all. Drive a relayout directly off visualViewport
    // so the keyboard freeze/pan engages regardless. Coarse pointers only: on a
    // desktop this event fires for pinch-zoom, which must still refit normally.
    const vv = window.visualViewport;
    const onVisualViewport = () => {
      if (coarsePointerRef.current) scheduleFit();
    };
    vv?.addEventListener("resize", onVisualViewport);
    vv?.addEventListener("scroll", onVisualViewport);

    // ResizeObserver only fires on size changes; two mount-time races leave
    // the terminal misfitted at a stable size until something (like toggling
    // the sidebar) nudges the container: the monospace font finishing its
    // load after the initial fit measured fallback-font cell metrics, and a
    // background tab's throttled layout settling only on refocus.
    const onVisibility = () => {
      if (document.visibilityState === "visible") scheduleFit();
    };
    document.addEventListener("visibilitychange", onVisibility);

    /*
     * devicePixelRatio moves without a reload — browser zoom, dragging the
     * window to a display with a different scale, DevTools device emulation.
     * The GPU renderer rasterized its glyph atlas for the old ratio and has no
     * idea, so every glyph keeps its old device-pixel size while the canvas is
     * now measured against a new one: 2 -> 3 paints type half again as large
     * as its cell, and lines run off the pane instead of wrapping. Clear the
     * atlas (it re-rasterizes at the current ratio) and refit.
     *
     * A media query is the only DPR change event there is, and it has to be
     * rebuilt each time because the ratio it tests for is baked into it.
     */
    let dprQuery: MediaQueryList | null = null;
    const onDevicePixelRatioChange = () => {
      webglAddonRef.current?.clearTextureAtlas();
      watchDevicePixelRatio();
      scheduleFit();
    };
    function watchDevicePixelRatio() {
      dprQuery?.removeEventListener("change", onDevicePixelRatioChange);
      dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      dprQuery.addEventListener("change", onDevicePixelRatioChange);
    }
    watchDevicePixelRatio();
    document.fonts?.ready
      .then(() => {
        scheduleFit();
      })
      .catch(() => {});

    return () => {
      ro.disconnect();
      scrollDisposable.dispose();
      xtermViewportEl?.removeEventListener("scroll", refreshLiveEdge);
      vv?.removeEventListener("resize", onVisualViewport);
      vv?.removeEventListener("scroll", onVisualViewport);
      document.removeEventListener("visibilitychange", onVisibility);
      dprQuery?.removeEventListener("change", onDevicePixelRatioChange);
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
      stopTouchMomentum();
      if (resizeTimer) clearTimeout(resizeTimer);
      onDataDisposableRef.current?.dispose();
      if (uploadStatusTimerRef.current) clearTimeout(uploadStatusTimerRef.current);
      if (liveViewportPinFrameRef.current !== null) {
        cancelAnimationFrame(liveViewportPinFrameRef.current);
        liveViewportPinFrameRef.current = null;
      }
      pendingLiveSeedWritesRef.current.clear();
      if (liveTerminalWriteIdleTimerRef.current) {
        clearTimeout(liveTerminalWriteIdleTimerRef.current);
        liveTerminalWriteIdleTimerRef.current = null;
      }
      if (liveTerminalWriteSyncTimerRef.current) {
        clearTimeout(liveTerminalWriteSyncTimerRef.current);
        liveTerminalWriteSyncTimerRef.current = null;
      }
      liveTerminalWritesRef.current.clear();
      liveTerminalWriteFlushPendingRef.current = false;
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
    // through `socketRef`, so it doesn't need to be in deps. pushOp is stable.
  }, [snapToLiveEdge, pushOp]);

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
          beginUploadTrack(clientId, file.size);
          reserveUploadReconciliation(clientId, file.name || "Image");
          const result = await socket.uploadFile(file, {
            uploadId: clientId,
            onProgress: (uploaded, total) => advanceUploadTrack(clientId, uploaded, total),
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
            error instanceof DirectSessionUploadError && error.code === "outcome_unknown";
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
        } finally {
          endUploadTrack(clientId);
        }
      }
      if (sent > 0) {
        termRef.current?.focus();
      }
    },
    [
      advanceUploadTrack,
      beginUploadTrack,
      endUploadTrack,
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
          beginUploadTrack(uploadId, file.size);
          reserveUploadReconciliation(uploadId, file.name || "File");
          const result = await socket.uploadFile(file, {
            uploadId,
            onProgress: (uploaded, total) => advanceUploadTrack(uploadId, uploaded, total),
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
          if (error instanceof DirectSessionUploadError && error.code === "outcome_unknown") {
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
        } finally {
          endUploadTrack(uploadId);
        }
      }
      if (sent > 0) {
        termRef.current?.focus();
      }
    },
    [
      advanceUploadTrack,
      beginUploadTrack,
      dismissUploadReconciliation,
      endUploadTrack,
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
      if (displayOwnerRef.current !== true || !socket.dcOpen) return;
      const filtered = stripDeviceAttributeResponses(d);
      const mapped = rewriteMobileReturn(
        filtered,
        mobileReturnModeRef.current,
        coarsePointerRef.current,
        mobileReturnBytesRef.current,
      );
      if (mapped !== filtered) lastMobileReturnAtRef.current = performance.now();
      const withAttachments = appendAttachmentsForSubmit(mapped);
      if (withAttachments) {
        if (!socket.sendBinary(enc.encode(withAttachments))) return;
      }
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
  }, [appendAttachmentsForSubmit, rawInput, socket, schedulePredictionSweep]);

  // Resend the last known size on (re)connection so the daemon's PTY matches.
  useEffect(() => {
    if (!socket.dcOpen) {
      lastSentSizeRef.current = null;
      return;
    }
    if (displayOwnerRef.current !== true) return;
    const { cols, rows } = lastSizeRef.current;
    const key = `${cols}x${rows}`;
    if (lastSentSizeRef.current === key) return;
    if (socket.sendJson({ type: "resize", cols, rows })) lastSentSizeRef.current = key;
  }, [socket.dcOpen, socket.sendJson]);

  useImperativeHandle(
    ref,
    () => ({
      sendInput: (data) => {
        snapToLiveEdge();
        socket.sendBinary(data);
      },
      resize: (cols, rows) => {
        const last = lastSizeRef.current;
        lastSizeRef.current = { cols, rows };
        if (cols !== last.cols || rows !== last.rows) {
          invalidateScrollbackForResizeRef.current();
        }
        // A width change owes a history reseed (see notifyResizeIfChanged).
        if (cols !== last.cols) {
          historyReseedPendingRef.current = true;
          resizeQuietUntilRef.current = performance.now() + RESIZE_QUIET_MS;
        }
        if (displayOwnerRef.current === true) {
          socket.sendJson({ type: "resize", cols, rows });
        } else {
          socket.sendJson({ type: "focus_view", cols, rows });
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
          // What the user is actually looking at: the live terminal is the
          // only buffer, so either they are scrolled up in it or at the edge.
          const liveScrolledUp = !!buf && buf.viewportY < buf.baseY;
          const rowsFrom = (t: XTerm, b: NonNullable<typeof buf>) => {
            const out: string[] = [];
            for (let i = 0; i < t.rows; i += 1) {
              out.push(b.getLine(b.viewportY + i)?.translateToString(true) ?? "");
            }
            return out;
          };
          const viewSource = liveScrolledUp ? "live-scrolled" : "live";
          const visibleRows = term && buf ? rowsFrom(term, buf) : [];
          // Whole-buffer scan: turn "there's a blank section / duplicate
          // content" into precise data. Blank RUNS locate empty bands; the
          // width histogram exposes the narrow(≈phone)+wide(≈desktop) mix that
          // is the phone-reflow-baking signature; duplicateLines surface
          // repeated content (same line committed twice). Bounded so a huge
          // scrollback can't wedge the capture.
          const scanBuffer = (b: NonNullable<typeof buf>) => {
            const max = Math.min(b.length, 20000);
            const widths = { "1-40": 0, "41-64": 0, "65-100": 0, "101-140": 0, "141+": 0 };
            const blankRuns: Array<{ start: number; len: number }> = [];
            const counts = new Map<string, number>();
            let blankTotal = 0;
            let runStart = -1;
            let runLen = 0;
            const lineAt = (i: number) => b.getLine(i)?.translateToString(true) ?? "";
            for (let i = 0; i < max; i += 1) {
              const s = lineAt(i);
              if (s.length === 0) {
                blankTotal += 1;
                if (runStart < 0) {
                  runStart = i;
                  runLen = 1;
                } else runLen += 1;
                continue;
              }
              if (runStart >= 0) {
                if (runLen >= 4) blankRuns.push({ start: runStart, len: runLen });
                runStart = -1;
                runLen = 0;
              }
              const n = s.length;
              if (n <= 40) widths["1-40"] += 1;
              else if (n <= 64) widths["41-64"] += 1;
              else if (n <= 100) widths["65-100"] += 1;
              else if (n <= 140) widths["101-140"] += 1;
              else widths["141+"] += 1;
              if (n >= 20) counts.set(s, (counts.get(s) ?? 0) + 1);
            }
            if (runStart >= 0 && runLen >= 4) blankRuns.push({ start: runStart, len: runLen });
            blankRuns.sort((a, c) => c.len - a.len);
            const topBlankRuns = blankRuns.slice(0, 8);
            const context: string[] = [];
            const top = topBlankRuns[0];
            if (top) {
              for (
                let i = Math.max(0, top.start - 2);
                i < Math.min(max, top.start + top.len + 2);
                i += 1
              ) {
                context.push(`${i}:${lineAt(i).slice(0, 70)}`);
              }
            }
            const duplicateLines = [...counts.entries()]
              .filter(([, c]) => c >= 2)
              .sort((a, c) => c[1] - a[1])
              .slice(0, 8)
              .map(([line, count]) => ({ count, sample: line.slice(0, 70) }));
            return {
              scanned: max,
              length: b.length,
              blankTotal,
              blankRunCount: blankRuns.length,
              topBlankRuns,
              largestBlankRunContext: context,
              widths,
              duplicateLines,
            };
          };
          const bufferScan = term && buf ? scanBuffer(buf) : null;
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
            scrollback: {
              cacheDirty: scrollbackCacheDirtyRef.current,
              reseedPending: historyReseedPendingRef.current,
              deepSeeded: unifiedDeepSeededRef.current,
            },
            fonts: document.fonts?.status ?? "unknown",
            dpr: window.devicePixelRatio,
            viewport: { w: window.innerWidth, h: window.innerHeight },
            visibility: document.visibilityState,
            // Recent resize->repaint latencies (ms): toFirstByte is the app's
            // first response, toSettle is when the repaint burst went quiet.
            resizeTimings: resizeTimingsRef.current.slice(-12),
            // Recent buffer-shaping ops (ms before this capture) — the seed /
            // reseed / resize sequence that produced the current render.
            opLog: opLogRef.current.slice(-48).map((entry) => ({
              msAgo: Math.round(Date.now() - entry.t),
              op: entry.op,
              info: entry.info,
            })),
            tail,
            bufferScan,
          };
        };
        const before = capture();
        fitTerminalRef.current(true);
        if (displayOwnerRef.current === true) {
          const { cols, rows } = lastSizeRef.current;
          socketRef.current.sendJson({ type: "resize", cols, rows });
        }
        const liveAtEdge = () => {
          const b = termRef.current?.buffer.active;
          return !b || b.viewportY >= b.baseY;
        };
        if (!liveAtEdge()) {
          // Scrolled up reading history: never rewrite the buffer under the
          // reader. The refit above is the whole heal.
          await new Promise((resolve) => setTimeout(resolve, 800));
        } else {
          // At the live edge: drive a fresh authoritative reseed to
          // convergence. Only clean snapshots apply (offset-anchored replay
          // slices cover live bytes), so this can never roll the terminal
          // back. Keep requesting promptly until one converges or we give up.
          historyReseedPendingRef.current = true;
          const deadline = Date.now() + 6000;
          while (
            historyReseedPendingRef.current &&
            liveAtEdge() &&
            socketRef.current.state === "open" &&
            Date.now() < deadline
          ) {
            if (!scrollbackSnapshotInFlightRef.current) {
              scrollbackCacheDirtyRef.current = true;
              requestSnapshotRef.current();
            }
            await new Promise((resolve) => setTimeout(resolve, 300));
          }
        }
        const after = capture();
        return {
          kind: "terminal-refresh-diagnostics",
          sessionId,
          userAgent: navigator.userAgent,
          before,
          after,
        };
      },
      uploadFile: async (file, options) => {
        const uploadId = options?.uploadId ?? makeClientId();
        const fileName = file.name || "file";
        try {
          beginUploadTrack(uploadId, file.size);
          reserveUploadReconciliation(uploadId, fileName);
          const result = await socket.uploadFile(file, {
            name: fileName,
            onProgress: (uploaded, total) => advanceUploadTrack(uploadId, uploaded, total),
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
          if (error instanceof DirectSessionUploadError && error.code === "outcome_unknown") {
            try {
              promoteUploadReconciliation(uploadId, fileName, error.message);
            } catch {
              // Preserve the already-recorded ambiguity and storage lock.
            }
          } else if (!(error instanceof UploadReconciliationBlockedError)) {
            dismissUploadReconciliation(uploadId);
          }
          throw error;
        } finally {
          endUploadTrack(uploadId);
        }
      },
      focus: () => {
        focusViewRef.current();
        termRef.current?.focus();
      },
      submit: () => {
        snapToLiveEdge();
        const payload = appendAttachmentsForSubmit("\r");
        socket.sendBinary(payload);
        termRef.current?.focus();
      },
      pasteFromClipboard,
      pasteDataTransfer,
      pasteText,
      takeControl: () => takeControlNowRef.current(),
      openUpload: () => fileInputRef.current?.click(),
      snapToLiveEdge,
    }),
    [
      advanceUploadTrack,
      appendAttachmentsForSubmit,
      assertUploadReconciliation,
      beginUploadTrack,
      dismissUploadReconciliation,
      endUploadTrack,
      snapToLiveEdge,
      pasteDataTransfer,
      pasteFromClipboard,
      pasteText,
      promoteUploadReconciliation,
      reserveUploadReconciliation,
      socket,
      sessionId,
    ],
  );

  const settledAttachments = pendingAttachments.filter(
    (attachment) => attachment.status !== "uploading",
  );

  // While the connecting overlay is up it is the pane's transport story, told
  // in full sentences — the corner chip would be the same news at 10px. The
  // chip's node stays mounted either way: it is the live region, so it keeps
  // announcing the transitions a screen reader would otherwise miss.
  const connectingOverlayOwnsStatus =
    !painted && (socket.state !== "open" || (socket.v3 && !socket.dcOpen));

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
    // chip / pasted path per session app); only non-image files take the
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
      aria-label="Session terminal"
      data-session-id={sessionId}
      data-input-ready={socket.dcOpen && controlState?.owner === true}
      aria-busy={!socket.dcOpen}
      onFocusCapture={() => {
        focusViewRef.current();
      }}
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
      {/* Before the first byte lands there is nothing under here but the
          terminal's own black: the overlay explains the wait, and gets out of
          the way the moment output arrives. */}
      <ConnectingOverlay
        sharedConnectionReady={daemonReady}
        socketState={socket.state}
        v3={socket.v3}
        dcOpen={socket.dcOpen}
        refusal={socket.signedRtcRefusal}
        painted={painted}
        hostName={hostIdentityQuery.data?.name ?? null}
        hostOffline={hostIdentityQuery.data?.status === "offline"}
      />
      {socket.state === "unauthorized" && (
        <div className="pointer-events-auto absolute inset-x-2 top-2 z-40 flex items-center justify-center gap-3 rounded-md border border-destructive/45 bg-background/95 px-3 py-2 text-xs text-foreground shadow-lg backdrop-blur">
          <span>You've been signed out.</span>
          <Link
            href="/login"
            className="rounded border border-border bg-card px-2 py-1 font-medium hover:bg-accent"
          >
            Sign in
          </Link>
        </div>
      )}
      {socket.state === "disabled" && (
        <div className="pointer-events-none absolute inset-x-2 top-2 z-20 rounded-md border border-border bg-background/95 px-3 py-2 text-center text-xs text-foreground shadow-lg backdrop-blur">
          Transport disabled by this server.
        </div>
      )}
      {showReconnectBanner && socket.state !== "unauthorized" && socket.state !== "disabled" && (
        <div
          role="status"
          data-testid="terminal-reconnect-banner"
          className="pointer-events-none absolute inset-x-2 top-2 z-20 rounded-md border border-warning/45 bg-background/95 px-3 py-2 text-center text-xs text-foreground shadow-lg backdrop-blur"
        >
          Connection paused. Your terminal output is still available to copy.
        </div>
      )}
      {(uploadReconciliations.length > 0 || uploadReconciliationFault) && (
        <div
          data-testid="upload-reconciliation"
          role="alert"
          className="pointer-events-auto absolute left-2 top-2 z-40 flex max-w-[min(32rem,calc(100%-1rem))] flex-col gap-2 rounded-md border border-warning/60 bg-background/95 p-2 text-xs text-foreground shadow-lg backdrop-blur"
        >
          {uploadReconciliationFault && (
            <div data-testid="upload-reconciliation-fault" className="font-medium text-warning">
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
      {/* Upload progress reads as a hairline under the pane header. Uploads in
          flight are only ever this bar: a thumbnail for something that is
          about to disappear on its own just flashes. */}
      <UploadProgressBar ratio={uploadRatio(Object.values(uploadTracks))} />
      {/* What survives the upload does get a chip — a queued attachment (the
          deferred paste mode) needs somewhere to be seen and removed, and a
          failed one needs to say so. */}
      {settledAttachments.length > 0 && (
        <div className="pointer-events-auto absolute bottom-2 left-2 z-20 flex max-w-[calc(100%-1rem)] gap-2 overflow-x-auto rounded-md border border-border bg-background/90 p-1 shadow-lg backdrop-blur">
          {settledAttachments.map((attachment) => (
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
      {/* Followers keep selectable output and explicitly request control. */}
      {controlState && !controlState.owner && (
        <div className="absolute inset-x-2 top-2 z-30 flex items-center justify-center gap-2.5 rounded-md border border-border bg-background/95 px-3 py-2">
          <span className="rounded bg-popover/90 px-2 py-0.5 text-xs text-muted-foreground ring-1 ring-border">
            Another view has control
            {typeof controlState.cols === "number" && typeof controlState.rows === "number"
              ? ` · ${controlState.cols}x${controlState.rows}`
              : ""}
            {controlState.viewers > 1 ? ` · ${controlState.viewers} viewers` : ""}
          </span>
          <button
            type="button"
            onClick={() => takeControlNow()}
            className="rounded-lg border border-border bg-popover px-4 py-2 text-sm font-medium shadow-lg shadow-black/20 transition-colors hover:bg-accent dark:shadow-black/40"
          >
            Take control
          </button>
        </div>
      )}
      {/* Jump-to-latest: appears only when the reader has scrolled up off the
          live edge. Sits above the mobile modifier bar (which lives outside the
          terminal, below it) and clears the room's right edge. Icon-only when
          quiet; grows a label + pulse when output arrived while scrolled away. */}
      {!atLiveEdge && (
        <button
          type="button"
          data-testid="terminal-jump-to-latest"
          aria-label={newOutputWhileAway ? "Jump to latest output (new output)" : "Jump to latest"}
          onClick={() => {
            snapToLiveEdge();
            setNewOutputWhileAway(false);
            termRef.current?.focus();
          }}
          className="pointer-events-auto absolute bottom-3 right-3 z-30 flex items-center gap-1.5 rounded-full border border-border bg-popover/95 py-2 pr-3 pl-2.5 text-xs font-medium text-foreground shadow-lg backdrop-blur transition-colors hover:bg-accent"
        >
          <ArrowDown className="size-4" aria-hidden />
          {newOutputWhileAway && (
            <>
              <span>New</span>
              <span className="size-1.5 rounded-full bg-success" aria-hidden />
            </>
          )}
        </button>
      )}
      {/* Live region stays mounted so screen readers hear transitions; the
          visible chip only appears when there is something worth saying —
          a healthy "open" connection is the norm, not news. */}
      <div
        className={
          (socket.state !== "open" || channelPending || exitBanner || uploadStatus) &&
          !connectingOverlayOwnsStatus
            ? "pointer-events-none absolute right-2 top-2 rounded bg-popover/90 px-2 py-0.5 text-[10px] text-muted-foreground ring-1 ring-border"
            : "sr-only"
        }
        aria-live="polite"
      >
        {[
          socket.state !== "open" ? SOCKET_STATE_COPY[socket.state] : null,
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

function uploadReconciliationStorageKey(sessionId: string): string {
  return `${UPLOAD_RECONCILIATION_STORAGE_PREFIX}:${sessionId}`;
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

function dispatchUploadReconciliationEvent(sessionId: string): void {
  try {
    window.dispatchEvent(new CustomEvent(UPLOAD_RECONCILIATION_EVENT, { detail: { sessionId } }));
  } catch {
    // The in-memory latch is authoritative for the current call even if a
    // hostile/broken event target prevents another mounted instance syncing.
  }
}

function readUploadReconciliationHistoryFallback(
  sessionId: string,
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
  const fallback = (fallbacks as Record<string, unknown>)[sessionId];
  if (typeof fallback !== "object" || fallback === null) return null;
  const records = (fallback as Record<string, unknown>).records;
  const fault = (fallback as Record<string, unknown>).fault;
  if (!Array.isArray(records) || typeof fault !== "string") return null;
  return { records: records as UploadReconciliation[], fault };
}

function writeUploadReconciliationHistoryFallback(
  sessionId: string,
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
    if (fallback) fallbacks[sessionId] = fallback;
    else delete fallbacks[sessionId];
    window.history.replaceState(
      { ...current, __spawnUploadReconciliationFallback: fallbacks },
      document.title,
    );
  } catch {
    // sessionStorage or the in-memory latch still owns safety. This fallback
    // must never replace the typed upload-blocking error with a DOM exception.
  }
}

function loadUploadReconciliationState(sessionId: string): UploadReconciliationState {
  if (typeof window === "undefined") return { records: [], fault: null };
  const runtime = uploadReconciliationRuntime();
  const historyFallback = readUploadReconciliationHistoryFallback(sessionId);
  const memory = mergeUploadReconciliations(
    runtime.memory.get(sessionId) ?? [],
    historyFallback?.records ?? [],
  );
  if (historyFallback) runtime.faults.set(sessionId, historyFallback.fault);
  try {
    const raw = window.sessionStorage.getItem(uploadReconciliationStorageKey(sessionId));
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
        sessionId,
        "Upload reconciliation capacity was exceeded; no records were discarded.",
      );
    }
    runtime.memory.set(sessionId, records);
    return { records, fault: runtime.faults.get(sessionId) ?? null };
  } catch {
    const fault = uploadReconciliationStorageFault();
    const blocked = blockReservedUploadReconciliations(memory);
    runtime.memory.set(sessionId, blocked);
    runtime.faults.set(sessionId, fault);
    writeUploadReconciliationHistoryFallback(sessionId, { records: blocked, fault });
    return { records: blocked, fault };
  }
}

function persistUploadReconciliations(
  sessionId: string,
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
  const existingFault = runtime.faults.get(sessionId) ?? null;
  try {
    const key = uploadReconciliationStorageKey(sessionId);
    if (records.length === 0) window.sessionStorage.removeItem(key);
    else window.sessionStorage.setItem(key, JSON.stringify(records));
    runtime.memory.set(sessionId, records);
    if (clearFault) {
      runtime.faults.delete(sessionId);
      writeUploadReconciliationHistoryFallback(sessionId, null);
    } else if (existingFault) {
      runtime.faults.set(sessionId, existingFault);
      writeUploadReconciliationHistoryFallback(sessionId, {
        records,
        fault: existingFault,
      });
    } else {
      writeUploadReconciliationHistoryFallback(sessionId, null);
    }
    dispatchUploadReconciliationEvent(sessionId);
  } catch {
    const blocked = blockReservedUploadReconciliations(recordsOnFailure);
    runtime.memory.set(sessionId, blocked);
    const fault = uploadReconciliationStorageFault();
    runtime.faults.set(sessionId, fault);
    writeUploadReconciliationHistoryFallback(sessionId, {
      records: blocked,
      fault,
    });
    dispatchUploadReconciliationEvent(sessionId);
    throw new UploadReconciliationBlockedError(fault);
  }
}

function reserveUploadReconciliationSlot(
  sessionId: string,
  uploadId: string,
  fileName: string,
): void {
  const state = loadUploadReconciliationState(sessionId);
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
    runtime.memory.set(sessionId, records);
    runtime.faults.set(sessionId, state.fault);
    writeUploadReconciliationHistoryFallback(sessionId, { records, fault: state.fault });
    dispatchUploadReconciliationEvent(sessionId);
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
  uploadReconciliationRuntime().memory.set(sessionId, next);
  persistUploadReconciliations(sessionId, next, next);
}

function promoteUploadReconciliationSlot(
  sessionId: string,
  uploadId: string,
  fileName: string,
  message: string,
): void {
  const state = loadUploadReconciliationState(sessionId);
  const existing = state.records.find((record) => record.uploadId === uploadId);
  if (state.fault) {
    dispatchUploadReconciliationEvent(sessionId);
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
  persistUploadReconciliations(sessionId, next, state.records);
}

function assertUploadReconciliationActive(sessionId: string, uploadId: string): void {
  const state = loadUploadReconciliationState(sessionId);
  const record = state.records.find((candidate) => candidate.uploadId === uploadId);
  if (state.fault) {
    dispatchUploadReconciliationEvent(sessionId);
    throw new UploadReconciliationBlockedError(state.fault);
  }
  if (!record || record.phase === "blocked") {
    throw new UploadReconciliationBlockedError(
      "This upload no longer has an active durable safety reservation.",
    );
  }
}

function dismissUploadReconciliationSlot(
  sessionId: string,
  uploadId: string,
  recoverFault: boolean,
): void {
  const state = loadUploadReconciliationState(sessionId);
  const next = state.records.filter((record) => record.uploadId !== uploadId);
  persistUploadReconciliations(sessionId, next, state.records, recoverFault);
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
 *  real users; DEC synchronized-output frames keep repaint fragments atomic.
 *  Automation contexts (`navigator.webdriver` — Playwright, CI) also keep
 *  the DOM renderer, whose `.xterm-rows` text the e2e suites assert on.
 *  `localStorage.spawnRenderer` overrides both ways: "gpu" forces WebGL and
 *  "dom" forces the fallback. */
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
 * Emitted between the history text and the screen repaint: scrolls the viewport
 * rows the history occupies up into scrollback, so the absolute-addressed screen
 * repaint that follows paints a blank viewport instead of overwriting the newest
 * history lines.
 *
 * Scroll by the last NON-BLANK viewport row, not the cursor row. When the
 * seeded history ends in blank lines — which old-worker committed logs still
 * carry — the cursor sits well below the last content, and scrolling to the
 * cursor pushed a screenful of blank rows into scrollback: the "gap" wedged at
 * the history↔live-screen seam that a reseed left behind. Trailing blank rows
 * are frame padding, never content, so excluding them loses nothing; interior
 * blanks (rows above the last content) are still scrolled up intact.
 */
function flushViewportIntoScrollback(term: XTerm): string {
  const buffer = term.buffer.active;
  let occupied = 0;
  // The rows to flush are the screen's, which start at baseY; viewportY is
  // where the reader is looking. The reseed gate keeps them equal here, but
  // the phone's worker has no such gate, and the two must measure alike.
  for (let row = 0; row < term.rows; row += 1) {
    const line = buffer.getLine(buffer.baseY + row);
    if (line && line.translateToString(true).length > 0) occupied = row + 1;
  }
  if (occupied <= 0) return "";
  return `\x1b[${term.rows};1H${"\n".repeat(occupied)}`;
}

/**
 * Worker-backed sessions ship snapshots as exact terminal byte streams,
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
function _overlayWriteOps(
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
  // Committed history becomes the live terminal's own scrollback: flowing
  // text, then a viewport flush so the screen repaint below cannot overwrite
  // the newest history lines. No resize ops: the live terminal is fit-sized
  // and must never be geometry-walked; history reflows natively instead.
  const storied = parseHistoryReplay(exact);
  if (storied) {
    return [
      { data: storied.history },
      { data: flushViewportIntoScrollback },
      { data: storied.screen.data },
    ];
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
  // back to the app after replay can echo fragments like "0;276;0c".
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

/**
 * Is a drag carrying files, asked while it is still in the air?
 *
 * Three signals rather than one, because mid-drag every engine withholds
 * something: `files` is empty until the drop in Chrome, and WebKit — which is
 * the whole of the macOS desktop app — can hand back an `items` list it will
 * not let anything be read from. `types` is the one every engine fills on
 * `dragenter`, and getting this wrong costs the drop hint that tells someone
 * the terminal will take what they are holding.
 */
function hasFileTransfer(data: DataTransfer): boolean {
  return (
    Array.from(data.types).includes("Files") ||
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
