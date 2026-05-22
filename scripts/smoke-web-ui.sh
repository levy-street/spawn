#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/smoke-web-ui.sh

Runs a real-browser smoke test against an already-running local spawn stack.

Expected local stack:
  - spawn-web reachable at SPAWN_WEB_SMOKE_BASE_URL
  - spawn-server reachable through the web origin's /api rewrites
  - at least one approved, online host owned by a local user

Environment:
  SPAWN_WEB_SMOKE_BASE_URL   Web origin. Default: http://localhost:3002
  SPAWN_WEB_SMOKE_DB_URL     Server DB URL. Default: sqlite+aiosqlite:///./data/spawn.db
  SPAWN_WEB_SMOKE_USER_EMAIL Optional user email. Default: owner of the newest online host.
  SPAWN_WEB_SMOKE_TMP        Temp work dir. Default: /tmp/spawn-playwright-smoke
  SPAWN_WEB_SMOKE_HOST_TIMEOUT
                            Seconds to wait for an online host. Default: 30
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

die() {
  printf 'smoke-web-ui: %s\n' "$*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1
}

repo_root="$(git rev-parse --show-toplevel 2>/dev/null)" || die "run from inside the spawn repo"
cd "$repo_root"

need node || die "node is required"
need npm || die "npm is required"
need curl || die "curl is required"

base_url="${SPAWN_WEB_SMOKE_BASE_URL:-http://localhost:3002}"
db_url="${SPAWN_WEB_SMOKE_DB_URL:-sqlite+aiosqlite:///./data/spawn.db}"
tmpdir="${SPAWN_WEB_SMOKE_TMP:-/tmp/spawn-playwright-smoke}"
host_timeout="${SPAWN_WEB_SMOKE_HOST_TIMEOUT:-30}"
auth_email="browser-smoke-auth-$(date +%s)-$$@example.com"
auth_password="browser-smoke-password"

cleanup_auth_user() {
  (
    cd "$repo_root/server"
    SPAWN_DATABASE_URL="$db_url" SPAWN_WEB_SMOKE_AUTH_EMAIL="$auth_email" uv run python - <<'PY'
import asyncio
import os

from sqlalchemy import delete

from spawn_server.db import get_sessionmaker, init_engine
from spawn_server.models import User


async def main() -> None:
    init_engine()
    async with get_sessionmaker()() as session:
        await session.execute(delete(User).where(User.email == os.environ["SPAWN_WEB_SMOKE_AUTH_EMAIL"]))
        await session.commit()


asyncio.run(main())
PY
  ) >/dev/null 2>&1 || true
}

trap cleanup_auth_user EXIT INT TERM

curl -fsSI "$base_url/" >/dev/null || die "$base_url is not reachable"
curl -fsSI "$base_url/hosts" >/dev/null || die "$base_url/hosts is not reachable"

session_token="$(
  cd server
  SPAWN_DATABASE_URL="$db_url" SPAWN_WEB_SMOKE_HOST_TIMEOUT="$host_timeout" uv run python - <<'PY'
import asyncio
import os
import sys

from sqlalchemy import select

from spawn_server import auth
from spawn_server.db import get_sessionmaker, init_engine
from spawn_server.models import Host, User


async def main() -> None:
    email = os.environ.get("SPAWN_WEB_SMOKE_USER_EMAIL")
    timeout = float(os.environ.get("SPAWN_WEB_SMOKE_HOST_TIMEOUT", "30"))
    deadline = asyncio.get_running_loop().time() + timeout
    init_engine()
    async with get_sessionmaker()() as session:
        user = None
        if email:
            user = (
                await session.execute(select(User).where(User.email == email))
            ).scalar_one_or_none()
            if user is None:
                print(f"no user found for {email}", file=sys.stderr)
                raise SystemExit(1)
        else:
            host = None
            while host is None:
                host = (
                    await session.execute(
                        select(Host)
                        .where(Host.status == "online")
                        .order_by(Host.last_seen_at.desc())
                    )
                ).scalars().first()
                if host is not None:
                    break
                if asyncio.get_running_loop().time() >= deadline:
                    break
                await asyncio.sleep(1)
            if host is None:
                print("no online host found", file=sys.stderr)
                raise SystemExit(1)
            user = await session.get(User, host.owner_user_id)
            if user is None:
                print("online host has no owner user", file=sys.stderr)
                raise SystemExit(1)
        print(auth.issue_session_token(user.id))


