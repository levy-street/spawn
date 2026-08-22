import { createHash } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";

// Host possession's out-of-band key check (docs/TRUST_UX.md §4): the daemon
// appends its OWN public key to the approval URL as a `#k=` fragment, which
// travels terminal→browser without ever passing through the server. The page
// compares the server-claimed host key against that fragment invisibly:
//   - exact match  → a single Approve click (no number, no fingerprint);
//   - mismatch     → refusal — the substitution a hostile relay would need
//                    is caught before anything is pinned or approved;
//   - damaged      → refusal (never downgraded);
//   - no fragment  → the full-fingerprint compare fallback, never a weaker
//                    check and never a silent pin.

const USER_ID = "00000000-0000-4000-8000-000000000001";
const BROWSER_DEVICE_ID = "00000000-0000-4000-8000-000000000009";
const APPROVAL_NONCE = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
const HOST_PUBLIC_KEY = "PUAXw-hDiVqStwqnTRt-vJyYLM8uxJaMwM1V8Sr0Zgw";
// A different, equally valid ed25519 wire key — what a substituting server
// would claim while the daemon's link still carries HOST_PUBLIC_KEY.
const SUBSTITUTED_KEY = "11qYAYdk9Jt0uvL7Tp_5eQK8heP0LOEYVVt4dSK3M3A";
const APPROVAL_REF = "wL0aFhZ0S3nQ8yq2m4X1nAmBcDeFgHiJkLmNoPqRsTu";

function fingerprint(publicKey: string): string {
  const digest = createHash("sha256").update(Buffer.from(publicKey, "base64url")).digest();
  return `SHA256:${digest.subarray(0, 12).toString("base64url")}`;
}

async function readHostPins(page: Page): Promise<Array<Record<string, unknown>>> {
  return page.evaluate(async () => {
    const request = indexedDB.open("spawn-browser-host-pins", 1);
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      // On the refusal paths the app never touches the pin store, so this
      // bare open may have created an empty database: no store ⇒ no pins.
      if (!database.objectStoreNames.contains("host-pins")) return [];
      const transaction = database.transaction("host-pins", "readonly");
      const records = transaction.objectStore("host-pins").getAll();
      return await new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
        records.onsuccess = () => resolve(records.result);
        records.onerror = () => reject(records.error);
      });
    } finally {
      database.close();
    }
  });
}

interface FlowState {
  pendingCalls: number;
  pendingBodies: Array<Record<string, unknown>>;
  approveCalls: number;
  approveBody: Record<string, unknown> | null;
}

/** Auth + registration + a pending ceremony whose server-claimed host key is
 * `claimedKey` — pass a key different from the URL fragment to play the
 * substituting server. The claimed fingerprint is always self-consistent, so
 * only the fragment check can catch the substitution. */
async function installRoutes(page: Page, opts: { claimedKey: string }): Promise<FlowState> {
  const state: FlowState = {
    pendingCalls: 0,
    pendingBodies: [],
    approveCalls: 0,
    approveBody: null,
  };
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/me") {
      await route.fulfill({
        json: {
          user: { id: USER_ID, email: "owner@example.com", created_at: "2026-07-17T00:00:00Z" },
        },
      });
      return;
    }
    if (path === "/api/browser-devices/register") {
      const body = request.postDataJSON() as { public_key: string };
      await route.fulfill({
        json: {
          id: BROWSER_DEVICE_ID,
          key_algorithm: "ed25519",
          public_key: body.public_key,
          created_at: "2026-07-17T00:00:00Z",
          revoked_at: null,
        },
      });
      return;
    }
    if (path === "/api/auth/device/pending") {
      state.pendingCalls += 1;
      state.pendingBodies.push(request.postDataJSON() as Record<string, unknown>);
      await route.fulfill({
        json: {
          host_name: "fragment-host",
          approval_nonce: APPROVAL_NONCE,
          host_key_algorithm: "ed25519",
          host_public_key: opts.claimedKey,
          host_key_fingerprint: fingerprint(opts.claimedKey),
        },
      });
      return;
    }
    if (path === "/api/auth/device/approve") {
      state.approveCalls += 1;
      const body = request.postDataJSON() as Record<string, unknown>;
      state.approveBody = body;
      await route.fulfill({
        json: {
          host_name: "fragment-host",
          approval_nonce: APPROVAL_NONCE,
          host_key_algorithm: "ed25519",
          host_public_key: opts.claimedKey,
          browser_device_id: body.browser_device_id,
          browser_key_algorithm: body.browser_key_algorithm,
          browser_public_key: body.browser_public_key,
        },
      });
      return;
    }
    await route.fulfill({ status: 404, json: { detail: "not mocked" } });
  });
  return state;
}

