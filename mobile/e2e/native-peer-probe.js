// Copied into acceptance worker assets only; every peer/channel remains native.
(() => {
  const config = __NATIVE_ACCEPTANCE_RTC_CONFIG__;
  const NativePeer = globalThis.RTCPeerConnection;
  if (typeof NativePeer !== "function") return;
  const peers = [];
  const workerId = `worker-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  class ObservedPeer extends NativePeer {
    constructor(options) {
      super({
        ...options,
        iceServers: config.iceServers,
        iceTransportPolicy: config.forceRelay ? "relay" : options?.iceTransportPolicy,
      });
      const record = { peer: this, id: `${workerId}-peer-${peers.length + 1}`, channels: [] };
      peers.push(record);
      this.addEventListener("datachannel", ({ channel }) => observeChannel(record, channel));
    }
    createDataChannel(...args) {
      const channel = super.createDataChannel(...args);
      observeChannel(
        peers.find((record) => record.peer === this),
        channel,
      );
      return channel;
    }
  }
  function observeChannel(record, channel) {
    const stats = { channel, receivedBytes: 0, sentBytes: 0 };
    record.channels.push(stats);
    channel.addEventListener("message", ({ data }) => {
      stats.receivedBytes +=
        typeof data === "string"
          ? new TextEncoder().encode(data).length
          : (data.byteLength ?? data.size ?? 0);
    });
    const send = channel.send.bind(channel);
    channel.send = (data) => {
      send(data);
      stats.sentBytes +=
        typeof data === "string"
          ? new TextEncoder().encode(data).length
          : (data.byteLength ?? data.size ?? 0);
    };
  }
  globalThis.RTCPeerConnection = ObservedPeer;
  let sampling = false;
  setInterval(async () => {
    if (!peers.length || sampling) return;
    sampling = true;
    try {
      const snapshots = await Promise.all(
        peers.map(async ({ peer, id, channels }) => {
          let selected = null;
          try {
            const stats = await peer.getStats();
            let pair;
            stats.forEach((entry) => {
              if (entry.type === "transport" && entry.selectedCandidatePairId)
                pair = stats.get(entry.selectedCandidatePairId);
            });
            if (!pair)
              stats.forEach((entry) => {
                if (
                  entry.type === "candidate-pair" &&
                  entry.state === "succeeded" &&
                  entry.nominated
                )
                  pair = entry;
              });
            if (pair) {
              const local = stats.get(pair.localCandidateId),
                remote = stats.get(pair.remoteCandidateId);
              selected = {
                localCandidateType: local?.candidateType,
                remoteCandidateType: remote?.candidateType,
                protocol: local?.protocol,
                relayProtocol: local?.relayProtocol,
                bytesSent: pair.bytesSent,
                bytesReceived: pair.bytesReceived,
                currentRoundTripTime: pair.currentRoundTripTime,
              };
            }
          } catch {
            /* A retired native peer may reject getStats. */
          }
          return {
            id,
            connectionState: peer.connectionState,
            iceConnectionState: peer.iceConnectionState,
            selected,
            channels: channels.map(({ channel, sentBytes, receivedBytes }) => ({
              label: channel.label,
              state: channel.readyState,
              sentBytes,
              receivedBytes,
            })),
          };
        }),
      );
      globalThis.ReactNativeWebView?.postMessage(
        JSON.stringify({
          type: "native-acceptance-peer",
          snapshot: {
            workerId,
            sampledAtMs: Date.now(),
            peers: snapshots,
            livePeerCount: snapshots.filter((peer) => peer.connectionState !== "closed").length,
            createdPeerCount: snapshots.length,
          },
        }),
      );
    } finally {
      sampling = false;
    }
  }, 500);
})();
