import { expect, type Page, test } from "@playwright/test";

/**
 * `/pricing`, `/terms`, `/privacy` — the three public pages billing adds.
 *
 * These deliberately do not use `app-mocks`: the only server fact they care
 * about is the billing block of `GET /api/auth/config`, and the interesting
 * case is a config the app mocks do not describe (a self-hosted install with
 * billing off). Intercepting that one endpoint here keeps both cases in one
 * file and leaves the shared mocks alone.
 *
 * Note the e2e server proxies `/api/*` at a dead port, so the pages' own
 * server-side read of the config always fails and lands on the "could not be
 * asked" branch. That makes these specs a real test of the client-side
 * resolution: everything asserted below is decided by the intercepted
 * response, not by a value baked into the HTML.
 */

const TIERS = [
  { key: "free", name: "Free", price_cents: 0, host_limit: 1 },
  { key: "coven", name: "Coven", price_cents: 500, host_limit: 3 },
  { key: "legion", name: "the Legion plan", price_cents: 2000, host_limit: 20 },
  { key: "pandemonium", name: "Pandemonium", price_cents: 5000, host_limit: null },
];

async function mockBilling(page: Page, enabled: boolean) {
  await page.route("**/api/auth/config", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      json: {
        providers: [],
        email_verification_required: false,
        invite_only: false,
        billing: {
          enabled,
          free_host_limit: 1,
          mobile_upgrade_link: false,
          tiers: enabled ? TIERS : [],
        },
      },
    });
  });
}

/** Go somewhere, and do not return until the page has read the billing config. */
async function visit(page: Page, path: string) {
  const config = page.waitForResponse("**/api/auth/config");
  await page.goto(path);
  await config;
}

const masthead = (page: Page) => page.locator("header").first();
const colophon = (page: Page) => page.locator("footer");

/**
 * The page's own words, untransformed. `innerText` would hand back what CSS
 * renders — every poster heading here is `uppercase` — and the point of these
 * checks is the exact casing of two names.
 */
async function pageWords(page: Page): Promise<string> {
  return page.evaluate(() => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const parts: string[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const tag = node.parentElement?.tagName;
      if (tag === "SCRIPT" || tag === "STYLE" || tag === "TEMPLATE") continue;
      parts.push(node.nodeValue ?? "");
    }
    return parts.join(" ");
  });
}

test("the pricing page prints four tiers, and the Legion tier is never bare", async ({ page }) => {
  await mockBilling(page, true);
  await visit(page, "/pricing");

  const grid = page.getByTestId("pricing-tiers");
  await expect(grid).toBeVisible();

  const free = page.getByTestId("pricing-tier-free");
  await expect(free).toContainText("Free");
  await expect(free).toContainText("$0");
  await expect(free).toContainText("1 host");

  const coven = page.getByTestId("pricing-tier-coven");
  await expect(coven).toContainText("Coven");
  await expect(coven).toContainText("$5");
  await expect(coven).toContainText("3 hosts");
  // The recommended column, marked with an eyebrow rather than a red button.
  await expect(coven).toContainText("Recommended");

  const legion = page.getByTestId("pricing-tier-legion");
  await expect(legion).toContainText("the Legion plan");
  await expect(legion).toContainText("$20");
  await expect(legion).toContainText("20 hosts");

  const pandemonium = page.getByTestId("pricing-tier-pandemonium");
  await expect(pandemonium).toContainText("Pandemonium");
  await expect(pandemonium).toContainText("$50");
  await expect(pandemonium).toContainText("Unlimited hosts");

  // The plan is "the Legion plan" everywhere or it is a bug; `/legion` is the
  // fleet page and bare "Legion" in a billing sentence reads as that page.
  const words = await pageWords(page);
  expect(words.replace(/the Legion plan/gu, "")).not.toMatch(/Legion/u);
});

