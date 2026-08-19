import { expect, test } from "@playwright/test";
import { host, mockAuthenticatedApi } from "./app-mocks";

const MAC = {
  ...host,
  id: "00000000-0000-4000-8000-0000000000a1",
  name: "studio",
  os: "macos",
  arch: "aarch64",
  gpu: { vendor: "apple", name: "Apple M3 Max", vram_mb: null, count: 1 },
};

const GPU_BOX = {
  ...host,
  id: "00000000-0000-4000-8000-0000000000a2",
  name: "rig",
  os: "linux",
  arch: "x86_64",
  gpu: { vendor: "nvidia", name: "NVIDIA H100 PCIe", vram_mb: 81559, count: 4 },
};

/** A host from a daemon that predates the field: no `gpu` key at all. */
const OLD_DAEMON = {
  ...host,
  id: "00000000-0000-4000-8000-0000000000a3",
  name: "legacy",
  os: "linux",
  arch: "x86_64",
};

/** Detection ran and found nothing. Must be indistinguishable from the above. */
const NO_GPU = {
  ...host,
  id: "00000000-0000-4000-8000-0000000000a4",
  name: "vps",
  os: null,
  arch: null,
  gpu: null,
};

test("the hosts list marks each box by OS and says which one has the GPU", async ({ page }) => {
  await mockAuthenticatedApi(page, { hosts: [MAC, GPU_BOX, OLD_DAEMON, NO_GPU] });
  await page.goto("/hosts");

  const rows = page.getByRole("listitem");
  await expect(rows.filter({ hasText: "studio" })).toContainText("macOS/aarch64");
  await expect(rows.filter({ hasText: "rig" })).toContainText("Linux/x86_64");

  // Brand marks, not one generic server glyph for everything.
  await expect(
    rows.filter({ hasText: "studio" }).getByRole("img", { name: "macOS" }),
  ).toBeVisible();
  await expect(rows.filter({ hasText: "rig" }).getByRole("img", { name: "Linux" })).toBeVisible();

  // The GPU badge carries the adapter and its VRAM, and "+3" for the rest.
  const rig = rows.filter({ hasText: "rig" });
  await expect(rig.getByLabel(/^GPU:/u)).toContainText("80 GB");
  await expect(rig.getByLabel(/^GPU:/u)).toContainText("+3");
  await expect(rig.getByLabel(/^GPU:/u)).toHaveAttribute(
    "aria-label",
    "GPU: NVIDIA H100 PCIe · 80 GB · 4 adapters",
  );

  // Unified memory reports no VRAM figure rather than an invented one.
  const studio = rows.filter({ hasText: "studio" });
  await expect(studio.getByLabel(/^GPU:/u)).toHaveAttribute("aria-label", "GPU: Apple M3 Max");
  await expect(studio.getByLabel(/^GPU:/u)).not.toContainText("GB");
});

test("no GPU, failed detection and an old daemon all render identically", async ({ page }) => {
  await mockAuthenticatedApi(page, { hosts: [OLD_DAEMON, NO_GPU] });
  await page.goto("/hosts");

  const rows = page.getByRole("listitem");
  // Absent, not a broken or empty badge.
  await expect(rows.filter({ hasText: "legacy" }).getByLabel(/^GPU:/u)).toHaveCount(0);
  await expect(rows.filter({ hasText: "vps" }).getByLabel(/^GPU:/u)).toHaveCount(0);

  // An unknown OS still gets a row, and says what it actually knows.
  await expect(rows.filter({ hasText: "vps" })).toContainText("Unknown OS/unknown");
});

test("the host detail page carries the same marks and a GPU fact", async ({ page }) => {
  await mockAuthenticatedApi(page, { hosts: [GPU_BOX] });
  await page.goto(`/hosts/${GPU_BOX.id}`);

  await expect(page.getByRole("button", { name: "rig", exact: true })).toBeVisible();
  await expect(page.getByRole("img", { name: "Linux" }).first()).toBeVisible();
  await expect(page.getByLabel(/^GPU:/u).first()).toBeVisible();
  // Spelled out in the facts grid, where there is room for the full model.
  await expect(page.getByText("NVIDIA H100 PCIe · 80 GB · 4 adapters")).toBeVisible();
});

test("a host with no GPU says so on its detail page rather than staying silent", async ({
  page,
}) => {
  await mockAuthenticatedApi(page, { hosts: [NO_GPU] });
  await page.goto(`/hosts/${NO_GPU.id}`);

  // The list hides the badge; the detail page has room to answer the question.
  await expect(page.getByText("none detected")).toBeVisible();
  await expect(page.getByLabel(/^GPU:/u)).toHaveCount(0);
});

test("the new-agent host picker shows the same marks", async ({ page }) => {
  await mockAuthenticatedApi(page, { hosts: [MAC, GPU_BOX] });
  await page.goto("/agents/new");

  const picker = page.getByRole("button", { name: /rig/u });
  await expect(picker).toContainText("Linux");
  await expect(picker.getByLabel(/^GPU:/u)).toBeVisible();
  await expect(page.getByRole("button", { name: /studio/u })).toContainText("macOS");
});
