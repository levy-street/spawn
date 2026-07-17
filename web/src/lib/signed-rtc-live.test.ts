import { describe, expect, test } from "bun:test";
import {
  SignedRtcLiveError,
  SignedRtcLiveSession,
  type SignedRtcRoute,
  type SignedRtcTrustCapability,
} from "./signed-rtc-live";
import {
  decodeEd25519PublicKeyWire,
  exportEd25519PublicKeyWire,
  generateEd25519IdentityKeyPair,
  type SignedSignalTranscript,
  signSignedSignalTranscript,
} from "./signed-signal";
import { signRtcSignalWire } from "./signed-signal-wire";

const AGENT_ID = "11111111-2222-4333-8444-555555555555";
const HOST_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const SESSION_ID = "01234567-89ab-4cde-8fab-0123456789ab";
const VERIFIED_SDP = "v=0\r\ns=verified\r\na=fingerprint:sha-256 11:22:33:44:55:66:77:88\r\n";
const HOSTILE_RAW_SDP =
  "v=0\r\ns=relay-substitution\r\na=fingerprint:sha-256 AA:BB:CC:DD:EE:FF:00:11\r\n";

const routes: SignedRtcRoute[] = [
  {
    scopeType: "agent",
    scopeId: AGENT_ID,
    protocol: "spawn.pty",
    protocolVersion: 2,
  },
  {
    scopeType: "host",
    scopeId: HOST_ID,
    protocol: "spawn.host.ctl",
    protocolVersion: 1,
  },
];

class FakePeer {
  readonly applied: RTCSessionDescriptionInit[] = [];
  closeCalls = 0;

  async setRemoteDescription(value: RTCSessionDescriptionInit): Promise<void> {
    this.applied.push(structuredClone(value));
  }

  close(): void {
    this.closeCalls += 1;
  }
}

class DelayedPeer extends FakePeer {
  entered!: () => void;
  private readonly waiting: Promise<void>;
  release!: () => void;

  constructor() {
    super();
    this.waiting = new Promise<void>((resolve) => {
      this.release = resolve;
    });
    this.entered = () => {};
  }

  override async setRemoteDescription(value: RTCSessionDescriptionInit): Promise<void> {
    this.entered();
    await this.waiting;
    await super.setRemoteDescription(value);
  }
}

async function fixture(route: SignedRtcRoute, sessionId = SESSION_ID) {
  const browser = await generateEd25519IdentityKeyPair();
  const host = await generateEd25519IdentityKeyPair();
  const browserPublicKeyWire = await exportEd25519PublicKeyWire(browser.publicKey);
  const hostPublicKeyWire = await exportEd25519PublicKeyWire(host.publicKey);
  let active = true;
  const trust: SignedRtcTrustCapability = {
    browserPublicKeyWire,
    hostPublicKeyWire,
    assertActive: () => {
      if (!active) throw new DOMException("trust epoch ended", "AbortError");
    },
    signOffer: (input) =>
      signRtcSignalWire(
        {
          publicKeyWire: browserPublicKeyWire,
          sign: (transcript) => signSignedSignalTranscript(browser.privateKey, transcript),
        },
        input,
      ),
  };
  const session = new SignedRtcLiveSession(route, sessionId, trust);
  const offer = await session.createOffer("v=0\r\ns=browser-offer\r\n");
  const answer = async (
    overrides: Partial<SignedSignalTranscript> = {},
    signingKey = host.privateKey,
    senderPublicKeyWire = hostPublicKeyWire,
  ) => {
    const transcript: SignedSignalTranscript = {
      signalKind: "answer",
      protocolVersion: route.protocolVersion,
      sessionId,
      scopeType: route.scopeType,
      scopeId: route.scopeId,
      senderRole: "daemon",
      intendedPeerPublicKey: decodeEd25519PublicKeyWire(browserPublicKeyWire),
      sdp: VERIFIED_SDP,
      ...overrides,
    };
    return signRtcSignalWire(
      {
        publicKeyWire: senderPublicKeyWire,
        sign: (value) => signSignedSignalTranscript(signingKey, value),
      },
      { protocol: route.protocol, transcript },
    );
  };
  const frame = (signedEnvelope: unknown, rawSdp: unknown = HOSTILE_RAW_SDP) => ({
    session_id: sessionId,
    scope_type: route.scopeType,
    scope_id: route.scopeId,
    protocol: route.protocol,
    protocol_version: route.protocolVersion,
    signed_envelope: signedEnvelope,
    sdp: rawSdp,
  });
  return {
    answer,
    browser,
    browserPublicKeyWire,
    frame,
    host,
    hostPublicKeyWire,
    offer,
    revoke: () => {
      active = false;
    },
    session,
    trust,
  };
}

