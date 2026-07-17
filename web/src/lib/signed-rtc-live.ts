import { decodeEd25519PublicKeyWire, type SignedSignalTranscript } from "./signed-signal";
import {
  type RtcSignalProtocol,
  type SignedRtcSignalInput,
  type VerifiedRtcSignal,
  verifyRtcSignalWire,
} from "./signed-signal-wire";

export type SignedRtcRoute =
  | {
      readonly scopeType: "agent";
      readonly scopeId: string;
      readonly protocol: "spawn.pty";
      readonly protocolVersion: 2;
    }
  | {
      readonly scopeType: "host";
      readonly scopeId: string;
      readonly protocol: "spawn.host.ctl";
      readonly protocolVersion: 1;
    };

/**
 * The live adapter receives a bounded signing operation, never a private key.
 * The trust-scope owner must reassert its exact epoch before and after every
 * asynchronous boundary inside `signOffer` and `assertActive`.
 */
export interface SignedRtcTrustCapability {
  readonly browserPublicKeyWire: string;
  readonly hostPublicKeyWire: string;
  readonly signOffer: (input: SignedRtcSignalInput) => Promise<string>;
  readonly assertActive: () => void;
}

export interface SignedRtcAnswerFrame {
  readonly session_id?: unknown;
  readonly scope_type?: unknown;
  readonly scope_id?: unknown;
  readonly protocol?: unknown;
  readonly protocol_version?: unknown;
  readonly signed_envelope?: unknown;
  /** Untrusted compatibility field. It is deliberately never read. */
  readonly sdp?: unknown;
}

type RemoteAnswerConsumer = Pick<RTCPeerConnection, "close" | "setRemoteDescription">;

export class SignedRtcLiveError extends Error {
  constructor(
    readonly code:
      | "answer_already_consumed"
      | "inactive_trust"
      | "invalid_outer_route"
      | "missing_signed_answer"
      | "offer_already_created"
      | "signed_transcript_mismatch",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SignedRtcLiveError";
  }
}

type SessionPhase = "new" | "signing" | "offered" | "verifying" | "applied" | "failed";

/** One signed offer and one signed answer for one immutable RTC generation. */
export class SignedRtcLiveSession {
  private phase: SessionPhase = "new";

  constructor(
    readonly route: SignedRtcRoute,
    readonly sessionId: string,
    private readonly trust: SignedRtcTrustCapability,
  ) {}

  async createOffer(sdp: string): Promise<{ readonly signed_envelope: string }> {
    if (this.phase !== "new") {
      throw new SignedRtcLiveError(
        "offer_already_created",
        "a signed RTC generation can create exactly one offer",
      );
    }
    this.phase = "signing";
    try {
      this.assertTrustActive();
      const transcript: SignedSignalTranscript = {
        signalKind: "offer",
        protocolVersion: this.route.protocolVersion,
        sessionId: this.sessionId,
        scopeType: this.route.scopeType,
        scopeId: this.route.scopeId,
        senderRole: "browser",
        intendedPeerPublicKey: decodeEd25519PublicKeyWire(this.trust.hostPublicKeyWire),
        sdp,
      };
      const wire = await this.trust.signOffer({
        protocol: this.route.protocol,
        transcript,
      });
      this.assertPhase("signing");
      this.assertTrustActive();

      // Treat the signing boundary as capability-bearing, not infallible. Its
      // output must itself bind the exact local browser and Host pins and the
      // exact route before the carrier may leave this endpoint.
      const verified = await verifyRtcSignalWire(
        wire,
        this.trust.browserPublicKeyWire,
        this.trust.hostPublicKeyWire,
      );
      this.assertPhase("signing");
      this.assertTrustActive();
      this.assertTranscript(verified, "offer", sdp);
      this.phase = "offered";
      return { signed_envelope: wire };
    } catch (error) {
      this.phase = "failed";
      throw error;
    }
  }

  /** Fence an in-flight verifier before its owning RTC generation is closed. */
  abort(): void {
    this.phase = "failed";
  }

  /**
   * Verify first, then apply only the SDP returned by the verifier. Presence
   * of a raw sibling can never become a fallback because `frame.sdp` is never
   * read. Any failure permanently seals this RTC generation and closes it.
   */
  async verifyAndApplyAnswer(
    peer: RemoteAnswerConsumer,
    frame: SignedRtcAnswerFrame,
  ): Promise<VerifiedRtcSignal> {
    if (this.phase !== "offered") {
      this.closePeer(peer);
      this.phase = "failed";
      throw new SignedRtcLiveError(
        "answer_already_consumed",
        "a signed RTC generation accepts exactly one answer attempt",
      );
    }
    this.phase = "verifying";
    try {
      this.assertOuterRoute(frame);
      if (typeof frame.signed_envelope !== "string") {
        throw new SignedRtcLiveError(
          "missing_signed_answer",
          "signed RTC mode requires one opaque signed answer",
        );
      }
      this.assertTrustActive();
      const verified = await verifyRtcSignalWire(
        frame.signed_envelope,
        this.trust.hostPublicKeyWire,
        this.trust.browserPublicKeyWire,
      );
      this.assertPhase("verifying");
      this.assertTrustActive();
      this.assertTranscript(verified, "answer");
      await peer.setRemoteDescription({
        type: "answer",
        sdp: verified.transcript.sdp,
      });
      this.assertPhase("verifying");
      this.assertTrustActive();
      this.phase = "applied";
      return verified;
    } catch (error) {
      this.phase = "failed";
      this.closePeer(peer);
      throw error;
    }
  }

  private assertTrustActive(): void {
    try {
      this.trust.assertActive();
    } catch (error) {
      throw new SignedRtcLiveError(
        "inactive_trust",
        "the browser trust epoch ended during signed RTC negotiation",
        { cause: error },
      );
    }
  }

  private assertPhase(expected: SessionPhase): void {
    if (this.phase !== expected) {
      throw new SignedRtcLiveError(
        expected === "signing" ? "offer_already_created" : "answer_already_consumed",
        "the signed RTC generation changed during an asynchronous boundary",
      );
    }
  }

  private assertOuterRoute(frame: SignedRtcAnswerFrame): void {
    if (
      frame.session_id !== this.sessionId ||
      frame.scope_type !== this.route.scopeType ||
      frame.scope_id !== this.route.scopeId ||
      frame.protocol !== this.route.protocol ||
      frame.protocol_version !== this.route.protocolVersion
    ) {
      throw new SignedRtcLiveError(
        "invalid_outer_route",
        "signed RTC answer routing metadata does not match the local generation",
      );
    }
  }

  private assertTranscript(
    verified: VerifiedRtcSignal,
    signalKind: "offer" | "answer",
    exactSdp?: string,
  ): void {
    const transcript = verified.transcript;
    if (
      verified.protocol !== (this.route.protocol as RtcSignalProtocol) ||
      transcript.signalKind !== signalKind ||
      transcript.protocolVersion !== this.route.protocolVersion ||
      transcript.sessionId !== this.sessionId ||
      transcript.scopeType !== this.route.scopeType ||
      transcript.scopeId !== this.route.scopeId ||
      transcript.senderRole !== (signalKind === "offer" ? "browser" : "daemon") ||
      (exactSdp !== undefined && transcript.sdp !== exactSdp)
    ) {
      throw new SignedRtcLiveError(
        "signed_transcript_mismatch",
        "verified signed RTC transcript does not match the local generation",
      );
    }
  }

  private closePeer(peer: RemoteAnswerConsumer): void {
    try {
      peer.close();
    } catch {
      // Verification failure remains fatal even if browser teardown throws.
    }
  }
}
