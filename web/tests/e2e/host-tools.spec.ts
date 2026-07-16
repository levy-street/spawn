import { expect, test } from "@playwright/test";
import { HOST_ID, host, mockAuthenticatedApi, PRESET_ID } from "./app-mocks";

test("interactive tool detail and install output stay on host control", async ({ page }) => {
  const checks: unknown[] = [];
  const installs: unknown[] = [];
  const apiRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.includes("/tools")) apiRequests.push(url.pathname);
  });
  page.on("dialog", (dialog) => dialog.accept());

  await mockAuthenticatedApi(page, {
    toolTargets: [
      {
        preset_id: PRESET_ID,
        preset_name: "codex",
        agent_kind: "codex",
        auto_update: false,
        last_checked_at: null,
        last_auto_update_at: null,
      },
    ],
    toolCheck: (_hostId, payload) => {
      checks.push(payload);
      return {
        tools: [
          {
            target_id: PRESET_ID,
            tool: "codex",
            command: ["codex"],
            installed: true,
            path: "/private/bin/codex",
            version: "codex 1.2.3",
            latest_version: "1.2.4",
            update_available: true,
          },
        ],
      };
    },
    toolInstall: (_hostId, payload) => {
      installs.push(payload);
      return {
        target_id: PRESET_ID,
        tool: "codex",
        command: ["codex"],
        install_argv: ["npm", "install", "--global", "@openai/codex"],
        outcome: "succeeded",
        success: true,
        exit_code: 0,
        stdout: "private endpoint install output",
        stderr: "",
        output_truncated: false,
        status: {
          target_id: PRESET_ID,
          tool: "codex",
          command: ["codex"],
          installed: true,
          path: "/private/bin/codex",
          version: "codex 1.2.4",
          latest_version: "1.2.4",
          update_available: false,
        },
      };
    },
  });

  await page.goto(`/hosts/${HOST_ID}`);
  await expect(page.getByText("codex 1.2.3")).toBeVisible();
  await expect(page.getByText("/private/bin/codex")).toBeVisible();
  await page.getByRole("button", { name: "Update" }).click();
  await expect(page.getByText("private endpoint install output")).toBeVisible();
  await expect(page.getByText("codex: completed")).toBeVisible();

  expect(checks[0]).toEqual({ targets: [{ target_id: PRESET_ID, tool: "codex" }] });
  expect(installs).toEqual([{ target: { target_id: PRESET_ID, tool: "codex" } }]);
  expect(apiRequests).toEqual([]);
  expect(host.status).toBe("online");
});

test("install cancel is reachable and late success requires reconciliation", async ({ page }) => {
  let resolveInstall: ((value: unknown) => void) | null = null;
  const installs: unknown[] = [];
  page.on("dialog", (dialog) => dialog.accept());
  await mockAuthenticatedApi(page, {
    toolTargets: [
      {
        preset_id: PRESET_ID,
        preset_name: "codex",
        agent_kind: "codex",
        auto_update: false,
        last_checked_at: null,
        last_auto_update_at: null,
      },
    ],
    toolCheck: () => ({
      tools: [
        {
          target_id: PRESET_ID,
          tool: "codex",
          command: ["codex"],
          installed: false,
        },
      ],
    }),
    toolInstall: (_hostId, payload) => {
      installs.push(payload);
      return new Promise((resolve) => {
        resolveInstall = resolve;
      });
    },
  });

  await page.goto(`/hosts/${HOST_ID}`);
  await page.getByRole("button", { name: "Install" }).click();
  await expect(page.getByRole("button", { name: "Cancel" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(
    page.getByText(/Cancellation requested; waiting for the endpoint outcome/),
  ).toBeVisible();
  expect(resolveInstall).not.toBeNull();
  const finishInstall = resolveInstall as unknown as (value: unknown) => void;
  finishInstall({
    target_id: PRESET_ID,
    tool: "codex",
    command: ["codex"],
    install_argv: ["npm", "install", "--global", "@openai/codex"],
    outcome: "succeeded",
    success: true,
    exit_code: 0,
    stdout: "late success must not replace cancelled UI state",
    stderr: "",
    output_truncated: false,
    status: {
      target_id: PRESET_ID,
      tool: "codex",
      command: ["codex"],
      installed: true,
      path: "/private/bin/codex",
      version: "codex 1.2.4",
    },
  });
  await expect(page.getByText(/codex: outcome unknown/)).toBeVisible();
  await expect(
    page.getByText(
      "Check the tool status before retrying. This install is never retried automatically.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.getByText("late success must not replace cancelled UI state")).toHaveCount(0);
  expect(installs).toHaveLength(1);
});

test("built-in Aider metadata uses its canonical endpoint kind", async ({ page }) => {
  const checks: unknown[] = [];
  await mockAuthenticatedApi(page, {
    toolTargets: [
      {
        preset_id: PRESET_ID,
        preset_name: "aider-sonnet",
        agent_kind: "aider",
        auto_update: false,
        last_checked_at: null,
        last_auto_update_at: null,
      },
    ],
    toolCheck: (_hostId, payload) => {
      checks.push(payload);
      return {
        tools: [
          {
            target_id: PRESET_ID,
            tool: "aider",
            command: ["aider"],
            installed: false,
          },
        ],
      };
    },
  });
  await page.goto(`/hosts/${HOST_ID}`);
  await expect(page.getByText("aider-sonnet")).toBeVisible();
  await expect(page.getByText("unsupported policy")).toHaveCount(0);
  expect(checks).toEqual([{ targets: [{ target_id: PRESET_ID, tool: "aider" }] }]);
});
