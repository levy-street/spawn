import { expect, type Page, test } from "@playwright/test";
import { host, mockApp, user } from "./app-mocks";

test("a fresh signup starts at account and advances to the first unsatisfied gate", async ({
  page,
}) => {
  await mockApp(page, { me: null, hosts: [], workspaces: [] });
  await page.goto("/onboarding");
  await expect(page.getByRole("heading", { name: "Create your account" })).toBeVisible();
  await page.getByLabel("Email").fill("new@example.com");
  await page.getByLabel("Password").fill("long-enough-password");
  await page.getByRole("button", { name: "Create account and continue" }).click();
  await expect(page.getByRole("heading", { name: "Connect your first host" })).toBeVisible();
});

test("verification polls /api/me and advances when the address becomes verified", async ({
  page,
}) => {
  await page.clock.install();
  await mockApp(page, {
    config: { email_verification_required: true },
    meSequence: [
      { ...user, email_verified_at: null },
      { ...user, email_verified_at: "2026-08-19T01:00:00Z" },
    ],
    hosts: [],
    workspaces: [],
  });
  await page.goto("/onboarding");
  await expect(page.getByRole("heading", { name: "Check your inbox" })).toBeVisible();
  await page.clock.fastForward(5_100);
  await expect(page.getByRole("status")).toContainText("Email verified");
  await page.clock.fastForward(1_000);
  await expect(page.getByRole("heading", { name: "Connect your first host" })).toBeVisible();
});

test("a step deep link cannot skip an unsatisfied verification gate", async ({ page }) => {
  await mockApp(page, {
    config: { email_verification_required: true },
    me: { ...user, email_verified_at: null },
    hosts: [],
    workspaces: [],
  });
  await page.goto("/onboarding?step=done");
  await expect(page.getByRole("heading", { name: "Check your inbox" })).toBeVisible();
  await expect(page.getByRole("list", { name: "Onboarding progress" })).toContainText("Verify");
});

test("the host gate notices a newly online host and moves on", async ({ page }) => {
  await page.clock.install();
  const store = await mockApp(page, { hosts: [], workspaces: [] });
  await page.goto("/onboarding");
  await expect(page.getByRole("heading", { name: "Connect your first host" })).toBeVisible();
  store.hosts.push({ ...host });
  await page.clock.fastForward(3_100);
  await expect(page.getByRole("status")).toContainText("host is online");
  await page.clock.fastForward(2_000);
  // Onboarding hands over rather than building: no workspace is created here,
  // and /app decides where this account's work is.
  await expect(page).toHaveURL("/app");
  expect(store.requests.workspaces).toHaveLength(0);
});

test("done creates nothing and hands the reader to the first-workspace state", async ({ page }) => {
  // The first workspace is a deliberate act — a folder someone picks. Opening
  // a shell in the home directory on their behalf made the first thing anyone
  // saw of the product a terminal they had not chosen, and disagreed with what
  // /app does for every other arrival.
  const store = await mockApp(page, { hosts: [host], workspaces: [] });
  await page.goto("/onboarding");
  await expect(page).toHaveURL("/app");
  await expect(page.getByRole("heading", { name: "Create your first workspace" })).toBeVisible();
  expect(store.requests.workspaces).toHaveLength(0);
  expect(store.sessions).toHaveLength(0);
});

test("returning after login derives the host step instead of restarting", async ({ page }) => {
  await mockApp(page, { me: user, hosts: [], workspaces: [] });
  await page.goto("/onboarding?step=account");
  await expect(page.getByRole("heading", { name: "Connect your first host" })).toBeVisible();
  await expect(page.getByLabel("Email")).toHaveCount(0);
});

// The terminal-first arrival: `spawnd possess` prints an approval link and the
// person following it has no account yet. Login stashes the link's `#k=`
// fragment, signup lands on onboarding, and onboarding claims the stash and
// finishes the approval in place. What follows the approve click is the part
// that used to break: the ceremony's own "possessed" card kept the whole
// screen, and its Done — the only control left on it — swapped the answer for
// an empty pairing form and instructions to run `spawnd possess`, while the
// machine was still connecting and nothing said so.
const APPROVAL_REF = "wL0aFhZ0S3nQ8yq2m4X1nAmBcDeFgHiJkLmNoPqRsTu";
const HOST_PUBLIC_KEY = "PUAXw-hDiVqStwqnTRt-vJyYLM8uxJaMwM1V8Sr0Zgw";

/** Follow a machine's approval link with no account, and end up on the host
 * step with that ceremony loaded and waiting to be approved. */
async function arriveByApprovalLink(page: Page) {
  await page.goto(`/device?ref=${APPROVAL_REF}#k=${HOST_PUBLIC_KEY}`);
  await expect(page).toHaveURL(/\/login\?next=.*device/);
  const createOne = page.getByRole("link", { name: "Create one" });
  await expect(createOne).toBeVisible();
  // Loaded rather than clicked, so the form is hydrated before it is typed
  // into. approval-return.spec.ts is what pins the href itself.
  await page.goto((await createOne.getAttribute("href")) as string);
  await page.getByLabel("Email").fill("new@example.com");
  await page.getByLabel("Password").fill("long-enough-password");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByTestId("possess-approve-screen")).toBeVisible({ timeout: 15_000 });
}

test("an approval link followed through signup finishes onboarding", async ({ page }) => {
  const store = await mockApp(page, { me: null, hosts: [], workspaces: [] });
  await arriveByApprovalLink(page);
  // The ceremony is already waiting, so there is nothing to install and no
  // code to type.
  await expect(page.getByLabel("Code from the terminal")).toHaveCount(0);
  await page.getByTestId("possess-approve").click();

  // The approval hands the screen to the wait, rather than leaving a spent
  // ceremony — and a Done that empties it — as the only thing on the page.
  await expect(page.locator('[data-step="3"]')).toHaveAttribute("data-state", "complete", {
    timeout: 10_000,
  });
  await expect(page.getByLabel("Code from the terminal")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Done" })).toHaveCount(0);

  // The daemon notices the approval and calls home.
  store.hosts.push({ ...host, status: "online", session_count: 0 });
  // Online is painted here before the page around it is told, exactly as on the
  // setup-claim path.
  await expect(page.locator('[data-step="4"]')).toHaveAttribute("data-state", "complete", {
    timeout: 10_000,
  });
  await expect(page.getByRole("status")).toContainText("host is online", { timeout: 10_000 });
  await expect(page).toHaveURL("/app", { timeout: 10_000 });
});

test("a reloaded approval link finishes the ceremony it still carries", async ({ page }) => {
  // The stash is spent the first time onboarding reads it, so anything that
  // mounts this page again — a reload, the URL opened a second time — has only
  // `?ref=` to go on. Treating that as "arrived cold" put the install command
  // and a pairing-code field in front of someone whose machine was already
  // asking to be let in.
  await mockApp(page, { me: null, hosts: [], workspaces: [] });
  await arriveByApprovalLink(page);

  await page.reload();
  await expect(page.getByTestId("possess-approve-screen")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: "Copy install command" })).toHaveCount(0);
  await expect(page.getByLabel("Code from the terminal")).toHaveCount(0);
});
