import { expect, test } from "@playwright/test";
import { agent, host, mockApp, openSettings, USER_ID, user } from "./app-mocks";

test("all seven settings tabs open", async ({ page }) => {
  await mockApp(page);
  await openSettings(page);
  const cases = [
    ["Account", "Account"],
    ["Appearance", "Appearance"],
    ["Hosts", "Hosts"],
    ["Agents", "Agents"],
    ["Skills", "Skills"],
    ["Browser devices", "Browser devices"],
    ["Device trust", "Device trust"],
  ] as const;
  for (const [tab, heading] of cases) {
    await page.getByRole("button", { name: tab, exact: true }).click();
    await expect(page.getByRole("heading", { name: heading, exact: true }).last()).toBeVisible();
  }
});

test("module-level openSettings links change tabs without navigating", async ({ page }) => {
  await mockApp(page);
  await openSettings(page, "devices");
  const url = page.url();
  await page
    .getByRole("heading", { name: "Browser devices" })
    .locator("xpath=ancestor::section")
    .getByRole("button", { name: "Device trust" })
    .click();
  await expect(page.getByRole("heading", { name: "Device trust" })).toBeVisible();
  expect(page.url()).toBe(url);
  await page
    .getByRole("heading", { name: "Device trust" })
    .locator("xpath=ancestor::section")
    .getByRole("button", { name: "Browser devices" })
    .click();
  await expect(page.getByRole("heading", { name: "Browser devices" })).toBeVisible();
});

test("Hosts lists connected machines and offers the connect flow", async ({ page }) => {
  await mockApp(page, { hosts: [host] });
  await openSettings(page, "hosts");
  await expect(page.getByText("Mac", { exact: true })).toBeVisible();
  await expect(page.getByText("macos/aarch64 · daemon 0.1.0")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Connect a host" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy install command" })).toBeVisible();
  await expect(page.getByLabel("Code from the terminal")).toBeVisible();
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
  await add.getByLabel("Command").fill("deploy --watch");
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
  await edit.getByLabel("Command").fill("deploy --safe");
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