test("a matching fragment key makes possession a single Approve click", async ({ page }) => {
  const state = await installRoutes(page, { claimedKey: HOST_PUBLIC_KEY });
  await page.goto(`/device?ref=${APPROVAL_REF}#k=${HOST_PUBLIC_KEY}`);

  // The invisible check passed: a plain authorization screen — no number to
  // type, no fingerprint to eyeball.
  await expect(page.getByTestId("possess-approve-screen")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("fragment-host", { exact: true })).toBeVisible();
  await expect(page.getByTestId("number-entry")).toHaveCount(0);
  await expect(page.getByTestId("host-key-fingerprint")).toHaveCount(0);
  expect(state.approveCalls).toBe(0);
  expect(state.pendingBodies[0]).toMatchObject({ approval_ref: APPROVAL_REF });

  await page.getByTestId("possess-approve").click();
  await expect(page.getByTestId("ceremony-done")).toContainText("fragment-host is possessed", {
    timeout: 15_000,
  });

  // The approval still binds the verified host key, the ceremony nonce, and
  // this browser's own identity, signed by the browser identity key.
  expect(state.approveBody).toMatchObject({
    approval_ref: APPROVAL_REF,
    approval_nonce: APPROVAL_NONCE,
    host_key_algorithm: "ed25519",
    host_public_key: HOST_PUBLIC_KEY,
    // Still sent in the signed approve REQUEST (cross-checked wire data the
    // daemon prints; mesh B5 removed only the redundant response copies).
    host_key_fingerprint: fingerprint(HOST_PUBLIC_KEY),
    browser_device_id: BROWSER_DEVICE_ID,
    browser_key_algorithm: "ed25519",
  });
  expect((state.approveBody as { signature: string }).signature).toHaveLength(86);
  expect(await readHostPins(page)).toMatchObject([
    { hostPublicKey: HOST_PUBLIC_KEY, state: "active" },
  ]);
});

test("a server-substituted host key is refused: nothing pinned, nothing approved", async ({
  page,
}) => {
  // The server claims SUBSTITUTED_KEY (with a self-consistent fingerprint —
  // only the out-of-band fragment can catch this), while the link the host's
  // terminal produced carries HOST_PUBLIC_KEY.
  const state = await installRoutes(page, { claimedKey: SUBSTITUTED_KEY });
  await page.goto(`/device?ref=${APPROVAL_REF}#k=${HOST_PUBLIC_KEY}`);

  const refusal = page.getByTestId("possess-refusal");
  await expect(refusal).toBeVisible({ timeout: 15_000 });
  await expect(refusal).toContainText("could not be verified");
  await expect(refusal).toContainText("different identity key");
  // No approval path is offered at all.
  await expect(page.getByTestId("possess-approve")).toHaveCount(0);
  await expect(page.getByTestId("host-key-fingerprint")).toHaveCount(0);
  await expect(page.getByTestId("number-entry")).toHaveCount(0);
  expect(state.approveCalls).toBe(0);
  expect(await readHostPins(page)).toEqual([]);
});

test("a damaged fragment is refused outright, never downgraded to a weaker check", async ({
  page,
}) => {
  const state = await installRoutes(page, { claimedKey: HOST_PUBLIC_KEY });
  await page.goto(`/device?ref=${APPROVAL_REF}#k=truncated`);

  const refusal = page.getByTestId("possess-refusal");
  await expect(refusal).toBeVisible({ timeout: 15_000 });
  await expect(refusal).toContainText("damaged or cut off");
  // Refused before the ceremony is even fetched — and no fallback offered.
  expect(state.pendingCalls).toBe(0);
  expect(state.approveCalls).toBe(0);
  await expect(page.getByTestId("host-key-fingerprint")).toHaveCount(0);
  expect(await readHostPins(page)).toEqual([]);
});

test("no fragment falls back to the full-fingerprint compare — never a silent pin", async ({
  page,
}) => {
  const state = await installRoutes(page, { claimedKey: HOST_PUBLIC_KEY });
  await page.goto(`/device?ref=${APPROVAL_REF}`);

  // An old daemon (or a retyped URL) has no fragment: the human compares the
  // full fingerprint against the one the terminal prints.
  await expect(page.getByTestId("host-key-fingerprint")).toHaveText(fingerprint(HOST_PUBLIC_KEY), {
    timeout: 15_000,
  });
  await expect(page.getByTestId("possess-approve")).toHaveCount(0);
  expect(state.approveCalls).toBe(0);

  await page.getByRole("button", { name: "They match" }).click();
  await expect(page.getByTestId("ceremony-done")).toContainText("fragment-host is possessed", {
    timeout: 15_000,
  });
  expect(state.approveBody).toMatchObject({ host_public_key: HOST_PUBLIC_KEY });
});
