import { createHash, generateKeyPairSync, type KeyObject, randomBytes, sign } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { BROWSER_DEVICE_ID, USER_ID, mockAuthenticatedApi } from "./app-mocks";

// The C1 terminal-state truth, joiner side (docs/TRUST_DEVICE_MESH.md §4 —
// mutual endorsement is a REQUIRED P1 invariant; the relay row's absence
// proves nothing). A ceremony whose pairing row vanishes mid-flight (10-min
// TTL or the peer's delete) must read from VERIFIED endorsement edges:
//
//  - the approver's edge landed and its signature verifies against the
//    ceremony-pinned initiator key → this device IS admitted: the screen says
//    approved (and the reciprocal edge is signed), never "nothing was trusted";
//  - no verified edge → stopped stays the honest terminal.
//
// The approver-side interleavings (half-done, forged-edge refusals, the late
// upgrade to done) need two browser contexts sharing one relay and live in
// unit tests: src/lib/approve-ceremony.test.ts.

const INITIATOR_DEVICE_ID = "00000000-0000-4000-8000-000000000077";
const PAIRING_ID = "00000000-0000-4000-8000-0000000000cc";

function b64url(buffer: Buffer): string {
  return buffer.toString("base64url");
}

function rawEd25519PublicKey(publicKey: KeyObject): Buffer {
  const spki = publicKey.export({ type: "spki", format: "der" });
  return Buffer.from(spki.subarray(spki.length - 32));
}

/** Byte-identical to web/src/lib/sas.ts `commit`. */
function sasCommit(rawKey: Buffer, nonce: Buffer): string {
  return b64url(
    createHash("sha256")
      .update(Buffer.concat([Buffer.from("SPAWN-SAS-COMMIT-V1"), rawKey, nonce]))
      .digest(),
  );
}

function uuidBytes(uuid: string): Buffer {
  return Buffer.from(uuid.replaceAll("-", ""), "hex");
}

/** Byte-identical to web/src/lib/acct-endorsement-transcript.ts. */
function acctEndorsementTranscript(
  accountId: string,
  endorserRaw: Buffer,
  endorsedRaw: Buffer,
  endorsedDeviceId: string,
): Buffer {
  return Buffer.concat([
    Buffer.from("SPAWN-ACCT-ENDORSE-V1"),
    Buffer.from([1]),
    uuidBytes(accountId),
    endorserRaw,
    endorsedRaw,
    uuidBytes(endorsedDeviceId),
  ]);
}

interface VanishHarness {
  readonly initiatorWire: string;
  readonly setVanished: () => void;
  readonly reciprocal: () => Record<string, unknown> | null;
  /** Sign the initiator's x→c edge over the joiner key the browser registered. */
  readonly serveApproverEdge: () => void;
}

