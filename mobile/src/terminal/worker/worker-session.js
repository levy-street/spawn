// biome-ignore-all lint: This source executes inside WKWebView, not the React Native runtime.
(() => {
  "use strict";
  const api = globalThis.spawnWorker;
  const state = api.state;
  // The largest replay chunk payload accepted. The daemon frames a replay as
  // 16 KiB SCTP messages, 28 of them header; the size is learned from the
  // first non-final chunk, never assumed
  // (proto/session-ctl-replay-framing-v1-vectors.json).
  const CHUNK_BYTES = 48 * 1024;
  const MIN_REPLAY_CHUNK_BYTES = 1024;
  const MAX_REPLAY_BYTES = 12 * 1024 * 1024;
  const MAX_PREBOOT_BYTES = 12 * 1024 * 1024;
  const MAX_WRITE_BYTES = 4 * 1024 * 1024;
  const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
  const UPLOAD_START_ATTEMPTS = 3;
  const UPLOAD_START_TIMEOUT_MS = 5_000;
  const gates = {
    bindingAccepted: false,
    ptyOpen: false,
    ctlOpen: false,
    daemonReady: false,
    historyReady: false,
  };
  const session = {
    ready: false,
    bootstrapStarted: false,
    bootstrapCount: 0,
    requestedOffset: null,
    displaySeen: false,
    claiming: false,
    history: null,
    preboot: [],
    prebootBytes: 0,
    ptyOffset: 0,
    ptyTail: Promise.resolve(),
    ctlTail: Promise.resolve(),
    writes: [],
    writeBytes: 0,
    writeTimer: null,
    writeInFlight: false,
    stale: false,
    uploadCapability: null,
    agentGeneration: null,
    uploads: new Map(),
  };

  api.sessionReady = () => session.ready;

  function resetGates() {
    for (const key of Object.keys(gates)) gates[key] = false;
    session.ready = false;
    session.bootstrapStarted = false;
    session.requestedOffset = null;
    session.displaySeen = false;
    session.claiming = false;
    state.displayOwner = null;
    state.displayGeometry = null;
    state.displayViewers = 1;
    session.history = null;
    session.preboot.splice(0);
    session.prebootBytes = 0;
    session.ptyOffset = 0;
    session.writes.splice(0);
    session.writeBytes = 0;
    session.writeInFlight = false;
    session.stale = false;
    session.uploadCapability = null;
    session.agentGeneration = null;
    for (const upload of session.uploads.values()) clearTimeout(upload.startTimer);
    session.uploads.clear();
    clearTimeout(session.writeTimer);
    session.writeTimer = null;
  }

  api.resetSessionGeneration = resetGates;

  function allReady() {
    return Object.values(gates).every(Boolean);
  }

  function checkReady() {
    if (!allReady() || session.ready) return;
    session.ready = true;
    api.post({ type: "state", state: "ready" });
    // The grid was fitted long before the control channel could carry it. A
    // session that never publishes it leaves the PTY at whatever size it was
    // created with, and every row the daemon renders is written for a terminal
    // this phone does not have.
    api.sendResize(state.cols, state.rows);
  }

  api.sessionGate = (gate) => {
    if (!(gate in gates) || gates[gate]) return;
    gates[gate] = true;
    api.post({ type: "state", state: "connecting", gate });
    startBootstrap();
    checkReady();
  };

  api.sessionChannelOpened = (gate) => api.sessionGate(gate);

  function makeRequest(requestId, operation, parameters = {}) {
    return JSON.stringify({
      ...parameters,
      version: 1,
      kind: "request",
      request_id: requestId,
      operation,
    });
  }

  function sendCtlText(requestId, operation, parameters = {}) {
    if (!state.ctl || state.ctl.readyState !== "open") return false;
    const text = makeRequest(requestId, operation, parameters);
    if (new TextEncoder().encode(text).byteLength > 16 * 1024) return false;
    state.ctl.send(text);
    return true;
  }

  function startBootstrap() {
    if (
      session.bootstrapStarted ||
      !gates.bindingAccepted ||
      !gates.ptyOpen ||
      !gates.ctlOpen ||
      !gates.daemonReady
    ) {
      return;
    }
    session.bootstrapStarted = true;
    const requestId = crypto.randomUUID();
    session.history = {
      requestId,
      operation: "history",
      metadata: null,
      chunks: new Map(),
      chunkBytes: null,
      bytes: 0,
      rendering: false,
    };
    if (
      !sendCtlText(requestId, "history", {
        lines: 400,
        plain: false,
        ...(session.requestedOffset === null ? {} : { offset: session.requestedOffset }),
        cols: state.cols,
        rows: state.rows,
      })
    ) {
      api.error("history_request", "Initial terminal history request was rejected.", true);
      return;
    }
    sendCtlText(crypto.randomUUID(), "history_subscribe");
  }

  function enqueueWrite(bytes) {
    if (bytes.byteLength === 0 || session.stale) return;
    if (session.writeBytes + bytes.byteLength > MAX_WRITE_BYTES) {
      session.writes.splice(0);
      session.writeBytes = 0;
      session.stale = true;
      requestReplay();
      return;
    }
    session.writes.push(bytes);
    session.writeBytes += bytes.byteLength;
    if (session.writeBytes >= 32 * 1024) flushWrites();
    else if (session.writeTimer === null) session.writeTimer = setTimeout(flushWrites, 8);
  }

  function takeWriteBatch() {
    const target = Math.min(32 * 1024, session.writeBytes);
    const batch = new Uint8Array(target);
    let written = 0;
    while (written < target && session.writes.length > 0) {
      const current = session.writes[0];
      const take = Math.min(current.byteLength, target - written);
      batch.set(current.subarray(0, take), written);
      written += take;
      if (take === current.byteLength) session.writes.shift();
      else session.writes[0] = current.subarray(take);
    }
    session.writeBytes -= written;
    return batch;
  }

  function flushWrites() {
    clearTimeout(session.writeTimer);
    session.writeTimer = null;
    if (session.writeInFlight || session.writeBytes === 0 || session.stale || !state.term) return;
    session.writeInFlight = true;
    const wasAtBottom = api.scrollState().atBottom;
    state.term.write(takeWriteBatch(), () => {
      session.writeInFlight = false;
      if (state.follow && wasAtBottom) state.term.scrollToBottom();
      api.emitScroll();
      flushWrites();
    });
  }

  api.receivePty = (value) => {
    session.ptyTail = session.ptyTail
      .then(async () => {
        const bytes = await api.bytesFromMessage(value);
        if (!bytes) return;
        session.ptyOffset += bytes.byteLength;
        const entry = { bytes, offsetAfter: session.ptyOffset };
        if (!session.ready) {
          if (session.prebootBytes + bytes.byteLength > MAX_PREBOOT_BYTES) {
            throw new Error("Pre-bootstrap terminal output exceeded 12 MiB.");
          }
          session.preboot.push(entry);
          session.prebootBytes += bytes.byteLength;
          finishReplay();
        } else {
          if (!api.scrollState().atBottom) state.newOutputWhileAway = true;
          enqueueWrite(bytes);
        }
      })
      .catch((error) => api.error("pty_decode", error.message, true));
  };

  function uuidBytes(value) {
    const compact = value.replaceAll("-", "");
    if (!/^[0-9a-f]{32}$/i.test(compact)) return null;
    return Uint8Array.from({ length: 16 }, (_, index) =>
      Number.parseInt(compact.slice(index * 2, index * 2 + 2), 16),
    );
  }

  function uuidText(bytes) {
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  function decodeSpct(bytes) {
    if (bytes.byteLength < 28 || bytes.byteLength > 28 + CHUNK_BYTES) return null;
    if (
      bytes[0] !== 0x53 ||
      bytes[1] !== 0x50 ||
      bytes[2] !== 0x43 ||
      bytes[3] !== 0x54 ||
      bytes[4] !== 1
    )
      return null;
    if (bytes[5] !== 1 && bytes[5] !== 2) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const flags = view.getUint16(6, true);
    if ((flags & ~1) !== 0) return null;
    return {
      kind: bytes[5],
      requestId: uuidText(bytes.subarray(8, 24)),
      sequence: view.getUint32(24, true),
      last: (flags & 1) !== 0,
      payload: bytes.slice(28),
    };
  }

  function encodeUploadChunk(uploadId, sequence, last, payload) {
    const id = uuidBytes(uploadId);
    if (!id || payload.byteLength === 0 || payload.byteLength > CHUNK_BYTES) return null;
    const output = new Uint8Array(28 + payload.byteLength);
    output.set([0x53, 0x50, 0x43, 0x54, 1, 2]);
    const view = new DataView(output.buffer);
    view.setUint16(6, last ? 1 : 0, true);
    output.set(id, 8);
    view.setUint32(24, sequence, true);
    output.set(payload, 28);
    return output;
  }

  function finishReplay() {
    const history = session.history;
    if (!history?.metadata || history.rendering) return;
    const { total_bytes: totalBytes, chunks, pty_offset: anchor } = history.metadata;
    if (history.chunks.size !== chunks) return;
    if (Number.isSafeInteger(anchor) && session.ptyOffset < anchor) return;
    const replay = new Uint8Array(totalBytes);
    let offset = 0;
    for (let sequence = 0; sequence < chunks; sequence += 1) {
      const chunk = history.chunks.get(sequence);
      if (!chunk) return;
      replay.set(chunk, offset);
      offset += chunk.byteLength;
    }
    history.rendering = true;
    if (history.operation === "snapshot") state.term.reset();
    const finish = () => {
      let barrier = Number.isSafeInteger(anchor) ? anchor : null;
      for (const entry of session.preboot) {
        if (barrier !== null && entry.offsetAfter <= barrier) {
          if (entry.offsetAfter === barrier) barrier = null;
          continue;
        }
        const start = entry.offsetAfter - entry.bytes.byteLength;
        const suffix =
          barrier !== null && start < barrier ? entry.bytes.subarray(barrier - start) : entry.bytes;
        barrier = null;
        enqueueWrite(suffix);
      }
      session.preboot.splice(0);
      session.prebootBytes = 0;
      session.history = null;
      session.stale = false;
      session.requestedOffset = null;
      session.bootstrapCount += 1;
      api.sessionGate("historyReady");
      flushWrites();
    };
    const alternate = state.term.buffer.active === state.term.buffer.alternate;
    if (history.operation === "history" && session.bootstrapCount > 0 && alternate) {
      finish();
      return;
    }
    const writeReplay = () => state.term.write(replay, finish);
    if (history.operation === "history" && session.bootstrapCount > 0) {
      state.term.write("\x1b[0m\x1b[H\x1b[2J\x1b[3J", writeReplay);
    } else {
      writeReplay();
    }
  }

  function recoverFromGap(offset) {
    if (!Number.isSafeInteger(offset) || offset < 0) return;
    session.preboot.splice(0);
    session.prebootBytes = 0;
    session.writes.splice(0);
    session.writeBytes = 0;
    session.history = null;
    session.stale = false;
    session.ready = false;
    session.bootstrapStarted = false;
    session.requestedOffset = offset;
    session.ptyOffset = offset;
    gates.historyReady = false;
    startBootstrap();
  }

  // Whether `chunks` can carry `totalBytes` under some chunk size in the
  // accepted range; the first non-final chunk fixes the exact size.
  function replayChunkCountIsPlausible(totalBytes, chunks) {
    if (chunks === 0) return totalBytes === 0;
    if (totalBytes === 0) return false;
    if (chunks === 1) return totalBytes <= CHUNK_BYTES;
    return (chunks - 1) * MIN_REPLAY_CHUNK_BYTES < totalBytes && totalBytes <= chunks * CHUNK_BYTES;
  }

  function acceptReplayMetadata(message) {
    const history = session.history;
    if (
      !history ||
      message.request_id !== history.requestId ||
      message.operation !== history.operation ||
      message.ok !== true
    ) {
      return false;
    }
    if (
      message.plain !== false ||
      !Number.isSafeInteger(message.total_bytes) ||
      message.total_bytes < 0 ||
      message.total_bytes > MAX_REPLAY_BYTES ||
      !Number.isSafeInteger(message.chunks) ||
      !replayChunkCountIsPlausible(message.total_bytes, message.chunks) ||
      !(
        message.pty_offset === undefined ||
        message.pty_offset === null ||
        (Number.isSafeInteger(message.pty_offset) && message.pty_offset >= 0)
      )
    ) {
      // A reply this client will not assemble is a wire disagreement, not
      // silence: the pane must not wait on it until the connect timeout.
      api.error("replay_metadata", "Replay metadata is not a framing this client accepts.", true);
      return false;
    }
    history.metadata = message;
    if (message.chunks === 0) finishReplay();
    return true;
  }

  function acceptReplayChunk(frame) {
    const history = session.history;
    const metadata = history?.metadata;
    if (!history || !metadata || frame.kind !== 1 || frame.requestId !== history.requestId) return;
    const final = metadata.chunks - 1;
    const isFinal = frame.sequence === final;
    const length = frame.payload.byteLength;
    const reject = (reason) => api.error("replay_frame", reason, true);
    if (frame.sequence >= metadata.chunks || history.chunks.has(frame.sequence)) {
      reject("Malformed or duplicate replay chunk.");
      return;
    }
    if (frame.last !== isFinal || length === 0 || length > CHUNK_BYTES) {
      reject("Replay chunk flag or length is out of range.");
      return;
    }
    if (isFinal) {
      const expected =
        history.chunkBytes == null
          ? metadata.chunks === 1
            ? metadata.total_bytes
            : null
          : metadata.total_bytes - history.chunkBytes * final;
      if (expected !== null && length !== expected) {
        reject("Final replay chunk does not complete the total.");
        return;
      }
    } else if (history.chunkBytes == null) {
      // The first non-final chunk fixes the framing for the rest; the
      // daemon's size is never assumed, only required to carry the total.
      if (
        length < MIN_REPLAY_CHUNK_BYTES ||
        length * final >= metadata.total_bytes ||
        length * metadata.chunks < metadata.total_bytes
      ) {
        reject("Replay chunk size cannot carry the total.");
        return;
      }
      const held = history.chunks.get(final);
      if (held && held.byteLength !== metadata.total_bytes - length * final) {
        reject("Final replay chunk does not complete the total.");
        return;
      }
      history.chunkBytes = length;
    } else if (length !== history.chunkBytes) {
      reject("Replay chunks are not one size.");
      return;
    }
    if (history.bytes + length > MAX_REPLAY_BYTES) {
      reject("Replay exceeds the aggregate byte limit.");
      return;
    }
    history.chunks.set(frame.sequence, frame.payload);
    history.bytes += length;
    finishReplay();
  }

  function handleReady(message) {
    if (
      typeof message.upload_capability !== "string" ||
      !Number.isSafeInteger(message.agent_generation) ||
      message.agent_generation <= 0 ||
      message.upload_max_bytes !== MAX_UPLOAD_BYTES ||
      message.upload_chunk_bytes !== CHUNK_BYTES
    ) {
      api.error("ctl_ready", "Daemon ready event has incompatible upload limits.");
      return;
    }
    session.uploadCapability = message.upload_capability;
    session.agentGeneration = message.agent_generation;
    api.sessionGate("daemonReady");
  }

  function uploadProgress(upload, progress) {
    api.post({
      type: "upload-progress",
      uploadId: upload.uploadId,
      totalBytes: upload.totalBytes,
      ...progress,
    });
  }

  function sendUploadStart(upload) {
    upload.startAttempts += 1;
    sendCtlText(upload.uploadId, "upload_start", {
      capability: session.uploadCapability,
      agent_generation: session.agentGeneration,
      name: upload.name,
      mime_type: upload.mimeType,
      destination: upload.destination,
      total_bytes: upload.totalBytes,
      chunks: upload.chunks,
      sha256: upload.sha256,
    });
    clearTimeout(upload.startTimer);
    upload.startTimer = setTimeout(() => {
      if (!session.uploads.has(upload.uploadId) || upload.finalDispatched) return;
      if (upload.startAttempts < UPLOAD_START_ATTEMPTS) {
        sendUploadStart(upload);
        return;
      }
      uploadProgress(upload, {
        state: "failed",
        sentBytes: upload.sentBytes,
        error: {
          code: "upload_start_timeout",
          message: "Upload start response timed out after three attempts.",
          retryable: true,
        },
      });
      session.uploads.delete(upload.uploadId);
    }, UPLOAD_START_TIMEOUT_MS);
  }

  function handleUploadResponse(message) {
    const upload = session.uploads.get(message.request_id);
    if (!upload) return false;
    clearTimeout(upload.startTimer);
    upload.startTimer = null;
    if (!message.ok) {
      uploadProgress(upload, {
        state: upload.finalDispatched ? "outcome_unknown" : "failed",
        sentBytes: upload.sentBytes,
        error: {
          code: message.error?.code ?? "upload_failed",
          message: message.error?.detail ?? "Upload failed.",
          retryable: false,
        },
      });
      if (!upload.finalDispatched) session.uploads.delete(upload.uploadId);
      return true;
    }
    if (message.operation === "upload_start" && message.state === "ready") {
      if (
        !Number.isSafeInteger(message.next_sequence) ||
        !Number.isSafeInteger(message.received_bytes)
      )
        return true;
      upload.nextSequence = message.next_sequence;
      upload.sentBytes = message.received_bytes;
      uploadProgress(upload, {
        state: "uploading",
        sentBytes: upload.sentBytes,
        nextSequence: upload.nextSequence,
      });
      return true;
    }
    if (
      message.operation === "upload_complete" &&
      message.state === "complete" &&
      message.total_bytes === upload.totalBytes &&
      message.sha256 === upload.sha256 &&
      typeof message.path === "string"
    ) {
      uploadProgress(upload, {
        state: "complete",
        sentBytes: upload.totalBytes,
        path: message.path,
        sha256: message.sha256,
      });
      session.uploads.delete(upload.uploadId);
      return true;
    }
    return false;
  }

  function receiveCtlValue(value) {
    if (typeof value === "string") {
      if (new TextEncoder().encode(value).byteLength > 16 * 1024) return;
      let message;
      try {
        message = JSON.parse(value);
      } catch {
        return;
      }
      if (message?.version !== 1) return;
      if (message.kind === "event" && message.event === "ready") handleReady(message);
      else if (message.kind === "event" && message.event === "history_gap") {
        recoverFromGap(session.ptyOffset);
      } else if (message.kind === "event" && message.event === "pty_gap") {
        recoverFromGap(message.offset);
      } else if (message.kind === "event" && message.event === "display_state") {
        handleDisplayState(message);
      } else if (message.kind === "response") {
        if (!handleUploadResponse(message)) acceptReplayMetadata(message);
      }
      return;
    }
    return api.bytesFromMessage(value).then((bytes) => {
      if (bytes) {
        const frame = decodeSpct(bytes);
        if (frame) acceptReplayChunk(frame);
      }
    });
  }

  api.receiveSessionCtl = (value) => {
    session.ctlTail = session.ctlTail
      .then(() => receiveCtlValue(value))
      .catch((error) => api.error("ctl_decode", error.message, true));
  };

  api.sendResize = (cols, rows) => {
    if (session.claiming || !session.ready) return;
    // Only the display owner may resize the shared PTY; a follower's request is
    // refused, and acting as though it succeeded is what leaves the grid lying
    // about its width.
    if (state.displayOwner === false) return;
    const geometry = state.displayGeometry;
    if (geometry && geometry.cols === cols && geometry.rows === rows) return;
    sendCtlText(crypto.randomUUID(), "resize", { cols, rows });
  };

  /**
   * Claims the shared display at this phone's own geometry. The daemon resizes
   * the PTY and redraws, so the next frame is rendered for this screen instead
   * of whatever desk the session was last read from.
   */
  api.takeDisplayControl = () => {
    if (!state.term) return false;
    session.claiming = true;
    state.displayOwner = true;
    state.displayGeometry = null;
    try {
      api.fitTerminal();
    } finally {
      session.claiming = false;
    }
    return sendCtlText(crypto.randomUUID(), "take_control", {
      cols: state.cols,
      rows: state.rows,
    });
  };

  function handleDisplayState(message) {
    const owner = message.owner === true;
    const cols = Number.isSafeInteger(message.cols) ? message.cols : null;
    const rows = Number.isSafeInteger(message.rows) ? message.rows : null;
    state.displayOwner = owner;
    state.displayGeometry = cols === null || rows === null ? null : { cols, rows };
    state.displayViewers = Number.isSafeInteger(message.viewers) ? message.viewers : 1;
    api.post({
      type: "display",
      owner,
      viewers: state.displayViewers,
      ...(cols === null ? {} : { cols }),
      ...(rows === null ? {} : { rows }),
    });
    // A frame that lands before the grid exists is recorded but not acted on,
    // so the claim below still happens off the first frame that can carry it.
    if (!state.term) return;
    // Opening a terminal claims the display, matching the web client. Only off
    // the first frame, though: reacting to later ownership changes would have
    // two open viewers steal control from each other forever. A follower re-takes
    // it deliberately, from the banner.
    const first = !session.displaySeen;
    session.displaySeen = true;
    if (!owner && first) {
      api.takeDisplayControl();
      return;
    }
    api.fitTerminal();
  }

  function requestReplay() {
    if (!gates.ctlOpen || !gates.daemonReady || session.history) return;
    gates.historyReady = false;
    session.ready = false;
    const requestId = crypto.randomUUID();
    session.history = {
      requestId,
      operation: "snapshot",
      metadata: null,
      chunks: new Map(),
      chunkBytes: null,
      bytes: 0,
      rendering: false,
    };
    sendCtlText(requestId, "snapshot", { lines: 10_000, plain: false });
  }

  api.requestReplay = requestReplay;

  function waitForBufferedAmount() {
    if (!state.ctl || state.ctl.bufferedAmount <= 256 * 1024) return Promise.resolve();
    state.ctl.bufferedAmountLowThreshold = 128 * 1024;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Upload channel remained backpressured.")),
        5_000,
      );
      state.ctl.addEventListener(
        "bufferedamountlow",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }

  function validUploadStart(message) {
    if (
      typeof message.uploadId !== "string" ||
      typeof message.name !== "string" ||
      typeof message.mimeType !== "string" ||
      typeof message.sha256 !== "string"
    ) {
      return false;
    }
    const nameBytes = new TextEncoder().encode(message.name).byteLength;
    const mimeBytes = new TextEncoder().encode(message.mimeType).byteLength;
    return (
      uuidBytes(message.uploadId) !== null &&
      Number.isSafeInteger(message.totalBytes) &&
      message.totalBytes > 0 &&
      message.totalBytes <= MAX_UPLOAD_BYTES &&
      nameBytes >= 1 &&
      nameBytes <= 255 &&
      message.name !== "." &&
      message.name !== ".." &&
      !/[\u0000-\u001f\u007f-\u009f/\\]/.test(message.name) &&
      mimeBytes >= 1 &&
      mimeBytes <= 128 &&
      /^[\x21-\x7e]+$/.test(message.mimeType) &&
      !message.mimeType.includes(";") &&
      (message.destination === "cwd" ||
        (message.destination === "attachments" &&
          (message.mimeType.startsWith("image/") || message.mimeType === "application/json"))) &&
      /^[0-9a-f]{64}$/.test(message.sha256)
    );
  }

  api.handleUploadMessage = async (message) => {
    if (message.type === "upload-start") {
      if (
        !session.ready ||
        !session.uploadCapability ||
        !session.agentGeneration ||
        session.uploads.size >= 4 ||
        !validUploadStart(message)
      ) {
        api.post({
          type: "upload-progress",
          uploadId: message.uploadId,
          state: "failed",
          sentBytes: 0,
          totalBytes: message.totalBytes,
          error: {
            code: "upload_unavailable",
            message: "Session upload is unavailable.",
            retryable: true,
          },
        });
        return;
      }
      const chunks = Math.ceil(message.totalBytes / CHUNK_BYTES);
      const upload = {
        ...message,
        chunks,
        nextSequence: 0,
        sentBytes: 0,
        finalDispatched: false,
        startAttempts: 0,
        startTimer: null,
      };
      session.uploads.set(message.uploadId, upload);
      uploadProgress(upload, { state: "starting", sentBytes: 0 });
      sendUploadStart(upload);
      return;
    }
    const upload = session.uploads.get(message.uploadId);
    if (!upload) return;
    if (message.type === "upload-cancel") {
      if (!upload.finalDispatched) {
        sendCtlText(crypto.randomUUID(), "upload_cancel", {
          capability: session.uploadCapability,
          agent_generation: session.agentGeneration,
          upload_id: upload.uploadId,
        });
        uploadProgress(upload, { state: "cancelled", sentBytes: upload.sentBytes });
        clearTimeout(upload.startTimer);
        session.uploads.delete(upload.uploadId);
      }
      return;
    }
    if (message.sequence !== upload.nextSequence)
      throw new Error("Upload bridge sequence mismatch.");
    const payload = api.decodeBase64(message.data);
    const expected = message.last
      ? upload.totalBytes - message.sequence * CHUNK_BYTES
      : CHUNK_BYTES;
    if (
      payload.byteLength !== expected ||
      message.last !== (message.sequence === upload.chunks - 1)
    ) {
      throw new Error("Upload bridge chunk length or final flag mismatch.");
    }
    await waitForBufferedAmount();
    const frame = encodeUploadChunk(upload.uploadId, message.sequence, message.last, payload);
    if (!frame || !state.ctl || state.ctl.readyState !== "open")
      throw new Error("Upload channel closed.");
    if (message.last) {
      upload.finalDispatched = true;
      uploadProgress(upload, { state: "outcome_unknown", sentBytes: upload.sentBytes });
    }
    state.ctl.send(frame);
    upload.nextSequence += 1;
    upload.sentBytes += payload.byteLength;
    uploadProgress(upload, {
      state: message.last ? "outcome_unknown" : "uploading",
      sentBytes: upload.sentBytes,
      nextSequence: upload.nextSequence,
    });
  };
})();
