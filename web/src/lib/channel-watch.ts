/**
 * Whether a device connection can still open channels.
 *
 * A device connection reads as ready while its peer is connected and its root
 * channel open, but what a terminal or a host tool needs is a new channel. A
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
 * - Probes: the owner opens a host-control channel of its own, which the daemon
 *   greets with a hello as soon as it accepts it, with no session involved; ten
 *   seconds later, still silent, a second one beside it. Both keep listening:
 *   a hello from either, however late, stands the watch down. One silent probe
 *   is not proof, because a daemon's hello waits on work a ping does not (the
 *   daemon-wide admission lock, a filesystem lookup), so on a starved host it
 *   can trail the root's pong by more than ten seconds.
 * - Proof, weighed against the root channel with a ping sent as the second
 *   probe opens. The peer is replaced when both probes have been silent for
 *   their full ten seconds and either
 *   - the root answered: the association, the daemon and both directions
 *     work, and new channels are not being accepted; or
 *   - the root stayed silent through two pings of twenty seconds each: the
 *     association carries nothing to the daemon. An old daemon's stops
 *     acknowledging once channels pile up behind its dead acceptor (sixteen
 *     are queued, then each new one is dropped unacknowledged), which several
 *     views reattaching at once reach in moments. Two pings, for the same
 *     reason as two probes: a starved host can be slow on the root too.
 *   Only an answer stands the watch down: a probe's hello or refusal, or any
 *   watched channel answered meanwhile. A host that is merely slow answers one
 *   of its probes inside those windows; one briefly unreachable loses ICE
 *   consent within seconds, which takes the peer out of readiness and resets
 *   the watch.
 *
 * A refusal is an answer, never a timeout: a daemon closes a channel it
 * refuses at once (a session it does not run, a full pair), so a close counts
 * as heard. One proof at a time. Rebuilds for this reason are at least thirty
 * seconds apart, and each one in a run doubles that, up to five minutes. A run
 * ends only when the replacement has gone five minutes — the cap, the longest
 * the watch ever waits — without a suspicion: views reattaching and being
 * answered after a rebuild say nothing about whether the fault comes back.
 *
 * On a daemon that accepts it, each probe is a host-control channel like any
 * other: its hello makes the daemon publish one content-free `rtc.status
 * connected` for the device's binding through the server.
 */

export interface ChannelWatchTiming {
  /** A watched channel unanswered this long makes its peer suspect. */
  unansweredMs: number;
  /** A consumer that gave up on an unanswered channel after this long does too. */
  abandonedAfterMs: number;
  /** Each probe's own window; the second opens when the first's ends. */
  probeMs: number;
  /** Each of the two root pings a silent root gets before the peer is replaced anyway. */
  rootSilenceMs: number;
  /** The least time between two rebuilds; doubles per rebuild in a run. */
  rebuildBackoffMs: number;
  rebuildBackoffCapMs: number;
  /** A run of rebuilds ends after this long without a suspicion. */
  runQuietMs: number;
}

export const CHANNEL_WATCH_TIMING: Readonly<ChannelWatchTiming> = Object.freeze({
  unansweredMs: 10_000,
  abandonedAfterMs: 5_000,
  probeMs: 10_000,
  rootSilenceMs: 20_000,
  rebuildBackoffMs: 30_000,
  rebuildBackoffCapMs: 300_000,
  runQuietMs: 300_000,
});

/** What a terminal and the host's row show while its connection is being
 *  replaced for this reason. The phone says the same (mobile
 *  `CHANNELS_UNANSWERED_MESSAGE`). */
export const REBUILDING_MESSAGE =
  "The connection stopped opening new terminals and tools. SPAWN D is making a new one.";

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
/** Monotonic: a clock jump or a sleeping device must not move a decision. */
const now = () => performance.now();

type Pending = { since: number; timer: ReturnType<typeof setTimeout> };
type Proof = {
  probes: RTCDataChannel[];
  /** When the first probe opened. */
  since: number;
  /** How long the channel that raised the suspicion had waited. */
  waitedMs: number;
  timer: ReturnType<typeof setTimeout> | null;
  /** Both probes have been silent for their full windows. */
  probesSilent: boolean;
  /** How long the root took to answer a ping, once it has. */
  rootAnsweredMs: number | null;
  /** Root pings that ran out unanswered, and how long they waited in all. */
  rootSilentPings: number;
  rootSilentMs: number;
};

