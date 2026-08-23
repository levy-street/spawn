import { expect, test } from "@playwright/test";
import { mockApp, openSettings, SKILL_ID, skill } from "./app-mocks";

test("settings can create skills", async ({ page }) => {
  let skillBody: Record<string, unknown> | null = null;

  await mockApp(page, {
    skills: [skill({ name: "existing review", enabled_by_default: true })],
    createSkill: async (body, route) => {
      skillBody = body as Record<string, unknown>;
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        json: skill({ ...(body as Record<string, unknown>), name: "triage" }),
      });
    },
  });

  await openSettings(page, "skills");
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(page.getByText("existing review")).toBeVisible();

  const skillsForm = page.locator("form").filter({ has: page.locator("#skill-content") });
  await skillsForm.locator("#skill-name").fill("triage");
  await skillsForm.locator("#skill-description").fill("Triage changed files");
  await skillsForm.locator("#skill-content").fill("Inspect the current diff and report issues.");
  await skillsForm.getByLabel("Grant to new sessions by default").check();
  await skillsForm.getByRole("button", { name: "Add skill" }).click();
  await expect
    .poll(() => skillBody)
    .toMatchObject({
      name: "triage",
      description: "Triage changed files",
      content: "Inspect the current diff and report issues.",
      enabled_by_default: true,
    });
});

test("settings has no MCP surface", async ({ page }) => {
  await mockApp(page);

  await openSettings(page, "skills");
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(page.getByText("MCP", { exact: false })).toHaveCount(0);
});

test("settings can edit and delete skills", async ({ page }) => {
  let skillPatch: { id: string; body: Record<string, unknown> } | null = null;
  let skillDeleteId: string | null = null;

  page.on("dialog", (dialog) => dialog.accept());

  await mockApp(page, {
    skills: [skill({ id: SKILL_ID, name: "existing review" })],
    updateSkill: async (id, body, route) => {
      skillPatch = { id, body: body as Record<string, unknown> };
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        json: skill({ id, ...(body as Record<string, unknown>) }),
      });
    },
    deleteSkill: async (id, route) => {
      skillDeleteId = id;
      await route.fulfill({ status: 204 });
    },
  });

  await openSettings(page, "skills");
  await page.getByRole("button", { name: "Edit skill existing review" }).click();
  await page.locator("#skill-description").fill("Updated review guidance");
  await page.locator("#skill-content").fill("Review the diff and identify regressions.");
  await page.getByRole("button", { name: "Update skill" }).click();
  await expect
    .poll(() => skillPatch)
    .toMatchObject({
      id: SKILL_ID,
      body: {
        name: "existing review",
        description: "Updated review guidance",
        content: "Review the diff and identify regressions.",
      },
    });

  await page.getByRole("button", { name: "Delete skill existing review" }).click();
  await expect.poll(() => skillDeleteId).toBe(SKILL_ID);
});
