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
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  const store = await mockApp(page, { hosts: [], workspaces: [] });
  await page.goto("/onboarding");
  await expect(page.getByRole("heading", { name: "Connect your first host" })).toBeVisible();
  const command = page.getByText(/curl -fsSL .*install\.sh \| sh$/);
  await expect(command).toBeVisible();
  await expect(page.getByText("After installation, run")).toContainText("spawnd possess");
  await expect(page.getByText("Already running SPAWN D for another account")).toContainText(
    "--new-account",
  );

  await page.getByRole("button", { name: "Copy install command" }).click();
  const progress = page.getByTestId("setup-progress");
  await expect(progress).toBeVisible();
  await expect(progress.locator('[data-step="1"]')).toHaveAttribute("data-state", "complete");
  await expect(progress.locator('[data-step="2"]')).toHaveAttribute("data-state", "current");
  // Waiting for the approval waits on the person — they have the command and
  // have still to run it. A spinner there claimed the browser was working.
  await expect(progress.locator('[data-step="2"] .animate-spin')).toHaveCount(0);

  store.hosts.push({ ...host });
  await page.clock.fastForward(3_100);
  await expect(progress.locator('[data-step="2"]')).toHaveAttribute("data-state", "complete");
  await expect(progress.locator('[data-step="3"]')).toHaveAttribute("data-state", "complete");
  await page.clock.fastForward(400);
  await expect(page.getByRole("status")).toContainText("host is online");
  await page.clock.fastForward(2_000);
  // Onboarding hands over rather than building: no workspace is created here,
  // and /app decides where this account's work is.
  await expect(page).toHaveURL("/app");
  expect(store.requests.workspaces).toHaveLength(0);
});

test("the host wait keeps its 30 and 60 second recovery hints", async ({ page }) => {
  await page.clock.install();
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await mockApp(page, { hosts: [], workspaces: [] });
  await page.goto("/onboarding");
  await page.getByRole("button", { name: "Copy install command" }).click();

  await page.clock.fastForward(30_100);
  await expect(page.getByText("Still waiting…")).toBeVisible();
  await page.clock.fastForward(30_100);
  await expect(page.getByTestId("setup-stalled-hint")).toHaveText(
    "Having trouble? Re-run the install command — it's safe to repeat.",
  );
  await expect(page.getByText(/spawnd doctor/)).toBeVisible();
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
// fragment and signup carries them back to the ceremony, which finishes in
// place. None of this had end-to-end coverage before; these walk it.
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

test("the onboarding host step finishes an approval its URL still carries", async ({ page }) => {
  // The state the terminal-first path actually lands in: signed in, no host
  // yet, and a machine's approval handle on the onboarding URL — either put
  // back there from the sessionStorage stash, or still on it after a reload.
  //
  // The stash is spent the first time it is read, so anything that renders this
  // page a second time has only `?ref=` to go on. Reading only the stash meant
  // that second render decided nobody had arrived by link, and put the install
  // command and an empty pairing field in front of someone whose machine was
  // already asking to be let in.
  const store = await mockApp(page, { me: user, hosts: [], workspaces: [] });
  await page.goto(`/onboarding?ref=${APPROVAL_REF}#k=${HOST_PUBLIC_KEY}`);

  await expect(page.getByTestId("possess-approve-screen")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: "Copy install command" })).toHaveCount(0);
  await expect(page.getByLabel("Code from the terminal")).toHaveCount(0);

  await page.getByTestId("possess-approve").click();
  await expect(page.locator('[data-step="2"]')).toHaveAttribute("data-state", "complete", {
    timeout: 10_000,
  });
  // The command was copied in a terminal, before this account existed. The row
  // for it can never tick here, and listing it unchecked above two checked ones
  // reads as a step the reader skipped.
  await expect(page.getByTestId("setup-progress")).not.toContainText("Command copied");
  await expect(page.locator('[data-step="1"]')).toHaveCount(0);

  // The approval hands the screen to the wait rather than leaving a spent
  // ceremony — whose Done resets it — as the only thing on the page.
  await expect(page.getByRole("button", { name: "Done" })).toHaveCount(0);
  await expect(page.getByLabel("Code from the terminal")).toHaveCount(0);

  // The daemon notices the approval and calls home. This surface has to see it
  // even though it mounted after the ceremony began — the reading that ignores
  // hosts already online is there to stop it completing someone else's
  // approval, and on this gate there is no one else's to complete.
  store.hosts.push({ ...host, status: "online", session_count: 0 });
  await expect(page.locator('[data-step="3"]')).toHaveAttribute("data-state", "complete", {
    timeout: 10_000,
  });
  await expect(page).toHaveURL("/app", { timeout: 10_000 });
});

test("an approval link followed through signup finishes inside onboarding", async ({ page }) => {
  // A brand-new account has not finished setting up, so its machine's approval
  // belongs to the flow it is already in. Finishing it on /device meant the
  // ceremony ran inside the app chrome of a product this person had not set up
  // yet, ending on a "Continue setup" button back out to onboarding.
  const store = await mockApp(page, { me: null, hosts: [], workspaces: [] });
  await arriveByApprovalLink(page);
  await expect(page).toHaveURL(/\/onboarding/);
  // The ceremony is already waiting, so there is nothing to install and no
  // code to type.
  await expect(page.getByLabel("Code from the terminal")).toHaveCount(0);
  await page.getByTestId("possess-approve").click();

  // No spent ceremony left owning the screen, and no Done that would empty it:
  // the approval hands over to the wait for the machine.
  await expect(page.locator('[data-step="2"]')).toHaveAttribute("data-state", "complete", {
    timeout: 10_000,
  });
  await expect(page.getByRole("button", { name: "Done" })).toHaveCount(0);

  store.hosts.push({ ...host, status: "online", session_count: 0 });
  await expect(page).toHaveURL("/app", { timeout: 15_000 });
});

test("a reloaded approval link keeps the ceremony it still carries", async ({ page }) => {
  // The stash is spent the first time it is read, so anything that mounts the
  // page again — a reload, the URL opened a second time — has only `?ref=` to
  // go on. Reading the URL rather than the stash is what keeps a second render
  // from deciding nobody arrived by link.
  await mockApp(page, { me: null, hosts: [], workspaces: [] });
  await arriveByApprovalLink(page);

  await page.reload();
  await expect(page.getByTestId("possess-approve-screen")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: "Copy install command" })).toHaveCount(0);
  await expect(page.getByLabel("Code from the terminal")).toHaveCount(0);
});