export class ChannelOpenWatch {
  private readonly pending = new Map<string, Pending>();
  private proof: Proof | null = null;
  /** Rebuilds in the current run. */
  private rebuilds = 0;
  private notBefore = Number.NEGATIVE_INFINITY;
  /** The last suspicion or rebuild; a run ends after `runQuietMs` without one. */
  private troubleAt = Number.NEGATIVE_INFINITY;
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
    const since = now();
    const timer = setTimeout(() => {
      if (this.pending.get(id)?.timer !== timer) return;
      this.pending.delete(id);
      this.suspect(now() - since);
    }, this.timing.unansweredMs);
    this.pending.set(id, { since, timer });
  }

  /** The daemon spoke on the channel, or closed it: either way it answered. */
  answered(id: string): void {
    if (this.take(id) && this.proof) this.endProof(this.proof);
  }

  /** The channel's own consumer closed it. */
  abandoned(id: string): void {
    const entry = this.take(id);
    if (!entry) return;
    const waited = now() - entry.since;
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
    if (this.proof) this.endProof(this.proof);
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

  private suspect(waitedMs: number): void {
    const at = now();
    if (this.rebuilds > 0 && at - this.troubleAt >= this.timing.runQuietMs) this.rebuilds = 0;
    this.troubleAt = at;
    if (this.closed || this.proof || at < this.notBefore) return;
    const proof: Proof = {
      probes: [],
      since: at,
      waitedMs,
      timer: null,
      probesSilent: false,
      rootAnsweredMs: null,
      rootSilentPings: 0,
      rootSilentMs: 0,
    };
    this.proof = proof;
    if (!this.openProbe(proof)) {
      this.endProof(proof);
      return;
    }
    proof.timer = setTimeout(() => this.secondRound(proof), this.timing.probeMs);
  }

  private openProbe(proof: Proof): boolean {
    let channel: RTCDataChannel;
    try {
      channel = this.peer.openProbe(`spawn.host.ctl/${crypto.randomUUID()}`);
    } catch {
      return false;
    }
    proof.probes.push(channel);
    const answered = () => {
      if (this.proof === proof) this.endProof(proof);
    };
    channel.onmessage = answered;
    channel.onclose = answered;
    channel.onerror = answered;
    return true;
  }

  private secondRound(proof: Proof): void {
    if (this.proof !== proof) return;
    if (!this.openProbe(proof)) {
      this.endProof(proof);
      return;
    }
    this.pingRoot(proof);
    proof.timer = setTimeout(() => {
      proof.timer = null;
      proof.probesSilent = true;
      this.decide(proof);
    }, this.timing.probeMs);
  }

  private pingRoot(proof: Proof): void {
    const sent = now();
    this.peer.ping(this.timing.rootSilenceMs).then(
      () => {
        if (this.proof !== proof) return;
        proof.rootAnsweredMs = now() - sent;
        this.decide(proof);
      },
      () => {
        if (this.proof !== proof) return;
        const silentFor = now() - sent;
        // A ping that failed before its deadline was never sent: that is no
        // evidence about the daemon.
        if (silentFor < this.timing.rootSilenceMs * 0.9) {
          this.endProof(proof);
          return;
        }
        proof.rootSilentPings += 1;
        proof.rootSilentMs += silentFor;
        if (proof.rootSilentPings < 2) this.pingRoot(proof);
        else this.decide(proof);
      },
    );
  }

  /** Rebuild once both probes are spent and the root has had its say. */
  private decide(proof: Proof): void {
    if (this.proof !== proof || this.closed || !proof.probesSilent) return;
    const rootAnswered = proof.rootAnsweredMs !== null;
    if (!rootAnswered && proof.rootSilentPings < 2) return;
    const at = now();
    const probeMs = at - proof.since;
    this.endProof(proof);
    if (at < this.notBefore || !this.peer.rebuild()) return;
    this.rebuilds += 1;
    this.troubleAt = at;
    this.notBefore =
      at +
      Math.min(
        this.timing.rebuildBackoffCapMs,
        this.timing.rebuildBackoffMs * 2 ** (this.rebuilds - 1),
      );
    // The daemon side of #120 stays visible from here: nothing a terminal
    // carries, only the host and how long each step waited.
    console.warn(
      `SPAWN D: host ${this.host}: no new channel opens on its connection ` +
        `(one waited ${seconds(proof.waitedMs)}, two probes ${seconds(probeMs)}, ` +
        (rootAnswered
          ? `while the root channel answered a ping in ${Math.round(proof.rootAnsweredMs ?? 0)} ms); `
          : `and the root channel did not answer two pings in ${seconds(proof.rootSilentMs)}); `) +
        `making a new connection (${this.rebuilds} in a row).`,
    );
  }

  private endProof(proof: Proof): void {
    if (this.proof !== proof) return;
    this.proof = null;
    if (proof.timer) clearTimeout(proof.timer);
    for (const channel of proof.probes) {
      channel.onmessage = null;
      channel.onclose = null;
      channel.onerror = null;
      try {
        channel.close();
      } catch {
        // A channel of a peer that is already gone has nothing left to close.
      }
    }
  }
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}
