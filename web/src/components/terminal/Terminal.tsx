"use client";

import { ClipboardAddon } from "@xterm/addon-clipboard";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal as XTerm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import Image from "next/image";
import {
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
import { useAgentSocket } from "@/components/terminal/useAgentSocket";

const TERMINAL_FONT_SIZE = 13;
const TERMINAL_LINE_HEIGHT = 1.2;
const TERMINAL_LINE_HEIGHT_PX = TERMINAL_FONT_SIZE * TERMINAL_LINE_HEIGHT;
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
type ScrollbackSnapshotOptions = { reset?: boolean };

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
    onExit,
  },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const onDataDisposableRef = useRef<{ dispose: () => void } | null>(null);
  const lastSizeRef = useRef<{ cols: number; rows: number }>({ cols: 80, rows: 24 });
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
  }>({
    active: false,
    startX: 0,
    startY: 0,
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
  const scrollbackTerminalHostRef = useRef<HTMLDivElement>(null);
  const scrollbackTermRef = useRef<XTerm | null>(null);
  const scrollbackVisibleRef = useRef(false);
  const scrollbackTextRef = useRef("");
  const scrollbackSnapshotRequestedRef = useRef(false);
  const scrollbackStickToBottomRef = useRef(false);
  const scrollbackPendingDeltaPxRef = useRef(0);
  const scrollbackReadyRef = useRef(false);
  const scrollbackSnapshotInFlightRef = useRef(false);
  const scrollbackIgnoreSnapshotCountRef = useRef(0);
  const scrollbackPendingLiveBytesRef = useRef<Uint8Array[]>([]);
  const requestScrollbackSnapshotRef = useRef<(options?: ScrollbackSnapshotOptions) => void>(
    () => {},
  );
  const terminalRowHeightRef = useRef(TERMINAL_LINE_HEIGHT_PX);
  const [scrollbackVisible, setScrollbackVisible] = useState(false);
  const [scrollbackReady, setScrollbackReady] = useState(false);
  const [scrollbackText, setScrollbackText] = useState("");

  const invalidateScrollbackSnapshot = useCallback(() => {
    scrollbackSnapshotRequestedRef.current = false;
    scrollbackPendingLiveBytesRef.current = [];
    if (scrollbackSnapshotInFlightRef.current && scrollbackIgnoreSnapshotCountRef.current === 0) {
      scrollbackIgnoreSnapshotCountRef.current = 1;
    }
    if (scrollbackTextRef.current !== "") {
      scrollbackTextRef.current = "";
      setScrollbackText("");
    }
  }, []);

  const hideScrollbackOverlay = useCallback(() => {
    if (!scrollbackVisibleRef.current) return;
    invalidateScrollbackSnapshot();
    scrollbackVisibleRef.current = false;
    scrollbackStickToBottomRef.current = false;
    scrollbackPendingDeltaPxRef.current = 0;
    scrollbackReadyRef.current = false;
    scrollbackTermRef.current?.scrollToBottom();
    setScrollbackReady(false);
    setScrollbackVisible(false);
    termRef.current?.scrollToBottom();
  }, [invalidateScrollbackSnapshot]);

  const getScrollbackViewport = useCallback(() => {
    return scrollbackTerminalHostRef.current?.querySelector<HTMLElement>(".xterm-viewport") ?? null;
  }, []);

  const updateScrollbackReveal = useCallback((overlay: HTMLElement) => {
    const maxTop = maxElementScrollTop(overlay);
    const reveal =
      maxTop > 0 && overlay.scrollTop < maxTop - Math.max(1, terminalRowHeightRef.current * 0.75);
    if (reveal === scrollbackReadyRef.current) return;
    scrollbackReadyRef.current = reveal;
    setScrollbackReady(reveal);
  }, []);

  const flushScrollbackOverlayPosition = useCallback(() => {
    const overlay = getScrollbackViewport();
    const text = scrollbackTextRef.current;
    if (!overlay || text.length === 0) return;
    const maxTop = maxElementScrollTop(overlay);
    const needsScroll = textHasMoreRowsThanViewport(text, lastSizeRef.current.rows);

    if (scrollbackStickToBottomRef.current) {
      if (maxTop <= 0 && needsScroll) return;
      overlay.scrollTop = maxTop;
      scrollbackStickToBottomRef.current = false;
    }

    const pendingDelta = scrollbackPendingDeltaPxRef.current;
    if (pendingDelta !== 0) {
      if (maxTop > 0) {
        scrollElementPixels(overlay, pendingDelta);
        scrollbackPendingDeltaPxRef.current = 0;
      } else if (scrollbackTextRef.current.length > 0) {
        scrollbackPendingDeltaPxRef.current = 0;
      }
    }

    updateScrollbackReveal(overlay);
  }, [getScrollbackViewport, updateScrollbackReveal]);

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

  const writeScrollbackLiveBytes = useCallback(
    (bytes: Uint8Array) => {
      const historyTerm = scrollbackTermRef.current;
      if (!historyTerm) return false;

      const viewport = getScrollbackViewport();
      const preserveTop = scrollbackReadyRef.current && viewport !== null;
      const scrollTop = viewport?.scrollTop ?? 0;

      historyTerm.write(bytes, () => {
        const nextViewport = getScrollbackViewport();
        if (preserveTop && nextViewport) {
          nextViewport.scrollTop = Math.min(maxElementScrollTop(nextViewport), scrollTop);
          updateScrollbackReveal(nextViewport);
        } else {
          historyTerm.scrollToBottom();
          if (nextViewport) updateScrollbackReveal(nextViewport);
        }
      });
      return true;
    },
    [getScrollbackViewport, updateScrollbackReveal],
  );

  const socket = useAgentSocket({
    agentId,
    enabled: socketInitialSize !== null,
    initialSize: socketInitialSize,
    onData: (bytes) => {
      if (scrollbackVisibleRef.current) {
        const canWriteLive =
          !scrollbackSnapshotInFlightRef.current &&
          scrollbackTextRef.current.length > 0 &&
          scrollbackTermRef.current !== null;
        if (canWriteLive) {
          writeScrollbackLiveBytes(bytes);
        } else {
          scrollbackPendingLiveBytesRef.current.push(bytes);
        }
      } else {
        invalidateScrollbackSnapshot();
      }
      termRef.current?.write(bytes);
    },
    onHistory: (bytes) => {
      const term = termRef.current;
      if (!term) return;
      scrollbackSnapshotRequestedRef.current = false;
      term.reset();
      term.write(bytes);
    },
    onSnapshot: (bytes) => {
      if (scrollbackIgnoreSnapshotCountRef.current > 0) {
        scrollbackIgnoreSnapshotCountRef.current -= 1;
        scrollbackSnapshotInFlightRef.current = false;
        scrollbackTextRef.current = "";
        setScrollbackText("");
        if (scrollbackVisibleRef.current) {
          requestAnimationFrame(() => requestScrollbackSnapshotRef.current({ reset: true }));
        }
        return;
      }

      const decoded = normalizeSnapshotText(decodeUtf8(bytes));
      scrollbackSnapshotInFlightRef.current = false;
      scrollbackTextRef.current = decoded;
      setScrollbackText(decoded);
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
    onUploadSaved: (path, clientId) => {
      if (imagePasteMode === "bracketed-path") {
        const targetId =
          clientId ??
          pendingAttachmentsRef.current.find((attachment) => attachment.status === "uploading")?.id;
        if (targetId) removePendingAttachment(targetId);
        socketRef.current.sendBinary(bracketedPaste(shellSingleQuote(path)));
        showUploadStatus("Image pasted");
        termRef.current?.focus();
        return;
      }

      const promptText = `@${compactPath(path)}`;
      updatePendingAttachments((attachments) => {
        const targetId =
          clientId ?? attachments.find((attachment) => attachment.status === "uploading")?.id;
        if (!targetId) return attachments;
        return attachments.map((attachment) =>
          attachment.id === targetId ? { ...attachment, promptText, status: "ready" } : attachment,
        );
      });
      showUploadStatus("Image attached");
    },
  });

  // Stash the socket in a ref so the once-on-mount bootstrap useEffect can
  // reach it without re-running every render.
  const socketRef = useRef(socket);
  socketRef.current = socket;
  rawInputRef.current = rawInput;
  mobileReturnModeRef.current = mobileReturnMode;
  mobileReturnBytesRef.current = mobileReturnBytes;

  const requestScrollbackSnapshot = useCallback((options: ScrollbackSnapshotOptions = {}) => {
    if (socketRef.current.state !== "open") return;
    if (scrollbackSnapshotInFlightRef.current) return;

    const reset = options.reset ?? true;
    scrollbackSnapshotRequestedRef.current = true;
    scrollbackSnapshotInFlightRef.current = true;
    if (reset) {
      scrollbackPendingLiveBytesRef.current = [];
      scrollbackTextRef.current = "";
      setScrollbackText("");
    }
    const sent = socketRef.current.sendJson({ type: "snapshot", lines: 10000, plain: false });
    if (!sent) {
      scrollbackSnapshotInFlightRef.current = false;
    }
  }, []);
  requestScrollbackSnapshotRef.current = requestScrollbackSnapshot;

  useEffect(() => {
    if (socket.state !== "open" || !coarsePointerRef.current) return;
    if (!scrollbackSnapshotRequestedRef.current) requestScrollbackSnapshot({ reset: true });
  }, [requestScrollbackSnapshot, socket.state]);

  useLayoutEffect(() => {
    if (!scrollbackVisible || scrollbackText.length === 0) return;
    flushScrollbackOverlayPosition();
    const frame = requestAnimationFrame(flushScrollbackOverlayPosition);
    return () => cancelAnimationFrame(frame);
  }, [flushScrollbackOverlayPosition, scrollbackText, scrollbackVisible]);

  useLayoutEffect(() => {
    if (!scrollbackVisible) return;
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
      scrollback: 10000,
      theme: {
        background: "#0a0a0a",
        foreground: "#e5e5e5",
        cursor: "#0a0a0a",
      },
    });
    historyTerm.open(host);
    scrollbackTermRef.current = historyTerm;
    const viewport = getScrollbackViewport();
    if (viewport) {
      viewport.style.scrollbarWidth = "none";
      viewport.style.touchAction = "none";
    }

    return () => {
      historyTerm.dispose();
      if (scrollbackTermRef.current === historyTerm) scrollbackTermRef.current = null;
    };
  }, [getScrollbackViewport, scrollbackVisible]);

  useLayoutEffect(() => {
    if (!scrollbackVisible || scrollbackText.length === 0) return;
    const historyTerm = scrollbackTermRef.current;
    if (!historyTerm) return;

    const { cols, rows } = lastSizeRef.current;
    historyTerm.reset();
    historyTerm.resize(cols, rows);
    historyTerm.write(formatSnapshotForXterm(scrollbackText), () => {
      const pendingLiveBytes = scrollbackPendingLiveBytesRef.current;
      scrollbackPendingLiveBytesRef.current = [];
      requestAnimationFrame(() => {
        historyTerm.scrollToBottom();
        for (const pendingBytes of pendingLiveBytes) writeScrollbackLiveBytes(pendingBytes);
        flushScrollbackOverlayPosition();
      });
    });
  }, [flushScrollbackOverlayPosition, scrollbackText, scrollbackVisible, writeScrollbackLiveBytes]);

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
      pendingAttachmentsRef.current.forEach((attachment) => {
        URL.revokeObjectURL(attachment.previewUrl);
      });
      pendingAttachmentsRef.current = [];
    };
  }, []);

  // Bootstrap xterm.js once on mount.
  useEffect(() => {
    if (!containerRef.current) return;
    const term = new XTerm({
      convertEol: false,
      cursorBlink: true,
      fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
      fontSize: TERMINAL_FONT_SIZE,
      lineHeight: TERMINAL_LINE_HEIGHT,
      // Generous scrollback so the user can browse far back. The actual
      // history is also persisted server-side per agent — see
      // `server/spawn_server/transcript.py`.
      scrollback: 50000,
      smoothScrollDuration: 70,
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
    const terminalElement = containerRef.current;
    terminalElement.style.touchAction = "none";

    const hideMobileScrollbackOverlay = () => {
      if (!scrollbackVisibleRef.current) return;
      invalidateScrollbackSnapshot();
      scrollbackVisibleRef.current = false;
      scrollbackStickToBottomRef.current = false;
      scrollbackPendingDeltaPxRef.current = 0;
      scrollbackReadyRef.current = false;
      scrollbackTermRef.current?.scrollToBottom();
      setScrollbackReady(false);
      setScrollbackVisible(false);
      term.scrollToBottom();
    };

    const flushMobileScrollbackOverlayPosition = () => {
      const overlay = getScrollbackViewport();
      const text = scrollbackTextRef.current;
      if (!overlay || text.length === 0) return;
      const maxTop = maxElementScrollTop(overlay);
      const needsScroll = textHasMoreRowsThanViewport(text, term.rows);

      if (scrollbackStickToBottomRef.current) {
        if (maxTop <= 0 && needsScroll) return;
        overlay.scrollTop = maxTop;
        scrollbackStickToBottomRef.current = false;
      }

      const pendingDelta = scrollbackPendingDeltaPxRef.current;
      if (pendingDelta !== 0) {
        if (maxTop > 0) {
          scrollElementPixels(overlay, pendingDelta);
          scrollbackPendingDeltaPxRef.current = 0;
        } else if (scrollbackTextRef.current.length > 0) {
          scrollbackPendingDeltaPxRef.current = 0;
        }
      }

      updateScrollbackReveal(overlay);
    };

    const rememberRowHeight = (rowHeight: number) => {
      if (rowHeight <= 0) return terminalRowHeightRef.current;
      if (Math.abs(rowHeight - terminalRowHeightRef.current) >= 0.25) {
        terminalRowHeightRef.current = rowHeight;
      }
      return terminalRowHeightRef.current;
    };

    term.attachCustomWheelEventHandler((event) => {
      if (event.ctrlKey) return true;
      const amount = wheelEventToPixels(event, term.rows);
      if (amount !== 0) scrollViewportPixels(amount);
      event.preventDefault();
      event.stopPropagation();
      return false;
    });

    const getViewport = () => terminalElement.querySelector<HTMLElement>(".xterm-viewport");

    const getRowHeight = () => {
      const canvas = terminalElement.querySelector<HTMLCanvasElement>(".xterm-screen canvas");
      const canvasHeight = canvas?.getBoundingClientRect().height ?? 0;
      if (canvasHeight > 0 && term.rows > 0) return rememberRowHeight(canvasHeight / term.rows);
      return terminalRowHeightRef.current;
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

    const scrollViewportPixels = (deltaY: number) => {
      const viewport = getViewport();
      if (!viewport) return false;
      const maxTop = maxScrollTop(viewport);
      if (maxTop <= 0) return false;
      const before = viewport.scrollTop;
      const next = Math.max(0, Math.min(maxTop, before + deltaY));
      if (Math.abs(next - before) < 0.5) return false;

      viewport.scrollTop = next;
      return true;
    };

    const scrollViewportRows = (rows: number) => {
      if (rows === 0) return 0;
      const viewport = getViewport();
      if (!viewport) return 0;
      const rowHeight = getRowHeight();
      const maxTop = maxScrollTop(viewport);
      if (rowHeight <= 0 || maxTop <= 0) return 0;

      const maxRow = Math.round(maxTop / rowHeight);
      const beforeRow = Math.round(viewport.scrollTop / rowHeight);
      const nextRow = Math.max(0, Math.min(maxRow, beforeRow + rows));
      if (nextRow === beforeRow) return 0;

      viewport.scrollTop = nextRow * rowHeight;
      return nextRow - beforeRow;
    };

    const maxOverlayScrollTop = (overlay: HTMLElement) => {
      return maxElementScrollTop(overlay);
    };

    const overlayIsAtBottom = (overlay: HTMLElement) => {
      return overlay.scrollTop >= maxOverlayScrollTop(overlay) - 0.5;
    };

    const scrollOverlayPixels = (deltaY: number) => {
      const overlay = getScrollbackViewport();
      if (!overlay || deltaY === 0) return false;
      const maxTop = maxOverlayScrollTop(overlay);
      if (maxTop <= 0) return false;
      const before = overlay.scrollTop;
      const next = Math.max(0, Math.min(maxTop, before + deltaY));
      if (Math.abs(next - before) < 0.5) return false;
      overlay.scrollTop = next;
      updateScrollbackReveal(overlay);
      return true;
    };

    const showScrollbackOverlay = (initialDeltaY = 0) => {
      if (!coarsePointerRef.current) return false;
      const wasVisible = scrollbackVisibleRef.current;

      if (!wasVisible) {
        scrollbackVisibleRef.current = true;
        scrollbackStickToBottomRef.current = true;
        scrollbackPendingDeltaPxRef.current = 0;
        scrollbackReadyRef.current = false;
        setScrollbackReady(false);
        setScrollbackVisible(true);
      }

      if (!scrollbackSnapshotRequestedRef.current) {
        requestScrollbackSnapshotRef.current();
      }

      requestAnimationFrame(() => {
        flushMobileScrollbackOverlayPosition();
        if (wasVisible && initialDeltaY !== 0) scrollOverlayPixels(initialDeltaY);
      });

      return true;
    };

    const canScrollViewport = (deltaY: number) => {
      const viewport = getViewport();
      if (!viewport || deltaY === 0) return false;
      const maxTop = maxScrollTop(viewport);
      if (maxTop <= 0) return false;
      return deltaY > 0 ? viewport.scrollTop < maxTop - 0.5 : viewport.scrollTop > 0.5;
    };

    const applyTouchScrollDelta = (deltaY: number) => {
      const state = touchScrollRef.current;
      if (coarsePointerRef.current) {
        if (scrollbackVisibleRef.current) {
          const overlay = getScrollbackViewport();
          if (overlay && deltaY > 0 && overlayIsAtBottom(overlay)) {
            hideMobileScrollbackOverlay();
            state.scrollRemainderPx = 0;
            return false;
          }
          if (scrollOverlayPixels(deltaY)) {
            if (overlay && deltaY > 0 && overlayIsAtBottom(overlay)) {
              hideMobileScrollbackOverlay();
              state.scrollRemainderPx = 0;
            }
            return true;
          }
          return Boolean(
            overlay && (maxOverlayScrollTop(overlay) > 0 || scrollbackTextRef.current.length === 0),
          );
        }

        if (deltaY < 0 && showScrollbackOverlay(deltaY)) {
          state.scrollRemainderPx = 0;
          return true;
        }
      }

      const rowHeight = getRowHeight();
      if (rowHeight <= 0) return false;

      state.scrollRemainderPx += deltaY;
      const rows = Math.trunc(state.scrollRemainderPx / rowHeight);
      if (rows === 0) return canScrollViewport(deltaY);

      const scrolledRows = scrollViewportRows(rows);
      if (scrolledRows === 0) {
        state.scrollRemainderPx = 0;
        return false;
      }

      state.scrollRemainderPx -= scrolledRows * rowHeight;
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
      if (!scrollbackVisibleRef.current) alignViewportToRows();
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
      hideMobileScrollbackOverlay();
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

      if (!applyTouchScrollDelta(deltaY)) {
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
      touchScrollRef.current.lastY = y;
      touchScrollRef.current.lastTime = time;
      touchScrollRef.current.movedPx = 0;
      touchScrollRef.current.velocityPxPerMs = 0;
      touchScrollRef.current.samples = [{ time, y }];
      touchScrollRef.current.pendingTapFocus = false;
      touchScrollRef.current.pointerCaptured = false;
      touchScrollRef.current.scrollRemainderPx = 0;
    };

    const moveTouchScroll = (x: number, y: number, time: number) => {
      const state = touchScrollRef.current;
      if (!state.active) return;

      state.movedPx = Math.max(state.movedPx, Math.hypot(x - state.startX, y - state.startY));
      const deltaY = state.lastY - y;
      state.lastY = y;
      if (deltaY === 0) return;

      const dt = Math.max(1, time - state.lastTime);
      state.lastTime = time;
      pushTouchSample(time, y);
      const instantVelocity = deltaY / dt;
      const sampledVelocity = estimateTouchVelocity();
      state.velocityPxPerMs = sampledVelocity * 0.75 + instantVelocity * 0.25;

      applyTouchScrollDelta(deltaY);
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
        alignViewportToRows();
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

    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType !== "touch" || !event.isPrimary) return;
      touchScrollRef.current.activePointerId = event.pointerId;
      startTouchScroll(event.clientX, event.clientY, event.timeStamp || performance.now());
      try {
        terminalElement.setPointerCapture(event.pointerId);
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
      touchScrollRef.current.activePointerId = null;
      touchScrollRef.current.pointerCaptured = false;
      if (hadCapture) {
        try {
          terminalElement.releasePointerCapture(event.pointerId);
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
      const touch = event.touches[0];
      if (!touch || event.touches.length !== 1) return;
      moveTouchScroll(touch.clientX, touch.clientY, event.timeStamp || performance.now());
      if (touchScrollRef.current.movedPx <= TOUCH_TAP_SLOP_PX) return;
      if (event.cancelable) event.preventDefault();
      event.stopPropagation();
    };

    const onTouchEnd = () => {
      endTouchScroll();
    };

    const onClick = (event: MouseEvent) => {
      if (!touchScrollRef.current.pendingTapFocus) return;
      touchScrollRef.current.pendingTapFocus = false;
      hideMobileScrollbackOverlay();
      term.focus();
      event.preventDefault();
      event.stopPropagation();
    };

    terminalElement.addEventListener("click", onClick, { capture: true });
    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") return true;
      if (event.key !== "Enter" && event.key !== "Return") return true;
      return !interceptMobileReturn(event);
    });
    term.textarea?.addEventListener("beforeinput", onBeforeInput, { capture: true });
    term.textarea?.addEventListener("input", onInput, { capture: true });

    const usePointerEvents = window.PointerEvent !== undefined;
    if (usePointerEvents) {
      terminalElement.addEventListener("touchmove", stopXtermTouchMove, {
        capture: true,
        passive: false,
      });
      terminalElement.addEventListener("pointerdown", onPointerDown, {
        capture: true,
        passive: false,
      });
      terminalElement.addEventListener("pointermove", onPointerMove, {
        capture: true,
        passive: false,
      });
      terminalElement.addEventListener("pointerup", onPointerEnd, { capture: true });
      terminalElement.addEventListener("pointercancel", onPointerEnd, { capture: true });
      terminalElement.addEventListener("lostpointercapture", onPointerEnd, { capture: true });
    } else {
      terminalElement.addEventListener("touchstart", onTouchStart, {
        capture: true,
        passive: true,
      });
      terminalElement.addEventListener("touchmove", onTouchMove, { capture: true, passive: false });
      terminalElement.addEventListener("touchend", onTouchEnd, { capture: true });
      terminalElement.addEventListener("touchcancel", onTouchEnd, { capture: true });
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
      if (cols !== last.cols || rows !== last.rows) {
        lastSizeRef.current = { cols, rows };
        socketRef.current.sendJson({ type: "resize", cols, rows });
      }
    };

    const fitTerminal = (preserveScroll: boolean) => {
      const anchor = preserveScroll ? captureScrollAnchor() : null;
      try {
        fit.fit();
      } catch {
        return;
      }
      if (anchor) {
        restoreScrollAnchor(anchor);
        requestAnimationFrame(() => restoreScrollAnchor(anchor));
      } else {
        alignViewportToRows();
      }
      notifyResizeIfChanged();
    };

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
    if (containerRef.current) ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      terminalElement.removeEventListener("click", onClick, { capture: true });
      term.attachCustomKeyEventHandler(() => true);
      term.textarea?.removeEventListener("beforeinput", onBeforeInput, { capture: true });
      term.textarea?.removeEventListener("input", onInput, { capture: true });
      if (usePointerEvents) {
        terminalElement.removeEventListener("touchmove", stopXtermTouchMove, { capture: true });
        terminalElement.removeEventListener("pointerdown", onPointerDown, { capture: true });
        terminalElement.removeEventListener("pointermove", onPointerMove, { capture: true });
        terminalElement.removeEventListener("pointerup", onPointerEnd, { capture: true });
        terminalElement.removeEventListener("pointercancel", onPointerEnd, { capture: true });
        terminalElement.removeEventListener("lostpointercapture", onPointerEnd, {
          capture: true,
        });
      } else {
        terminalElement.removeEventListener("touchstart", onTouchStart, { capture: true });
        terminalElement.removeEventListener("touchmove", onTouchMove, { capture: true });
        terminalElement.removeEventListener("touchend", onTouchEnd, { capture: true });
        terminalElement.removeEventListener("touchcancel", onTouchEnd, { capture: true });
      }
      stopTouchMomentum();
      if (resizeTimer) clearTimeout(resizeTimer);
      onDataDisposableRef.current?.dispose();
      if (uploadStatusTimerRef.current) clearTimeout(uploadStatusTimerRef.current);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // Bootstrap effect: deliberately runs once on mount; the socket is read
    // through `socketRef`, so it doesn't need to be in deps.
  }, [getScrollbackViewport, invalidateScrollbackSnapshot, updateScrollbackReveal]);

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
          const ok = socketRef.current.sendJson({
            type: "upload",
            client_id: clientId,
            name: file.name || defaultImageName(file),
            mime_type: mimeTypeForFile(file),
            bytes_b64,
            paste: false,
          });
          if (!ok) {
            showUploadStatus("Terminal is not connected.");
            updatePendingAttachments((attachments) =>
              attachments.map((attachment) =>
                attachment.id === clientId ? { ...attachment, status: "error" } : attachment,
              ),
            );
            return;
          }
          sent += 1;
        } catch {
          showUploadStatus(`${file.name || "Image"} could not be read.`);
          updatePendingAttachments((attachments) =>
            attachments.map((attachment) =>
              attachment.id === clientId ? { ...attachment, status: "error" } : attachment,
            ),
          );
        }
      }
      if (sent > 0) {
        showUploadStatus(sent === 1 ? "Attaching image..." : `Attaching ${sent} images...`);
        termRef.current?.focus();
      }
    },
    [showUploadStatus, updatePendingAttachments],
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
    });
    return () => {
      onDataDisposableRef.current?.dispose();
      onDataDisposableRef.current = null;
    };
  }, [appendAttachmentsForSubmit, hideScrollbackOverlay, rawInput, socket]);

  // Resend the last known size on (re)connection so the daemon's PTY matches.
  useEffect(() => {
    if (socket.state === "open") {
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
        lastSizeRef.current = { cols, rows };
        socket.sendJson({ type: "resize", cols, rows });
      },
      fit: () => {
        try {
          fitRef.current?.fit();
        } catch {
          /* ignore */
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
    if (!hasImageTransfer(event.dataTransfer)) return;
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
    if (!hasImageTransfer(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    const files = imageFilesFromDataTransfer(event.dataTransfer);
    if (files.length === 0) return;
    event.preventDefault();
    dragDepthRef.current = 0;
    setDropActive(false);
    void uploadImages(files);
  };

  const onDragLeave = (event: DragEvent<HTMLDivElement>) => {
    if (!hasImageTransfer(event.dataTransfer)) return;
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
      <div ref={containerRef} className="size-full touch-none" />
      {scrollbackVisible && (
        <div
          className="pointer-events-none absolute inset-0 z-10 bg-[var(--color-terminal-bg)] text-[#e5e5e5]"
          style={{
            visibility: scrollbackReady ? "visible" : "hidden",
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
            Drop image
          </div>
        </div>
      )}
      <div
        className="pointer-events-none absolute right-2 top-2 rounded bg-black/60 px-2 py-0.5 text-[10px] text-muted-foreground"
        aria-live="polite"
      >
        {socket.state}
        {exitBanner ? ` · ${exitBanner}` : ""}
        {uploadStatus ? ` · ${uploadStatus}` : ""}
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

function textHasMoreRowsThanViewport(text: string, rows: number): boolean {
  if (rows <= 0) return true;
  let lineCount = 1;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) !== 10) continue;
    lineCount += 1;
    if (lineCount > rows) return true;
  }
  return false;
}

function normalizeSnapshotText(input: string): string {
  const normalized = input.replaceAll(/\r\n/g, "\n").replaceAll("\r", "\n");
  return normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
}

function formatSnapshotForXterm(input: string): string {
  // `capture-pane -p` returns already-rendered rows. Disable xterm autowrap so
  // exact-width rows do not gain an extra wrapped line while replaying them.
  return `\x1b[?7l${input.split("\n").join("\r\n")}\x1b[?7h`;
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
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
  const files = Array.from(data.files).filter(isImageFile);
  if (files.length > 0) return files;

  return Array.from(data.items)
    .filter((item) => item.kind === "file" && isImageMimeOrName(item.type))
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null && isImageFile(file));
}

function hasImageTransfer(data: DataTransfer): boolean {
  return (
    Array.from(data.files).some(isImageFile) ||
    Array.from(data.items).some((item) => item.kind === "file" && isImageMimeOrName(item.type))
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