async function installVanishingCeremony(page: Page): Promise<VanishHarness> {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const initiatorRaw = rawEd25519PublicKey(publicKey);
  const initiatorWire = b64url(initiatorRaw);
  const initiatorNonce = randomBytes(32);

  await mockAuthenticatedApi(page, {
    hostPins: {},
    extraBrowserDevices: [
      {
        id: INITIATOR_DEVICE_ID,
        key_algorithm: "ed25519",
        public_key: initiatorWire,
        label: "MacBook Pro",
        created_at: "2026-08-01T00:00:00Z",
        revoked_at: null,
      },
    ],
  });

  // Later-registered routes win; fall back to the app mocks for everything
  // they already answer. The registration intercept only observes the
  // browser's real joiner key.
  let joinerKeyWire = "";
  await page.route("**/api/browser-devices/register", async (route) => {
    const body = route.request().postDataJSON() as { public_key: string };
    joinerKeyWire = body.public_key;
    await route.fallback();
  });

  let contribution: { joiner_public_key: string; joiner_nonce: string } | null = null;
  let vanished = false;
  let edgeServed = false;
  let reciprocal: Record<string, unknown> | null = null;

  const pairingRow = () => ({
    id: PAIRING_ID,
    initiator_device_id: INITIATOR_DEVICE_ID,
    joiner_device_id: BROWSER_DEVICE_ID,
    initiator_public_key: initiatorWire,
    initiator_commit: sasCommit(initiatorRaw, initiatorNonce),
    // The initiator reveals once the joiner has contributed (the commit binds
    // key + nonce, so the joiner can verify the opening).
    initiator_nonce: contribution === null ? null : b64url(initiatorNonce),
    joiner_public_key: contribution?.joiner_public_key ?? null,
    joiner_nonce: contribution?.joiner_nonce ?? null,
    introductions: null,
    device_introductions: null,
    created_at: "2026-08-22T00:00:00Z",
    expires_at: "2027-01-01T00:00:00Z",
  });

  await page.route(
    (url) => url.pathname === "/api/trust/pairing" && url.searchParams.has("device_id"),
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        json: vanished ? [] : [pairingRow()],
      });
    },
  );
  await page.route(`**/api/trust/pairing/${PAIRING_ID}/contribute`, async (route) => {
    contribution = route.request().postDataJSON() as {
      joiner_public_key: string;
      joiner_nonce: string;
    };
    await route.fulfill({ status: 200, contentType: "application/json", json: pairingRow() });
  });
  // The vanished row's delete may still be attempted by cancel paths.
  await page.route(`**/api/trust/pairing/${PAIRING_ID}`, async (route) => {
    await route.fulfill({ status: 404, json: { detail: "pairing not found" } });
  });

  await page.route(
    (url) => url.pathname === "/api/trust/account-endorsements",
    async (route) => {
      if (route.request().method() === "POST") {
        reciprocal = route.request().postDataJSON() as Record<string, unknown>;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          json: {
            id: "00000000-0000-4000-8000-0000000000ee",
            endorser_device_id: BROWSER_DEVICE_ID,
            endorsed_device_id: INITIATOR_DEVICE_ID,
            created_at: "2026-08-22T00:00:01Z",
          },
        });
        return;
      }
      if (!edgeServed || joinerKeyWire === "") {
        await route.fulfill({ status: 200, contentType: "application/json", json: [] });
        return;
      }
      // The approver's genuine x→c edge, signed over the browser's REAL key —
      // the signature the joiner re-verifies against its ceremony-pinned copy
      // of the initiator key.
      const signature = b64url(
        sign(
          null,
          acctEndorsementTranscript(
            USER_ID,
            initiatorRaw,
            Buffer.from(joinerKeyWire, "base64url"),
            BROWSER_DEVICE_ID,
          ),
          privateKey,
        ),
      );
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        json: [
          {
            endorser_device_id: INITIATOR_DEVICE_ID,
            endorser_public_key: initiatorWire,
            endorsed_device_id: BROWSER_DEVICE_ID,
            endorsed_public_key: joinerKeyWire,
            signature,
            created_at: "2026-08-22T00:00:00Z",
          },
        ],
      });
    },
  );

  return {
    initiatorWire,
    setVanished: () => {
      vanished = true;
    },
    serveApproverEdge: () => {
      edgeServed = true;
    },
    reciprocal: () => reciprocal,
  };
}

test("a vanished row whose verified approval landed reads approved — and reciprocates", async ({
  page,
}) => {
  const harness = await installVanishingCeremony(page);
  await page.goto("/hosts");

  // The joiner runs the commit/reveal dance and shows its number.
  const ceremony = page.getByTestId("approve-ceremony");
  await expect(ceremony).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("ceremony-sas")).toBeVisible({ timeout: 15_000 });

  // TTL/peer-delete: the row vanishes AND the approver's signed edge is on the
  // account — exactly the interleaving that used to land on "nothing was
  // trusted" while the device was in fact admitted.
  harness.serveApproverEdge();
  harness.setVanished();

  await expect(page.getByTestId("ceremony-done")).toContainText("This device is approved", {
    timeout: 20_000,
  });
  // The one entry still covers both directions: the fallback signed the
  // reciprocal edge toward the ceremony-pinned initiator (P1's mutual pair).
  await expect
    .poll(() => harness.reciprocal(), { timeout: 10_000 })
    .toMatchObject({ endorsed_device_id: INITIATOR_DEVICE_ID });
});

test("a vanished row with no verified edge stays stopped — nothing was trusted", async ({
  page,
}) => {
  const harness = await installVanishingCeremony(page);
  await page.goto("/hosts");

  await expect(page.getByTestId("ceremony-sas")).toBeVisible({ timeout: 15_000 });
  harness.setVanished(); // peer cancel; no edge ever appears

  const check = page.getByTestId("number-check");
  await expect(check).toHaveAttribute("data-phase", "stopped", { timeout: 20_000 });
  await expect(page.getByTestId("approve-ceremony")).toContainText("nothing was trusted");
  expect(harness.reciprocal()).toBeNull();
});
