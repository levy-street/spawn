// biome-ignore-all lint: This source executes inside WebView, not React Native.
(() => {
  "use strict";
  const api = globalThis.spawnWorker;
  const consumers = new Map();
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  function post(id, message) {
    const entry = consumers.get(id);
    let sequence;
    if (entry && message.type === "host-response") {
      const bytes = new TextEncoder().encode(JSON.stringify(message)).byteLength;
      if (entry.unreceived + bytes > 2 * 1024 * 1024 || entry.receipts.size >= 1024) {
        post(id, {
          type: "error",
          code: "host_consumer_receive_limit",
          message: "Host tool receive queue is full.",
          retryable: false,
        });
        close(id);
        return;
      }
      sequence = ++entry.receiveSequence;
      entry.unreceived += bytes;
      entry.receipts.set(sequence, bytes);
    }
    api.post({
      type: "host-consumer-event",
      consumerId: id,
      message,
      ...(sequence === undefined ? {} : { sequence }),
    });
  }

  function close(id) {
    const entry = consumers.get(id);
    if (!entry) return;
    consumers.delete(id);
    clearTimeout(entry.timer);
    entry.dc.onclose = entry.dc.onerror = entry.dc.onmessage = entry.dc.onopen = null;
    entry.dc.removeEventListener("bufferedamountlow", entry.onBuffered);
    entry.dc.close();
    for (const item of entry.queue.splice(0)) item.reject(new Error("Host consumer closed."));
    entry.queued = 0;
    entry.receipts.clear();
    entry.unreceived = 0;
    entry.channel.dispatchEvent(new Event("close"));
    post(id, { type: "state", state: "reconnecting" });
  }

  function drain(id) {
    const entry = consumers.get(id);
    if (!entry) return;
    entry.timer = null;
    if (api.state.pc?.connectionState !== "connected" || entry.dc.readyState !== "open") {
      close(id);
      return;
    }
    // A bounded queue and native buffer for this consumer. Service one frame
    // per turn so bulk work yields to terminal channels and sibling tools.
    if (entry.queue.length && entry.dc.bufferedAmount <= 32 * 1024) {
      const item = entry.queue.shift();
      entry.queued -= item.bytes;
      try {
        entry.dc.send(item.text);
        item.resolve();
      } catch (error) {
        item.reject(error);
        close(id);
        return;
      }
      entry.channel.dispatchEvent(new Event("bufferedamountlow"));
    }
    if (entry.queue.length) entry.timer = setTimeout(() => drain(id), 4);
  }

  function open(id) {
    if (consumers.has(id)) return;
    if (
      !uuid.test(id) ||
      consumers.size >= 32 ||
      api.state.mode !== "host" ||
      api.state.pc?.connectionState !== "connected" ||
      api.state.ctl?.readyState !== "open"
    ) {
      post(id, {
        type: "error",
        code: "host_consumer_unavailable",
        message: "Host connection is not ready for another tool.",
        retryable: false,
      });
      return;
    }
    const dc = api.state.pc.createDataChannel(`spawn.host.ctl/${id}`, { ordered: true });
    const entry = {
      dc,
      queue: [],
      queued: 0,
      timer: null,
      channel: null,
      protocol: null,
      receiveSequence: 0,
      unreceived: 0,
      receipts: new Map(),
      onBuffered: null,
    };
    const channel = new EventTarget();
    Object.defineProperties(channel, {
      readyState: { get: () => (consumers.get(id) === entry ? dc.readyState : "closed") },
      bufferedAmount: { get: () => entry.queued + dc.bufferedAmount },
      bufferedAmountLowThreshold: {
        get: () => dc.bufferedAmountLowThreshold,
        set: (value) => {
          dc.bufferedAmountLowThreshold = value;
        },
      },
    });
    channel.send = (text) =>
      new Promise((resolve, reject) => {
        const bytes = new TextEncoder().encode(text).byteLength;
        if (
          channel.readyState !== "open" ||
          bytes > 64 * 1024 ||
          entry.queued + bytes > 256 * 1024 ||
          entry.queue.length >= 1024
        ) {
          reject(new Error("Host consumer send queue is unavailable."));
          return;
        }
        entry.queue.push({ text, bytes, resolve, reject });
        entry.queued += bytes;
        if (entry.timer === null) entry.timer = setTimeout(() => drain(id), 0);
      });
    entry.channel = channel;
    const protocol = {
      state: { ctl: channel },
      decodeBase64: api.decodeBase64,
      post: (message) => {
        if (consumers.get(id) === entry) post(id, message);
      },
      error: (code, message) => {
        if (consumers.get(id) !== entry) return;
        post(id, { type: "error", code, message, retryable: false });
        close(id);
      },
    };
    api.createHostProtocol(protocol);
    entry.protocol = protocol;
    consumers.set(id, entry);
    protocol.hostBindingAccepted();
    dc.onopen = () => {
      if (consumers.get(id) === entry) protocol.hostChannelOpened();
    };
    dc.onmessage = ({ data }) => {
      if (consumers.get(id) === entry) protocol.receiveHostCtl(data);
    };
    dc.onclose = dc.onerror = () => close(id);
    entry.onBuffered = () => channel.dispatchEvent(new Event("bufferedamountlow"));
    dc.addEventListener("bufferedamountlow", entry.onBuffered);
  }

  api.closeHostConsumers = () => {
    for (const id of [...consumers.keys()]) close(id);
  };
  api.handleHostConsumerMessage = (message) => {
    if (message.type === "host-consumer-open") {
      try {
        open(message.consumerId);
      } catch {
        post(message.consumerId, {
          type: "error",
          code: "host_consumer_open",
          message: "Host tool channel could not open.",
          retryable: false,
        });
      }
      return true;
    }
    if (message.type === "host-consumer-close") {
      close(message.consumerId);
      return true;
    }
    if (message.type === "host-consumer-command") {
      consumers.get(message.consumerId)?.protocol.handleHostMessage(message.command);
      return true;
    }
    if (message.type === "host-consumer-received") {
      const entry = consumers.get(message.consumerId);
      const bytes = entry?.receipts.get(message.sequence);
      if (bytes !== undefined) {
        entry.receipts.delete(message.sequence);
        entry.unreceived -= bytes;
      }
      return true;
    }
    return false;
  };
})();
