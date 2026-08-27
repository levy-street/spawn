import { expect, test } from "@playwright/test";
import { mockApp } from "./app-mocks";

const APPROVAL_REF = "approval-ref-phase-c";
const HOST_PUBLIC_KEY = "PUAXw-hDiVqStwqnTRt-vJyYLM8uxJaMwM1V8Sr0Zgw";

test("expired approval links use the catalogue instead of the raw server string", async ({
  page,
}) => {
  await mockApp(page, {
    devicePendingError: { status: 400, detail: "user code is expired" },
  });
  await page.goto("/device?code=QZ4K-7HMT");
  const failure = page.getByTestId("pairing-failure");
  await expect(failure).toContainText(
    "That approval expired. On the machine, run spawnd possess again.",
  );
  await expect(failure).not.toContainText("user code is expired");
});

test("AuthGate and password login restore the tab-scoped approval fragment", async ({ page }) => {
  const store = await mockApp(page, { me: null, workspaces: [] });
  await page.goto(`/device?ref=${APPROVAL_REF}#k=${HOST_PUBLIC_KEY}`);
  await expect(page).toHaveURL(/\/login\?next=.*device/);

  await page.getByLabel("Email").fill("owner@example.com");
  await page.getByLabel("Password").fill("long-enough-password");
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page).toHaveURL(`/device?ref=${APPROVAL_REF}#k=${HOST_PUBLIC_KEY}`);
  await expect(page.getByTestId("possess-approve-screen")).toBeVisible({ timeout: 15_000 });
  expect(store.requests.auth).toContainEqual({
    path: "/api/auth/device/pending",
    approval_ref: APPROVAL_REF,
  });
  await expect
    .poll(() => page.evaluate(() => sessionStorage.getItem("spawn:device-approval")))
    .toBeNull();
});

test("OAuth receives the validated device path and query, never its fragment", async ({ page }) => {
  await mockApp(page, {
    me: null,
    config: { providers: [{ id: "google", name: "Google" }] },
  });
  const next = encodeURIComponent(`/device?ref=${APPROVAL_REF}#k=${HOST_PUBLIC_KEY}`);
  await page.goto(`/login?next=${next}`);
  const oauth = page.getByRole("link", { name: "Continue with Google" });
  await expect(oauth).toHaveAttribute(
    "href",
    `/api/auth/oauth/google/start?return_to=${encodeURIComponent(`/device?ref=${APPROVAL_REF}`)}`,
  );
  await expect(oauth).not.toHaveAttribute("href", /%23k%3D/);
});

test("key_conflict on /device shows the exact three-option catalogue", async ({ page }) => {
  await mockApp(page, {
    devicePendingError: { status: 409, code: "key_conflict", message: "key_conflict" },
  });
  await page.goto("/device?ref=conflicted");
  const failure = page.getByTestId("pairing-failure");
  await expect(failure).toContainText(
    "This machine was set up before, under a different SPAWN D account, and that account still holds its identity. Nothing was changed.",
  );
  await expect(failure).toContainText(
    "To hand it to this account: remove the host from the old account's Hosts page first, then run spawnd possess again.",
  );
  await expect(failure).toContainText(
    "To keep both accounts on this machine: spawnd possess --new-account",
  );
});
