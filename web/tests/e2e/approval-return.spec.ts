/**
 * A host approval link must survive creating an account.
 *
 * `spawnd possess` prints /device?ref=…#k=…. An unauthenticated visitor is
 * bounced to /login?next=…, and if they choose "Create one" from there the
 * destination has to travel with them — otherwise signup lands them on the
 * generic "connect your first host" step and the approval they came to finish
 * is silently abandoned, with the daemon still waiting in their terminal.
 *
 * The `#k=` fragment is deliberately absent from `next`; it rides in
 * sessionStorage (device-approval-stash) so the host key never touches a
 * redirect.
 */
import { expect, test } from "@playwright/test";

const APPROVAL = "/device?ref=dIF2cG14Xj3maek4";

test("login carries the approval destination on to signup", async ({ page }) => {
  await page.goto(`/login?next=${encodeURIComponent(APPROVAL)}`);
  const createOne = page.getByRole("link", { name: /create one/i });
  await expect(createOne).toBeVisible();
  const href = await createOne.getAttribute("href");
  expect(href).toContain("next=");
  expect(decodeURIComponent(href ?? "")).toContain(APPROVAL);
});

test("a cold visitor gets a plain signup link", async ({ page }) => {
  await page.goto("/login");
  const createOne = page.getByRole("link", { name: /create one/i });
  await expect(createOne).toHaveAttribute("href", "/signup");
});

test("an open redirect is refused rather than carried", async ({ page }) => {
  await page.goto("/login?next=%2F%2Fevil.test%2Fsteal");
  const createOne = page.getByRole("link", { name: /create one/i });
  await expect(createOne).toHaveAttribute("href", "/signup");
});
