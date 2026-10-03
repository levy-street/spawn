import { expect, test } from "@playwright/test";
import {
  agent,
  host,
  mockApp,
  openSettings,
  USER_ID,
  user,
  WORKSPACE_ID,
  windowsHost,
} from "./app-mocks";

test("all seven settings tabs open", async ({ page }) => {
  await mockApp(page);
  await openSettings(page);
  // "Browser devices" and "Device trust" were two tabs before the mesh; both
  // now live on the single Access tab (docs/TRUST_UX.md).
  const cases = [
    ["Account", "Account"],
    ["Appearance", "Appearance"],
    ["Notifications", "Notifications"],
    ["Agents", "Agents"],
    ["Skills", "Skills"],
    ["Templates", "Workspace templates"],
    ["Access", "Access"],
  ] as const;
  for (const [tab, heading] of cases) {
    await page.getByRole("button", { name: tab, exact: true }).click();
    await expect(page.getByRole("heading", { name: heading, exact: true }).last()).toBeVisible();
  }
});

test("switching tabs changes the panel without navigating", async ({ page }) => {
  // The dialog is a module singleton, not URL state: opening and switching
  // tabs must never push a history entry.
  await mockApp(page);
  await openSettings(page, "access");
  const url = page.url();
  await expect(page.getByRole("heading", { name: "Access", exact: true }).last()).toBeVisible();

  await page.getByRole("button", { name: "Account", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Account", exact: true }).last()).toBeVisible();
  expect(page.url()).toBe(url);

  await page.getByRole("button", { name: "Access", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Access", exact: true }).last()).toBeVisible();
  expect(page.url()).toBe(url);
});

test("Settings has no Hosts tab: hosts have a page of their own", async ({ page }) => {
  await mockApp(page, { hosts: [host] });
  await openSettings(page);
  await expect(page.getByRole("button", { name: "Hosts", exact: true })).toHaveCount(0);
});

test("the connect flow lives on its own page, reached from Hosts", async ({ page }) => {
  await mockApp(page, { hosts: [host] });
  await page.goto("/device");
  await expect(page.getByRole("heading", { name: "Connect a host" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy install command" })).toBeVisible();
  await expect(page.getByText("After installation, run")).toBeVisible();
  // The link the terminal prints is the one way in; there is no code to type.
  await expect(page.getByLabel("Code from the terminal")).toHaveCount(0);
});

test("the Hosts page's possess flow waits after copying the plain command", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window.navigator, "platform", { get: () => "Linux x86_64" });
  });
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await mockApp(page, { hosts: [host] });
  await page.goto("/hosts");
  await page.getByRole("button", { name: "Possess a host", exact: true }).first().click();

  const dialog = page.getByRole("dialog", { name: "Possess a host" });
  await expect(dialog).toContainText(
    "Install SPAWN D on the computer, run spawnd possess there, and keep this window open until it comes online.",
  );
  await expect(dialog.getByText(/curl -fsSL .*install\.sh \| sh$/)).toBeVisible();
  await expect(dialog.getByText("After installation, run")).toContainText("spawnd possess");
  await dialog.getByRole("button", { name: "Copy install command" }).click();
  await expect(dialog.getByText("Waiting for your machine…")).toBeVisible();
});

test("Windows defaults the shared device and Hosts gates to the WSL wrapper", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window.navigator, "platform", { get: () => "Win32" });
  });
  await mockApp(page, { hosts: [host] });

  await page.goto("/device");
  const expected = `wsl -- bash -c "curl -fsSL ${new URL(page.url()).origin}/install.sh | sh"`;
  await expect(page.getByRole("tab", { name: "Windows (WSL)" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.locator("code").filter({ hasText: "wsl -- bash" }).first()).toContainText(
    expected,
  );

  await page.goto("/hosts");
  await page.getByRole("button", { name: "Possess a host", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "Possess a host" });
  await expect(dialog.getByRole("tab", { name: "Windows (WSL)" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(dialog.locator("code").filter({ hasText: "wsl -- bash" })).toContainText(expected);
});

test("Windows defaults the shared gate to native after release proof is complete", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window.navigator, "platform", { get: () => "Win32" });
  });
  await mockApp(page, {
    hosts: [host],
    releaseDaemonTargets: ["windows-x86_64"],
    releaseDesktop: {
      version: "0.2.0",
      tree: "a".repeat(40),
      platforms: ["darwin-aarch64", "darwin-x86_64", "windows-x86_64"],
    },
  });

  await page.goto("/device");
  const expected = `irm ${new URL(page.url()).origin}/install.ps1 | iex`;
  await expect(page.getByRole("tab", { name: "Windows", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.locator("code").filter({ hasText: "install.ps1" }).first()).toContainText(
    expected,
  );
  // WSL is the fallback, not a second Windows: with a native daemon published
  // the PC is offered one route, not two.
  await expect(page.getByRole("tab", { name: "Windows (WSL)" })).toHaveCount(0);
});

test("the Hosts page formats a Windows x64 host without changing its generic fleet row", async ({
  page,
}) => {
  await mockApp(page, { hosts: [windowsHost] });
  await page.goto("/hosts");
  await expect(page.getByText("Windows · x64", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Windows PC", exact: true })).toBeVisible();
});

test("/legion is the Hosts page's old address and lands on it", async ({ page }) => {
  await mockApp(page, { hosts: [{ ...host, cpu_cores: 8 }] });
  await page.goto("/legion");
  await expect(page).toHaveURL(/\/hosts$/u);
  await expect(page.getByRole("heading", { name: "Hosts", exact: true })).toBeVisible();
  // Operational surfaces say plain "cores"; "possessed" belongs to the profile.
  // The host has cores, so the totals draw the figure and its label.
  const totals = page.getByRole("region", { name: "Totals across your hosts" });
  await expect(totals.getByText("cores", { exact: true })).toBeVisible();
  await expect(page.getByText("cores possessed")).toHaveCount(0);
  // Exact figures follow the cards on screen; there is no switch to find.
  await expect(page.getByRole("button", { name: /^(?:Go live|Live)$/u })).toHaveCount(0);
});

test("a host list that fails to load is not an empty account, and Retry fetches it again", async ({
  page,
}) => {
  await mockApp(page, { hosts: [{ ...host, cpu_cores: 8 }] });
  let failing = true;
  await page.route("**/api/hosts", async (route) => {
    if (failing && route.request().method() === "GET") {
      await route.fulfill({ status: 503, json: { detail: "hosts are down" } });
      return;
    }
    await route.fallback();
  });
  await page.goto("/hosts");

  // The phone's Hosts tab says the same: what failed, and a way to try again.
  await expect(page.getByRole("heading", { name: "Hosts unavailable", exact: true })).toBeVisible();
  await expect(page.getByText(/^Failed to load hosts: /u)).toBeVisible();
  await expect(page.getByText("No hosts yet.", { exact: true })).toHaveCount(0);
  const totals = page.getByRole("region", { name: "Totals across your hosts" });
  await expect(totals).toHaveCount(0);

  failing = false;
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(totals.getByText("cores", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Hosts unavailable", exact: true })).toHaveCount(
    0,
  );
});

test("the sidebar's Hosts label opens the Hosts page while its count toggles the list", async ({
  page,
}) => {
  await mockApp(page, { hosts: [host] });
  await page.goto(`/w/${WORKSPACE_ID}`);
  // The toggle's name carries the count it draws: one host here.
  const toggle = page.getByRole("button", { name: /^(?:Show|Hide) the host list \(1\)$/u }).first();
  await expect(toggle).toBeVisible();
  const expanded = await toggle.getAttribute("aria-expanded");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", expanded === "true" ? "false" : "true");
  expect(page.url()).toContain(`/w/${WORKSPACE_ID}`);

  await page.getByRole("link", { name: "Hosts", exact: true }).first().click();
  await expect(page).toHaveURL(/\/hosts$/u);
  await expect(page.getByRole("heading", { name: "Hosts", exact: true })).toBeVisible();
});

test("Agents keeps built-ins read-only and round-trips a custom definition", async ({ page }) => {
  const store = await mockApp(page, {
    agents: [
      agent(),
      agent({
        id: "00000000-0000-4000-8000-00000000000e",
        owner_user_id: USER_ID,
        name: "Review bot",
        kind: "custom",
        command: "review",
        env: {},
        install: null,
      }),
    ],
  });
  await openSettings(page, "agents");
  await expect(page.getByText("read only", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Codex actions" })).toHaveCount(0);

  await page.getByRole("button", { name: "Add agent" }).click();
  const add = page.getByRole("dialog", { name: "Add an agent" });
  await add.getByLabel("Name").fill("Deploy bot");
  await add.getByLabel("Kind").fill("custom");
  await add.getByLabel("Command", { exact: true }).fill("deploy --watch");
  await add.getByLabel("Install command (optional)").fill("npm i -g deploy");
  await add.getByRole("button", { name: "Add variable" }).click();
  await add.getByLabel("Environment variable name").fill("REGION");
  await add.getByLabel("Environment variable value").fill("nz");
  await add.getByRole("button", { name: "Add agent" }).click();
  await expect.poll(() => store.agents.some((item) => item.name === "Deploy bot")).toBe(true);
  await expect(page.getByText("Deploy bot", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Deploy bot actions" }).click();
  await page.getByRole("menuitem", { name: "Edit" }).click();
  const edit = page.getByRole("dialog", { name: "Edit Deploy bot" });
  await edit.getByLabel("Command", { exact: true }).fill("deploy --safe");
  await edit.getByRole("button", { name: "Save changes" }).click();
  await expect
    .poll(() => store.agents.find((item) => item.name === "Deploy bot")?.command)
    .toBe("deploy --safe");

  await page.getByRole("button", { name: "Deploy bot actions" }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page
    .getByRole("dialog", { name: "Delete Deploy bot?" })
    .getByRole("button", { name: "Delete agent" })
    .click();
  await expect.poll(() => store.agents.some((item) => item.name === "Deploy bot")).toBe(false);
});

test("Agents offers a yolo toggle on a built-in and withholds it without a flag", async ({
  page,
}) => {
  const store = await mockApp(page, {
    agents: [
      agent(),
      agent({
        id: "00000000-0000-4000-8000-00000000000f",
        owner_user_id: USER_ID,
        name: "Review bot",
        kind: "custom",
        command: "review",
        env: {},
        install: null,
        yolo_args: null,
        yolo_env: {},
      }),
    ],
  });
  await openSettings(page, "agents");

  // Built-ins are read-only definitions, but the yolo choice is the account's
  // own — so the switch is live on one anyway.
  const codex = page.getByRole("switch", { name: "Yolo mode for Codex" });
  await expect(codex).toHaveAttribute("aria-checked", "false");
  await codex.click();
  await expect.poll(() => store.agents.find((item) => item.name === "Codex")?.yolo).toBe(true);
  await expect(codex).toHaveAttribute("aria-checked", "true");
  await expect(page.getByText("--dangerously-bypass-approvals-and-sandbox")).toBeVisible();

  // Nothing to spell it with, so nothing to poke at.
  await expect(page.getByRole("switch", { name: "Yolo mode for Review bot" })).toBeDisabled();
});

test("Admin row is hidden for ordinary users", async ({ page }) => {
  await mockApp(page, { me: user });
  await openSettings(page);
  await expect(page.getByRole("link", { name: "Admin" })).toHaveCount(0);
});

test("Admin row is shown for administrators", async ({ page }) => {
  await mockApp(page, { me: { ...user, is_admin: true } });
  await openSettings(page);
  await expect(page.getByRole("link", { name: "Admin" })).toBeVisible();
});
