import {
  type ChannelBytes,
  type DaemonChannel,
  DaemonSendScheduler,
  RemoteDaemonChannel,
} from "./daemon-channel";
import type { HostControlClient, HostControlState } from "./hostControl";
import type { SignedRtcRefusalReason } from "./signed-rtc-trust";

export interface DaemonSnapshot {
  state: HostControlState;
  generation: string | null;
  capabilities: readonly string[];
  refusal: SignedRtcRefusalReason | null;
  trust: "verified" | "first_contact" | "raw" | null;
  info?: {
    kind: "direct" | "stun" | "relay" | null;
    rttMs: number | null;
    protocol: string | null;
  };
  error?: string | null;
}
export interface DaemonConnection {
  getSnapshot(): DaemonSnapshot;
  subscribe(listener: () => void): () => void;
  createChannel(label: string): DaemonChannel;
  retry(): void;
}
const INITIAL: DaemonSnapshot = {
  state: "idle",
  generation: null,
  capabilities: [],
  refusal: null,
  trust: null,
};
const HEARTBEAT_MS = 2_000;
const VIEW_LEASE_MS = 12_000;
const MAX_CHANNELS = 256;
const RECEIVE_WINDOW_BYTES = 2 * 1024 * 1024;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const CHANNEL_LABEL = new RegExp(
  `^(spawn\\.host\\.ctl/${UUID}|spawn\\.(pty|ctl)/${UUID}/${UUID}/${UUID})$`,
);

type Wire = {
  v: 1;
  from: string;
  to?: string;
  owner?: string;
  term?: number;
  epoch?: number;
  type: string;
  channel?: string;
  label?: string;
  sequence?: number;
  data?: ChannelBytes;
  snapshot?: DaemonSnapshot;
};
type OwnedChannel = {
  channel: RTCDataChannel;
  tab: string;
  receiveBytes: number;
  sequence: number;
  sendSequence: number;
  receipts: Map<number, number>;
};

/** One physical connection across same-origin tabs, with bounded per-view channels. */
export class SharedDaemonConnection implements DaemonConnection {
  private snapshot: DaemonSnapshot = INITIAL;
  private readonly tab = crypto.randomUUID();
  private readonly listeners = new Set<() => void>();
  private readonly channels = new Map<string, RemoteDaemonChannel>();
  private readonly owned = new Map<string, OwnedChannel>();
  private readonly leases = new Map<string, number>();
  private readonly bus: BroadcastChannel | null;
  private root: HostControlClient | null = null;
  private owner: string | null = null;
  private leader: string | null = null;
  private term = 0;
  private epoch = 0;
  private ownerSeen = 0;
  private lockAbort: AbortController | null = null;
  private releaseLock: (() => void) | null = null;
  private stopRoot: (() => void) | null = null;
  private scheduler = new DaemonSendScheduler();
  private heartbeat: ReturnType<typeof setInterval>;
  private closed = false;
  private readonly onHide = () => this.relinquish();
  private readonly onShow = () => this.elect();

  constructor(
    private readonly key: string,
    private readonly createRoot: () => HostControlClient,
    private readonly isActive: () => boolean = () => true,
  ) {
    try {
      this.bus = new BroadcastChannel(`spawn.daemon.v2:${key}`);
      this.bus.onmessage = ({ data }) => this.receive(data);
    } catch {
      this.bus = null;
    }
    this.heartbeat = setInterval(() => {
      if (!this.isActive()) {
        this.close();
        return;
      }
      if (!this.root && this.ownerSeen && Date.now() - this.ownerSeen > 6_000) {
        this.publish({ ...this.snapshot, state: "connecting", generation: null });
      }
      this.post({ type: "heartbeat" });
      if (this.root) {
        this.announce();
        const now = Date.now();
        for (const [id, entry] of this.owned) {
          if (now - (this.leases.get(entry.tab) ?? 0) > VIEW_LEASE_MS) this.closeOwned(id);
        }
      }
    }, HEARTBEAT_MS);
    window.addEventListener("pagehide", this.onHide);
    window.addEventListener("pageshow", this.onShow);
    document.addEventListener("freeze", this.onHide);
    document.addEventListener("resume", this.onShow);
    this.post({ type: "hello" });
    this.elect();
  }

