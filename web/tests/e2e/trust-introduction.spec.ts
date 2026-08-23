import { createHash, generateKeyPairSync, type KeyObject, sign as nodeSign } from "node:crypto";
import { expect, test } from "@playwright/test";
import {
  BROWSER_DEVICE_ID,
  HOST_ID,
  host,
  mockApp,
  openSettings,
  USER_ID,
  WORKSPACE_ID,
} from "./app-mocks";

// Bidirectional approval, receiving half: this browser was endorsed, and the
// endorsement carries the host's key. The panel verifies the signature
// locally against the endorser key, shows the ENDORSER's fingerprint for the
// human to confirm, and only then pins the host — a server that tampers with
// any covered field cannot produce a signature that survives.

function rawPublicKey(publicKey: KeyObject): Buffer {
  const spki = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  return spki.subarray(spki.length - 32);
}
const wire = (raw: Buffer) => raw.toString("base64url");
const fingerprintOf = (raw: Buffer) =>
  `SHA256:${createHash("sha256").update(raw).digest().subarray(0, 12).toString("base64url")}`;

const uuidBytes = (value: string) => Buffer.from(value.replaceAll("-", ""), "hex");

/** Byte-identical to encodeBrowserEndorsementTranscript. */
function transcript(
  accountId: string,
  hostKey: Buffer,
  endorserKey: Buffer,
  endorsedKey: Buffer,
  endorsedDeviceId: string,
): Buffer {
  return Buffer.concat([
    Buffer.from("SPAWN-BROWSER-ENDORSE-V1", "utf8"),
    Buffer.from([1]),
    uuidBytes(accountId),
    hostKey,
    endorserKey,
    endorsedKey,
    uuidBytes(endorsedDeviceId),
  ]);
}

test("an endorsed browser verifies its hosts from the endorsement itself", async ({ page }) => {
  const hostPair = generateKeyPairSync("ed25519");
  const endorserPair = generateKeyPairSync("ed25519");
  const hostRaw = rawPublicKey(hostPair.publicKey);
  const endorserRaw = rawPublicKey(endorserPair.publicKey);

  // The endorsed key is this browser's own, minted in-page: capture it from
  // the registration the app performs, then serve a matching endorsement.
  await mockApp(page, {
    hosts: [
      {
        ...host,
        host_public_key: wire(hostRaw),
      },
    ],
  });
  await page.route("**/api/trust/endorsements?*", async (route) => {
    const registered = await page.evaluate(async (accountId) => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("spawn-browser-device-identity");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const value = await new Promise<{ publicKeyWire?: string } | undefined>((resolve) => {
        const store = database
          .transaction("device-identities", "readonly")
          .objectStore("device-identities");
        const getRequest = store.get(accountId);
        getRequest.onsuccess = () => resolve(getRequest.result);
        getRequest.onerror = () => resolve(undefined);
      });
      database.close();
      return value?.publicKeyWire ?? null;
    }, USER_ID);
    if (registered === null) {
      await route.fulfill({ status: 200, json: [] });
      return;
    }
    const endorsedRaw = Buffer.from(registered, "base64url");
    const signature = nodeSign(
      null,
      transcript(USER_ID, hostRaw, endorserRaw, endorsedRaw, BROWSER_DEVICE_ID),
      endorserPair.privateKey,
    );
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      json: [
        {
          host_id: HOST_ID,
          host_name: "dream",
          host_public_key: wire(hostRaw),
          endorser_device_id: "00000000-0000-4000-8000-000000000099",
          endorser_public_key: wire(endorserRaw),
          endorser_label: "Chrome on Mac",
          signature: signature.toString("base64url"),
        },
      ],
    });
  });

  await openSettings(page, "access", WORKSPACE_ID, `/hosts/${HOST_ID}`);
  // Introductions live under Advanced on the Access tab.
  await page.getByTestId("access-advanced").locator("summary").click();
  const panel = page.getByTestId("introduction-panel");
  await expect(panel).toBeVisible({ timeout: 20_000 });
  // The fingerprint shown is the ENDORSER's, derived locally from its key.
  await expect(panel).toContainText(fingerprintOf(endorserRaw));
  await expect(panel).toContainText("dream");

  await panel.getByRole("button", { name: "It matches — verify these hosts" }).click();
  await expect(panel.getByRole("status")).toContainText("Verified 1 host");

  // The host key really landed as a local pin.
  const pinned = await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("spawn-browser-host-pins");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const rows = await new Promise<unknown[]>((resolve) => {
      const store = database.transaction("host-pins", "readonly").objectStore("host-pins");
      const all = store.getAll();
      all.onsuccess = () => resolve(all.result as unknown[]);
      all.onerror = () => resolve([]);
    });
    database.close();
    return rows.length;
  });
  expect(pinned).toBeGreaterThan(0);
});

test("a server-substituted host key cannot be introduced", async ({ page }) => {
  const hostPair = generateKeyPairSync("ed25519");
  const attackerPair = generateKeyPairSync("ed25519");
  const endorserPair = generateKeyPairSync("ed25519");
  const hostRaw = rawPublicKey(hostPair.publicKey);
  const attackerRaw = rawPublicKey(attackerPair.publicKey);
  const endorserRaw = rawPublicKey(endorserPair.publicKey);

  await mockApp(page, {
    hosts: [
      {
        ...host,
        host_public_key: wire(attackerRaw),
      },
    ],
  });
  await page.route("**/api/trust/endorsements?*", async (route) => {
    const registered = await page.evaluate(async (accountId) => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("spawn-browser-device-identity");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const value = await new Promise<{ publicKeyWire?: string } | undefined>((resolve) => {
        const store = database
          .transaction("device-identities", "readonly")
          .objectStore("device-identities");
        const getRequest = store.get(accountId);
        getRequest.onsuccess = () => resolve(getRequest.result);
        getRequest.onerror = () => resolve(undefined);
      });
      database.close();
      return value?.publicKeyWire ?? null;
    }, USER_ID);
    if (registered === null) {
      await route.fulfill({ status: 200, json: [] });
      return;
    }
    // Signed for the REAL host key, then served with the attacker's swapped in.
    const signature = nodeSign(
      null,
      transcript(
        USER_ID,
        hostRaw,
        endorserRaw,
        Buffer.from(registered, "base64url"),
        BROWSER_DEVICE_ID,
      ),
      endorserPair.privateKey,
    );
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      json: [
        {
          host_id: HOST_ID,
          host_name: "dream",
          host_public_key: wire(attackerRaw),
          endorser_device_id: "00000000-0000-4000-8000-000000000099",
          endorser_public_key: wire(endorserRaw),
          endorser_label: "Chrome on Mac",
          signature: signature.toString("base64url"),
        },
      ],
    });
  });

  await openSettings(page, "access", WORKSPACE_ID, `/hosts/${HOST_ID}`);
  await page.getByTestId("access-advanced").locator("summary").click();
  await expect(page.getByTestId("browser-fingerprint")).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(2_000);
  // Nothing verifies, so the panel never offers the substituted key.
  await expect(page.getByTestId("introduction-panel")).toHaveCount(0);
});