async function signedAnswer(
  route: SignedRtcRoute,
  sessionId: string,
  host: Awaited<ReturnType<typeof generateEd25519IdentityKeyPair>>,
  hostPublicKeyWire: string,
  browserPublicKeyWire: string,
  sdp = VERIFIED_SDP,
): Promise<string> {
  return signRtcSignalWire(
    {
      publicKeyWire: hostPublicKeyWire,
      sign: (transcript) => signSignedSignalTranscript(host.privateKey, transcript),
    },
    {
      protocol: route.protocol,
      transcript: {
        signalKind: "answer",
        protocolVersion: route.protocolVersion,
        sessionId,
        scopeType: route.scopeType,
        scopeId: route.scopeId,
        senderRole: "daemon",
        intendedPeerPublicKey: decodeEd25519PublicKeyWire(browserPublicKeyWire),
        sdp,
      },
    },
  );
}

function answerFrame(route: SignedRtcRoute, sessionId: string, signedEnvelope: string) {
  return {
    session_id: sessionId,
    scope_type: route.scopeType,
    scope_id: route.scopeId,
    protocol: route.protocol,
    protocol_version: route.protocolVersion,
    signed_envelope: signedEnvelope,
    sdp: HOSTILE_RAW_SDP,
  };
}

describe("signed RTC live answer adapter", () => {
  for (const route of routes) {
    test(`${route.scopeType} consumes only verified transcript SDP when the relay raw SDP differs`, async () => {
      const value = await fixture(route);
      const peer = new FakePeer();

      expect(value.offer).toHaveProperty("signed_envelope");
      expect(value.offer).not.toHaveProperty("sdp");
      const verified = await value.session.verifyAndApplyAnswer(
        peer,
        value.frame(await value.answer()),
      );

      expect(verified.transcript.sdp).toBe(VERIFIED_SDP);
      expect(peer.applied).toEqual([{ type: "answer", sdp: VERIFIED_SDP }]);
      expect(peer.applied[0]?.sdp).not.toBe(HOSTILE_RAW_SDP);
      expect(peer.closeCalls).toBe(0);
    });

    test(`${route.scopeType} treats stripped or malformed signed answers as fatal without raw fallback`, async () => {
      for (const signedEnvelope of [undefined, "not-json", ""]) {
        const value = await fixture(route);
        const peer = new FakePeer();
        await expect(
          value.session.verifyAndApplyAnswer(peer, value.frame(signedEnvelope)),
        ).rejects.toBeInstanceOf(Error);
        expect(peer.applied).toEqual([]);
        expect(peer.closeCalls).toBe(1);
      }
    });

    test(`${route.scopeType} rejects pin substitution, route replay, and signature mutation before SDP`, async () => {
      const cases: Array<(value: Awaited<ReturnType<typeof fixture>>) => Promise<string>> = [
        async (value) => {
          const otherHost = await generateEd25519IdentityKeyPair();
          return value.answer(
            {},
            otherHost.privateKey,
            await exportEd25519PublicKeyWire(otherHost.publicKey),
          );
        },
        (value) => value.answer({ sessionId: "ffffffff-ffff-4fff-8fff-ffffffffffff" }),
        async (value) => {
          const wire = await value.answer();
          const parsed = JSON.parse(wire) as { signature: string };
          parsed.signature = `${parsed.signature.startsWith("A") ? "B" : "A"}${parsed.signature.slice(1)}`;
          return JSON.stringify(parsed);
        },
      ];
      for (const makeWire of cases) {
        const value = await fixture(route);
        const peer = new FakePeer();
        await expect(
          value.session.verifyAndApplyAnswer(peer, value.frame(await makeWire(value))),
        ).rejects.toBeInstanceOf(Error);
        expect(peer.applied).toEqual([]);
        expect(peer.closeCalls).toBe(1);
      }
    });

    test(`${route.scopeType} rejects peer substitution and outer topology mutation before SDP`, async () => {
      const peerSubstitution = await fixture(route);
      const otherBrowser = await generateEd25519IdentityKeyPair();
      const peer = new FakePeer();
      await expect(
        peerSubstitution.session.verifyAndApplyAnswer(
          peer,
          peerSubstitution.frame(
            await peerSubstitution.answer({
              intendedPeerPublicKey: decodeEd25519PublicKeyWire(
                await exportEd25519PublicKeyWire(otherBrowser.publicKey),
              ),
            }),
          ),
        ),
      ).rejects.toBeInstanceOf(Error);
      expect(peer.applied).toEqual([]);

      const outerMutation = await fixture(route);
      const outerPeer = new FakePeer();
      await expect(
        outerMutation.session.verifyAndApplyAnswer(outerPeer, {
          ...outerMutation.frame(await outerMutation.answer()),
          protocol_version: route.protocolVersion + 1,
        }),
      ).rejects.toMatchObject({ code: "invalid_outer_route" });
      expect(outerPeer.applied).toEqual([]);
    });

    test(`${route.scopeType} seals retry, concurrent replay, and fingerprint renegotiation to one answer`, async () => {
      const value = await fixture(route);
      const peer = new FakePeer();
      const firstWire = await value.answer();
      await value.session.verifyAndApplyAnswer(peer, value.frame(firstWire));

      await expect(
        value.session.verifyAndApplyAnswer(
          peer,
          value.frame(
            await value.answer({
              sdp: `${VERIFIED_SDP}a=fingerprint:sha-256 FF:EE:DD:CC:BB:AA:99:88\r\n`,
            }),
          ),
        ),
      ).rejects.toMatchObject({ code: "answer_already_consumed" });
      expect(peer.applied).toEqual([{ type: "answer", sdp: VERIFIED_SDP }]);
      expect(peer.closeCalls).toBe(1);
    });
  }

  test("trust invalidation after verification closes the peer and discards the answer", async () => {
    const value = await fixture(routes[0]);
    const wire = await value.answer();
    const peer = new FakePeer();
    value.revoke();
    await expect(
      value.session.verifyAndApplyAnswer(peer, value.frame(wire)),
    ).rejects.toBeInstanceOf(SignedRtcLiveError);
    expect(peer.applied).toEqual([]);
    expect(peer.closeCalls).toBe(1);
  });

  test("a concurrent second answer cannot outrun the one-answer generation gate", async () => {
    const value = await fixture(routes[0]);
    const wire = await value.answer();
    const peer = new DelayedPeer();
    let entered!: () => void;
    const applying = new Promise<void>((resolve) => {
      entered = resolve;
    });
    peer.entered = entered;
    const first = value.session.verifyAndApplyAnswer(peer, value.frame(wire));
    await applying;

    await expect(value.session.verifyAndApplyAnswer(peer, value.frame(wire))).rejects.toMatchObject(
      { code: "answer_already_consumed" },
    );
    peer.release();
    await expect(first).rejects.toMatchObject({ code: "answer_already_consumed" });
    expect(peer.closeCalls).toBeGreaterThanOrEqual(2);
  });

  test("a failed generation stays sealed while a fresh reconnect session can succeed", async () => {
    const failed = await fixture(routes[0]);
    const failedPeer = new FakePeer();
    await expect(
      failed.session.verifyAndApplyAnswer(failedPeer, failed.frame(undefined)),
    ).rejects.toMatchObject({ code: "missing_signed_answer" });
    await expect(
      failed.session.verifyAndApplyAnswer(failedPeer, failed.frame(await failed.answer())),
    ).rejects.toMatchObject({ code: "answer_already_consumed" });

    const retry = await fixture(routes[0], "12345678-9abc-4def-8abc-123456789abc");
    const retryPeer = new FakePeer();
    await retry.session.verifyAndApplyAnswer(retryPeer, retry.frame(await retry.answer()));
    expect(retryPeer.applied).toEqual([{ type: "answer", sdp: VERIFIED_SDP }]);
    expect(retryPeer.closeCalls).toBe(0);
  });

  test("trust invalidation during SDP application closes the peer before success escapes", async () => {
    const value = await fixture(routes[1]);
    const peer = new DelayedPeer();
    let entered!: () => void;
    const applying = new Promise<void>((resolve) => {
      entered = resolve;
    });
    peer.entered = entered;
    const result = value.session.verifyAndApplyAnswer(peer, value.frame(await value.answer()));
    await applying;
    value.revoke();
    peer.release();
    await expect(result).rejects.toMatchObject({ code: "inactive_trust" });
    expect(peer.closeCalls).toBe(1);
  });

  test("a generation snapshots H1 once, rejects a post-offer H2 rotation, and a fresh H2 generation succeeds", async () => {
    const route = routes[0];
    const browser = await generateEd25519IdentityKeyPair();
    const hostH1 = await generateEd25519IdentityKeyPair();
    const hostH2 = await generateEd25519IdentityKeyPair();
    const browserWire = await exportEd25519PublicKeyWire(browser.publicKey);
    const hostH1Wire = await exportEd25519PublicKeyWire(hostH1.publicKey);
    const hostH2Wire = await exportEd25519PublicKeyWire(hostH2.publicKey);
    let selectedHostWire = hostH1Wire;
    let browserReads = 0;
    let hostReads = 0;
    const trust: SignedRtcTrustCapability = {
      get browserPublicKeyWire() {
        browserReads += 1;
        return browserWire;
      },
      get hostPublicKeyWire() {
        hostReads += 1;
        return selectedHostWire;
      },
      assertActive: () => {},
      signOffer: (input) =>
        signRtcSignalWire(
          {
            publicKeyWire: browserWire,
            sign: (transcript) => signSignedSignalTranscript(browser.privateKey, transcript),
          },
          input,
        ),
    };

    const h1Session = new SignedRtcLiveSession(route, SESSION_ID, trust);
    expect({ browserReads, hostReads }).toEqual({ browserReads: 1, hostReads: 1 });
    await h1Session.createOffer("v=0\r\ns=h1-offer\r\n");
    selectedHostWire = hostH2Wire;
    const h1Peer = new FakePeer();
    await expect(
      h1Session.verifyAndApplyAnswer(
        h1Peer,
        answerFrame(
          route,
          SESSION_ID,
          await signedAnswer(route, SESSION_ID, hostH2, hostH2Wire, browserWire),
        ),
      ),
    ).rejects.toMatchObject({ code: "sender_pin_mismatch" });
    expect(h1Peer.applied).toEqual([]);
    expect(h1Peer.closeCalls).toBe(1);
    expect({ browserReads, hostReads }).toEqual({ browserReads: 1, hostReads: 1 });

    const nextSessionId = "12345678-9abc-4def-8abc-123456789abc";
    const h2Session = new SignedRtcLiveSession(route, nextSessionId, trust);
    await h2Session.createOffer("v=0\r\ns=h2-offer\r\n");
    const h2Peer = new FakePeer();
    await h2Session.verifyAndApplyAnswer(
      h2Peer,
      answerFrame(
        route,
        nextSessionId,
        await signedAnswer(route, nextSessionId, hostH2, hostH2Wire, browserWire),
      ),
    );
    expect(h2Peer.applied).toEqual([{ type: "answer", sdp: VERIFIED_SDP }]);
    expect(h2Peer.closeCalls).toBe(0);
    expect({ browserReads, hostReads }).toEqual({ browserReads: 2, hostReads: 2 });
  });

  test("browser-pin getters and route proxies are snapshotted against post-construction substitution", async () => {
    const browserB1 = await generateEd25519IdentityKeyPair();
    const browserB2 = await generateEd25519IdentityKeyPair();
    const host = await generateEd25519IdentityKeyPair();
    const browserB1Wire = await exportEd25519PublicKeyWire(browserB1.publicKey);
    const browserB2Wire = await exportEd25519PublicKeyWire(browserB2.publicKey);
    const hostWire = await exportEd25519PublicKeyWire(host.publicKey);
    let selectedBrowserWire = browserB1Wire;
    let browserReads = 0;
    const mutableRoute = { ...routes[1] } as {
      scopeType: "host";
      scopeId: string;
      protocol: "spawn.host.ctl";
      protocolVersion: 1;
    };
    const routeReads = new Map<PropertyKey, number>();
    const routeProxy = new Proxy(mutableRoute, {
      get(target, property, receiver) {
        routeReads.set(property, (routeReads.get(property) ?? 0) + 1);
        return Reflect.get(target, property, receiver);
      },
    });
    const trust: SignedRtcTrustCapability = {
      get browserPublicKeyWire() {
        browserReads += 1;
        return selectedBrowserWire;
      },
      hostPublicKeyWire: hostWire,
      assertActive: () => {},
      signOffer: (input) =>
        signRtcSignalWire(
          {
            publicKeyWire: browserB1Wire,
            sign: (transcript) => signSignedSignalTranscript(browserB1.privateKey, transcript),
          },
          input,
        ),
    };
    const session = new SignedRtcLiveSession(routeProxy, SESSION_ID, trust);
    expect(browserReads).toBe(1);
    for (const property of ["scopeType", "scopeId", "protocol", "protocolVersion"]) {
      expect(routeReads.get(property)).toBe(1);
    }
    mutableRoute.scopeId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    selectedBrowserWire = browserB2Wire;
    await session.createOffer("v=0\r\ns=b1-offer\r\n");
    const peer = new FakePeer();
    await expect(
      session.verifyAndApplyAnswer(
        peer,
        answerFrame(
          routes[1],
          SESSION_ID,
          await signedAnswer(routes[1], SESSION_ID, host, hostWire, browserB2Wire),
        ),
      ),
    ).rejects.toMatchObject({ code: "peer_pin_mismatch" });
    expect(peer.applied).toEqual([]);
    expect(peer.closeCalls).toBe(1);
    expect(browserReads).toBe(1);
    for (const property of ["scopeType", "scopeId", "protocol", "protocolVersion"]) {
      expect(routeReads.get(property)).toBe(1);
    }
  });

  test("post-construction operation mutation cannot bypass the captured live epoch", async () => {
    const value = await fixture(routes[0]);
    let active = true;
    const mutableTrust = {
      ...value.trust,
      assertActive: () => {
        if (!active) throw new DOMException("trust epoch ended", "AbortError");
      },
    };
    const session = new SignedRtcLiveSession(routes[0], SESSION_ID, mutableTrust);
    mutableTrust.assertActive = () => {};
    mutableTrust.signOffer = async () => "attacker-controlled replacement";
    active = false;
    await expect(session.createOffer("v=0\r\ns=revoked\r\n")).rejects.toMatchObject({
      code: "inactive_trust",
    });
  });
});
