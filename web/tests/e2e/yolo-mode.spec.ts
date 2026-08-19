import { expect, type Page, test } from "@playwright/test";
import { agent, mockAuthenticatedApi, PRESET_ID, preset } from "./app-mocks";

const OPENCODE_PRESET = {
  ...preset,
  id: "00000000-0000-4000-8000-0000000000b1",
  name: "opencode",
  agent_kind: "opencode",
  default_argv: ["opencode"],
  install: "npm install -g opencode-ai",
  // Config-driven, so there is no flag to offer.
  yolo_argv: null,
};

const toggle = (page: Page) => page.getByRole("checkbox", { name: /YOLO mode/u });
const runsHint = (page: Page) => page.getByText(/^Runs /u);

test("the toggle is on by default and the composed command stays visible", async ({ page }) => {
  let created: Record<string, unknown> | null = null;
  await mockAuthenticatedApi(page, {
    createAgent: async (body, route) => {
      created = body as Record<string, unknown>;
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        json: agent(body as Record<string, unknown>),
      });
    },
  });

  await page.goto("/agents/new");

  await expect(toggle(page)).toBeChecked();
  // The exact argv, flag included, before you spawn — the toggle must never
  // be the only place the command is stated.
  await expect(runsHint(page)).toContainText("codex --yolo");

  await toggle(page).uncheck();
  await expect(runsHint(page)).toContainText("Runs codex —");
  await expect(runsHint(page)).not.toContainText("--yolo");

  await toggle(page).check();
  await expect(runsHint(page)).toContainText("codex --yolo");

  await page.getByRole("button", { name: "Spawn agent" }).click();
  // Composition is the server's job: the request keeps preset_id and asks for
  // the flag, rather than sending a custom argv that would lose the preset.
  await expect.poll(() => created).toMatchObject({ preset_id: PRESET_ID, yolo: true });
  expect(created).not.toHaveProperty("argv");
});

test("the choice is remembered for the next agent", async ({ page }) => {
  await mockAuthenticatedApi(page);
  await page.goto("/agents/new");

  await toggle(page).uncheck();
  await expect(toggle(page)).not.toBeChecked();

  await page.reload();
  await expect(toggle(page)).not.toBeChecked();
  await expect(runsHint(page)).not.toContainText("--yolo");

  await toggle(page).check();
  await page.reload();
  await expect(toggle(page)).toBeChecked();
});

test("a preset with no such flag does not offer the toggle", async ({ page }) => {
  let created: Record<string, unknown> | null = null;
  await mockAuthenticatedApi(page, {
    presets: [preset, OPENCODE_PRESET],
    createAgent: async (body, route) => {
      created = body as Record<string, unknown>;
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        json: agent(body as Record<string, unknown>),
      });
    },
  });

  await page.goto("/agents/new");
  await expect(toggle(page)).toBeVisible();

  await page.getByRole("button", { name: "opencode" }).click();
  // Hidden rather than shown-and-inert: a toggle that does nothing is worse
  // than no toggle.
  await expect(toggle(page)).toHaveCount(0);
  await expect(runsHint(page)).toContainText("Runs opencode —");

  await page.getByRole("button", { name: "Spawn agent" }).click();
  await expect.poll(() => created).toMatchObject({ yolo: false });
});

test("a hand-written command is never edited by the toggle", async ({ page }) => {
  let created: Record<string, unknown> | null = null;
  await mockAuthenticatedApi(page, {
    createAgent: async (body, route) => {
      created = body as Record<string, unknown>;
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        json: agent(body as Record<string, unknown>),
      });
    },
  });

  await page.goto("/agents/new");
  await expect(toggle(page)).toBeChecked();

  await page.getByRole("button", { name: /Advanced/u }).click();
  await page.getByLabel(/Custom command/u).fill("codex --search");
  // The toggle withdraws rather than appending to someone else's sentence.
  await expect(toggle(page)).toHaveCount(0);

  await page.getByRole("button", { name: "Spawn agent" }).click();
  await expect.poll(() => created).toMatchObject({ yolo: false });
});

test("a YOLO agent is identifiable in the list, however it was created", async ({ page }) => {
  await mockAuthenticatedApi(page, {
    agents: [
      agent({ id: "00000000-0000-4000-8000-0000000000c1", name: "gated", argv: ["codex"] }),
      agent({
        id: "00000000-0000-4000-8000-0000000000c2",
        name: "ungated",
        argv: ["codex", "--yolo"],
      }),
      // Typed by hand under Advanced options — no preset, no toggle, but the
      // agent is every bit as ungated, so the badge is read off the command.
      agent({
        id: "00000000-0000-4000-8000-0000000000c3",
        name: "hand-written",
        preset_id: null,
        argv: ["claude", "--dangerously-skip-permissions"],
      }),
    ],
  });

  await page.goto("/agents");

  const rows = page.getByRole("listitem");
  await expect(rows.filter({ hasText: "gated" }).getByTestId("yolo-badge")).toHaveCount(0);
  await expect(rows.filter({ hasText: "ungated" }).getByTestId("yolo-badge")).toBeVisible();
  await expect(rows.filter({ hasText: "hand-written" }).getByTestId("yolo-badge")).toBeVisible();
});
