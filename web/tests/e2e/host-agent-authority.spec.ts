import { expect, test } from "@playwright/test";
import { AGENT_ID, HOST_ID, host, mockApp } from "./app-mocks";

const guidance =
  "Agent installation and auto update are unavailable here. Install or update agents in a trusted terminal on this host.";

test("agent availability and refresh never offer installation or automation", async ({ page }) => {
  await mockApp(page, {
    hostAgents: {
      [HOST_ID]: [
        {
          agent_id: AGENT_ID,
          agent_name: "Example agent",
          agent_kind: "shell",
          command: "example-agent",
          install: "example-installer",
          installed: false,
          auto_update: true,
        },
      ],
    },
  });
  const writes: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes(`/api/hosts/${HOST_ID}/agents`) && request.method() !== "GET") {
      writes.push(`${request.method()} ${request.url()}`);
    }
  });
  await page.goto(`/hosts/${HOST_ID}`);
  const availability = page.getByRole("region", { name: "Agent availability" });
  await expect(availability.getByText("Example agent", { exact: true })).toBeVisible();
  await expect(availability.getByText("not installed", { exact: true })).toBeVisible();
  await expect(availability.getByText(guidance)).toBeVisible();
  await expect(availability.getByRole("button", { name: /install|update/i })).toHaveCount(0);
  await expect(availability.getByRole("checkbox")).toHaveCount(0);
  await expect(availability.getByRole("switch")).toHaveCount(0);
  const refreshed = page.waitForResponse((response) =>
    response.url().endsWith(`/api/hosts/${HOST_ID}/agents`),
  );
  await availability.getByRole("button", { name: `Refresh agents for ${host.name}` }).click();
  await refreshed;
  await expect(availability.getByRole("button")).toBeEnabled();
  expect(writes).toEqual([]);
});

test("an offline host retains the trusted-terminal installation guidance", async ({ page }) => {
  await mockApp(page, { hosts: [{ ...host, status: "offline" }] });
  await page.goto(`/hosts/${HOST_ID}`);
  await expect(
    page.getByText("Agent availability is unavailable while the daemon is offline."),
  ).toBeVisible();
  await expect(page.getByText(guidance)).toBeVisible();
});
