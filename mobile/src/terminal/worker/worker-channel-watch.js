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
  // deadline always comes first. A suspect peer gets one probe, a host-control
  // channel of the worker's own that the daemon greets without any session
  // involved. A probe silent for ten seconds is weighed against the root with
  // one ping, and native is asked to replace the peer when the root answers
  // while the probe is still silent (channels are not being accepted), or when
  // the root stays silent for twenty seconds too: an old daemon's association
  // stops acknowledging anything once channels pile up behind its dead
  // acceptor. Only an answer stands the watch down. A host that is merely slow
  // answers the probe within its thirty seconds; one briefly unreachable loses
  // ICE consent and leaves `connected`, which resets the watch.
  //
  // A refusal is an answer: the daemon closes a channel it refuses at once.
  // Any answer clears the suspicion and the run of rebuilds. One probe at a
  // time; rebuilds for this reason at least thirty seconds apart, doubling
  // while nothing is answered between them, up to five minutes.
  const api = globalThis.spawnWorker;
  const state = api.state;
  const UNANSWERED_MS = 10_000;
  const PROBE_MS = 10_000;
  const ROOT_SILENCE_MS = 20_000;
  const REBUILD_BACKOFF_MS = 30_000;
  const REBUILD_BACKOFF_CAP_MS = 300_000;
  const DAEMON_SPEAKS_FIRST = /^spawn\.(?:ctl|host\.ctl)\//;
  const pending = new Map();
  const pings = new Map();
  let probe = null;
  let rebuilds = 0;
  let notBefore = 0;

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

  function heard() {
    rebuilds = 0;
    if (probe) endProbe(probe);
  }

  function endProbe(current) {
    if (probe !== current) return;
    probe = null;
    clearTimeout(current.timer);
    current.channel.onmessage = current.channel.onclose = current.channel.onerror = null;
    try {
      current.channel.close();
    } catch {
      // A channel of a peer that is already gone has nothing left to close.
    }
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

  async function confirm(current) {
    if (probe !== current) return;
    const pinged = Date.now();
    let rootAnswered = true;
    try {
      await ping();
    } catch {
      rootAnswered = false;
    }
    // Answered meanwhile (the probe, or any watched channel), or the peer
    // left readiness: either way there is nothing to replace.
    if (probe !== current) return;
    const rootMs = Date.now() - pinged;
    const probeMs = Date.now() - current.since;
    endProbe(current);
    // A ping that failed before its deadline was never sent: no evidence.
    if (!rootAnswered && rootMs < ROOT_SILENCE_MS * 0.9) return;
    if (Date.now() < notBefore || !peerReady()) return;
    rebuilds += 1;
    notBefore =
      Date.now() + Math.min(REBUILD_BACKOFF_CAP_MS, REBUILD_BACKOFF_MS * 2 ** (rebuilds - 1));
    // Native replaces the peer and says why; nothing a terminal carries is in it.
    api.post({
      type: "rebuild",
      reason: "channels_unanswered",
      waitedMs: current.waitedMs,
      probeMs,
      rootAnswered,
      rootMs,
      rebuilds,
    });
  }

  function suspect(waitedMs) {
    if (probe || Date.now() < notBefore || !peerReady()) return;
    let channel;
    try {
      channel = state.pc.createDataChannel(`spawn.host.ctl/${crypto.randomUUID()}`, {
        ordered: true,
      });
    } catch {
      return;
    }
    const current = { channel, since: Date.now(), waitedMs, timer: null };
    probe = current;
    const answered = () => {
      if (probe === current) heard();
    };
    channel.onmessage = channel.onclose = channel.onerror = answered;
    current.timer = setTimeout(() => void confirm(current), PROBE_MS);
  }

  api.channelWatch = {
    /** The worker opened a child channel on the peer. */
    opened(label) {
      if (!DAEMON_SPEAKS_FIRST.test(label) || pending.has(label)) return;
      const since = Date.now();
      const timer = setTimeout(() => {
        if (pending.get(label)?.timer !== timer) return;
        pending.delete(label);
        suspect(Date.now() - since);
      }, UNANSWERED_MS);
      pending.set(label, { since, timer });
    },
    /** The daemon spoke on the channel, or closed it: either way it answered. */
    answered(label) {
      if (take(label)) heard();
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
      if (probe) endProbe(probe);
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
