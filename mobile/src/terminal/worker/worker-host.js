// biome-ignore-all lint: This source executes inside WKWebView, not the React Native runtime.
(() => {
  "use strict";
  const api = globalThis.spawnWorker;
  const state = api.state;
  const host = { binding: false, channel: false, hello: false };
  const HOST_HELLO_BRIDGE_ID = "$host.hello";
  const HOST_STREAM_BRIDGE_PREFIX = "$host.stream:";
  const STREAM_COMMAND_PREFIX = "$host.stream.";
  const MAX_FRAME_BYTES = 16 * 1024;
  const MAX_CHUNK_BYTES = 8 * 1024;
  const BUFFERED_HIGH_WATER = 256 * 1024;
  const STREAM_TIMEOUT_MS = 60_000;

  function checkReady() {
    if (host.binding && host.channel && host.hello) api.post({ type: "state", state: "ready" });
  }

  function postResponse(requestId, ok, result, error) {
    api.post({
      type: "host-response",
      requestId,
      ok,
      ...(result === undefined ? {} : { result }),
      ...(error === undefined ? {} : { error }),
    });
  }

  function encodeFrame(frame) {
    const text = JSON.stringify(frame);
    if (new TextEncoder().encode(text).byteLength > MAX_FRAME_BYTES) {
      throw new Error("Host-control frame exceeds 16 KiB.");
    }
    return text;
  }

  function sendFrame(frame) {
    if (!state.ctl || state.ctl.readyState !== "open") {
      throw new Error("Host-control channel is not ready.");
    }
    state.ctl.send(encodeFrame(frame));
  }

  async function waitForWritable() {
    const channel = state.ctl;
    if (channel?.readyState !== "open") throw new Error("Host-control channel is not ready.");
    if (channel.bufferedAmount <= BUFFERED_HIGH_WATER) return;
    channel.bufferedAmountLowThreshold = BUFFERED_HIGH_WATER / 2;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        channel.removeEventListener("bufferedamountlow", onWritable);
        reject(new Error("Host stream backpressure timed out."));
      }, STREAM_TIMEOUT_MS);
      const onWritable = () => {
        clearTimeout(timer);
        resolve();
      };
      channel.addEventListener("bufferedamountlow", onWritable, { once: true });
    });
    if (channel.readyState !== "open") throw new Error("Host-control channel is not ready.");
  }

  function streamFrame(type, payload) {
    if (!payload || typeof payload.stream_id !== "string" || payload.stream_id.length === 0) {
      throw new Error("Host stream command is missing its stream ID.");
    }
    if (type === "chunk") {
      if (!Number.isSafeInteger(payload.sequence) || payload.sequence < 0) {
        throw new Error("Host stream chunk sequence is invalid.");
      }
      if (typeof payload.bytes_b64 !== "string") {
        throw new Error("Host stream chunk bytes are invalid.");
      }
      const bytes = api.decodeBase64(payload.bytes_b64);
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_CHUNK_BYTES) {
        throw new Error("Host stream chunk exceeds 8 KiB.");
      }
    } else if (type === "end") {
      if (
        !Number.isSafeInteger(payload.length) ||
        payload.length < 0 ||
        typeof payload.sha256 !== "string" ||
        !/^[0-9a-f]{64}$/.test(payload.sha256)
      ) {
        throw new Error("Host stream end frame is invalid.");
      }
    } else if (type === "ack") {
      if (!Number.isSafeInteger(payload.sequence) || payload.sequence < 1) {
        throw new Error("Host stream acknowledgement is invalid.");
      }
    }
    return {
      version: 1,
      type: `stream.${type}`,
      stream_id: payload.stream_id,
      ...(type === "chunk"
        ? { sequence: payload.sequence, bytes_b64: payload.bytes_b64 }
        : type === "end"
          ? { length: payload.length, sha256: payload.sha256 }
          : type === "ack"
            ? { sequence: payload.sequence }
            : {}),
    };
  }

  async function sendHostMessage(message) {
    try {
      if (message.type === "host-cancel") {
        sendFrame({ version: 1, type: "cancel", request_id: message.requestId });
        return;
      }
      if (message.type !== "host-request") return;
      if (message.operation.startsWith(STREAM_COMMAND_PREFIX)) {
        const type = message.operation.slice(STREAM_COMMAND_PREFIX.length);
        if (!["ack", "cancel", "chunk", "end"].includes(type)) {
          throw new Error("Unknown host stream command.");
        }
        if (type === "chunk" || type === "end") await waitForWritable();
        sendFrame(streamFrame(type, message.payload));
        postResponse(message.requestId, true, { sent: true });
        return;
      }
      sendFrame({
        version: 1,
        type: "request",
        request_id: message.requestId,
        operation: message.operation,
        ...(message.payload === undefined ? {} : { payload: message.payload }),
      });
    } catch (error) {
      postResponse(message.requestId, false, undefined, {
        code: "host_send_failed",
        detail: error instanceof Error ? error.message : "Host-control send failed.",
      });
    }
  }

  api.resetHostGeneration = () => {
    host.binding = false;
    host.channel = false;
    host.hello = false;
  };

  api.hostBindingAccepted = () => {
    host.binding = true;
    checkReady();
  };

  api.hostChannelOpened = () => {
    host.channel = true;
    checkReady();
  };

  api.receiveHostCtl = (value) => {
    if (typeof value !== "string") {
      api.error("host_binary", "Unexpected host-control binary frame.", false);
      return;
    }
    if (new TextEncoder().encode(value).byteLength > MAX_FRAME_BYTES) {
      api.error("host_frame_size", "Host-control frame exceeds 16 KiB.", false);
      return;
    }
    let message;
    try {
      message = JSON.parse(value);
    } catch {
      api.error("host_json", "Host-control frame is not valid JSON.", false);
      return;
    }
    if (message?.version !== 1) {
      api.error("host_version", "Host-control frame has an unsupported version.", false);
      return;
    }
    if (message.type === "hello" && message.protocol === "spawn.host.ctl") {
      postResponse(HOST_HELLO_BRIDGE_ID, true, message);
      host.hello = true;
      checkReady();
      return;
    }
    if (typeof message.type === "string" && message.type.startsWith("stream.")) {
      if (typeof message.stream_id !== "string") {
        api.error("host_stream", "Host stream frame is missing its stream ID.", false);
        return;
      }
      postResponse(`${HOST_STREAM_BRIDGE_PREFIX}${message.stream_id}`, true, message);
      return;
    }
    if (message.type !== "response" || typeof message.request_id !== "string") return;
    postResponse(message.request_id, message.ok === true, message.result, message.error);
  };

  api.handleHostMessage = (message) => {
    void sendHostMessage(message);
  };
})();
