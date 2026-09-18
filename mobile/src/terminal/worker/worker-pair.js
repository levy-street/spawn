// biome-ignore-all lint: This source executes inside WKWebView, not the React Native runtime.
(() => {
  "use strict";
  const api = globalThis.spawnWorker;
  const state = api.state;
  const MAX_FRAME = 64 * 1024;
  const MAX_QUEUE = 256 * 1024;
  const MAX_RECEIVE = 2 * 1024 * 1024;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const attached = new Map();
  let view = null;
  let timer = null;
  let cursor = 0;
  const sizeOf = (value) =>
    typeof value === "string" ? new TextEncoder().encode(value).byteLength : value.byteLength;

  function postEvent(attachmentId, channel, event, extra = {}) {
    api.post({ type: "pair-event", attachmentId, channel, event, ...extra });
  }
  function command(attachmentId, channel, event, extra = {}) {
    api.post({ type: "pair-command", attachmentId, channel, event, ...extra });
  }

  function detach(id) {
    const entry = attached.get(id);
    if (!entry) return;
    attached.delete(id);
    for (const [kind, item] of entry) {
      item.dc.onclose = null;
      item.dc.onerror = null;
      item.dc.onmessage = null;
      item.dc.close();
      item.queue.length = 0;
      postEvent(id, kind, "close");
    }
  }

  // One bounded queue per channel. Visit every ready channel each round so a
  // paste or upload cannot monopolize another terminal's input.
  function drain() {
    timer = null;
    const all = [...attached.entries()].flatMap(([id, channels]) =>
      [...channels.entries()].map(([kind, item]) => ({ id, kind, item })),
    );
    if (!all.length) return;
    let pending = false;
    for (let n = 0; n < all.length; n++) {
      const { id, kind, item } = all[(cursor + n) % all.length];
      const next = item.queue[0];
      if (!next) continue;
      if (item.dc.readyState !== "open" || state.pc?.connectionState !== "connected") {
        detach(id);
        continue;
      }
      if (item.dc.bufferedAmount <= 32 * 1024) {
        try {
          item.dc.send(next.value);
          item.queue.shift();
          item.queued -= next.bytes;
          postEvent(id, kind, "ack", { sequence: next.sequence, bytes: next.bytes });
        } catch {
          detach(id);
        }
      }
      pending ||= item.queue.length > 0;
    }
    cursor = (cursor + 1) % all.length;
    if (pending) timer = setTimeout(drain, 4);
  }

  function attach(message) {
    const { attachmentId: id, sessionId, viewId } = message;
    if (
      !uuid.test(id) ||
      !uuid.test(sessionId) ||
      !uuid.test(viewId) ||
      state.mode !== "host" ||
      state.pc?.connectionState !== "connected" ||
      state.ctl?.readyState !== "open" ||
      attached.size >= 128
    ) {
      postEvent(id, "ctl", "close");
      return;
    }
    if (attached.has(id)) return;
    const entry = new Map();
    attached.set(id, entry);
    try {
      for (const kind of ["pty", "ctl"]) {
        const dc = state.pc.createDataChannel(`spawn.${kind}/${sessionId}/${viewId}/${id}`, {
          ordered: true,
        });
        const item = {
          dc,
          queue: [],
          queued: 0,
          unreceived: 0,
          receiveSequence: 0,
          sendSequence: 0,
          receipts: new Map(),
          pendingBytes: 0,
          pendingMessages: 0,
          tail: Promise.resolve(),
        };
        entry.set(kind, item);
        dc.binaryType = "arraybuffer";
        dc.onopen = () => {
          if (attached.get(id) === entry) postEvent(id, kind, "open");
        };
        dc.onclose = dc.onerror = () => detach(id);
        dc.onmessage = ({ data }) => {
          const pendingBytes =
            typeof data === "string" ? sizeOf(data) : (data.byteLength ?? data.size);
          if (
            !Number.isFinite(pendingBytes) ||
            pendingBytes > MAX_FRAME ||
            item.pendingBytes + item.unreceived + pendingBytes > MAX_RECEIVE ||
            item.pendingMessages + item.receipts.size >= 1024
          ) {
            detach(id);
            return;
          }
          item.pendingBytes += pendingBytes;
          item.pendingMessages++;
          item.tail = item.tail
            .then(async () => {
              if (attached.get(id) !== entry) return;
              const binary = typeof data !== "string";
              const value = binary ? await api.bytesFromMessage(data) : data;
              if (attached.get(id) !== entry) return;
              item.pendingBytes -= pendingBytes;
              item.pendingMessages--;
              const bytes = sizeOf(value);
              if (
                bytes > MAX_FRAME ||
                item.unreceived + bytes > MAX_RECEIVE ||
                item.receipts.size >= 1024
              ) {
                detach(id);
                return;
              }
              const sequence = ++item.receiveSequence;
              item.unreceived += bytes;
              item.receipts.set(sequence, bytes);
              postEvent(id, kind, "data", {
                data: binary ? api.encodeBase64(value) : value,
                binary,
                sequence,
                bytes,
              });
            })
            .catch(() => detach(id));
        };
      }
    } catch {
      detach(id);
    }
  }

  function receiveCommand(message) {
    const item = attached.get(message.attachmentId)?.get(message.channel);
    if (!item) return;
    if (message.event === "close") return detach(message.attachmentId);
    if (message.event === "received") {
      const bytes = item.receipts.get(message.sequence);
      if (bytes !== undefined) {
        item.receipts.delete(message.sequence);
        item.unreceived -= bytes;
      }
      return;
    }
    if (message.event !== "send") return;
    if (
      message.sequence !== item.sendSequence + 1 ||
      typeof message.data !== "string" ||
      message.data.length > MAX_FRAME * 2
    )
      return detach(message.attachmentId);
    const value = message.binary ? api.decodeBase64(message.data) : message.data;
    const bytes = sizeOf(value);
    if (bytes > MAX_FRAME || item.queued + bytes > MAX_QUEUE || item.queue.length >= 1024)
      return detach(message.attachmentId);
    item.sendSequence = message.sequence;
    item.queued += bytes;
    item.queue.push({ value, bytes, sequence: message.sequence });
    if (timer === null) timer = setTimeout(drain, 0);
  }

  class ViewChannel extends EventTarget {
    constructor(id, kind) {
      super();
      this.id = id;
      this.kind = kind;
      this.label = `spawn.${kind}`;
      this.readyState = "connecting";
      this.binaryType = "arraybuffer";
      this.bufferedAmount = 0;
      this.bufferedAmountLowThreshold = 128 * 1024;
      this.sequence = 0;
      this.receipts = new Map();
    }
    fire(name, event = new Event(name)) {
      this[`on${name}`]?.(event);
      this.dispatchEvent(event);
    }
    send(value) {
      if (this.readyState !== "open") throw new Error("Terminal connection is paused.");
      const binary = typeof value !== "string";
      const bytes = binary
        ? value instanceof ArrayBuffer
          ? new Uint8Array(value)
          : new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
        : value;
      const length = sizeOf(bytes);
      if (
        length > MAX_FRAME ||
        this.bufferedAmount + length > MAX_QUEUE ||
        this.receipts.size >= 1024
      )
        throw new Error("Terminal channel is busy.");
      const sequence = ++this.sequence;
      this.bufferedAmount += length;
      this.receipts.set(sequence, length);
      command(this.id, this.kind, "send", {
        binary,
        sequence,
        data: binary ? api.encodeBase64(bytes) : bytes,
      });
    }
    close() {
      if (this.readyState === "closed") return;
      this.readyState = "closed";
      this.bufferedAmount = 0;
      this.receipts.clear();
      command(this.id, this.kind, "close");
      this.fire("close");
    }
    receive(message) {
      if (this.readyState === "closed") return;
      if (message.event === "close") return this.close();
      if (message.event === "open") {
        this.readyState = "open";
        this.fire("open");
      } else if (message.event === "ack") {
        const bytes = this.receipts.get(message.sequence);
        if (bytes === undefined) return;
        this.receipts.delete(message.sequence);
        this.bufferedAmount -= bytes;
        if (this.bufferedAmount <= this.bufferedAmountLowThreshold) this.fire("bufferedamountlow");
      } else if (message.event === "data") {
        const data = message.binary ? api.decodeBase64(message.data).buffer : message.data;
        const event = new MessageEvent("message", { data });
        this.dispatchEvent(event);
        Promise.resolve(this.onmessage?.(event))
          .then(() => {
            if (this.readyState === "open")
              command(this.id, this.kind, "received", { sequence: message.sequence });
          })
          .catch(() => this.close());
      }
    }
  }

  function closeView() {
    if (!view) return;
    const old = view;
    view = null;
    for (const dc of [old.pty, old.ctl]) {
      dc.onclose = null;
      dc.onmessage = null;
      dc.close();
    }
    api.resetSessionGeneration?.();
  }

  function openView(message) {
    closeView();
    state.stopped = false;
    api.resetSessionGeneration?.();
    const id = message.attachmentId;
    const current = { id, pty: new ViewChannel(id, "pty"), ctl: new ViewChannel(id, "ctl") };
    view = current;
    state.pty = current.pty;
    state.ctl = current.ctl;
    state.rtcSessionId = id;
    for (const kind of ["pty", "ctl"]) {
      current[kind].onopen = () =>
        api.sessionChannelOpened?.(kind === "pty" ? "ptyOpen" : "ctlOpen");
      current[kind].onclose = () => {
        if (view !== current) return;
        closeView();
        api.post({ type: "state", state: "reconnecting" });
      };
      current[kind].onmessage = ({ data }) =>
        kind === "pty" ? api.receivePty?.(data) : api.receiveSessionCtl?.(data);
    }
    api.sessionGate?.("bindingAccepted");
  }

  api.failSessionChannel = () => {
    closeView();
    api.post({ type: "state", state: "reconnecting" });
  };
  api.closePairChannels = () => {
    for (const id of [...attached.keys()]) detach(id);
    clearTimeout(timer);
    timer = null;
    closeView();
  };
  api.handlePairMessage = (message) => {
    if (message.type === "pair-attach") {
      attach(message);
      return true;
    }
    if (message.type === "pair-command") {
      receiveCommand(message);
      return true;
    }
    if (message.type === "pair-view" && state.mode === "session") {
      openView(message);
      return true;
    }
    if (message.type === "pair-event") {
      if (view?.id === message.attachmentId) view[message.channel]?.receive(message);
      return true;
    }
    return false;
  };
})();