  getSnapshot = (): DaemonSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  createChannel(label: string): DaemonChannel {
    if (!CHANNEL_LABEL.test(label)) throw new Error("Invalid daemon channel label");
    if (this.snapshot.state !== "ready" || !this.owner || this.closed || !this.isActive())
      throw new Error("Daemon is not connected");
    if (this.channels.size >= MAX_CHANNELS) throw new Error("Too many open views");
    const id = crypto.randomUUID();
    const owner = this.owner;
    const epoch = this.epoch;
    const channel = new RemoteDaemonChannel(label, (event) => {
      if (event.type === "close") {
        this.channels.delete(id);
        this.post({ type: "channel-close", channel: id, owner, epoch });
        return;
      }
      if (
        this.owner !== owner ||
        this.epoch !== epoch ||
        this.snapshot.state !== "ready" ||
        !this.isActive()
      ) {
        channel.retired();
        this.channels.delete(id);
        return;
      }
      this.post({
        type: "channel-send",
        channel: id,
        owner,
        epoch,
        sequence: event.sequence,
        data: event.data,
      });
    });
    this.channels.set(id, channel);
    // Let consumers install message callbacks before an already-open local
    // connection can deliver its first channel events.
    queueMicrotask(() => {
      if (channel.readyState === "connecting")
        this.post({ type: "channel-open", channel: id, label, owner, epoch });
    });
    return channel;
  }

