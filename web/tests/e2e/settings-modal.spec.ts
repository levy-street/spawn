import { expect, test } from "@playwright/test";
import { agent, host, mockApp, openSettings, USER_ID, user } from "./app-mocks";

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

test("Settings has no Hosts tab: machines live on the legion", async ({ page }) => {
  await mockApp(page, { hosts: [host] });
  await openSettings(page);
  await expect(page.getByRole("button", { name: "Hosts", exact: true })).toHaveCount(0);
});

test("the connect flow lives on its own page, reached from the legion", async ({ page }) => {
  await mockApp(page, { hosts: [host] });
  await page.goto("/device");
  await expect(page.getByRole("heading", { name: "Connect a host" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy install command" })).toBeVisible();
  await expect(page.getByText("After installation, run")).toBeVisible();
  // The link the terminal prints is the one way in; there is no code to type.
  await expect(page.getByLabel("Code from the terminal")).toHaveCount(0);
});

test("the legion add-machine flow waits after copying the plain command", async ({ page }) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await mockApp(page, { hosts: [host] });
  await page.goto("/legion");
  await page.getByRole("button", { name: "Add a machine", exact: true }).first().click();

  const dialog = page.getByRole("dialog", { name: "Add a machine" });
  await expect(dialog.getByText(/curl -fsSL .*install\.sh \| sh$/)).toBeVisible();
  await expect(dialog.getByText("After installation, run")).toContainText("spawnd possess");
  await dialog.getByRole("button", { name: "Copy install command" }).click();
  await expect(dialog.getByText("Waiting for your machine…")).toBeVisible();
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