asyncio.run(main())
PY
)"
csrf_token="smoke-csrf-$RANDOM-$$"

mkdir -p "$tmpdir"
if [[ ! -d "$tmpdir/node_modules/@playwright/test" ]]; then
  (
    cd "$tmpdir"
    npm init -y >/dev/null
    npm install @playwright/test@1.60.0 >/dev/null
  )
fi

(
  cd "$tmpdir"
  SPAWN_WEB_SMOKE_BASE_URL="$base_url" \
    SPAWN_WEB_SMOKE_SESSION="$session_token" \
    SPAWN_WEB_SMOKE_CSRF="$csrf_token" \
    SPAWN_WEB_SMOKE_AUTH_EMAIL="$auth_email" \
    SPAWN_WEB_SMOKE_AUTH_PASSWORD="$auth_password" \
    node <<'JS'
const { chromium, expect } = require("@playwright/test");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const BASE = process.env.SPAWN_WEB_SMOKE_BASE_URL;
const SESSION_TOKEN = process.env.SPAWN_WEB_SMOKE_SESSION;
const CSRF_TOKEN = process.env.SPAWN_WEB_SMOKE_CSRF;
const AUTH_EMAIL = process.env.SPAWN_WEB_SMOKE_AUTH_EMAIL;
const AUTH_PASSWORD = process.env.SPAWN_WEB_SMOKE_AUTH_PASSWORD;
const OUT = process.cwd();
if (!BASE || !SESSION_TOKEN || !CSRF_TOKEN || !AUTH_EMAIL || !AUTH_PASSWORD) {
  throw new Error("missing smoke configuration");
}

async function smokeAuthFlow(browser) {
  const context = await browser.newContext({
    baseURL: BASE,
    viewport: { width: 1440, height: 980 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  try {
    await page.goto("/signup", { waitUntil: "networkidle" });
    await page.locator("#email").fill(AUTH_EMAIL);
    await page.locator("#password").fill(AUTH_PASSWORD);
    await page.getByRole("button", { name: "Create account" }).click();
    await page.waitForURL(/\/dash$/u, { timeout: 10_000 });
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
    let cookies = await context.cookies(BASE);
    const session = cookies.find((cookie) => cookie.name === "spawn_session");
    const csrf = cookies.find((cookie) => cookie.name === "spawn_csrf");
    if (!session?.httpOnly) throw new Error("signup did not set HTTP-only session cookie");
    if (!csrf || csrf.httpOnly) throw new Error("signup did not set readable CSRF cookie");

    await page.getByRole("button", { name: "Log out" }).click();
    await page.waitForURL(/\/login$/u, { timeout: 10_000 });
    await expect(page.getByText("Sign in to spawn")).toBeVisible();
    cookies = await context.cookies(BASE);
    if (cookies.some((cookie) => ["spawn_session", "spawn_csrf"].includes(cookie.name))) {
      throw new Error("logout did not clear session and CSRF cookies");
    }

    await page.locator("#email").fill(AUTH_EMAIL);
    await page.locator("#password").fill(AUTH_PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL(/\/dash$/u, { timeout: 10_000 });
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
    cookies = await context.cookies(BASE);
    if (!cookies.find((cookie) => cookie.name === "spawn_session")?.httpOnly) {
      throw new Error("login did not set HTTP-only session cookie");
    }
    if (!cookies.find((cookie) => cookie.name === "spawn_csrf")) {
      throw new Error("login did not set CSRF cookie");
    }
  } finally {
    await context.close();
  }
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  await smokeAuthFlow(browser);

  const context = await browser.newContext({
    baseURL: BASE,
    viewport: { width: 1440, height: 980 },
    deviceScaleFactor: 1,
  });
  await context.addCookies([
    {
      name: "spawn_session",
      value: SESSION_TOKEN,
      url: BASE,
      httpOnly: true,
      sameSite: "Lax",
    },
    {
      name: "spawn_csrf",
      value: CSRF_TOKEN,
      url: BASE,
      httpOnly: false,
      sameSite: "Lax",
    },
  ]);

  const page = await context.newPage();
  const issues = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") issues.push(`console error: ${msg.text()}`);
  });
  page.on("pageerror", (err) => issues.push(`page error: ${err.message}`));

  let agentId = null;
  let presetId = null;
  let hostId = null;
  let originalHostName = null;
  const presetName = `browser-smoke-preset-${Date.now()}`;
  const editedPresetName = `${presetName}-edited`;
  const hostRenameSuffix = `smoke-${Date.now()}`;
  const agentCwd = await fs.mkdtemp(path.join(os.tmpdir(), "spawn-web-smoke-agent-"));
  const uploadName = `browser-upload-${Date.now()}.txt`;
  const uploadSourcePath = path.join(OUT, uploadName);
  const uploadTargetPath = path.join(agentCwd, uploadName);
  await fs.writeFile(uploadSourcePath, "browser upload smoke\n", "utf8");
  async function api(apiPath, init = {}) {
    return await page.evaluate(
      async ({ apiPath, init, csrfToken }) => {
        const response = await fetch(apiPath, {
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            "X-CSRF-Token": csrfToken,
            ...(init.headers || {}),
          },
          ...init,
        });
        const text = await response.text();
        let body = null;
        try {
          body = text ? JSON.parse(text) : null;
        } catch {
          body = text;
        }
        return { ok: response.ok, status: response.status, body };
      },
      { apiPath, init, csrfToken: CSRF_TOKEN },
    );
  }

  try {
    await page.goto("/", { waitUntil: "networkidle" });
    await expect(page.getByRole("heading", { name: "spawn" })).toBeVisible();
    await expect(page.getByText("Remote agents for machines you control")).toBeVisible();
    await expect(page.getByRole("link", { name: /Install daemon/ })).toBeVisible();
    await page.screenshot({ path: path.join(OUT, "landing.png"), fullPage: true });

    await page.goto("/download", { waitUntil: "networkidle" });
    await expect(page.getByRole("heading", { name: "Install daemon" })).toBeVisible();
    await expect(
      page.getByText(`curl -fsSL ${BASE}/install.sh | sh -s -- --server ${BASE}`),
    ).toBeVisible();
    await expect(page.getByText("--build-from-source")).toBeVisible();

    await page.goto("/hosts", { waitUntil: "networkidle" });
    await expect(page.getByRole("heading", { name: "Hosts" })).toBeVisible();
    const hostsResponse = await api("/api/hosts");
    const host = hostsResponse.body.find((candidate) => candidate.name === "Mac")
      ?? hostsResponse.body.find((candidate) => candidate.status === "online");
    if (!host) throw new Error("no online host available for Hosts UI smoke");
    hostId = host.id;
    originalHostName = host.name;
    const renamedHostName = `${originalHostName}-${hostRenameSuffix}`;
    await expect(page.getByText(originalHostName, { exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText(/spawnd 0\.2\.0/)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Targets")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Daemon offline")).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByText("claude-code").first()).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: `Rename ${originalHostName}` }).click();
    await page.getByRole("textbox", { name: "Host name" }).fill(renamedHostName);
    await page.getByRole("button", { name: "Save host name" }).click();
    await expect(page.getByText(renamedHostName, { exact: true })).toBeVisible({
      timeout: 10_000,
    });
    const renamedHost = await api(`/api/hosts/${hostId}`);
    if (renamedHost.body.name !== renamedHostName) {
      throw new Error(`host rename did not persist: ${JSON.stringify(renamedHost.body)}`);
    }
    await page.getByRole("button", { name: `Rename ${renamedHostName}` }).click();
    await page.getByRole("textbox", { name: "Host name" }).fill(originalHostName);
    await page.getByRole("button", { name: "Save host name" }).click();
    await expect(page.getByText(originalHostName, { exact: true })).toBeVisible({
      timeout: 10_000,
    });
    const restoredHost = await api(`/api/hosts/${hostId}`);
    if (restoredHost.body.name !== originalHostName) {
      throw new Error(`host restore did not persist: ${JSON.stringify(restoredHost.body)}`);
    }
    hostId = null;
    originalHostName = null;
    await page.screenshot({ path: path.join(OUT, "hosts.png"), fullPage: true });

    await page.goto("/settings", { waitUntil: "networkidle" });
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
    await expect(page.getByText("Presets")).toBeVisible();
    await page.locator("#preset-name").fill(presetName);
    await page.locator("#preset-kind").fill("smoke");
    await page.locator("#preset-argv").fill('/bin/echo "preset smoke"');
    await page.locator("#preset-install").fill("printf installing-smoke");
    await page.locator("#preset-env").fill("FOO=bar\nBAR=baz");
    await page.getByRole("button", { name: "Add preset" }).click();
    await expect(page.getByText(presetName, { exact: true })).toBeVisible({ timeout: 10_000 });
    let presetsResponse = await api("/api/presets");
    presetId = presetsResponse.body.find((preset) => preset.name === presetName)?.id ?? null;
    if (!presetId) throw new Error(`created preset ${presetName} not found via API`);
    await page.getByRole("button", { name: `Edit preset ${presetName}` }).click();
    await expect(page.locator("#preset-name")).toHaveValue(presetName);
    await expect(page.locator("#preset-env")).toHaveValue("FOO=bar\nBAR=baz");
    await page.locator("#preset-name").fill(editedPresetName);
    await page.locator("#preset-kind").fill("smoke-updated");
    await page.locator("#preset-argv").fill("/bin/echo edited-smoke");
    await page.locator("#preset-install").fill("");
    await page.getByRole("button", { name: "Update preset" }).click();
    await expect(page.getByText(editedPresetName, { exact: true })).toBeVisible({
      timeout: 10_000,
    });
    presetsResponse = await api("/api/presets");
    const updatedPreset = presetsResponse.body.find((preset) => preset.id === presetId);
    if (!updatedPreset) throw new Error(`updated preset ${presetId} not found via API`);
    if (updatedPreset.name !== editedPresetName) {
      throw new Error(`preset rename did not persist: ${JSON.stringify(updatedPreset)}`);
    }
    if (updatedPreset.install !== null) {
      throw new Error(`preset install was not cleared: ${JSON.stringify(updatedPreset)}`);
    }
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: `Delete preset ${editedPresetName}` }).click();
    await expect(page.getByText(editedPresetName, { exact: true })).toHaveCount(0, {
      timeout: 10_000,
    });
    presetId = null;

    await page.goto("/agents", { waitUntil: "networkidle" });
    await expect(page.getByRole("heading", { name: "Agents", level: 1 })).toBeVisible();
    await page.getByRole("button", { name: /New agent/ }).click();
    await expect(page.getByText("Choose a host, agent, and working directory.")).toBeVisible();
    await expect(page.locator("#agent-host")).toContainText("Mac (online");
    await expect(page.locator("#agent-preset")).toContainText("shell");
    await page.getByRole("button", { name: "Cancel" }).click();

    const existingAgents = await api("/api/agents?include_archived=true");
    if (existingAgents.ok) {
      for (const agent of existingAgents.body) {
        if (agent.name?.startsWith("browser-smoke-")) {
          await api(`/api/agents/${agent.id}`, { method: "DELETE" });
        }
      }
    }

    await page.goto("/agents", { waitUntil: "networkidle" });
    await page.getByRole("button", { name: /New agent/ }).click();
    await page.locator("#agent-preset").selectOption("");
    await page.locator("#agent-name").fill("browser-smoke-shell");
    await page.locator("#agent-cwd").fill(agentCwd);
    await page
      .locator("#agent-argv")
      .fill(
        '/bin/sh -lc \'printf "browser-smoke-ready\\n"; while IFS= read -r line; do printf "browser-smoke:%s\\n" "$line"; done\'',
      );
    await page.locator("#agent-cols").fill("100");
    await page.locator("#agent-rows").fill("24");
    await page.getByRole("button", { name: "Spawn", exact: true }).click();
    await expect(page.getByText("browser-smoke-shell").first()).toBeVisible({ timeout: 10_000 });
    await page.getByText("browser-smoke-shell").first().click();
    await page.waitForURL(/\/agents\/[0-9a-f-]+$/u, { timeout: 10_000 });
    agentId = page.url().match(/\/agents\/([0-9a-f-]+)$/u)?.[1] ?? null;
    if (!agentId) throw new Error(`could not parse created agent id from ${page.url()}`);
    await expect(page.getByRole("application", { name: "Agent terminal" })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByRole("button", { name: "Upload files" })).toBeVisible();
    await expect(page.getByRole("link", { name: "All agents" })).toBeVisible();
    await page.waitForFunction(
      () => {
        if (document.querySelector(".xterm-rows")?.textContent?.includes("browser-smoke-ready")) {
          return true;
        }
        const canvases = Array.from(document.querySelectorAll(".xterm-screen canvas"));
        return canvases.some((canvas) => {
          const ctx = canvas.getContext("2d");
          if (!ctx || canvas.width === 0 || canvas.height === 0) return false;
          const width = Math.min(canvas.width, 900);
          const height = Math.min(canvas.height, 280);
          const data = ctx.getImageData(0, 0, width, height).data;
          let lightPixels = 0;
          for (let i = 0; i < data.length; i += 4) {
            if (data[i + 3] > 0 && data[i] + data[i + 1] + data[i + 2] > 140) {
              lightPixels += 1;
            }
            if (lightPixels > 30) return true;
          }
          return false;
        });
      },
      { timeout: 15_000 },
    );
    const fileChooserPromise = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Upload files" }).click();
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles(uploadSourcePath);
    await expect(page.getByText(/Uploaded .*browser-upload-/)).toBeVisible({ timeout: 10_000 });
    await expect
      .poll(
        async () => {
          try {
            return await fs.readFile(uploadTargetPath, "utf8");
          } catch {
            return "";
          }
        },
        { timeout: 10_000 },
      )
      .toBe("browser upload smoke\n");
    await page.screenshot({ path: path.join(OUT, "agent-terminal.png"), fullPage: true });

    const beforeInput = (await api(`/api/agents/${agentId}`)).body.last_input_at;
    const mobileContext = await browser.newContext({
      baseURL: BASE,
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
    });
    await mobileContext.addCookies([
      {
        name: "spawn_session",
        value: SESSION_TOKEN,
        url: BASE,
        httpOnly: true,
        sameSite: "Lax",
      },
      {
        name: "spawn_csrf",
        value: CSRF_TOKEN,
        url: BASE,
        httpOnly: false,
        sameSite: "Lax",
      },
    ]);
    const mobilePage = await mobileContext.newPage();
    mobilePage.on("console", (msg) => {
      if (msg.type() === "error") issues.push(`mobile console error: ${msg.text()}`);
    });
    mobilePage.on("pageerror", (err) => issues.push(`mobile page error: ${err.message}`));
    await mobilePage.goto(`/agents/${agentId}`, { waitUntil: "networkidle" });
    await expect(mobilePage.getByRole("application", { name: "Agent terminal" })).toBeVisible({
      timeout: 15_000,
    });
    await expect(mobilePage.getByText("Composer mode")).toBeVisible({ timeout: 10_000 });
    await expect(
      mobilePage.getByPlaceholder("Type a message... (Enter sends, Shift+Enter newline)"),
    ).toBeVisible();
    await expect(mobilePage.getByRole("button", { name: "Escape" })).toBeVisible();
    await expect(mobilePage.getByRole("button", { name: "Tab" })).toBeVisible();
    await expect(mobilePage.getByRole("button", { name: "Ctrl-C" })).toBeVisible();
    await expect(mobilePage.getByLabel("Paste")).toBeVisible();
    await mobilePage
      .getByPlaceholder("Type a message... (Enter sends, Shift+Enter newline)")
      .fill("mobile-composer-smoke");
    await mobilePage
      .getByPlaceholder("Type a message... (Enter sends, Shift+Enter newline)")
      .press("Enter");
    await expect
      .poll(
        async () => {
          const result = await api(`/api/agents/${agentId}`);
          return result.body.last_input_at;
        },
        { timeout: 10_000 },
      )
      .not.toBe(beforeInput);
    await mobilePage.screenshot({ path: path.join(OUT, "agent-terminal-mobile.png"), fullPage: true });
    await mobileContext.close();

    const renamedAgentName = "browser-smoke-shell-renamed";
    await page.goto("/agents", { waitUntil: "networkidle" });
    const mainRegion = page.getByRole("main");
    await expect(page.getByText("browser-smoke-shell", { exact: true }).first()).toBeVisible({
      timeout: 10_000,
    });
    await mainRegion.getByRole("button", { name: "Rename browser-smoke-shell" }).click();
    await mainRegion.getByRole("textbox", { name: "Agent name" }).fill(renamedAgentName);
    await mainRegion.getByRole("button", { name: "Save agent name" }).click();
    await expect(page.getByText(renamedAgentName, { exact: true }).first()).toBeVisible({
      timeout: 10_000,
    });
    let agentResponse = await api(`/api/agents/${agentId}`);
    if (agentResponse.body.name !== renamedAgentName) {
      throw new Error(`agent rename did not persist: ${JSON.stringify(agentResponse.body)}`);
    }
    await mainRegion.getByRole("button", { name: `Archive ${renamedAgentName}` }).click();
    await expect
      .poll(
        async () => {
          agentResponse = await api(`/api/agents/${agentId}`);
          return agentResponse.body.archived_at !== null;
        },
        { timeout: 10_000 },
      )
      .toBe(true);
    await mainRegion.getByRole("button", { name: "Show archived" }).click();
    await expect(page.getByText(renamedAgentName, { exact: true }).first()).toBeVisible({
      timeout: 10_000,
    });
    await mainRegion.getByRole("button", { name: `Unarchive ${renamedAgentName}` }).click();
    await expect
      .poll(
        async () => {
          agentResponse = await api(`/api/agents/${agentId}`);
          return agentResponse.body.archived_at;
        },
        { timeout: 10_000 },
      )
      .toBeNull();

    if (issues.length) throw new Error(`browser issues:\n${issues.join("\n")}`);
    console.log(
      JSON.stringify(
        {
          ok: true,
          screenshots: [
            path.join(OUT, "landing.png"),
            path.join(OUT, "hosts.png"),
            path.join(OUT, "agent-terminal.png"),
            path.join(OUT, "agent-terminal-mobile.png"),
          ],
          agentId,
        },
        null,
        2,
      ),
    );
  } finally {
    if (agentId) {
      try {
        await api(`/api/agents/${agentId}`, { method: "DELETE" });
      } catch (err) {
        console.error(`cleanup failed: ${err.message}`);
      }
    }
    if (presetId) {
      try {
        await api(`/api/presets/${presetId}`, { method: "DELETE" });
      } catch (err) {
        console.error(`preset cleanup failed: ${err.message}`);
      }
    }
    if (hostId && originalHostName) {
      try {
        await api(`/api/hosts/${hostId}`, {
          method: "PATCH",
          body: JSON.stringify({ name: originalHostName }),
        });
      } catch (err) {
        console.error(`host cleanup failed: ${err.message}`);
      }
    }
    await fs.rm(agentCwd, { recursive: true, force: true });
    await fs.rm(uploadSourcePath, { force: true });
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
JS
)