  retry(): void {
    this.post({ type: "retry", owner: this.owner ?? undefined });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const channel of [...this.channels.values()]) channel.close();
    this.post({ type: "depart" });
    this.relinquish();
    this.publish({ ...INITIAL, state: "closed" });
    clearInterval(this.heartbeat);
    this.bus?.close();
    window.removeEventListener("pagehide", this.onHide);
    window.removeEventListener("pageshow", this.onShow);
    document.removeEventListener("freeze", this.onHide);
    document.removeEventListener("resume", this.onShow);
    this.listeners.clear();
  }

  private elect(): void {
    if (this.closed || this.lockAbort) return;
    if (!navigator.locks || !this.bus) {
      this.publish({
        ...INITIAL,
        state: "error",
        error: "This browser cannot share daemon connections. Update your browser to continue.",
      });
      return;
    }
    const abort = new AbortController();
    this.lockAbort = abort;
    void navigator.locks
      .request(`spawn.daemon.v2:${this.key}`, { signal: abort.signal }, async () => {
        if (this.closed || abort.signal.aborted) return;
        if (!this.isActive()) return;
        const termKey = `spawn.daemon.term:${this.key}`;
        const saved = Number(localStorage.getItem(termKey)) || 0;
        this.term = Math.max(Date.now(), saved + 1, this.term + 1);
        localStorage.setItem(termKey, String(this.term));
        this.leader = `${this.tab}:${this.term}`;
        this.epoch = 0;
        this.owner = null;
        this.scheduler = new DaemonSendScheduler();
        this.root = this.createRoot();
        this.stopRoot = this.root.subscribe(() => this.announce());
        this.root.connect();
        await new Promise<void>((resolve) => {
          this.releaseLock = resolve;
        });
      })
      .catch(() => {
        if (!abort.signal.aborted && !this.closed)
          this.publish({
            ...INITIAL,
            state: "error",
            error: "SPAWN D could not coordinate this browser's daemon connection.",
          });
      })
      .finally(() => {
        if (this.lockAbort === abort) this.lockAbort = null;
      });
  }

  private relinquish(): void {
    if (this.leader)
      this.post({
        type: "snapshot",
        owner: this.leader,
        term: this.term,
        snapshot: { ...INITIAL, state: "connecting" },
      });
    this.stopRoot?.();
    this.stopRoot = null;
    for (const id of [...this.owned.keys()]) this.closeOwned(id);
    this.root?.close();
    this.root = null;
    this.scheduler.close();
    this.leader = null;
    this.releaseLock?.();
    this.releaseLock = null;
    this.lockAbort?.abort();
    this.lockAbort = null;
  }

  private announce(): void {
    const root = this.root;
    if (!root || !this.leader) return;
    // The peer UUID can survive ICE recovery. A separate child epoch fences
    // opens still in another tab's dispatch queue when readiness is lost.
    if (
      this.snapshot.generation !== root.getConnectionGeneration() ||
      (this.snapshot.state === "ready" && root.getState() !== "ready")
    )
      this.epoch++;
    this.post({
      type: "snapshot",
      owner: this.leader,
      term: this.term,
      snapshot: {
        state: root.getState(),
        generation: root.getConnectionGeneration(),
        capabilities: [...root.getCapabilities()],
        refusal: root.getSignedRtcRefusal(),
        trust: root.getSignalingTrust(),
        info: root.getConnectionInfo(),
        error: root.getConnectionError(),
      },
    });
  }

  private publish(snapshot: DaemonSnapshot, retireChildren = false): void {
    if (!retireChildren && JSON.stringify(this.snapshot) === JSON.stringify(snapshot)) return;
    const changed =
      retireChildren ||
      this.snapshot.generation !== snapshot.generation ||
      (this.snapshot.state === "ready" && snapshot.state !== "ready");
    this.snapshot = snapshot;
    if (changed) {
      // Readiness can be lost without replacing the physical peer. Retire
      // every child at that boundary, including the owner's unsent queues;
      // a later same-peer recovery must attach afresh, never replay input.
      const retired = [...this.channels.values()];
      this.channels.clear();
      for (const id of [...this.owned.keys()]) this.closeOwned(id);
      for (const channel of retired) channel.retired();
    }
    for (const listener of this.listeners) listener();
  }

  private post(message: Omit<Wire, "v" | "from">): void {
    const wire: Wire = { v: 1, from: this.tab, epoch: this.epoch, ...message };
    // BroadcastChannel does not echo to the sender. Use the same route for
    // local consumers so they have the same ordering and credit semantics.
    this.bus?.postMessage(wire);
    this.receive(wire);
  }

  private receive(raw: unknown): void {
    if (!raw || typeof raw !== "object") return;
    const message = raw as Wire;
    if (message.v !== 1 || typeof message.from !== "string" || typeof message.type !== "string")
      return;
    if (message.to && message.to !== this.tab) return;
    if (message.type === "snapshot" && message.owner && message.snapshot) {
      if (!Number.isSafeInteger(message.term) || (message.term ?? 0) < this.term) return;
      if (!Number.isSafeInteger(message.epoch) || (message.epoch ?? -1) < 0) return;
      if (message.term === this.term && this.owner && this.owner !== message.owner) return;
      if (message.term === this.term && message.epoch! < this.epoch) return;
      this.term = message.term!;
      this.ownerSeen = Date.now();
      const retireChildren = this.owner !== message.owner || this.epoch !== message.epoch;
      this.owner = message.owner;
      this.epoch = message.epoch!;
      this.publish(message.snapshot, retireChildren);
      return;
    }
    if (
      ["channel-opened", "channel-data", "channel-ack", "channel-closed"].includes(message.type)
    ) {
      if (message.owner !== this.owner || message.epoch !== this.epoch || !message.channel) return;
      const channel = this.channels.get(message.channel);
      if (!channel) {
        // A local timeout can retire a proxy while its owner is still ready.
        // Close a late allocation whose consumer has already gone away.
        if (message.type === "channel-opened")
          this.post({ type: "channel-close", owner: message.owner, channel: message.channel });
        return;
      }
      if (message.type === "channel-opened") channel.opened();
      else if (message.type === "channel-closed") {
        this.channels.delete(message.channel);
        channel.retired();
      } else if (message.type === "channel-ack" && typeof message.sequence === "number")
        channel.acknowledge(message.sequence);
      else if (
        message.type === "channel-data" &&
        (typeof message.data === "string" || message.data instanceof ArrayBuffer)
      ) {
        channel.receive(message.data);
        this.post({
          type: "channel-received",
          owner: message.owner,
          channel: message.channel,
          sequence: message.sequence,
        });
      }
      return;
    }
    const root = this.root;
    if (!root || !this.leader || !this.isActive()) return;
    this.leases.set(message.from, Date.now());
    if (message.type === "hello") {
      this.announce();
      return;
    }
    if (message.type === "depart") {
      for (const [id, entry] of this.owned) if (entry.tab === message.from) this.closeOwned(id);
      this.leases.delete(message.from);
      return;
    }
    if (message.owner !== this.leader) return;
    if (message.type === "retry") {
      root.retryConnection();
      return;
    }
    if (message.epoch !== this.epoch) return;
    const id = message.channel;
    if (typeof id !== "string" || id.length > 64) return;
    if (message.type === "channel-open") {
      if (
        root.getState() !== "ready" ||
        this.owned.has(id) ||
        this.owned.size >= MAX_CHANNELS ||
        !message.label ||
        !CHANNEL_LABEL.test(message.label)
      )
        return;
      try {
        const dc = root.createDeviceChannel(message.label);
        const entry: OwnedChannel = {
          channel: dc,
          tab: message.from,
          receiveBytes: 0,
          sequence: 0,
          sendSequence: 0,
          receipts: new Map(),
        };
        this.owned.set(id, entry);
        dc.binaryType = "arraybuffer";
        dc.onopen = () => this.reply(entry, id, { type: "channel-opened" });
        dc.onmessage = ({ data }) => {
          if (
            this.owned.get(id) !== entry ||
            (typeof data !== "string" && !(data instanceof ArrayBuffer))
          )
            return;
          const size =
            typeof data === "string" ? new TextEncoder().encode(data).byteLength : data.byteLength;
          if (
            size > 64 * 1024 ||
            entry.receiveBytes + size > RECEIVE_WINDOW_BYTES ||
            entry.receipts.size >= 1024
          ) {
            this.closeOwned(id);
            return;
          }
          const sequence = ++entry.sequence;
          entry.receiveBytes += size;
          entry.receipts.set(sequence, size);
          this.reply(entry, id, { type: "channel-data", data, sequence });
        };
        dc.onclose = () => this.closeOwned(id);
        dc.onerror = () => this.closeOwned(id);
      } catch {
        this.post({ type: "channel-closed", channel: id, to: message.from, owner: this.leader });
      }
      return;
    }
    const entry = this.owned.get(id);
    if (!entry || entry.tab !== message.from) return;
    if (message.type === "channel-close") {
      this.closeOwned(id);
      return;
    }
    if (message.type === "channel-received" && typeof message.sequence === "number") {
      const size = entry.receipts.get(message.sequence);
      if (size !== undefined) {
        entry.receiveBytes -= size;
        entry.receipts.delete(message.sequence);
      }
      return;
    }
    if (
      message.type === "channel-send" &&
      typeof message.sequence === "number" &&
      (typeof message.data === "string" || message.data instanceof ArrayBuffer)
    ) {
      if (root.getState() !== "ready") {
        this.closeOwned(id);
        return;
      }
      if (message.sequence !== entry.sendSequence + 1) {
        this.closeOwned(id);
        return;
      }
      entry.sendSequence = message.sequence;
      try {
        this.scheduler.enqueue(entry.channel, message.data, () =>
          this.reply(entry, id, { type: "channel-ack", sequence: message.sequence }),
        );
      } catch {
        this.closeOwned(id);
      }
    }
  }

  private reply(entry: OwnedChannel, id: string, message: Omit<Wire, "v" | "from">): void {
    if (this.leader) this.post({ ...message, owner: this.leader, channel: id, to: entry.tab });
  }
  private closeOwned(id: string): void {
    const entry = this.owned.get(id);
    if (!entry) return;
    this.owned.delete(id);
    this.scheduler.remove(entry.channel);
    entry.channel.onclose = null;
    entry.channel.onerror = null;
    entry.channel.onmessage = null;
    entry.channel.close();
    this.reply(entry, id, { type: "channel-closed" });
  }
}
