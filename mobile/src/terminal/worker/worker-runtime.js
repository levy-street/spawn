// biome-ignore-all lint: This source executes inside WKWebView, not the React Native runtime.
(() => {
  "use strict";

  const BRIDGE_VERSION = 1;
  const MAX_INPUT_BYTES = 64 * 1024;
  const TELEMETRY_DELAY_MS = 8;
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
    pc: null,
    pty: null,
    ctl: null,
    rtcSessionId: null,
    bindingNonce: null,
    bindingGeneration: null,
    pendingLocalCandidates: [],
    pendingRemoteCandidates: [],
    pendingSign: new Map(),
    inputSequence: -1,
    clipboardRequests: new Map(),
    clipboardSequence: 0,
    search: null,
    disconnectTimer: null,
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

  function configureTextarea() {
    const textarea = document.querySelector(".xterm-helper-textarea");
    if (!textarea) return;
    textarea.setAttribute("autocomplete", "off");
    textarea.setAttribute("autocapitalize", "off");
    textarea.setAttribute("autocorrect", "off");
    textarea.setAttribute("spellcheck", "false");
    textarea.setAttribute("enterkeyhint", "enter");
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
    state.renderer = "dom";
    try {
      const webgl = new WebglAddon.WebglAddon();
      webgl.onContextLoss(() => {
        webgl.dispose();
        state.webglAddon = null;
        state.renderer = "dom";
        api.post({
          type: "diagnostic",
          diagnostic: {
            ...api.capability,
            renderer: "dom",
            detail: "WebGL context lost; DOM fallback active.",
          },
        });
      });
      terminal.loadAddon(webgl);
      state.webglAddon = webgl;
      state.renderer = "webgl";
    } catch {
      state.renderer = "dom";
    }
    terminal.resize(message.cols, message.rows);
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
    state.term = terminal;
    state.fitAddon = fitAddon;
    state.serializeAddon = serializeAddon;
    configureTextarea();
    applyTheme(message.theme);
    api.post({ type: "ready", renderer: state.renderer });
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
        state.fitAddon?.fit();
        if (state.term) {
          state.cols = state.term.cols;
          state.rows = state.term.rows;
          api.sendResize?.(state.cols, state.rows);
        }
        return true;
      case "set-theme":
        applyTheme(message.theme);
        return true;
      case "set-font-size":
        state.fontSize = message.fontSize;
        if (state.term) state.term.options.fontSize = message.fontSize;
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
        api.post({
          type: "selection",
          requestId: message.requestId,
          text: state.term?.getSelection() ?? "",
        });
        return true;
      case "focus":
        state.term?.focus();
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

  let lastRaw = null;
  let lastRawAt = 0;
  const listener = (event) => {
    if (typeof event.data !== "string") return;
    const now = performance.now();
    if (event.data === lastRaw && now - lastRawAt < 1) return;
    lastRaw = event.data;
    lastRawAt = now;
    void receiveMessage(event.data);
  };
  window.addEventListener("message", listener);
  document.addEventListener("message", listener);

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

  void probeLoopback();
})();
