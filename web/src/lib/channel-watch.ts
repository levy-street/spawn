/**
 * Whether a device connection can still open channels.
 *
 * A device connection reads as ready while its peer is connected and its root
 * channel open, but what a terminal needs is a new channel: it opens two. A
 * peer can stay connected, its root channel answering, while nothing new opens
 * on it — a daemon built before #122 let one stream reset end its channel
 * acceptor for the rest of the peer's life (#120) — and every terminal opened
 * on that host then timed out after ten seconds and retried on the same peer
 * for as long as the page stayed open.
 *
 * The tab that owns the physical connection runs one watch over it, on the
 * channels the daemon speaks on first: a terminal's control channel
 * (`spawn.ctl/…`, which the daemon opens with `ready`) and a host consumer's
 * (`spawn.host.ctl/<id>`, its hello). A terminal's pty channel can stay quiet
 * for as long as its shell does and is not watched.
 *
 * - Suspicion: a watched channel the daemon has neither spoken on nor closed
 *   for ten seconds, or one its consumer gave up on after at least five.
 * - Probe: the owner opens one host-control channel of its own. The daemon
 *   says hello on it as soon as it accepts it, with no session involved, so a
 *   session that is slow to start (a restart holding its transition) does not
 *   look like a peer that accepts nothing.
 * - Proof: a probe still silent after ten seconds is weighed against the root
 *   channel, with one ping, and the peer is replaced when either
 *   - the root answers while the probe is still silent: the association, the
 *     daemon and both directions work, and new channels are not accepted; or
 *   - the root stays silent for twenty seconds as well. Thirty seconds without
 *     a hello and twenty without a pong, on a peer ICE still calls connected,
 *     is an association that carries nothing to the daemon: an old daemon's
 *     stops acknowledging once channels pile up behind its dead acceptor
 *     (sixteen are queued, then each new one is dropped unacknowledged), which
 *     several views reattaching at once reach in moments.
 *   Only an answer stands the watch down: the probe's hello or refusal, or any
 *   watched channel answered meanwhile. A host that is merely slow answers the
 *   probe within its thirty seconds; one briefly unreachable loses ICE
 *   consent within seconds, which takes the peer out of readiness and resets
 *   the watch.
 *
 * A refusal is an answer, never a timeout: a daemon closes a channel it
 * refuses at once (a session it does not run, a full pair), so a close counts
 * as heard. Any answer, on a watched channel or on the probe, clears the
 * suspicion and the run of rebuilds. There is one probe at a time, and
 * rebuilds for this reason are at least thirty seconds apart, doubling while
 * nothing is answered between them, up to five minutes.
 */

export interface ChannelWatchTiming {
  /** A watched channel unanswered this long makes its peer suspect. */
  unansweredMs: number;
  /** A consumer that gave up on an unanswered channel after this long does too. */
  abandonedAfterMs: number;
  /** How long the probe has to hear from the daemon before the root is asked. */
  probeMs: number;
  /** How long a silent root is waited on before the peer is replaced anyway. */
  rootSilenceMs: number;
  /** The least time between two rebuilds; doubles per rebuild in a row. */
  rebuildBackoffMs: number;
  rebuildBackoffCapMs: number;
}

export const CHANNEL_WATCH_TIMING: Readonly<ChannelWatchTiming> = Object.freeze({
  unansweredMs: 10_000,
  abandonedAfterMs: 5_000,
  probeMs: 10_000,
  rootSilenceMs: 20_000,
  rebuildBackoffMs: 30_000,
  rebuildBackoffCapMs: 300_000,
});

/** What a terminal shows while its host's connection is being replaced for
 *  this reason. The phone says the same (mobile `CHANNELS_UNANSWERED_MESSAGE`). */
export const REBUILDING_MESSAGE =
  "The connection stopped opening terminals. SPAWN D is making a new one.";

/** What the watch needs from the peer it watches. */
export interface WatchedPeer {
  /** Open a channel of the watch's own on the peer. Throws when it cannot. */
  openProbe(label: string): RTCDataChannel;
  /** One round trip on the root channel; rejects when it is not answered in
   *  time, or at once when it cannot be sent. */
  ping(timeoutMs: number): Promise<unknown>;
  /** Retire the peer and negotiate a fresh one. False when there is no ready peer. */
  rebuild(): boolean;
}

const DAEMON_SPEAKS_FIRST = /^spawn\.(?:ctl|host\.ctl)\//;

type Pending = { since: number; timer: ReturnType<typeof setTimeout> };
type Probe = {
  channel: RTCDataChannel;
  since: number;
  /** How long the channel that raised the suspicion had waited. */
  waitedMs: number;
  timer: ReturnType<typeof setTimeout> | null;
};

