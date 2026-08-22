// biome-ignore-all lint: This source executes inside WKWebView, not the React Native runtime.
(() => {
  "use strict";
  const api = globalThis.spawnWorker;
  const state = api.state;
  const host = { binding: false, channel: false, hello: false };

  function checkReady() {
    if (host.binding && host.channel && host.hello) api.post({ type: "state", state: "ready" });
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
    if (new TextEncoder().encode(value).byteLength > 16 * 1024) {
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
    if (message?.version !== 1) return;
    if (message.type === "hello" && message.protocol === "spawn.host.ctl") {
      host.hello = true;
      checkReady();
      return;
    }
    if (message.type !== "response" || typeof message.request_id !== "string") return;
    api.post({
      type: "host-response",
      requestId: message.request_id,
      ok: message.ok === true,
      ...(message.result === undefined ? {} : { result: message.result }),
      ...(message.error === undefined ? {} : { error: message.error }),
    });
  };

  api.handleHostMessage = (message) => {
    if (!state.ctl || state.ctl.readyState !== "open") {
      api.error("host_not_ready", "Host-control channel is not ready.", true);
      return;
    }
    const frame =
      message.type === "host-cancel"
        ? { version: 1, type: "cancel", request_id: message.requestId }
        : {
            version: 1,
            type: "request",
            request_id: message.requestId,
            operation: message.operation,
            ...(message.payload === undefined ? {} : { payload: message.payload }),
          };
    const text = JSON.stringify(frame);
    if (new TextEncoder().encode(text).byteLength > 16 * 1024) {
      api.post({
        type: "host-response",
        requestId: message.requestId,
        ok: false,
        error: { code: "frame_too_large", detail: "Host-control request exceeds 16 KiB." },
      });
      return;
    }
    state.ctl.send(text);
  };
})();