test("the pricing page states the rules a price has to state", async ({ page }) => {
  await mockBilling(page, true);
  await visit(page, "/pricing");

  await expect(page.getByText("A host is a registration, not a machine.")).toBeVisible();
  await expect(page.getByText("spawnd possess --new-account")).toBeVisible();
  await expect(page.getByText(/renew automatically until you cancel/u)).toBeVisible();
  await expect(page.getByText(/Settings → Subscription/u).first()).toBeVisible();
  await expect(page.getByText(/Where tax applies, the amount is shown at checkout/u)).toBeVisible();
  await expect(page.getByText(/Host it yourself\. Free, unlimited, forever\./u)).toBeVisible();
  await expect(page.getByRole("link", { name: "Install the daemon" }).first()).toHaveAttribute(
    "href",
    "/download",
  );
  // Consumer Rights Directive Art 11a: the label is fixed by law, and the
  // route to it has to be on the page where the contract is entered.
  await expect(page.getByRole("link", { name: "Withdraw from contract" })).toHaveAttribute(
    "href",
    "/terms#withdrawal",
  );
});

test("the legal pages render and the colophon reaches them", async ({ page }) => {
  await mockBilling(page, true);
  await visit(page, "/pricing");

  await colophon(page).getByRole("link", { name: "Terms" }).click();
  await expect(page).toHaveURL(/\/terms$/u);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("in plain words");
  await expect(page.getByRole("heading", { name: /Right of withdrawal/u })).toBeVisible();
  await expect(page.getByText(/Model withdrawal form/u)).toBeVisible();

  await colophon(page).getByRole("link", { name: "Privacy" }).click();
  await expect(page).toHaveURL(/\/privacy$/u);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Not the flattering half");
  // Google requires a deletion route reachable without installing the app.
  await expect(
    page.getByRole("heading", { name: /Requesting deletion without the app/u }),
  ).toBeVisible();
  await expect(page.getByText("Request account deletion")).toBeVisible();
  await expect(page.getByText("POST /api/auth/account/delete")).toBeVisible();
});

test("every product mention on the new pages is SPAWN D", async ({ page }) => {
  await mockBilling(page, true);
  for (const path of ["/pricing", "/terms", "/privacy"]) {
    await visit(page, path);
    const words = await pageWords(page);
    expect(words).toContain("SPAWN D");
    // Bare lower-case "spawn" as the product name is a bug. `spawnd`,
    // `spawnd.dev` and `spawn_session` name technical things and are fine, so
    // the match stops at a word character.
    expect(words).not.toMatch(/(?<![A-Za-z])[Ss]pawn(?![A-Za-z0-9_])/u);
  }
});

test("a self-hosted server shows no shop and no pricing link anywhere", async ({ page }) => {
  // Six routes, and a dev server compiles each of them the first time it is
  // asked. The assertions are cheap; the navigations are not.
  test.slow();
  await mockBilling(page, false);
  await visit(page, "/pricing");

  // The honest panel, not an empty grid and not an error.
  await expect(page.getByTestId("pricing-self-hosted")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("is for sale");
  await expect(page.getByTestId("pricing-tiers")).toHaveCount(0);
  await expect(page.getByTestId("pricing-tier-coven")).toHaveCount(0);
  const words = await pageWords(page);
  expect(words).not.toMatch(/\$\d/u);
  expect(words).not.toContain("Coven");
  expect(words).not.toContain("Pandemonium");

  // §9.2: not one route offers the shop that does not exist here.
  for (const path of ["/", "/pricing", "/terms", "/privacy", "/security", "/download"]) {
    await visit(page, path);
    await expect(masthead(page).getByRole("link", { name: "Pricing" })).toHaveCount(0);
    await expect(colophon(page).getByRole("link", { name: "Pricing" })).toHaveCount(0);
  }
});

test("the masthead offers pricing exactly when the server sells something", async ({ page }) => {
  await mockBilling(page, true);
  await visit(page, "/pricing");
  await expect(masthead(page).getByRole("link", { name: "Pricing" })).toBeVisible();
  await expect(colophon(page).getByRole("link", { name: "Pricing" })).toBeVisible();
  // The legal pages are not billing-conditional; they exist on every deployment.
  await expect(colophon(page).getByRole("link", { name: "Terms" })).toBeVisible();
  await expect(colophon(page).getByRole("link", { name: "Privacy" })).toBeVisible();
});
