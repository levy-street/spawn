import { expect, test } from "@playwright/test";
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
