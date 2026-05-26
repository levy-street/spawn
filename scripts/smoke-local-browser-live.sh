#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

need() {
  command -v "$1" >/dev/null 2>&1 || {
    printf 'smoke-local-browser-live: missing required command: %s\n' "$1" >&2
    exit 1
  }
}

need bun
need cargo
need curl
need python3
need tmux
need uv

tmp_dir="$(mktemp -d)"
server_pid=""
web_pid=""
daemon_pid=""
user_token=""
base_url=""
tmux_tmp="$tmp_dir/tmux"

cleanup() {
  local status=$?
  if [[ -n "${base_url:-}" && -n "${user_token:-}" ]]; then
    python3 - "$base_url" "$user_token" <<'PY' >/dev/null 2>&1 || true
import json
import sys
import urllib.error
import urllib.parse
import urllib.request

base_url, token = sys.argv[1:]


def request(method: str, path: str, payload: dict | None = None) -> dict | list | None:
    data = None if payload is None else json.dumps(payload).encode()
    req = urllib.request.Request(
        base_url + path,
        data=data,
        method=method,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as response:
            body = response.read()
            return json.loads(body.decode() or "null")
    except (urllib.error.HTTPError, urllib.error.URLError):
        return None


agents = request("GET", "/api/agents?" + urllib.parse.urlencode({"include_archived": "true"}))
if isinstance(agents, list):
    for agent in agents:
        agent_id = agent.get("id")
        if agent_id:
            request("DELETE", f"/api/agents/{agent_id}")
PY
  fi

  if [[ -n "$daemon_pid" ]]; then
    kill "$daemon_pid" >/dev/null 2>&1 || true
    wait "$daemon_pid" 2>/dev/null || true
  fi
  if [[ -n "$web_pid" ]]; then
    kill "$web_pid" >/dev/null 2>&1 || true
    if command -v pkill >/dev/null 2>&1; then
      pkill -TERM -P "$web_pid" >/dev/null 2>&1 || true
    fi
    wait "$web_pid" 2>/dev/null || true
  fi
  if [[ -n "$server_pid" ]]; then
    kill "$server_pid" >/dev/null 2>&1 || true
    wait "$server_pid" 2>/dev/null || true
  fi
  if [[ -d "$tmux_tmp" ]]; then
    TMUX_TMPDIR="$tmux_tmp" tmux kill-server >/dev/null 2>&1 || true
  fi
  if [[ "$status" != "0" ]]; then
    for log in "${server_log:-}" "${web_log:-}" "${daemon_log:-}" "${browser_log:-}"; do
      if [[ -n "$log" && -f "$log" ]]; then
        printf '%s\n' "---- $(basename "$log") ----" >&2
        tail -240 "$log" >&2 || true
      fi
    done
  fi
  rm -rf "$tmp_dir"
  exit "$status"
}
trap cleanup EXIT

read -r server_port web_port < <(
  python3 - <<'PY'
import socket

sockets = []
ports = []
for _ in range(2):
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    sockets.append(sock)
    ports.append(sock.getsockname()[1])
print(*ports)
for sock in sockets:
    sock.close()
PY
)

base_url="http://127.0.0.1:$server_port"
web_url="http://127.0.0.1:$web_port"
ws_url="ws://127.0.0.1:$server_port"
db_url="sqlite+aiosqlite:///$tmp_dir/spawn-browser-live.db"
server_log="$tmp_dir/server.log"
web_log="$tmp_dir/web.log"
daemon_log="$tmp_dir/daemon.log"
browser_log="$tmp_dir/browser.log"
daemon_home="$tmp_dir/daemon-home"
agent_cwd="$tmp_dir/agent-cwd"
agent_id_file="$tmp_dir/agent-id"
upload_path="$agent_cwd/live-upload.txt"
email="browser-live@example.com"
password="passpasspass"
mkdir -p "$daemon_home" "$agent_cwd" "$tmux_tmp"

wait_for_url() {
  local url="$1"
  local label="$2"
  local deadline="${3:-120}"
  local elapsed=0
  until curl -fsS --max-time 2 "$url" >/dev/null 2>&1; do
    if [[ "$elapsed" -ge "$deadline" ]]; then
      printf 'smoke-local-browser-live: timed out waiting for %s at %s\n' "$label" "$url" >&2
      return 1
    fi
    sleep 0.5
    elapsed=$((elapsed + 1))
  done
}

printf '%s\n' "smoke-local-browser-live: building spawnd"
(cd daemon && cargo build --locked >/dev/null)

printf '%s\n' "smoke-local-browser-live: preparing database"
(
  cd server
  SPAWN_DATABASE_URL="$db_url" \
    SPAWN_USE_INPROCESS_PUBSUB=1 \
    SPAWN_JWT_SECRET=smoke-browser-live-secret-with-enough-length \
    SPAWN_PUBLIC_URL="$web_url" \
    uv run alembic upgrade head >/dev/null
)

printf '%s\n' "smoke-local-browser-live: starting API server on $base_url"
(
  cd server
  exec env \
    SPAWN_DATABASE_URL="$db_url" \
    SPAWN_USE_INPROCESS_PUBSUB=1 \
    SPAWN_JWT_SECRET=smoke-browser-live-secret-with-enough-length \
    SPAWN_PUBLIC_URL="$web_url" \
    SPAWN_CORS_ORIGINS="$web_url" \
    SPAWN_TRANSCRIPT_DIR="$tmp_dir/transcripts" \
    uv run uvicorn spawn_server.main:app --host 127.0.0.1 --port "$server_port"
) >"$server_log" 2>&1 &
server_pid=$!
wait_for_url "$base_url/healthz" "API server"

printf '%s\n' "smoke-local-browser-live: provisioning daemon credentials"
creds="$(
  python3 - "$base_url" "$daemon_home" "$email" "$password" <<'PY'
import json
import os
import sys
import urllib.error
import urllib.request

base_url, home, email, password = sys.argv[1:]


def request(method: str, path: str, payload: dict | None = None, token: str | None = None) -> dict:
    data = None if payload is None else json.dumps(payload).encode()
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(base_url + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            return json.loads(response.read().decode() or "{}")
    except urllib.error.HTTPError as error:
        raise SystemExit(f"{method} {path} failed: {error.code} {error.read().decode()}") from error


signup = request("POST", "/api/auth/signup", {"email": email, "password": password})
token = signup["access_token"]
start = request(
    "POST",
    "/api/auth/device/start",
    {
        "host_name": "browser-live-host",
        "os": sys.platform,
        "arch": "smoke",
        "version": "smoke",
    },
)
request("POST", "/api/auth/device/approve", {"user_code": start["user_code"]}, token)
poll = request("POST", "/api/auth/device/poll", {"device_code": start["device_code"]})

creds = {
    "access_token": poll["access_token"],
    "host_id": poll["host_id"],
    "server_url": base_url,
}
for config_dir in (
    os.path.join(home, ".config", "spawn"),
    os.path.join(home, "Library", "Application Support", "spawn"),
):
    os.makedirs(config_dir, exist_ok=True)
    with open(os.path.join(config_dir, "credentials.json"), "w", encoding="utf-8") as handle:
        json.dump(creds, handle)

print(json.dumps({"token": token, "host_id": poll["host_id"]}))
PY
)"
user_token="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])' <<<"$creds")"
host_id="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["host_id"])' <<<"$creds")"

printf '%s\n' "smoke-local-browser-live: starting spawnd for host $host_id"
HOME="$daemon_home" \
  SPAWN_DISABLE_KEYRING=1 \
  TMUX_TMPDIR="$tmux_tmp" \
  daemon/target/debug/spawnd --server "$base_url" run \
  >"$daemon_log" 2>&1 &
daemon_pid=$!

python3 - "$base_url" "$user_token" "$host_id" <<'PY'
import json
import sys
import time
import urllib.error
import urllib.request

base_url, token, host_id = sys.argv[1:]
for _ in range(120):
    req = urllib.request.Request(
        f"{base_url}/api/hosts/{host_id}",
        headers={"Authorization": f"Bearer {token}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            host = json.loads(response.read().decode())
    except urllib.error.URLError:
        time.sleep(0.1)
        continue
    if host["status"] == "online":
        raise SystemExit(0)
    time.sleep(0.1)
raise SystemExit("daemon did not come online")
PY

printf '%s\n' "smoke-local-browser-live: starting web server on $web_url"
(
  cd web
  exec env \
    SPAWN_API_PROXY_TARGET="$base_url" \
    NEXT_PUBLIC_SPAWN_WS_URL="$ws_url" \
    bun run dev -- -H 127.0.0.1 -p "$web_port"
) >"$web_log" 2>&1 &
web_pid=$!
wait_for_url "$web_url/" "web server"

printf '%s\n' "smoke-local-browser-live: driving real browser flow"
(
  cd web
  SPAWN_LIVE_WEB_URL="$web_url" \
    SPAWN_LIVE_EMAIL="$email" \
    SPAWN_LIVE_PASSWORD="$password" \
    SPAWN_LIVE_AGENT_CWD="$agent_cwd" \
    SPAWN_LIVE_AGENT_ID_FILE="$agent_id_file" \
    SPAWN_LIVE_UPLOAD_PATH="$upload_path" \
    bun - <<'JS'
import { chromium, expect } from "@playwright/test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const webUrl = process.env.SPAWN_LIVE_WEB_URL;
const email = process.env.SPAWN_LIVE_EMAIL;
const password = process.env.SPAWN_LIVE_PASSWORD;
const agentCwd = process.env.SPAWN_LIVE_AGENT_CWD;
const agentIdFile = process.env.SPAWN_LIVE_AGENT_ID_FILE;
const uploadPath = process.env.SPAWN_LIVE_UPLOAD_PATH;
if (!webUrl || !email || !password || !agentCwd || !agentIdFile || !uploadPath) {
  throw new Error("missing live browser smoke environment");
}

const command =
  'sh -lc \'printf "browser-live-ready\\n\\033[31mLIVE_RED\\033[0m\\n"; while IFS= read -r line; do printf "browser-live:%s\\n" "$line"; done\'';

const browser = await chromium.launch();
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(() => {
    globalThis.__spawnRtcEvents = [];
    const OriginalRTCPeerConnection = globalThis.RTCPeerConnection;
    if (!OriginalRTCPeerConnection) return;

    globalThis.RTCPeerConnection = class SpawnObservedPeerConnection extends OriginalRTCPeerConnection {
      constructor(...args) {
        super(...args);
        globalThis.__spawnRtcEvents.push({ type: "pc.created" });
      }

      createDataChannel(label, options) {
        const channel = super.createDataChannel(label, options);
        globalThis.__spawnRtcEvents.push({ type: "dc.created", label });
        channel.addEventListener("open", () => {
          globalThis.__spawnRtcEvents.push({ type: "dc.open", label });
        });
        channel.addEventListener("message", (event) => {
          const size =
            typeof event.data === "string" ? event.data.length : event.data?.byteLength || 0;
          globalThis.__spawnRtcEvents.push({ type: "dc.message", label, size });
        });
        const send = channel.send.bind(channel);
        channel.send = (data) => {
          const size = typeof data === "string" ? data.length : data?.byteLength || 0;
          globalThis.__spawnRtcEvents.push({ type: "dc.send", label, size });
          return send(data);
        };
        return channel;
      }
    };
  });
  const page = await context.newPage();

  await page.goto(`${webUrl}/login`);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible({ timeout: 15_000 });

  await page.goto(`${webUrl}/agents`);
  await page.getByRole("button", { name: "New agent" }).click();
  await expect(page.locator("#agent-host")).not.toHaveValue("", { timeout: 15_000 });
  await page.locator("#agent-preset").selectOption("");
  await page.getByLabel("Name").fill("browser live");
  await page.locator("#agent-cwd").fill(agentCwd);
  await page.locator("#agent-argv").fill(command);
  await page.getByRole("button", { name: "Spawn" }).click();

  const agentLink = page.getByRole("link", { name: /browser live/i }).first();
  await expect(agentLink).toBeVisible({ timeout: 20_000 });
  await agentLink.click();

  await expect(page.getByLabel("Agent terminal")).toBeVisible({ timeout: 20_000 });
  const terminalBox = await page.getByLabel("Agent terminal").boundingBox();
  if (!terminalBox || terminalBox.width < 600 || terminalBox.height < 300) {
    throw new Error(`terminal layout too small: ${JSON.stringify(terminalBox)}`);
  }
  await expect(page.locator(".xterm-rows")).toContainText("browser-live-ready", {
    timeout: 20_000,
  });
  await expect(page.locator(".xterm-rows")).toContainText("LIVE_RED", {
    timeout: 20_000,
  });
  const normalColor = await page
    .locator(".xterm-rows span", { hasText: "browser-live-ready" })
    .first()
    .evaluate((node) => window.getComputedStyle(node).color);
  const redColor = await page
    .locator(".xterm-rows span", { hasText: "LIVE_RED" })
    .first()
    .evaluate((node) => window.getComputedStyle(node).color);
  if (redColor === normalColor) {
    throw new Error(`ANSI color did not render differently: ${redColor}`);
  }
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          (globalThis.__spawnRtcEvents || []).some(
            (event) => event.type === "dc.open" && event.label === "spawn.pty",
          ),
        ),
      { timeout: 20_000 },
    )
    .toBe(true);
  const match = page.url().match(/\/agents\/([0-9a-f-]{36})/i);
  if (!match) throw new Error(`could not extract agent id from ${page.url()}`);
  const agentId = match[1];
  writeFileSync(agentIdFile, `${match[1]}\n`);

  await page.getByLabel("Agent terminal").click();
  await page.keyboard.type("ping");
  await page.keyboard.press("Enter");
  await expect(page.locator(".xterm-rows")).toContainText("browser-live:ping", {
    timeout: 20_000,
  });
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const events = globalThis.__spawnRtcEvents || [];
          return {
            sends: events.filter((event) => event.type === "dc.send" && event.label === "spawn.pty")
              .length,
            messages: events.filter(
              (event) => event.type === "dc.message" && event.label === "spawn.pty",
            ).length,
          };
        }),
      { timeout: 20_000 },
    )
    .toEqual(expect.objectContaining({ sends: expect.any(Number), messages: expect.any(Number) }));
  const rtcCounts = await page.evaluate(() => {
    const events = globalThis.__spawnRtcEvents || [];
    return {
      sends: events.filter((event) => event.type === "dc.send" && event.label === "spawn.pty")
        .length,
      messages: events.filter((event) => event.type === "dc.message" && event.label === "spawn.pty")
        .length,
    };
  });
  if (rtcCounts.sends < 1 || rtcCounts.messages < 1) {
    throw new Error(`WebRTC DataChannel did not carry terminal bytes: ${JSON.stringify(rtcCounts)}`);
  }

  await page.locator('input[type="file"]').setInputFiles({
    name: "live-upload.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("uploaded from live browser\n"),
  });
  await expect
    .poll(() => {
      if (!existsSync(uploadPath)) return "";
      return readFileSync(uploadPath, "utf8");
    }, { timeout: 20_000 })
    .toBe("uploaded from live browser\n");

  const secondPage = await page.context().newPage();
  await secondPage.goto(`${webUrl}/agents/${agentId}`);
  await expect(secondPage.getByLabel("Agent terminal")).toBeVisible({ timeout: 20_000 });
  await expect(secondPage.getByRole("button", { name: "Take control" })).toBeVisible({
    timeout: 20_000,
  });
  await secondPage.getByRole("button", { name: "Take control" }).click();
  await secondPage.getByLabel("Agent terminal").click();
  await secondPage.keyboard.type("second");
  await secondPage.keyboard.press("Enter");
  await expect(secondPage.locator(".xterm-rows")).toContainText("browser-live:second", {
    timeout: 20_000,
  });
  await secondPage.close();
  await context.close();
} finally {
  await browser.close();
}
JS
) >"$browser_log" 2>&1

grep -Fx "uploaded from live browser" "$upload_path" >/dev/null

if [[ -f "$agent_id_file" ]]; then
  live_agent_id="$(cat "$agent_id_file")"
  curl -fsS -X DELETE \
    -H "Authorization: Bearer $user_token" \
    "$base_url/api/agents/$live_agent_id" >/dev/null
fi

printf '%s\n' "smoke-local-browser-live: passed"
