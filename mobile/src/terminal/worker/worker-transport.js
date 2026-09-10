// biome-ignore-all lint: This source executes inside WKWebView, not the React Native runtime.
(() => {
  "use strict";
  const api = globalThis.spawnWorker;
  const state = api.state;
  const CHANNEL_OPTIONS = Object.freeze({ ordered: true });
  state.restartTimer ??= null;
  state.statsTimer ??= null;
  state.pendingRestartRequests ??= new Set();

  function protocolTuple() {
    return state.mode === "session"
      ? { scopeType: "session", protocol: "spawn.pty", protocolVersion: 2 }
      : { scopeType: "host", protocol: "spawn.host.ctl", protocolVersion: 2 };
  }

  /** The two signalling channels bind a peer differently, and only the session
   * channel works the way this file originally assumed. /ws/browser echoes the
   * browser-proposed `binding_nonce` and a server ownership `binding_generation`
   * on every frame. /ws/host mints its own nonce, never discloses it, and has no
   * generation at all: the scope tuple plus `session_id` is the whole binding.
   * Matching or gating on the session fields in host mode drops every daemon
   * frame and strands the connection in `connecting`. */
  function isSessionMode() {
    return state.mode === "session";
  }

  function outerTuple() {
    const tuple = protocolTuple();
    // `binding_nonce` is inert on /ws/host — the server substitutes its own
    // before the frame reaches the daemon — but it still guards teardown.
    return {
      session_id: state.rtcSessionId,
      binding_nonce: state.bindingNonce,
      ...(state.bindingGeneration === null ? {} : { binding_generation: state.bindingGeneration }),
      scope_type: tuple.scopeType,
      scope_id: state.scopeId,
      protocol: tuple.protocol,
      protocol_version: tuple.protocolVersion,
    };
  }

  function emitSignal(frame) {
    api.post({ type: "signal-frame", frame });
  }

  function channelFailed(label, reason) {
    // A daemon-authored reason (an unapproved device, a refused binding) is the
    // only thing that tells the operator why, so it wins over the generic text.
    api.error("channel_closed", reason || `${label} closed before the session retired.`, true);
    api.post({ type: "state", state: "reconnecting" });
    teardown(true);
  }

  async function requestSignedOffer(pc, iceRestart) {
    const offer = await pc.createOffer(iceRestart ? { iceRestart: true } : undefined);
    await pc.setLocalDescription(offer);
    const tuple = protocolTuple();
    const requestId = crypto.randomUUID();
    const transcript = {
      signalKind: "offer",
      protocolVersion: tuple.protocolVersion,
      sessionId: state.rtcSessionId,
      scopeType: tuple.scopeType,
      scopeId: state.scopeId,
      senderRole: "browser",
      intendedPeerIdentityPublicKey: state.hostKey,
      sdp: offer.sdp,
    };
    state.pendingSign.set(requestId, transcript);
    if (iceRestart) state.pendingRestartRequests.add(requestId);
    api.post({ type: "sign-request", requestId, transcript });
  }

  function scheduleStats() {
    clearTimeout(state.statsTimer);
    if (!state.pc || state.pc.connectionState !== "connected") return;
    state.statsTimer = setTimeout(async () => {
      const pc = state.pc;
      if (!pc || pc.connectionState !== "connected") return;
      try {
        const stats = await pc.getStats();
        let selected = null;
        const records = new Map();
        stats.forEach((entry) => {
          records.set(entry.id, entry);
          if (entry.type === "candidate-pair" && entry.state === "succeeded" && entry.nominated) {
            selected = entry;
          }
        });
        const local = selected ? records.get(selected.localCandidateId) : null;
        const remote = selected ? records.get(selected.remoteCandidateId) : null;
        const candidateTypes = [local?.candidateType, remote?.candidateType];
        const kind = candidateTypes.includes("relay")
          ? "relay"
          : candidateTypes.some((value) => value === "srflx" || value === "prflx")
            ? "stun"
            : candidateTypes.includes("host")
              ? "direct"
              : "unknown";
        const rttMs =
          typeof selected?.currentRoundTripTime === "number"
            ? Math.round(selected.currentRoundTripTime * 1_000)
            : null;
        api.post({ type: "connection-info", info: { kind, rttMs } });
      } catch {
        // Stats are diagnostic only; an older WebKit must not affect the channel.
      } finally {
        scheduleStats();
        api.hostChannelOpened?.();
      }
    }, 5_000);
  }

  async function restartPeer(message = {}, cause = "connection lost") {
    const pc = state.pc;
    if (!pc || pc.connectionState === "closed" || state.restartTimer !== null) {
      if (!pc) channelFailed("RTCPeerConnection");
      return;
    }
    clearTimeout(state.disconnectTimer);
    state.disconnectTimer = null;
    if (Array.isArray(message.iceServers) && typeof pc.setConfiguration === "function") {
      const relayOnly = message.iceTransportPolicy === "relay";
      pc.setConfiguration({
        iceServers: message.iceServers,
        iceTransportPolicy: relayOnly ? "relay" : "all",
      });
    }
    pc.restartIce?.();
    await requestSignedOffer(pc, true);
    state.restartTimer = setTimeout(() => {
      state.restartTimer = null;
      if (state.pc?.connectionState !== "connected") {
        channelFailed(
          "ICE restart",
          cause === "network changed"
            ? "The network changed and the terminal connection could not be restored."
            : "The host connection was lost and could not be restored.",
        );
      }
    }, 10_000);
  }

  function configureChannel(channel, kind) {
    channel.binaryType = "arraybuffer";
    channel.onopen = () => {
      if (kind === "pty") api.sessionChannelOpened?.("ptyOpen");
      else api.sessionChannelOpened?.("ctlOpen");
      if (state.mode === "host") api.hostChannelOpened?.();
    };
    channel.onclose = () => channelFailed(channel.label);
    channel.onerror = () => channelFailed(channel.label);
    channel.onmessage = (event) => {
      if (kind === "pty") api.receivePty?.(event.data);
      else if (state.mode === "session") api.receiveSessionCtl?.(event.data);
      else api.receiveHostCtl?.(event.data);
    };
  }

  async function startPeer(message) {
    if (state.mode !== "host") throw new Error("Terminal views attach to the daemon connection.");
    if (state.pc?.connectionState === "connected" && message.forceRebuild !== true) return;
    if (state.pc && state.rtcSessionId === message.rtcSessionId) return;
    teardown(false);
    state.stopped = false;
    state.rtcSessionId = message.rtcSessionId;
    state.bindingNonce = message.bindingNonce;
    state.bindingGeneration = null;
    state.offerSent = false;
    // Either the operator's deployment says every peer relays, or this client
    // was asked to prove it can. Native used to read neither, so a relay-only
    // deployment kept the phone hunting for direct paths that do not exist.
    const relayOnly = message.forceRelay === true || message.iceTransportPolicy === "relay";
    const pc = new RTCPeerConnection({
      iceServers: message.iceServers,
      iceTransportPolicy: relayOnly ? "relay" : "all",
    });
    state.pc = pc;
    state.ctl = pc.createDataChannel("spawn.host.ctl", CHANNEL_OPTIONS);
    configureChannel(state.ctl, "ctl");
    api.resetHostGeneration?.();
    pc.onicecandidate = ({ candidate }) => {
      if (!candidate) return;
      const frame = { type: "rtc.candidate", ...outerTuple(), candidate: candidate.toJSON() };
      // Candidates disclose the session, so neither mode emits one before its
      // offer is armed: a session waits for the server to accept the binding,
      // a host — which is never told of a binding — waits for the signed offer.
      const armed = isSessionMode() ? state.bindingGeneration !== null : state.offerSent;
      if (armed) emitSignal(frame);
      else state.pendingLocalCandidates.push(frame);
    };
    pc.onconnectionstatechange = () => {
      if (pc !== state.pc) return;
      if (["failed", "disconnected"].includes(pc.connectionState)) {
        api.post({ type: "state", state: "connecting" });
      }
      if (pc.connectionState === "failed") void restartPeer();
      if (pc.connectionState === "disconnected") {
        clearTimeout(state.disconnectTimer);
        state.disconnectTimer = setTimeout(() => void restartPeer(), 5_000);
      } else if (pc.connectionState === "connected") {
        clearTimeout(state.disconnectTimer);
        clearTimeout(state.restartTimer);
        state.restartTimer = null;
        scheduleStats();
        api.hostChannelOpened?.();
      }
    };
    api.post({ type: "state", state: "connecting" });
    await requestSignedOffer(pc, false);
  }

  async function acceptSignResponse(message) {
    const transcript = state.pendingSign.get(message.requestId);
    if (!transcript) return;
    state.pendingSign.delete(message.requestId);
    const iceRestart = state.pendingRestartRequests.delete(message.requestId);
    if (!message.signature) {
      api.error("signal_signing", message.error ?? "Signal signing failed.");
      return;
    }
    const tuple = protocolTuple();
    const envelope = {
      type: "rtc.offer",
      signature_algorithm: "ed25519",
      sender_identity_public_key: state.browserKey,
      intended_peer_identity_public_key: state.hostKey,
      protocol: tuple.protocol,
      protocol_version: tuple.protocolVersion,
      session_id: state.rtcSessionId,
      scope_type: tuple.scopeType,
      scope_id: state.scopeId,
      sender_role: "browser",
      sdp: transcript.sdp,
      signature: message.signature,
    };
    const offerFrame = {
      type: "rtc.offer",
      ...outerTuple(),
      signed_envelope: JSON.stringify(envelope),
      ...(iceRestart ? { ice_restart: true } : {}),
    };
    if (Array.isArray(message.carriedEndorsements) && message.carriedEndorsements.length > 0) {
      offerFrame.carried_endorsements = message.carriedEndorsements;
    }
    emitSignal(offerFrame);
    if (!isSessionMode()) {
      state.offerSent = true;
      for (const candidate of state.pendingLocalCandidates.splice(0)) emitSignal(candidate);
    }
  }

  function frameMatches(value) {
    const tuple = protocolTuple();
    return (
      value?.session_id === state.rtcSessionId &&
      (!isSessionMode() || value?.binding_nonce === state.bindingNonce) &&
      value?.scope_type === tuple.scopeType &&
      value?.scope_id === state.scopeId &&
      value?.protocol === tuple.protocol &&
      value?.protocol_version === tuple.protocolVersion
    );
  }

  async function acceptSignal(frame) {
    if (frame?.type === "rtc.config") return;
    if (frame?.type === "rtc.status") {
      if (!frameMatches(frame)) return;
      if (
        isSessionMode() &&
        (frame.status === "negotiating" || frame.status === "connected") &&
        Number.isSafeInteger(frame.binding_generation) &&
        frame.binding_generation > 0
      ) {
        state.bindingGeneration = frame.binding_generation;
        api.sessionGate?.("bindingAccepted");
        for (const candidate of state.pendingLocalCandidates.splice(0)) {
          emitSignal({ ...candidate, binding_generation: frame.binding_generation });
        }
      }
      if (["failed", "unavailable", "collision", "disabled"].includes(frame.status)) {
        const reason = typeof frame.message === "string" ? frame.message.slice(0, 512) : "";
        channelFailed(`RTC ${frame.status}`, reason);
      }
      return;
    }
    if (!frameMatches(frame) || !state.pc) return;
    if (frame.type === "rtc.answer") {
      const envelope =
        typeof frame.signed_envelope === "string" ? JSON.parse(frame.signed_envelope) : null;
      if (
        !envelope ||
        envelope.sender_identity_public_key !== state.hostKey ||
        envelope.sdp.length === 0
      ) {
        throw new Error("Signed RTC answer identity or shape mismatch.");
      }
      await state.pc.setRemoteDescription({ type: "answer", sdp: envelope.sdp });
      // The host channel has no binding status to wait for: an answer signed by
      // the pinned host for this exact session and scope is the proof itself.
      if (!isSessionMode()) api.hostBindingAccepted?.();
      for (const candidate of state.pendingRemoteCandidates.splice(0))
        await state.pc.addIceCandidate(candidate);
      return;
    }
    if (frame.type === "rtc.candidate" && frame.candidate) {
      if (!state.pc.remoteDescription) state.pendingRemoteCandidates.push(frame.candidate);
      else await state.pc.addIceCandidate(frame.candidate);
    }
  }

  function teardown(sendClose) {
    api.closeHostConsumers?.();
    api.closePairChannels?.();
    if (state.mode === "host" && sendClose && state.rtcSessionId && state.bindingNonce) {
      emitSignal({ type: "rtc.close", ...outerTuple() });
    }
    clearTimeout(state.disconnectTimer);
    clearTimeout(state.restartTimer);
    clearTimeout(state.statsTimer);
    state.disconnectTimer = null;
    state.restartTimer = null;
    state.statsTimer = null;
    for (const channel of [state.pty, state.ctl]) {
      if (!channel) continue;
      channel.onclose = null;
      channel.onerror = null;
      channel.close();
    }
    state.pty = null;
    state.ctl = null;
    state.pc?.close();
    state.pc = null;
    state.offerSent = false;
    state.pendingLocalCandidates.splice(0);
    state.pendingRemoteCandidates.splice(0);
    state.pendingSign.clear();
    state.pendingRestartRequests.clear();
  }

  api.handleTransportMessage = async (message) => {
    if (api.handleHostConsumerMessage?.(message)) return;
    if (api.handlePairMessage?.(message)) return;
    switch (message.type) {
      case "connect":
        await startPeer(message);
        break;
      case "sign-response":
        await acceptSignResponse(message);
        break;
      case "signal-frame":
        await acceptSignal(message.frame);
        break;
      case "network-changed":
        await restartPeer(message, "network changed");
        break;
      case "request-replay":
        api.requestReplay?.(message.fromOffset);
        break;
      case "upload-start":
      case "upload-chunk":
      case "upload-cancel":
        await api.handleUploadMessage?.(message);
        break;
      case "host-request":
      case "host-cancel":
        api.handleHostMessage?.(message);
        break;
      case "close":
        state.stopped = true;
        teardown(true);
        api.post({ type: "state", state: "closed" });
        break;
      default:
        api.error("bridge_message", `Unknown worker command: ${String(message.type)}.`);
    }
  };
})();
