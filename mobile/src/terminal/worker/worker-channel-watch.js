// biome-ignore-all lint: This source executes inside WKWebView, not the React Native runtime.
(() => {
  "use strict";
  // Whether the host worker's peer can still open channels: the phone's half
  // of web/src/lib/channel-watch.ts, with the same rule and the same numbers.
  //
  // A peer can stay connected, its root channel answering, while no new
  // channel opens on it (a daemon built before #122 let one reset stream end
  // its channel acceptor for the peer's life, #120). Every terminal opened on
  // that host then waited out its attachment deadline and attached again on
  // the same peer, for good.
  //
  // Watched: the channels the daemon speaks on first, a terminal's spawn.ctl
  // (its ready) and a host tool's spawn.host.ctl/<id> (its hello). A channel
  // neither spoken on nor closed by the daemon for ten seconds makes the peer
  // suspect; a phone's views wait twenty-five before they give up, so this
  // deadline always comes first. The worker then opens a host-control channel
  // of its own, which the daemon greets without any session involved, and ten
  // seconds later, still silent, a second beside it; both keep listening, and
  // a hello from either, however late, stands the watch down. One silent
  // probe is not proof: a daemon's hello waits on work a ping does not, so on
  // a starved host it can trail the pong by more than ten seconds. The root
  // is pinged as the second probe opens, and native is asked to replace the
  // peer once both probes have had their full ten seconds and the root either
  // answered (channels are not being accepted) or stayed silent through two
  // pings of twenty seconds (an old daemon's association stops acknowledging
  // anything once channels pile up behind its dead acceptor; two pings because
  // a starved host can be slow on the root too). A host that is merely slow
  // answers a probe inside those windows; one briefly unreachable loses ICE
  // consent and leaves `connected`, which resets the watch.
  //
  // A refusal is an answer: the daemon closes a channel it refuses at once.
  // One proof at a time. Rebuilds for this reason are at least thirty seconds
  // apart and each one in a run doubles that, up to five minutes; a run ends
  // only when the peer has gone five minutes without a suspicion, since views
  // reattaching and being answered after a rebuild say nothing about whether
  // the fault comes back.
  const api = globalThis.spawnWorker;
  const state = api.state;
  const UNANSWERED_MS = 10_000;
  const PROBE_MS = 10_000;
  const ROOT_SILENCE_MS = 20_000;
  const REBUILD_BACKOFF_MS = 30_000;
  const REBUILD_BACKOFF_CAP_MS = 300_000;
  const RUN_QUIET_MS = 300_000;
  const DAEMON_SPEAKS_FIRST = /^spawn\.(?:ctl|host\.ctl)\//;
  // Monotonic: a clock jump or a sleeping phone must not move a decision.
  const now = () => performance.now();
  const pending = new Map();
  const pings = new Map();
  let proof = null;
  let rebuilds = 0;
  let notBefore = Number.NEGATIVE_INFINITY;
  let troubleAt = Number.NEGATIVE_INFINITY;

  function peerReady() {
    return (
      state.mode === "host" &&
      state.pc?.connectionState === "connected" &&
      state.ctl?.readyState === "open"
    );
  }

  function take(label) {
    const entry = pending.get(label);
    if (!entry) return null;
    clearTimeout(entry.timer);
    pending.delete(label);
    return entry;
  }

  function endProof(current) {
    if (proof !== current) return;
    proof = null;
    clearTimeout(current.timer);
    for (const channel of current.probes) {
      channel.onmessage = channel.onclose = channel.onerror = null;
      try {
        channel.close();
      } catch {
        // A channel of a peer that is already gone has nothing left to close.
      }
    }
  }

  function openProbe(current) {
    let channel;
    try {
      channel = state.pc.createDataChannel(`spawn.host.ctl/${crypto.randomUUID()}`, {
        ordered: true,
      });
    } catch {
      return false;
    }
    current.probes.push(channel);
    channel.onmessage =
      channel.onclose =
      channel.onerror =
        () => {
          if (proof === current) endProof(current);
        };
    return true;
  }

  function ping() {
    return new Promise((resolve, reject) => {
      const requestId = crypto.randomUUID();
      const settle = (error) => {
        clearTimeout(timer);
        pings.delete(requestId);
        if (error) reject(error);
        else resolve();
      };
      const timer = setTimeout(
        () => settle(new Error("The host did not answer its root channel.")),
        ROOT_SILENCE_MS,
      );
      pings.set(requestId, settle);
      try {
        state.ctl.send(
          JSON.stringify({ version: 1, type: "request", request_id: requestId, operation: "ping" }),
        );
      } catch (error) {
        settle(error);
      }
    });
  }

  function pingRoot(current) {
    const sent = now();
    ping().then(
      () => {
        if (proof !== current) return;
        current.rootAnsweredMs = now() - sent;
        decide(current);
      },
      () => {
        if (proof !== current) return;
        const silentFor = now() - sent;
        // A ping that failed before its deadline was never sent: no evidence.
        if (silentFor < ROOT_SILENCE_MS * 0.9) {
          endProof(current);
          return;
        }
        current.rootSilentPings += 1;
        current.rootSilentMs += silentFor;
        if (current.rootSilentPings < 2) pingRoot(current);
        else decide(current);
      },
    );
  }

  /** Ask native for a new peer once both probes are spent and the root has had its say. */
  function decide(current) {
    if (proof !== current || !current.probesSilent) return;
    const rootAnswered = current.rootAnsweredMs !== null;
    if (!rootAnswered && current.rootSilentPings < 2) return;
    const at = now();
    const probeMs = at - current.since;
    endProof(current);
    if (at < notBefore || !peerReady()) return;
    rebuilds += 1;
    troubleAt = at;
    notBefore = at + Math.min(REBUILD_BACKOFF_CAP_MS, REBUILD_BACKOFF_MS * 2 ** (rebuilds - 1));
    // Native replaces this peer, and only this one, and says why; nothing a
    // terminal carries is in it.
    api.post({
      type: "rebuild",
      reason: "channels_unanswered",
      rtcSessionId: state.rtcSessionId,
      waitedMs: current.waitedMs,
      probeMs,
      rootAnswered,
      rootMs: rootAnswered ? current.rootAnsweredMs : current.rootSilentMs,
      rebuilds,
    });
  }

  function secondRound(current) {
    if (proof !== current) return;
    if (!openProbe(current)) {
      endProof(current);
      return;
    }
    pingRoot(current);
    current.timer = setTimeout(() => {
      current.timer = null;
      current.probesSilent = true;
      decide(current);
    }, PROBE_MS);
  }

  function suspect(waitedMs) {
    const at = now();
    if (rebuilds > 0 && at - troubleAt >= RUN_QUIET_MS) rebuilds = 0;
    troubleAt = at;
    if (proof || at < notBefore || !peerReady()) return;
    const current = {
      probes: [],
      since: at,
      waitedMs,
      timer: null,
      probesSilent: false,
      rootAnsweredMs: null,
      rootSilentPings: 0,
      rootSilentMs: 0,
    };
    proof = current;
    if (!openProbe(current)) {
      endProof(current);
      return;
    }
    current.timer = setTimeout(() => secondRound(current), PROBE_MS);
  }

  api.channelWatch = {
    /** The worker opened a child channel on the peer. */
    opened(label) {
      if (!DAEMON_SPEAKS_FIRST.test(label) || pending.has(label)) return;
      const since = now();
      const timer = setTimeout(() => {
        if (pending.get(label)?.timer !== timer) return;
        pending.delete(label);
        suspect(now() - since);
      }, UNANSWERED_MS);
      pending.set(label, { since, timer });
    },
    /** The daemon spoke on the channel, or closed it: either way it answered. */
    answered(label) {
      if (take(label) && proof) endProof(proof);
    },
    /** The channel went for a reason that says nothing about the daemon. */
    forget(label) {
      take(label);
    },
    /** The peer left `connected` or was torn down. The run of rebuilds and
     * its backoff carry over to the next peer. */
    reset() {
      for (const entry of pending.values()) clearTimeout(entry.timer);
      pending.clear();
      for (const settle of [...pings.values()]) settle(new Error("The peer was replaced."));
      if (proof) endProof(proof);
    },
    /** A root response: true when it answered the watch's own ping. */
    pong(requestId) {
      const settle = pings.get(requestId);
      if (!settle) return false;
      settle();
      return true;
    },
  };
})();
