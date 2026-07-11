"use client";

import { ClipboardAddon } from "@xterm/addon-clipboard";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal as XTerm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { Upload } from "lucide-react";
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
import { useAgentSocket } from "@/components/terminal/useAgentSocket";
import { agents as agentsApi } from "@/lib/api";
import type { DisplayControlState } from "@/lib/ws";

const TERMINAL_FONT_SIZE = 13;
const TERMINAL_LINE_HEIGHT = 1.2;
const TERMINAL_LINE_HEIGHT_PX = TERMINAL_FONT_SIZE * TERMINAL_LINE_HEIGHT;
const TERMINAL_SCROLLBACK_LINES = 100_000;
const TERMINAL_SNAPSHOT_LINES = 10_000;
// Defer the deep (10k-line) scrollback warm so connecting to an agent paints
// the small connect-time history first instead of competing with a multi-MB
// capture transfer and offscreen render.
const SCROLLBACK_WARM_DELAY_MS = 1_200;
// Server-side captures can time out without a reply; clear the in-flight
// flag eventually or scrollback fetches would wedge for the whole session.
const SCROLLBACK_SNAPSHOT_TIMEOUT_MS = 6_000;
// The cache refresh debounces on output, but a continuously-streaming agent
// would postpone it forever — bound how stale the cache is allowed to get.
const SCROLLBACK_REFRESH_MAX_WAIT_MS = 2_500;
// Without a DataChannel, snapshots share the relay WebSocket with keystroke
// echoes: a multi-hundred-KB capture every couple of seconds head-of-line
// blocks typing on slow links. Refresh far less often and capture fewer
// lines; opening scrollback still fetches the full depth once.
const SCROLLBACK_RELAY_REFRESH_DEBOUNCE_MS = 5_000;
const SCROLLBACK_RELAY_REFRESH_MAX_WAIT_MS = 20_000;
const SCROLLBACK_RELAY_CACHE_LINES = 2_000;
// Never re-render the overlay underneath an actively-scrolling user: the
// reset+rewrite collapses the scroll range mid-gesture and yanks the view.
const SCROLLBACK_RERENDER_IDLE_MS = 350;
// Recent live DataChannel chunks kept for replay on top of offset-anchored
// snapshots. Snapshots travel the slow relay path while live bytes ride the
// DataChannel, so a fresh capture can lag chunks already rendered locally;
// replaying chunks past the capture's stream offset makes re-renders exact.
const SCROLLBACK_DC_REPLAY_BUFFER_BYTES = 4 * 1024 * 1024;
// How long after a local live-buffer rewrite a keystroke still triggers a
// covering repaint (the rewrite->repaint cursor desync window plus slack).
const LIVE_REWRITE_ECHO_GUARD_MS = 5_000;
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
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
};

export interface TerminalHandle {
  /** Raw stdin into the agent (binary frame). */
  sendInput: (bytes: Uint8Array | string) => void;
  /** Tell the agent the new TTY size. */
  resize: (cols: number, rows: number) => void;
  /** Force a re-fit against the current container size. */
  fit: () => void;
  /** Last known terminal geometry. */
  getSize: () => TerminalGeometry;
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
  const scrollbackRerenderTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Daemon-stamped DataChannel stream offset for each snapshot payload.
  const scrollbackSnapshotOffsetsRef = useRef(new WeakMap<Uint8Array, number>());
  const scrollbackRenderInFlightRef = useRef(false);
  // Set when the terminal width changes: the next anchored snapshot rewrites
  // the live buffer so seeded history reflows at the new width.
  const historyReseedPendingRef = useRef(false);
  // Timestamp of the last local live-buffer rewrite; keystrokes shortly
  // after request an extra repaint to cover stale-cursor echo artifacts.
  const liveRewriteAtRef = useRef(0);
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
  const renderScrollbackSnapshotRef = useRef<(bytes: Uint8Array | null, reveal: boolean) => void>(
    () => {},
  );
  const prepareScrollbackSnapshotRef = useRef<() => void>(() => {});
  const revealRenderedScrollbackRef = useRef<() => boolean>(() => false);
  const requestScrollbackSnapshotRef = useRef<(initialDeltaY?: number) => boolean>(() => false);
  const scheduleScrollbackCacheRefreshRef = useRef<(delayMs?: number) => void>(() => {});
  const scrollbackWheelHandlerRef = useRef<(event: WheelEvent) => boolean>(() => true);
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

