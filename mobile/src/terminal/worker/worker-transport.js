// biome-ignore-all lint: This source executes inside WKWebView, not the React Native runtime.
(() => {
  "use strict";
  const api = globalThis.spawnWorker;
  const state = api.state;
  const CHANNEL_OPTIONS = Object.freeze({ ordered: true });

  function protocolTuple() {
    return state.mode === "session"
      ? { scopeType: "session", protocol: "spawn.pty", protocolVersion: 2 }
      : { scopeType: "host", protocol: "spawn.host.ctl", protocolVersion: 1 };
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
    teardown(false);
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
    if (state.pc && state.rtcSessionId === message.rtcSessionId) return;
    teardown(false);
    state.stopped = false;
    state.rtcSessionId = message.rtcSessionId;
    state.bindingNonce = message.bindingNonce;
    state.bindingGeneration = null;
    state.offerSent = false;
    const pc = new RTCPeerConnection({
      iceServers: message.iceServers,
      iceTransportPolicy: message.forceRelay ? "relay" : "all",
    });
    state.pc = pc;
    if (state.mode === "session") {
      state.pty = pc.createDataChannel("spawn.pty", CHANNEL_OPTIONS);
      state.ctl = pc.createDataChannel("spawn.ctl", CHANNEL_OPTIONS);
      configureChannel(state.pty, "pty");
      configureChannel(state.ctl, "ctl");
      api.resetSessionGeneration?.();
    } else {
      state.ctl = pc.createDataChannel("spawn.host.ctl", CHANNEL_OPTIONS);
      configureChannel(state.ctl, "ctl");
      api.resetHostGeneration?.();
    }
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
      if (pc.connectionState === "failed") channelFailed("RTCPeerConnection");
      if (pc.connectionState === "disconnected") {
        clearTimeout(state.disconnectTimer);
        state.disconnectTimer = setTimeout(() => channelFailed("RTCPeerConnection"), 5_000);
      } else if (pc.connectionState === "connected") {
        clearTimeout(state.disconnectTimer);
      }
    };
    api.post({ type: "state", state: "connecting" });
    const offer = await pc.createOffer();
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
    api.post({ type: "sign-request", requestId, transcript });
  }

  async function acceptSignResponse(message) {
    const transcript = state.pendingSign.get(message.requestId);
    if (!transcript) return;
    state.pendingSign.delete(message.requestId);
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
    emitSignal({ type: "rtc.offer", ...outerTuple(), signed_envelope: JSON.stringify(envelope) });
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
    if (sendClose && state.rtcSessionId && state.bindingNonce) {
      emitSignal({ type: "rtc.close", ...outerTuple() });
    }
    clearTimeout(state.disconnectTimer);
    state.disconnectTimer = null;
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
  }

  api.handleTransportMessage = async (message) => {
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
