// biome-ignore-all lint: This source executes inside WKWebView, not the React Native runtime.
(() => {
  "use strict";

  const BRIDGE_VERSION = 1;
  const MAX_INPUT_BYTES = 16 * 1024;
  const TELEMETRY_DELAY_MS = 8;
  const FIT_DEBOUNCE_MS = 60;
  /** Floor for the type when this viewer is matching someone else's grid. */
  const MIN_FOLLOWER_FONT_SIZE = 6;
  /** spawn.ctl refuses a grid outside these, so never draw or publish one. */
  const GRID_BOUNDS = { minCols: 20, maxCols: 400, minRows: 5, maxRows: 200 };
  /** Travel before a touch counts as a scroll rather than a tap. */
  const SCROLL_SLOP_PX = 6;
  /** Per-frame decay of a released fling, and the speed it is considered spent. */
  const FLING_FRICTION = 0.93;
  const FLING_MIN_VELOCITY = 0.02;
  const FLING_MAX_VELOCITY = 6;
  /** How much of the screen one synthesised page key is worth. */
  const PAGE_KEY_FRACTION = 0.5;
  /**
   * Whether ⌥ and ⌘ are on the hardware keyboard attached to this device —
   * an iPad with a Magic Keyboard is the case that matters.
   */
  const APPLE_MODIFIERS = /^(Mac|iPad|iPhone|iPod)/.test(navigator.platform || "");
  const DELETE = "\u007f";
  const state = {
    mode: null,
    scopeId: null,
    browserKey: null,
    hostKey: null,
    cols: 80,
    rows: 24,
    fontSize: 13,
    term: null,
    fitAddon: null,
    serializeAddon: null,
    webglAddon: null,
    renderer: null,
    follow: true,
    newOutputWhileAway: false,
    /** null until the daemon reports who owns the shared PTY geometry. */
    displayOwner: null,
    displayGeometry: null,
    displayViewers: 1,
    pc: null,
    pty: null,
    ctl: null,
    rtcSessionId: null,
    bindingNonce: null,
    bindingGeneration: null,
    /** Host mode has no binding generation; the sent offer arms its candidates. */
    offerSent: false,
    pendingLocalCandidates: [],
    pendingRemoteCandidates: [],
    pendingSign: new Map(),
    inputSequence: -1,
    clipboardRequests: new Map(),
    clipboardSequence: 0,
    search: null,
    disconnectTimer: null,
    restartTimer: null,
    statsTimer: null,
    pendingRestartRequests: new Set(),
    stopped: false,
  };

  const api = (globalThis.spawnWorker = { state });
  const encoder = new TextEncoder();

  api.post = (message) => {
    globalThis.ReactNativeWebView?.postMessage(JSON.stringify({ v: BRIDGE_VERSION, ...message }));
  };

  api.error = (code, message, retryable = false, detail) => {
    api.post({
      type: "error",
      code,
      message,
      retryable,
      ...(detail === undefined ? {} : { detail }),
    });
  };

  const latestTelemetry = new Map();
  let telemetryTimer = null;
  api.telemetry = (message) => {
    latestTelemetry.set(message.type, message);
    if (telemetryTimer !== null) return;
    telemetryTimer = setTimeout(() => {
      telemetryTimer = null;
      for (const pending of latestTelemetry.values()) api.post(pending);
      latestTelemetry.clear();
    }, TELEMETRY_DELAY_MS);
  };

  api.decodeBase64 = (value) => {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  };

  api.encodeBase64 = (bytes) => {
    let binary = "";
    for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return btoa(binary);
  };

  api.encodeBase64Url = (bytes) =>
    api.encodeBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");

  api.scrollState = () => {
    const terminal = state.term;
    if (!terminal) {
      return {
        atBottom: true,
        viewportY: 0,
        baseY: 0,
        buffer: "normal",
        newOutputWhileAway: false,
      };
    }
    const active = terminal.buffer.active;
    const atBottom = active.viewportY >= active.baseY;
    return {
      atBottom,
      viewportY: active.viewportY,
      baseY: active.baseY,
      buffer: terminal.buffer.active === terminal.buffer.alternate ? "alternate" : "normal",
      newOutputWhileAway: state.newOutputWhileAway && !atBottom,
    };
  };

  api.emitScroll = () => {
    const scroll = api.scrollState();
    if (scroll.atBottom) state.newOutputWhileAway = false;
    api.telemetry({ type: "scroll-state", scroll });
  };

  /**
   * The bytes a Mac keyboard's ⌥ or ⌘ arrow owes the shell, or null. The same
   * table the browser app keeps in `web/src/lib/keyboard-chords.ts`, and for
   * the same two reasons: xterm decides ⌥ from its own `isMac`, which is
   * false on an iPad, so ⌥← comes out as the Windows spelling no shell here
   * binds; and it drops every ⌘ chord unread, so the ends of the line were
   * simply missing. `ESC b` / `ESC f` and Ctrl-A / Ctrl-E are what readline,
   * zsh, fish and the TUI prompts people run all understand.
   */
  function appleArrowBytes(event) {
    if (event.ctrlKey || event.shiftKey || event.altKey === event.metaKey) return null;
    if (event.altKey) {
      if (event.key === "ArrowLeft") return "\u001bb";
      if (event.key === "ArrowRight") return "\u001bf";
      return null;
    }
    if (event.key === "ArrowLeft") return "\u0001";
    if (event.key === "ArrowRight") return "\u0005";
    return null;
  }

  function clipboardRequest(operation, text) {
    const requestId = `clipboard-${++state.clipboardSequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        state.clipboardRequests.delete(requestId);
        reject(new Error("Clipboard request timed out."));
      }, 5_000);
      state.clipboardRequests.set(requestId, { resolve, reject, timer });
      api.post({ type: operation, requestId, ...(text === undefined ? {} : { text }) });
    });
  }

  function applyTheme(theme) {
    if (state.term) state.term.options.theme = { ...theme };
    document.documentElement.style.background = theme.background;
    document.body.style.background = theme.background;
  }

  /**
   * Puts the keyboard back up.
   *
   * Focusing an element the page already considers focused is a no-op, and iOS
   * will not raise a keyboard for it — which is exactly the state left behind
   * when a drawer dismissed the keyboard without the textarea ever losing
   * focus. Dropping focus first makes the next call a real focus event.
   */
  function refocusTerminal() {
    const terminal = state.term;
    if (!terminal) return;
    const textarea = document.querySelector(".xterm-helper-textarea");
    if (textarea && document.activeElement === textarea) textarea.blur();
    terminal.focus();
  }

  /**
   * Turns an edit to xterm's hidden textarea into terminal keystrokes.
   *
   * Android keyboards can autocorrect by replacing any suffix of the textarea,
   * even though that suffix has already gone to the PTY. xterm 5.5 assumes every
   * IME change is an append and sends the entire accumulated textarea when that
   * assumption fails. Rewind only the changed suffix, then type its replacement.
   */
  function textareaEditSequence(previous, next) {
    const previousCharacters = Array.from(previous);
    const nextCharacters = Array.from(next);
    let unchanged = 0;
    while (
      unchanged < previousCharacters.length &&
      unchanged < nextCharacters.length &&
      previousCharacters[unchanged] === nextCharacters[unchanged]
    ) {
      unchanged += 1;
    }
    return (
      DELETE.repeat(previousCharacters.length - unchanged) +
      nextCharacters.slice(unchanged).join("")
    );
  }

  /**
   * Replaces xterm 5.5's lossy keyCode=229 fallback on Android WebView.
   *
   * This deliberately leaves xterm's normal composition path alone. It only
   * substitutes `_handleAnyTextareaChanges`, which xterm calls for Android IME
   * edits delivered outside a composition. The pending baseline is shared by
   * overlapping events so fast input cannot make an earlier timer resend or
   * drop its neighbour.
   */
  function installAndroidTextareaDiff(terminal) {
    if (!/Android/i.test(navigator.userAgent)) return;
    const textarea = terminal.textarea;
    const compositionHelper = terminal._core?._compositionHelper;
    if (!textarea || !compositionHelper) return;

    let pendingPrevious = null;
    let pendingTimer = null;
    compositionHelper._handleAnyTextareaChanges = () => {
      if (pendingPrevious === null) pendingPrevious = textarea.value;
      if (pendingTimer !== null) clearTimeout(pendingTimer);
      pendingTimer = setTimeout(() => {
        pendingTimer = null;
        const previous = pendingPrevious;
        pendingPrevious = null;
        if (previous === null || compositionHelper._isComposing) return;

        const input = textareaEditSequence(previous, textarea.value);
        compositionHelper._dataAlreadySent = "";
        if (input.length > 0) terminal.input(input, true);
      }, 0);
    };
  }

  function configureTextarea() {
    const textarea = document.querySelector(".xterm-helper-textarea");
    if (!textarea) return;
    textarea.setAttribute("autocomplete", "off");
    textarea.setAttribute("autocapitalize", "off");
    textarea.setAttribute("autocorrect", "off");
    textarea.setAttribute("spellcheck", "false");
    textarea.setAttribute("enterkeyhint", "enter");
  }

  function clamp(value, low, high) {
    return Math.min(high, Math.max(low, value));
  }

  /**
   * Shrinks the type until `cols` columns fit the surface. Used only when this
   * viewer follows someone else's grid: the daemon renders every row at the
   * owner's width, so a narrower local grid clips each line at the right edge
   * instead of wrapping it. Smaller text is the readable trade.
   */
  function fitFontToColumns(cols) {
    const terminal = state.term;
    const fitAddon = state.fitAddon;
    if (!terminal || !fitAddon) return;
    let size = state.fontSize;
    terminal.options.fontSize = size;
    for (let attempt = 0; attempt < 8 && size > MIN_FOLLOWER_FONT_SIZE; attempt += 1) {
      let proposed;
      try {
        proposed = fitAddon.proposeDimensions();
      } catch {
        return;
      }
      if (!proposed || !proposed.cols || proposed.cols >= cols) return;
      const scaled = Math.floor((size * proposed.cols) / cols);
      size = Math.max(MIN_FOLLOWER_FONT_SIZE, Math.min(size - 1, scaled));
      terminal.options.fontSize = size;
    }
  }

  /**
   * Brings the grid in line with the surface it is drawn on. The phone frame
   * changes constantly — the keyboard opens, the device rotates, the font-size
   * sheet moves — and nothing else re-measures it.
   */
  function fitTerminal() {
    const terminal = state.term;
    const fitAddon = state.fitAddon;
    if (!terminal || !fitAddon) return;
    const geometry = state.displayOwner === false ? state.displayGeometry : null;
    if (geometry) {
      fitFontToColumns(geometry.cols);
      if (terminal.cols !== geometry.cols || terminal.rows !== geometry.rows) {
        try {
          terminal.resize(geometry.cols, geometry.rows);
        } catch {
          return;
        }
      }
      state.cols = geometry.cols;
      state.rows = geometry.rows;
    } else {
      if (terminal.options.fontSize !== state.fontSize) terminal.options.fontSize = state.fontSize;
      try {
        fitAddon.fit();
      } catch {
        return;
      }
      const cols = clamp(terminal.cols, GRID_BOUNDS.minCols, GRID_BOUNDS.maxCols);
      const rows = clamp(terminal.rows, GRID_BOUNDS.minRows, GRID_BOUNDS.maxRows);
      if (cols !== terminal.cols || rows !== terminal.rows) {
        try {
          terminal.resize(cols, rows);
        } catch {
          return;
        }
      }
      state.cols = cols;
      state.rows = rows;
      api.sendResize?.(cols, rows);
    }
    if (state.follow) terminal.scrollToBottom();
    api.emitScroll();
  }

  api.fitTerminal = fitTerminal;

  let fitTimer = null;
  function scheduleFit() {
    if (fitTimer !== null) clearTimeout(fitTimer);
    fitTimer = setTimeout(() => {
      fitTimer = null;
      fitTerminal();
    }, FIT_DEBOUNCE_MS);
  }

  /**
   * Touch scrolling, owned here rather than by xterm.
   *
   * xterm only scrolls on touch while the program has NOT enabled mouse
   * tracking — and an agent TUI enables it, so on a phone the terminal simply
   * would not scroll at all. Nothing else scrolls it either: the viewport is
   * covered by the screen layer, and no ancestor is a scroll container. So the
   * gesture is read here, ahead of xterm in the capture phase, and replayed as
   * the wheel event a desk would have produced, with a fling to carry it.
   */
  function installTouchScroll(container) {
    let tracking = false;
    let scrolling = false;
    let startY = 0;
    let lastY = 0;
    let lastAt = 0;
    /** Where the wheel is reported from; a program may act on the column. */
    let pointerX = 0;
    let pointerY = 0;
    /** Pixels per millisecond; positive drags the content up. */
    let velocity = 0;
    /** Travel not yet worth a page key, on the alternate-screen path below. */
    let paged = 0;
    let flingFrame = null;

    const stopFling = () => {
      if (flingFrame !== null) cancelAnimationFrame(flingFrame);
      flingFrame = null;
    };

    /** Only these protocols carry the wheel; x10 and none do not. */
    const reportsWheel = () => {
      const mode = state.term?.modes.mouseTrackingMode;
      return mode === "vt200" || mode === "drag" || mode === "any";
    };

    /**
     * Replays the drag as a wheel event on the terminal element, which is the
     * one gesture every terminal already knows how to answer. xterm then does
     * exactly what it does on a desk: report the wheel to a program that asked
     * for mouse events, or scroll the scrollback.
     *
     * Returns false when nothing consumed it — the signal a fling needs to stop
     * rather than spin against the top of the buffer.
     */
    const wheel = (pixels) => {
      const element = state.term?.element;
      if (!element) return false;
      return !element.dispatchEvent(
        new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          clientX: pointerX,
          clientY: pointerY,
          deltaMode: 0,
          deltaX: 0,
          deltaY: pixels,
        }),
      );
    };

    /**
     * Page keys, for an alternate screen whose program never asked for the
     * wheel. xterm's own fallback there is arrow keys, and an agent reads those
     * as history navigation in its input box rather than as scrolling — which
     * is the whole reason this path is spelled out instead of delegated.
     */
    const pageKeys = (pixels) => {
      paged += pixels;
      const stride = Math.max(1, container.clientHeight * PAGE_KEY_FRACTION);
      const pages = paged / stride;
      const whole = pages > 0 ? Math.floor(pages) : Math.ceil(pages);
      if (whole === 0) return true;
      paged -= whole * stride;
      const key = whole > 0 ? "\u001b[6~" : "\u001b[5~";
      api.sendPty?.(encoder.encode(key.repeat(Math.min(Math.abs(whole), 4))));
      return true;
    };

    const scrollBy = (pixels) => {
      const terminal = state.term;
      if (!terminal || pixels === 0) return false;
      if (!reportsWheel() && terminal.buffer.active === terminal.buffer.alternate) {
        return pageKeys(pixels);
      }
      return wheel(pixels);
    };

    const fling = () => {
      flingFrame = null;
      if (Math.abs(velocity) < FLING_MIN_VELOCITY || !scrollBy(velocity * 16)) {
        velocity = 0;
        return;
      }
      velocity *= FLING_FRICTION;
      flingFrame = requestAnimationFrame(fling);
    };

    container.addEventListener(
      "touchstart",
      (event) => {
        stopFling();
        velocity = 0;
        paged = 0;
        scrolling = false;
        tracking = event.touches.length === 1;
        if (!tracking) return;
        pointerX = event.touches[0].clientX;
        pointerY = event.touches[0].clientY;
        startY = pointerY;
        lastY = startY;
        lastAt = event.timeStamp;
      },
      { capture: true, passive: true },
    );

    container.addEventListener(
      "touchmove",
      (event) => {
        if (!tracking || event.touches.length !== 1) return;
        const y = event.touches[0].clientY;
        pointerX = event.touches[0].clientX;
        pointerY = y;
        if (!scrolling) {
          if (Math.abs(y - startY) < SCROLL_SLOP_PX) return;
          scrolling = true;
          // Spend the slop, keep the rest: discarding the whole first move
          // would swallow the opening frame of a flick.
          lastY = startY + (y > startY ? SCROLL_SLOP_PX : -SCROLL_SLOP_PX);
          lastAt = event.timeStamp;
        }
        // Past the slop this is unambiguously a scroll, so xterm must not also
        // see it — as either its own touch scroll or a dragged mouse report.
        event.preventDefault();
        event.stopPropagation();
        const delta = lastY - y;
        const elapsed = Math.max(1, event.timeStamp - lastAt);
        lastY = y;
        lastAt = event.timeStamp;
        // Weighted toward the newest sample: a flick is over in a few frames,
        // and a heavily smoothed estimate would launch it at half speed.
        const sample = delta / elapsed;
        velocity = Math.max(
          -FLING_MAX_VELOCITY,
          Math.min(FLING_MAX_VELOCITY, velocity * 0.4 + sample * 0.6),
        );
        scrollBy(delta);
      },
      { capture: true, passive: false },
    );

    const release = (event) => {
      if (!tracking) return;
      tracking = false;
      if (!scrolling) return;
      scrolling = false;
      event.stopPropagation();
      // A finger held still before lifting means a placed viewport, not a fling.
      if (event.timeStamp - lastAt > 80) velocity = 0;
      if (Math.abs(velocity) >= FLING_MIN_VELOCITY) flingFrame = requestAnimationFrame(fling);
    };

    container.addEventListener("touchend", release, { capture: true, passive: true });
    container.addEventListener("touchcancel", release, { capture: true, passive: true });
  }

  function watchSurfaceSize(container) {
    // The native side owns this frame, so every layout change — keyboard,
    // rotation, the surface shrinking behind a sheet — reaches the worker as a
    // container resize and nothing else.
    if (typeof ResizeObserver === "function" && container) {
      new ResizeObserver(scheduleFit).observe(container);
    }
    // A first fit taken while the monospace face is still loading measures
    // fallback-font cells, and the grid then stays stably wrong because a
    // stable size never fires the observer again.
    document.fonts?.ready.then(scheduleFit).catch(() => {});
  }

  function initializeTerminal(message) {
    const terminal = new Terminal({
      allowProposedApi: true,
      convertEol: false,
      cursorBlink: true,
      fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
      fontSize: message.fontSize,
      lineHeight: 1.2,
      scrollback: 100_000,
      scrollOnUserInput: true,
      smoothScrollDuration: 0,
      theme: { ...message.theme },
    });
    const fitAddon = new FitAddon.FitAddon();
    const unicodeAddon = new Unicode11Addon.Unicode11Addon();
    const serializeAddon = new SerializeAddon.SerializeAddon();
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(unicodeAddon);
    terminal.unicode.activeVersion = "11";
    terminal.loadAddon(serializeAddon);
    terminal.loadAddon(
      new WebLinksAddon.WebLinksAddon((_event, uri) => api.post({ type: "link", url: uri })),
    );
    terminal.loadAddon(
      new ClipboardAddon.ClipboardAddon(undefined, {
        readText: async () => String(await clipboardRequest("clipboard-read")),
        writeText: async (_selection, text) => {
          await clipboardRequest("clipboard-write", text);
        },
      }),
    );
    terminal.open(document.getElementById("terminal"));
    // The DOM renderer, chosen rather than fallen back to. WebGL draws every
    // glyph into a canvas, and a canvas holds no text the system can select,
    // magnify, look up or copy — which is why selecting output used to need a
    // bespoke mode bolted on beside it. Real text nodes cost some scrolling
    // throughput and buy back every text interaction the phone already knows.
    state.renderer = "dom";
    terminal.resize(message.cols, message.rows);
    state.term = terminal;
    state.fitAddon = fitAddon;
    state.serializeAddon = serializeAddon;
    // Before anything is drawn or requested: the initial history render and the
    // PTY resize both quote state.cols, so the grid has to be the real one by
    // the time the control channel opens.
    fitTerminal();
    const container = document.getElementById("terminal");
    watchSurfaceSize(container);
    if (container) installTouchScroll(container);
    terminal.attachCustomKeyEventHandler((event) => {
      const arrow = APPLE_MODIFIERS ? appleArrowBytes(event) : null;
      if (!arrow) return true;
      // Suppress every event of the press, not just the keydown: returning
      // false does not preventDefault on its own, and a second path through
      // the same press would send the sequence twice.
      if (event.type === "keydown") {
        event.preventDefault();
        if (api.sessionReady?.()) {
          terminal.scrollToBottom();
          api.sendPty?.(encoder.encode(arrow));
        }
      }
      return false;
    });
    terminal.onData((data) => {
      if (!api.sessionReady?.()) return;
      const filtered = data.replace(/\u001b\[(?:\?|>)[0-9;]*c/g, "");
      api.sendPty?.(encoder.encode(filtered));
    });
    terminal.onTitleChange((title) => api.post({ type: "title", title }));
    terminal.onBell(() => api.post({ type: "bell" }));
    terminal.onScroll(api.emitScroll);
    terminal.onSelectionChange(() =>
      api.telemetry({ type: "selection", text: terminal.getSelection() }),
    );
    // A system selection is invisible to xterm, so the app hears about it here:
    // output arriving mid-selection must not scroll the handles off the text
    // they were placed on.
    document.addEventListener("selectionchange", () => {
      api.post({ type: "native-selection", active: documentSelection().length > 0 });
    });
    installAndroidTextareaDiff(terminal);
    configureTextarea();
    applyTheme(message.theme);
    api.post({ type: "ready", renderer: state.renderer });
  }

  /** What the system has selected in the document, if anything. */
  function documentSelection() {
    try {
      return String(window.getSelection() ?? "");
    } catch {
      return "";
    }
  }

  function searchTerminal(query, direction) {
    const terminal = state.term;
    if (!terminal || query.length === 0) return;
    const active = terminal.buffer.active;
    let line =
      state.search?.query === query
        ? state.search.line
        : direction === "next"
          ? 0
          : active.length - 1;
    for (let scanned = 0; scanned < active.length; scanned += 1) {
      const candidate = active.getLine(line)?.translateToString(true) ?? "";
      const column = direction === "next" ? candidate.indexOf(query) : candidate.lastIndexOf(query);
      if (column >= 0) {
        terminal.select(column, line, query.length);
        terminal.scrollToLine(line);
        state.search = { query, line: direction === "next" ? line + 1 : line - 1 };
        return;
      }
      line =
        direction === "next"
          ? (line + 1) % active.length
          : (line - 1 + active.length) % active.length;
    }
  }

  function handleSurfaceMessage(message) {
    switch (message.type) {
      case "input":
        if (message.sequence <= state.inputSequence) return true;
        state.inputSequence = message.sequence;
        api.sendPty?.(api.decodeBase64(message.data));
        return true;
      case "resize":
        state.cols = message.cols;
        state.rows = message.rows;
        state.term?.resize(message.cols, message.rows);
        api.sendResize?.(message.cols, message.rows);
        return true;
      case "fit":
        fitTerminal();
        return true;
      case "take-control":
        api.takeDisplayControl?.();
        return true;
      case "set-theme":
        applyTheme(message.theme);
        return true;
      case "set-font-size":
        state.fontSize = message.fontSize;
        // A new size changes the cell, and therefore the grid the PTY is owed.
        fitTerminal();
        return true;
      case "scroll":
        if (message.target === "bottom") state.term?.scrollToBottom();
        else state.term?.scrollToTop();
        api.emitScroll();
        return true;
      case "set-follow":
        state.follow = message.follow;
        if (message.follow) state.term?.scrollToBottom();
        api.emitScroll();
        return true;
      case "search":
        searchTerminal(message.query, message.direction);
        return true;
      case "copy-selection":
        // Whatever is selected: the system's selection first, since that is now
        // the one an operator makes, with xterm's own kept as the fallback.
        api.post({
          type: "selection",
          requestId: message.requestId,
          text: documentSelection() || (state.term?.getSelection() ?? ""),
        });
        return true;
      case "focus":
        refocusTerminal();
        return true;
      case "blur":
        state.term?.blur();
        return true;
      case "clipboard-response": {
        const pending = state.clipboardRequests.get(message.requestId);
        if (!pending) return true;
        clearTimeout(pending.timer);
        state.clipboardRequests.delete(message.requestId);
        if (message.error) pending.reject(new Error(message.error));
        else pending.resolve(message.text ?? undefined);
        return true;
      }
      default:
        return false;
    }
  }

  async function receiveMessage(raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      api.error("bridge_json", "Native bridge message is not valid JSON.");
      return;
    }
    if (message?.v !== BRIDGE_VERSION) {
      api.error("bridge_version", `Unsupported native bridge version: ${String(message?.v)}.`);
      return;
    }
    if (message.type === "init") {
      state.mode = message.mode;
      state.scopeId = message.scopeId;
      state.browserKey = message.browserIdentityPublicKey;
      state.hostKey = message.hostIdentityPublicKey;
      state.cols = message.cols;
      state.rows = message.rows;
      state.fontSize = message.fontSize;
      if (message.mode === "session" && !state.term) initializeTerminal(message);
      else api.post({ type: "ready", renderer: null });
      if (message.skipLoopbackProbe === true) {
        api.capability.dataChannel = api.capability.peerConnection;
        api.capability.loopback = api.capability.peerConnection;
        api.capabilityProbeComplete = true;
      } else if (typeof message.cachedLoopback === "boolean") {
        api.capability.dataChannel = api.capability.peerConnection;
        api.capability.loopback = message.cachedLoopback;
        api.capabilityProbeComplete = true;
      } else if (!api.capabilityProbeStarted) {
        api.capabilityProbeStarted = true;
        void probeLoopback();
      }
      if (api.capabilityProbeComplete) {
        api.post({
          type: "diagnostic",
          diagnostic: { ...api.capability, renderer: state.renderer },
        });
      }
      return;
    }
    if (handleSurfaceMessage(message)) return;
    try {
      await api.handleTransportMessage?.(message);
    } catch (error) {
      api.error(
        "worker_command",
        error instanceof Error ? error.message : "Worker command failed.",
      );
    }
  }

  const listener = (event) => {
    if (typeof event.data !== "string") return;
    void receiveMessage(event.data);
  };
  const bridgeTarget = /Android/i.test(navigator.userAgent) ? document : window;
  bridgeTarget.addEventListener("message", listener);

  api.sendPty = (bytes) => {
    if (!state.pty || state.pty.readyState !== "open") return false;
    for (let offset = 0; offset < bytes.byteLength; offset += MAX_INPUT_BYTES) {
      state.pty.send(bytes.slice(offset, offset + MAX_INPUT_BYTES));
    }
    if (bytes.byteLength > 0) {
      state.follow = true;
      state.term?.scrollToBottom();
      api.emitScroll();
    }
    return true;
  };

  api.bytesFromMessage = async (value) => {
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) {
      return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
    }
    if (value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
    return null;
  };

  api.capability = {
    isSecureContext: globalThis.isSecureContext === true,
    peerConnection: typeof RTCPeerConnection === "function",
    dataChannel: false,
    loopback: false,
    renderer: null,
  };
  api.capabilityProbeComplete = false;
  api.capabilityProbeStarted = false;

  async function probeLoopback() {
    if (!api.capability.peerConnection) {
      api.capabilityProbeComplete = true;
      api.post({ type: "diagnostic", diagnostic: { ...api.capability, renderer: state.renderer } });
      return;
    }
    const left = new RTCPeerConnection();
    const right = new RTCPeerConnection();
    try {
      left.onicecandidate = ({ candidate }) => candidate && void right.addIceCandidate(candidate);
      right.onicecandidate = ({ candidate }) => candidate && void left.addIceCandidate(candidate);
      const opened = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Loopback DataChannel timed out.")), 2_000);
        right.ondatachannel = ({ channel }) => {
          channel.onopen = () => {
            clearTimeout(timer);
            resolve(true);
          };
        };
      });
      left.createDataChannel("spawn.probe", { ordered: true });
      api.capability.dataChannel = true;
      const offer = await left.createOffer();
      await left.setLocalDescription(offer);
      await right.setRemoteDescription(offer);
      const answer = await right.createAnswer();
      await right.setLocalDescription(answer);
      await left.setRemoteDescription(answer);
      await opened;
      api.capability.loopback = true;
    } catch (error) {
      api.capability.detail = error instanceof Error ? error.message : "Loopback probe failed.";
    } finally {
      left.close();
      right.close();
      api.capabilityProbeComplete = true;
      api.post({ type: "diagnostic", diagnostic: { ...api.capability, renderer: state.renderer } });
    }
  }
})();