  const recordScrollbackUserPosition = useCallback((overlay: HTMLElement) => {
    scrollbackUserScrollGenerationRef.current += 1;
    scrollbackDesiredScrollTopRef.current = overlay.scrollTop;
    scrollbackLastUserScrollAtRef.current = Date.now();
    if (!scrollbackRenderInFlightRef.current) {
      scrollbackStableLineRef.current = scrollbackTermRef.current?.buffer.active.viewportY ?? null;
    }
  }, []);

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
    (bytes: Uint8Array | null): boolean => {
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
      // Clear via escape sequences instead of term.reset(): reset() also wipes
      // terminal modes (bracketed paste, mouse reporting, application cursor
      // keys) that the agent still believes are active, garbling input until
      // the next full repaint.
      term.write(`\x1b[0m\x1b[H\x1b[2J\x1b[3J${formatSnapshotForXterm(decodeUtf8(bytes))}`);
      for (const slice of replaySlices.slice(0, -1)) {
        term.write(slice);
      }
      term.write(
        replaySlices.length > 0 ? (replaySlices[replaySlices.length - 1] as Uint8Array) : "",
        () => {
          term.scrollToBottom();
        },
      );
      liveRewriteAtRef.current = Date.now();
      return true;
    },
    [takeDcReplaySlices],
  );

  const hideScrollbackOverlay = useCallback(() => {
    if (!scrollbackVisibleRef.current) return;
    if (scrollbackRerenderTimerRef.current) {
      clearTimeout(scrollbackRerenderTimerRef.current);
      scrollbackRerenderTimerRef.current = null;
    }
    const synced = syncLiveTerminalFromSnapshot(scrollbackRenderedSnapshotBytesRef.current);
    // tmux stays the authority on screen content and cursor position; after a
    // local rewrite, ask it to repaint so any drift self-corrects.
    if (synced) socketRef.current.sendJson({ type: "redraw" });
    scrollbackVisibleRef.current = false;
    scrollbackRenderInFlightRef.current = false;
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
  }, [setScrollbackReadyState, syncLiveTerminalFromSnapshot]);

  const updateScrollbackReveal = useCallback(
    (overlay: HTMLElement) => {
      // While a reset+rewrite is in flight the buffer is transiently
      // collapsed; deciding visibility against it would blink the overlay
      // out under the reader. The render's own completion callback re-runs
      // this with the rebuilt buffer.
      if (scrollbackRenderInFlightRef.current) return;
      const buffer = scrollbackTermRef.current?.buffer.active;
      const reveal = buffer ? buffer.baseY > 0 && buffer.viewportY < buffer.baseY : false;
      setScrollbackReadyState(reveal);
    },
    [setScrollbackReadyState],
  );

  const renderScrollbackSnapshot = useCallback(
    (bytes: Uint8Array | null, reveal: boolean) => {
      const historyTerm = scrollbackTermRef.current;
      if (!bytes || !historyTerm) return;
      const generation = scrollbackRenderGenerationRef.current + 1;
      scrollbackRenderGenerationRef.current = generation;
      scrollbackRenderInFlightRef.current = true;
      console.log(
        `[sbdbg] render start gen=${generation} reveal=${reveal} visible=${scrollbackVisibleRef.current} hasSnap=${scrollbackOverlayHasSnapshotRef.current} restore=${scrollbackRestoreLineRef.current} bytes=${bytes.length}`,
      );

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
        if (scrollbackRenderInFlightRef.current) {
          scrollbackRestoreLineRef.current = scrollbackStableLineRef.current;
        } else {
          scrollbackRestoreLineRef.current = historyTerm.buffer.active.viewportY;
        }
      }

      const { cols, rows } = lastSizeRef.current;
      historyTerm.reset();
      historyTerm.resize(cols, rows);
      // Queue the snapshot and any newer live chunks back-to-back so nothing
      // that arrives mid-render can interleave; the callback rides the last
      // queued write. A coverage gap (null) renders the snapshot alone —
      // best effort for the overlay; the scheduled refresh converges it.
      const replaySlices = takeDcReplaySlices(bytes) ?? [];
      const writeQueue: (string | Uint8Array)[] = [
        formatSnapshotForXterm(decodeUtf8(bytes)),
        ...replaySlices,
      ];
      for (const piece of writeQueue.slice(0, -1)) {
        historyTerm.write(piece);
      }
      historyTerm.write(writeQueue[writeQueue.length - 1] as string | Uint8Array, () => {
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
            scrollbackRenderedSnapshotBytesRef.current = bytes;
            const overlay = getScrollbackViewport();
            console.log(
              `[sbdbg] render done gen=${generation} overlay=${!!overlay} visible=${scrollbackVisibleRef.current}`,
            );
            if (!overlay) return;
            if (!reveal && !scrollbackVisibleRef.current) {
              historyTerm.scrollToBottom();
              overlay.scrollTop = maxElementScrollTop(overlay);
              return;
            }
            scrollbackOverlayHasSnapshotRef.current = true;
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
            console.log(
              `[sbdbg] positioned gen=${generation} st=${Math.round(overlay.scrollTop)} max=${Math.round(maxElementScrollTop(overlay))}`,
            );
            updateScrollbackReveal(overlay);
          });
        });
      });
    },
    [getScrollbackViewport, takeDcReplaySlices, updateScrollbackReveal],
  );
  renderScrollbackSnapshotRef.current = renderScrollbackSnapshot;

  const revealRenderedScrollback = useCallback(() => {
    const overlay = getScrollbackViewport();
    const bytes = scrollbackSnapshotBytesRef.current ?? scrollbackCachedSnapshotBytesRef.current;
    // A rewrite in flight owns the scroll position and the banked wheel
    // deltas; consuming them against the collapsing buffer loses them.
    if (scrollbackRenderInFlightRef.current) return false;
    if (!overlay || !bytes || scrollbackRenderedSnapshotBytesRef.current !== bytes) return false;
    scrollbackOverlayHasSnapshotRef.current = true;
    const historyTerm = scrollbackTermRef.current;
    const pendingDelta = scrollbackPendingDeltaPxRef.current;
    const pendingLines = Math.trunc(pendingDelta / Math.max(1, terminalRowHeightRef.current));
    if (historyTerm && pendingLines !== 0) historyTerm.scrollLines(pendingLines);
    scrollbackPendingDeltaPxRef.current = 0;
    scrollbackDesiredScrollTopRef.current = overlay.scrollTop;
    scrollbackStableLineRef.current = historyTerm?.buffer.active.viewportY ?? null;
    updateScrollbackReveal(overlay);
    return true;
  }, [getScrollbackViewport, updateScrollbackReveal]);
  revealRenderedScrollbackRef.current = revealRenderedScrollback;

  const prepareScrollbackSnapshot = useCallback(() => {
    const bytes = scrollbackCachedSnapshotBytesRef.current;
    if (
      !bytes ||
      scrollbackVisibleRef.current ||
      scrollbackRenderedSnapshotBytesRef.current === bytes
    ) {
      return;
    }
    renderScrollbackSnapshotRef.current(bytes, false);
  }, []);
  prepareScrollbackSnapshotRef.current = prepareScrollbackSnapshot;

  const writeScrollbackLiveBytes = useCallback(
    (bytes: Uint8Array) => {
      const historyTerm = scrollbackTermRef.current;
      if (!historyTerm || scrollbackRenderedSnapshotBytesRef.current === null) return;
      if (scrollbackVisibleRef.current && !scrollbackOverlayHasSnapshotRef.current) return;

      // xterm's own viewport semantics do the right thing here: writes
      // follow the bottom when the viewport is at the live edge and hold the
      // reader's lines steady when scrolled up. Reaching around them with
      // DOM scrollTop writes races the viewport sync and teleports the view.
      const wasVisible = scrollbackVisibleRef.current;
      historyTerm.write(bytes, () => {
        if (!wasVisible || !scrollbackVisibleRef.current) return;
        const overlay = getScrollbackViewport();
        if (overlay) updateScrollbackReveal(overlay);
      });
    },
    [getScrollbackViewport, updateScrollbackReveal],
  );

  // Re-render the overlay from a fresh snapshot only once the user pauses
  // scrolling: the reset+rewrite collapses the scroll range mid-write, so
  // rendering underneath an active gesture yanks the view to stale content.
  const renderOverlaySnapshotWhenIdle = useCallback(() => {
    if (scrollbackRerenderTimerRef.current) {
      clearTimeout(scrollbackRerenderTimerRef.current);
      scrollbackRerenderTimerRef.current = null;
    }
    const attempt = () => {
      scrollbackRerenderTimerRef.current = null;
      if (!scrollbackVisibleRef.current) return;
      const bytes = scrollbackSnapshotBytesRef.current;
      if (!bytes || scrollbackRenderedSnapshotBytesRef.current === bytes) return;
      const sinceScroll = Date.now() - scrollbackLastUserScrollAtRef.current;
      if (sinceScroll < SCROLLBACK_RERENDER_IDLE_MS) {
        scrollbackRerenderTimerRef.current = setTimeout(
          attempt,
          SCROLLBACK_RERENDER_IDLE_MS - sinceScroll,
        );
        return;
      }
      if (scrollbackOverlayHasSnapshotRef.current) {
        scrollbackRestoreLineRef.current = scrollbackRenderInFlightRef.current
          ? scrollbackStableLineRef.current
          : (scrollbackTermRef.current?.buffer.active.viewportY ?? null);
      }
      renderScrollbackSnapshotRef.current(bytes, true);
    };
    attempt();
  }, []);

  const showUploadStatus = useCallback((message: string) => {
    setUploadStatus(message);
    if (uploadStatusTimerRef.current) clearTimeout(uploadStatusTimerRef.current);
    uploadStatusTimerRef.current = setTimeout(() => {
      setUploadStatus(null);
      uploadStatusTimerRef.current = null;
    }, 3000);
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

  const applyDisplayControl = useCallback(
    (state: DisplayControlState) => {
      const geometry =
        typeof state.cols === "number" && typeof state.rows === "number"
          ? { cols: state.cols, rows: state.rows }
          : null;
      displayOwnerRef.current = state.owner;
      displayGeometryRef.current = geometry;
      onDisplayControl?.(state);

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

  const socket = useAgentSocket({
    agentId,
    enabled: socketInitialSize !== null,
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
        // Transport fell back to the relay; DataChannel offsets no longer
        // describe this stream.
        dcActiveRef.current = false;
        recentDcChunksRef.current = [];
        recentDcChunksSizeRef.current = 0;
      }
      scrollbackCacheDirtyRef.current = true;
      scrollbackLiveBytesAtRef.current = Date.now();
      scheduleScrollbackCacheRefreshRef.current();
      writeScrollbackLiveBytes(bytes);
      termRef.current?.write(bytes);
    },
    onHistory: (bytes) => {
      const term = termRef.current;
      if (!term) return;
      if (containsAlternateBufferSwitch(bytes)) {
        scrollbackCachedSnapshotBytesRef.current = null;
        scrollbackCacheDirtyRef.current = true;
        scheduleScrollbackCacheRefreshRef.current(SCROLLBACK_WARM_DELAY_MS);
      } else {
        // The connect-time history is a shallow capture: seed the overlay so
        // scrollback opens instantly, but leave the cache dirty so the full
        // depth is fetched once the terminal is interactive.
        scrollbackCachedSnapshotBytesRef.current = bytes;
        scrollbackCacheDirtyRef.current = true;
        scheduleScrollbackCacheRefreshRef.current(SCROLLBACK_WARM_DELAY_MS);
        requestAnimationFrame(() => prepareScrollbackSnapshotRef.current());
      }
      term.reset();
      term.write(formatSnapshotForXterm(decodeUtf8(bytes)), () => {
        term.scrollToBottom();
      });
      liveRewriteAtRef.current = Date.now();
    },
    onDisplayControl: applyDisplayControl,
    onSnapshot: (bytes, _plain, dcOffset) => {
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
        // Snapshots and live PTY bytes travel over different transports (ws
        // vs WebRTC DataChannel), so arrival order is not capture order. If
        // live bytes arrived since this snapshot was requested, the capture
        // may not contain them — keep the cache dirty and converge with a
        // follow-up refresh rather than risk rolling the live terminal back.
        const dirty =
          scrollbackLiveBytesAtRef.current !== 0 &&
          scrollbackLiveBytesAtRef.current >= scrollbackSnapshotRequestedAtRef.current;
        scrollbackCacheDirtyRef.current = dirty;
        if (dirty) scheduleScrollbackCacheRefreshRef.current();
      }
      if (
        historyReseedPendingRef.current &&
        typeof dcOffset === "number" &&
        !scrollbackVisibleRef.current
      ) {
        // A width change left seeded history wrapped at the old width;
        // rewrite the live buffer from this anchored capture so it reflows.
        // Stays pending until a rewrite actually succeeds (alternate-screen
        // apps and replay-coverage gaps defer it to a later snapshot).
        if (syncLiveTerminalFromSnapshot(bytes)) {
          historyReseedPendingRef.current = false;
          socketRef.current.sendJson({ type: "redraw" });
        }
      }
      if (scrollbackVisibleRef.current) {
        scrollbackSnapshotBytesRef.current = bytes;
        renderOverlaySnapshotWhenIdle();
      } else {
        requestAnimationFrame(() => prepareScrollbackSnapshotRef.current());
      }
    },
    onExit: (code, sig) => {
      const banner = `\r\n\x1b[33m[agent exited code=${code ?? "?"}${
        sig ? ` signal=${sig}` : ""
      }]\x1b[0m\r\n`;
      termRef.current?.write(banner);
      setExitBanner(`Agent exited (code=${code ?? "?"}${sig ? `, signal=${sig}` : ""})`);
      onExit?.(code, sig);
    },
    onUploadError: (message) => {
      showUploadStatus(message);
    },
    onUploadSaved: handleUploadSaved,
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
      ...socket.connInfo,
    });
  }, [socket.state, socket.v2, socket.dcOpen, socket.connInfo]);

  // On spawn.v2 the DataChannel is the only live path. When it (re)opens,
  // force a tmux repaint so output produced between the history snapshot and
  // channel-open lands on screen; the daemon only mirrors bytes from the
  // open handshake onward.
  const dcWasOpenRef = useRef(false);
  useEffect(() => {
    if (socket.v2 && socket.dcOpen && !dcWasOpenRef.current) {
      agentsApi.redraw(agentId).catch(() => {});
    }
    dcWasOpenRef.current = socket.dcOpen;
  }, [socket.v2, socket.dcOpen, agentId]);

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
          ? SCROLLBACK_RELAY_CACHE_LINES
          : TERMINAL_SNAPSHOT_LINES,
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

  const scheduleScrollbackCacheRefresh = useCallback(
    (delayMs?: number) => {
      // Debounce on output, but bound the postponement: an agent that streams
      // faster than the debounce window would otherwise starve the refresh
      // forever, leaving the scrollback cache minutes stale.
      const relayMode = !dcActiveRef.current;
      const debounce = delayMs ?? (relayMode ? SCROLLBACK_RELAY_REFRESH_DEBOUNCE_MS : 350);
      const maxWait = relayMode
        ? SCROLLBACK_RELAY_REFRESH_MAX_WAIT_MS
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
        scrollbackSnapshotBytesRef.current = scrollbackCachedSnapshotBytesRef.current;
        // Null = start at the live edge; renders that overlap the open
        // scroll to bottom plus whatever wheel deltas banked.
        scrollbackStableLineRef.current = null;
        setScrollbackReadyState(false);
        setScrollbackVisible(true);
      }

      if (scrollbackSnapshotBytesRef.current) {
        if (!revealRenderedScrollbackRef.current()) {
          requestAnimationFrame(() => {
            if (!revealRenderedScrollbackRef.current()) {
              renderScrollbackSnapshotRef.current(scrollbackSnapshotBytesRef.current, true);
            }
          });
        }
      }

      // An offset-anchored cached snapshot renders exactly (live bytes past
      // the capture offset are replayed on top), so no fresh capture is
      // needed even when live output has arrived since.
      const cachedAnchored =
        scrollbackSnapshotBytesRef.current !== null &&
        scrollbackSnapshotOffsetsRef.current.get(scrollbackSnapshotBytesRef.current) !== undefined;
      if (
        !scrollbackSnapshotBytesRef.current ||
        (scrollbackCacheDirtyRef.current && !cachedAnchored)
      ) {
        requestSnapshot("overlay");
      }
      return true;
    },
    [requestSnapshot, setScrollbackReadyState],
  );
  requestScrollbackSnapshotRef.current = requestScrollbackSnapshot;

  // A resize re-wraps the tmux pane, so any cached capture is laid out at the
  // old width. Drop the rendered copy and fetch a fresh capture at the new
  // geometry instead of presenting stale-width history.
  const invalidateScrollbackForResize = useCallback(() => {
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
      convertEol: false,
      cursorBlink: false,
      disableStdin: true,
      fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
      fontSize: TERMINAL_FONT_SIZE,
      lineHeight: TERMINAL_LINE_HEIGHT,
      scrollback: TERMINAL_SNAPSHOT_LINES,
      smoothScrollDuration: 0,
      theme: {
        background: "#0a0a0a",
        foreground: "#e5e5e5",
        cursor: "#0a0a0a",
      },
    });
    historyTerm.loadAddon(new WebLinksAddon());
    historyTerm.open(host);
    scrollbackTermRef.current = historyTerm;
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
    prepareScrollbackSnapshotRef.current();

    return () => {
      host.removeEventListener("mouseup", copySelectionOnMouseUp);
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
      convertEol: false,
      cursorBlink: true,
      fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
      fontSize: TERMINAL_FONT_SIZE,
      lineHeight: TERMINAL_LINE_HEIGHT,
      // Keep a large local buffer for transcript replay and non-wheel access.
      // Wheel/touch scrollback is rendered from fresh daemon snapshots so it
      // reflects the current tmux pane rather than browser replay artifacts.
      scrollback: TERMINAL_SCROLLBACK_LINES,
      scrollOnUserInput: true,
      smoothScrollDuration: 0,
      theme: {
        background: "#0a0a0a",
        foreground: "#e5e5e5",
        cursor: "#e5e5e5",
      },
    });
    const fit = new FitAddon();
    const links = new WebLinksAddon();
    const clipboard = new ClipboardAddon();
    term.loadAddon(fit);
    term.loadAddon(links);
    term.loadAddon(clipboard);

    term.open(containerRef.current);
    termRef.current = term;
    fitRef.current = fit;
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
      if (event.type !== "keydown") return true;
      if (event.key !== "Enter" && event.key !== "Return") return true;
      // Plain terminals can't distinguish Shift+Enter from Enter; send the
      // ESC+CR sequence TUIs like Claude Code bind to "insert newline" (the
      // same mapping their /terminal-setup installs in iTerm/VS Code).
      if (event.shiftKey && rawInputRef.current) {
        hideScrollbackOverlay();
        socketRef.current.sendBinary(ALT_ENTER);
        return false;
      }
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
      if (displayOwnerRef.current === true) {
        socketRef.current.sendJson({ type: "resize", cols, rows });
      }
      // History already written into the live buffer keeps its old wrap
      // after a width change (tmux reflows its own copy, not ours). Once a
      // fresh offset-anchored capture arrives, rewrite the live buffer from
      // it so history reflows at the new width too.
      historyReseedPendingRef.current = true;
    };

    const fitTerminal = (preserveScroll: boolean) => {
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

    return () => {
      ro.disconnect();
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
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      fitTerminalRef.current = () => {};
      layoutTerminalSurfaceRef.current = () => {};
    };
    // Bootstrap effect: deliberately runs once on mount; the socket is read
    // through `socketRef`, so it doesn't need to be in deps.
  }, [
    getScrollbackViewport,
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
        const previewUrl = URL.createObjectURL(file);
        updatePendingAttachments((attachments) => [
          ...attachments,
          {
            id: clientId,
            name: file.name || defaultImageName(file),
            previewUrl,
            promptText: null,
            status: "uploading",
          },
        ]);
        try {
          const bytes_b64 = await fileToBase64(file);
          const result = await agentsApi.upload(agentId, {
            client_id: clientId,
            name: file.name || defaultImageName(file),
            mime_type: mimeTypeForFile(file),
            bytes_b64,
            paste: false,
          });
          sent += 1;
          handleUploadSaved(result.path, result.client_id);
        } catch (error) {
          showUploadStatus(
            error instanceof Error && error.message
              ? error.message
              : `${file.name || "Image"} could not be uploaded.`,
          );
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
    [agentId, handleUploadSaved, showUploadStatus, updatePendingAttachments],
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
        try {
          const bytes_b64 = await fileToBase64(file);
          const result = await agentsApi.upload(agentId, {
            client_id: makeClientId(),
            destination: "cwd",
            name: file.name || "file",
            mime_type: mimeTypeForUpload(file),
            bytes_b64,
            paste: false,
          });
          sent += 1;
          showUploadStatus(`Uploaded ${compactPath(result.path)}`);
        } catch (error) {
          showUploadStatus(
            error instanceof Error && error.message
              ? error.message
              : `${file.name || "File"} could not be uploaded.`,
          );
        }
      }
      if (sent > 0) {
        termRef.current?.focus();
      }
    },
    [agentId, showUploadStatus],
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
      // A local buffer rewrite parks the real cursor away from where the app
      // believes it is until the requested repaint lands; a keystroke inside
      // that window can echo a glyph at the stale position. One extra repaint
      // right after the keystroke paints over it within a frame or two.
      if (
        liveRewriteAtRef.current !== 0 &&
        Date.now() - liveRewriteAtRef.current < LIVE_REWRITE_ECHO_GUARD_MS
      ) {
        liveRewriteAtRef.current = 0;
        socket.sendJson({ type: "redraw" });
      }
    });
    return () => {
      onDataDisposableRef.current?.dispose();
      onDataDisposableRef.current = null;
    };
  }, [appendAttachmentsForSubmit, hideScrollbackOverlay, rawInput, socket]);

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
      focus: () => termRef.current?.focus(),
      submit: () => {
        hideScrollbackOverlay();
        socket.sendBinary(appendAttachmentsForSubmit("\r"));
        termRef.current?.focus();
      },
      pasteFromClipboard,
      pasteDataTransfer,
      pasteText,
      takeControl: () => {
        hideScrollbackOverlay();
        const term = termRef.current;
        if (!term) return;
        displayOwnerRef.current = true;
        displayGeometryRef.current = null;
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
        socket.sendJson({ type: "take_control", cols, rows });
        term.focus();
      },
    }),
    [
      appendAttachmentsForSubmit,
      hideScrollbackOverlay,
      pasteDataTransfer,
      pasteFromClipboard,
      pasteText,
      socket,
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
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={onFileInputChange}
      />
      <button
        type="button"
        aria-label="Upload files"
        title="Upload files"
        className="pointer-events-auto absolute right-2 top-8 z-20 grid size-8 place-items-center rounded-md border border-border bg-card/90 text-muted-foreground shadow-sm backdrop-blur hover:bg-accent hover:text-accent-foreground"
        onClick={() => fileInputRef.current?.click()}
      >
        <Upload className="size-4" aria-hidden="true" />
      </button>
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

function formatSnapshotForXterm(input: string): string {
  const normalized = input.replaceAll(/\r\n/g, "\n").replaceAll("\r", "\n");
  // tmux captures terminate the final row with a newline; writing it would
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
  // to tmux after transcript replay can echo fragments like "0;276;0c".
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

async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}