export class ChannelOpenWatch {
  private readonly pending = new Map<string, Pending>();
  private probe: Probe | null = null;
  /** Rebuilds with nothing answered between them. */
  private rebuilds = 0;
  private notBefore = 0;
  private closed = false;

  constructor(
    private readonly peer: WatchedPeer,
    /** Names the host in the log line; never anything a terminal carries. */
    private readonly host: string,
    private readonly timing: ChannelWatchTiming = CHANNEL_WATCH_TIMING,
  ) {}

  /** The owner opened a child channel on the peer for a consumer. */
  opened(id: string, label: string): void {
    if (this.closed || !DAEMON_SPEAKS_FIRST.test(label) || this.pending.has(id)) return;
    const since = Date.now();
    const timer = setTimeout(() => {
      if (this.pending.get(id)?.timer !== timer) return;
      this.pending.delete(id);
      this.suspect(Date.now() - since);
    }, this.timing.unansweredMs);
    this.pending.set(id, { since, timer });
  }

  /** The daemon spoke on the channel, or closed it: either way it answered. */
  answered(id: string): void {
    if (this.take(id)) this.heard();
  }

  /** The channel's own consumer closed it. */
  abandoned(id: string): void {
    const entry = this.take(id);
    if (!entry) return;
    const waited = Date.now() - entry.since;
    if (waited >= this.timing.abandonedAfterMs) this.suspect(waited);
  }

  /** The channel went for a reason that says nothing about the daemon. */
  forget(id: string): void {
    this.take(id);
  }

  /** Readiness ended, or the peer was replaced: what was pending belonged to
   *  the old one. The run of rebuilds and its backoff carry over. */
  reset(): void {
    for (const entry of this.pending.values()) clearTimeout(entry.timer);
    this.pending.clear();
    if (this.probe) this.endProbe(this.probe);
  }

  close(): void {
    this.closed = true;
    this.reset();
  }

  private take(id: string): Pending | undefined {
    const entry = this.pending.get(id);
    if (!entry) return undefined;
    clearTimeout(entry.timer);
    this.pending.delete(id);
    return entry;
  }

  private heard(): void {
    this.rebuilds = 0;
    if (this.probe) this.endProbe(this.probe);
  }

  private suspect(waitedMs: number): void {
    if (this.closed || this.probe || Date.now() < this.notBefore) return;
    let channel: RTCDataChannel;
    try {
      channel = this.peer.openProbe(`spawn.host.ctl/${crypto.randomUUID()}`);
    } catch {
      return;
    }
    const probe: Probe = { channel, since: Date.now(), waitedMs, timer: null };
    this.probe = probe;
    const answered = () => {
      if (this.probe === probe) this.heard();
    };
    channel.onmessage = answered;
    channel.onclose = answered;
    channel.onerror = answered;
    probe.timer = setTimeout(() => void this.confirm(probe), this.timing.probeMs);
  }

  private async confirm(probe: Probe): Promise<void> {
    if (this.probe !== probe) return;
    probe.timer = null;
    const pinged = Date.now();
    let rootAnswered = true;
    try {
      await this.peer.ping(this.timing.rootSilenceMs);
    } catch {
      rootAnswered = false;
    }
    // Answered meanwhile (the probe, or any watched channel), or readiness
    // ended: either way there is nothing to replace.
    if (this.probe !== probe || this.closed) return;
    const rootMs = Date.now() - pinged;
    const probeMs = Date.now() - probe.since;
    this.endProbe(probe);
    // A ping that failed before its deadline was never sent; that is no
    // evidence about the daemon.
    if (!rootAnswered && rootMs < this.timing.rootSilenceMs * 0.9) return;
    if (Date.now() < this.notBefore || !this.peer.rebuild()) return;
    this.rebuilds += 1;
    this.notBefore =
      Date.now() +
      Math.min(
        this.timing.rebuildBackoffCapMs,
        this.timing.rebuildBackoffMs * 2 ** (this.rebuilds - 1),
      );
    // The daemon side of #120 stays visible from here: nothing a terminal
    // carries, only the host and how long each step waited.
    console.warn(
      `SPAWN D: host ${this.host}: no new channel opens on its connection ` +
        `(one waited ${seconds(probe.waitedMs)}, a probe ${seconds(probeMs)}, ` +
        (rootAnswered
          ? `while the root channel answered a ping in ${rootMs} ms); `
          : `and the root channel did not answer a ping for ${seconds(rootMs)}); `) +
        `making a new connection (${this.rebuilds} in a row).`,
    );
  }

  private endProbe(probe: Probe): void {
    if (this.probe !== probe) return;
    this.probe = null;
    if (probe.timer) clearTimeout(probe.timer);
    probe.channel.onmessage = null;
    probe.channel.onclose = null;
    probe.channel.onerror = null;
    try {
      probe.channel.close();
    } catch {
      // A channel of a peer that is already gone has nothing left to close.
    }
  }
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}
