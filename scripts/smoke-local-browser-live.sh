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
need uv

tmp_dir="$(mktemp -d)"
server_pid=""
web_pid=""
daemon_pid=""
user_token=""
base_url=""
worker_dir="$tmp_dir/workers"

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


agents = request("GET", "/api/sessions")
if isinstance(agents, list):
    for agent in agents:
        agent_id = agent.get("id")
        if agent_id:
            request("DELETE", f"/api/sessions/{agent_id}")
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
upload_path="$agent_cwd/live-upload.txt"
email="browser-live@example.com"
password="passpasspass"
mkdir -p "$daemon_home" "$agent_cwd" "$worker_dir"

# Sessions are always the host's login shell (resolved from $SHELL in the
# daemon's environment), so the argv-era custom command becomes the shell
# itself: ready marker, an ANSI-red line for the color assertion, then an
# echo loop the typing assertions drive.
live_shell="$tmp_dir/live-shell"
cat >"$live_shell" <<'SH'
#!/usr/bin/env sh
printf 'browser-live-ready\n'
printf '\033[31mLIVE_RED\033[0m\n'
while IFS= read -r line; do
  printf 'browser-live:%s\n' "$line"
done
SH
chmod 755 "$live_shell"

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
    SPAWN_WEBRTC_ENABLED=1 \
    uv run uvicorn spawn_server.main:app --host 127.0.0.1 --port "$server_port"
) >"$server_log" 2>&1 &
server_pid=$!
wait_for_url "$base_url/healthz" "API server"

printf '%s\n' "smoke-local-browser-live: provisioning daemon credentials"
creds="$(
  cd server
  uv run python - "$base_url" "$daemon_home" "$email" "$password" <<'PY'
import json
import os
import sys
import base64
import urllib.error
import urllib.request
import uuid

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from spawn_server.browser_registration import encode_browser_registration_transcript
from spawn_server.host_identity import decode_ed25519_public_key, ed25519_key_fingerprint
from spawn_server.host_pair_approval import (
    decode_approval_nonce,
    encode_host_pair_approval_transcript,
)
from spawn_server.host_pair_possession import (
    decode_device_code,
    encode_host_pair_possession_transcript,
)

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
user_id = signup["user"]["id"]
seed = bytes.fromhex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60")
public = bytes.fromhex("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a")
host_public_key = base64.urlsafe_b64encode(public).rstrip(b"=").decode()
host_binding = {
    "host_key_algorithm": "ed25519",
    "host_public_key": host_public_key,
}
start = request(
    "POST",
    "/api/auth/device/start",
    {
        "host_name": "browser-live-host",
        "os": sys.platform,
        "arch": "smoke",
        "version": "smoke",
        **host_binding,
    },
)
host_key = Ed25519PrivateKey.from_private_bytes(seed)
possession_transcript = encode_host_pair_possession_transcript(
    decode_device_code(start["device_code"]),
    decode_approval_nonce(start["approval_nonce"]),
    public,
)
possession = request(
    "POST",
    "/api/auth/device/possession",
    {
        "device_code": start["device_code"],
        "approval_nonce": start["approval_nonce"],
        **host_binding,
        "signature": base64.urlsafe_b64encode(
            host_key.sign(possession_transcript)
        ).rstrip(b"=").decode(),
    },
)
if possession != {"verified": True, "version": 1}:
    raise SystemExit(f"unexpected host possession response: {possession!r}")
reviewed = request("POST", "/api/auth/device/pending", {"user_code": start["user_code"]}, token)
browser_key = Ed25519PrivateKey.generate()
browser_public = browser_key.public_key().public_bytes_raw()
browser_public_key = base64.urlsafe_b64encode(browser_public).rstrip(b"=").decode()
registration = encode_browser_registration_transcript(user_id, browser_public, is_root=False)
browser = request(
    "POST",
    "/api/browser-devices/register",
    {
        "key_algorithm": "ed25519",
        "public_key": browser_public_key,
        "signature": base64.urlsafe_b64encode(browser_key.sign(registration)).rstrip(b"=").decode(),
    },
    token,
)
approval_transcript = encode_host_pair_approval_transcript(
    user_id,
    decode_approval_nonce(reviewed["approval_nonce"]),
    decode_ed25519_public_key(reviewed["host_public_key"]),
    browser_public,
)
approval = {
    "user_code": start["user_code"],
    "approval_nonce": reviewed["approval_nonce"],
    "host_key_algorithm": reviewed["host_key_algorithm"],
    "host_public_key": reviewed["host_public_key"],
    "host_key_fingerprint": reviewed["host_key_fingerprint"],
    "browser_device_id": browser["id"],
    "browser_key_algorithm": browser["key_algorithm"],
    "browser_public_key": browser["public_key"],
    "browser_key_fingerprint": ed25519_key_fingerprint(browser["public_key"]),
    "signature": base64.urlsafe_b64encode(browser_key.sign(approval_transcript)).rstrip(b"=").decode(),
}
approved = request(
    "POST",
    "/api/auth/device/approve",
    approval,
    token,
)
if any(approved.get(field) != value for field, value in approval.items() if field not in {"user_code", "signature", "host_key_fingerprint", "browser_key_fingerprint"}):
    raise SystemExit(f"approval response changed reviewed identity: {approved!r}")
poll = request(
    "POST",
    "/api/auth/device/poll",
    {"device_code": start["device_code"], **host_binding},
)

creds = {
    "credential_record_version": 1,
    "credential_generation": 1,
    "credential_record_id": str(uuid.uuid4()),
    "access_token": poll["access_token"],
    "host_id": poll["host_id"],
    "server_url": base_url,
    "host_private_key_seed": base64.urlsafe_b64encode(seed).rstrip(b"=").decode(),
    "browser_pins": [
        {
            "browser_device_id": poll["browser_device_id"],
            "browser_key_algorithm": poll["browser_key_algorithm"],
            "browser_public_key": poll["browser_public_key"],
            "browser_key_fingerprint": poll["browser_key_fingerprint"],
        }
    ],
}
for config_dir in (
    os.path.join(home, ".config", "spawn"),
    os.path.join(home, "Library", "Application Support", "spawn"),
):
    os.makedirs(config_dir, exist_ok=True)
    os.chmod(config_dir, 0o700)
    with open(os.path.join(config_dir, "credentials.json"), "w", encoding="utf-8") as handle:
        json.dump(creds, handle)
    os.chmod(os.path.join(config_dir, "credentials.json"), 0o600)

print(
    json.dumps(
        {
            "token": token,
            "host_id": poll["host_id"],
            # The synthetic approved browser is the daemon's pin (its anchor).
            # The live Playwright browser registers its OWN device key and the
            # mesh daemon rightly refuses it without a chain — so the live flow
            # below endorses it FROM this anchor, exactly as the product's
            # add-device ceremony would.
            "account_id": user_id,
            "anchor_device_id": browser["id"],
            "anchor_public_key": browser["public_key"],
            "anchor_seed": base64.urlsafe_b64encode(
                browser_key.private_bytes_raw()
            ).rstrip(b"=").decode(),
        }
    )
)
PY
)"
user_token="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])' <<<"$creds")"
host_id="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["host_id"])' <<<"$creds")"
account_id="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["account_id"])' <<<"$creds")"
anchor_device_id="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["anchor_device_id"])' <<<"$creds")"
anchor_public_key="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["anchor_public_key"])' <<<"$creds")"
anchor_seed="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["anchor_seed"])' <<<"$creds")"

printf '%s\n' "smoke-local-browser-live: starting spawnd for host $host_id"
env \
  -u SPAWN_ACCESS_TOKEN \
  -u SPAWN_DAEMON_TOKEN \
  -u SPAWN_HOST_ID \
  -u SPAWN_SERVER_URL \
  -u XDG_CONFIG_HOME \
  HOME="$daemon_home" \
  SPAWN_CONFIG_DIR="$daemon_home/.config/spawn" \
  SPAWN_DISABLE_KEYRING=1 \
  SPAWND_WORKER_DIR="$worker_dir" \
  SHELL="$live_shell" \
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

# The since-replaced creation form is covered by the web e2e suite; the live
# smoke's unique value is the real daemon + WebRTC path, so the workspace and
# its first shell session come from the API the form itself would call.
printf '%s\n' "smoke-local-browser-live: creating live workspace and first shell session"
live_ids="$(
  python3 - "$base_url" "$user_token" "$host_id" "$agent_cwd" <<'PY'
import json
import sys
import urllib.error
import urllib.request

base_url, token, host_id, cwd = sys.argv[1:]
req = urllib.request.Request(
    f"{base_url}/api/workspaces",
    data=json.dumps(
        {
            "name": "browser live",
            "first_session": {"host_id": host_id, "cwd": cwd},
        }
    ).encode(),
    method="POST",
    headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
)
try:
    with urllib.request.urlopen(req, timeout=10) as response:
        created = json.loads(response.read().decode())
except urllib.error.HTTPError as error:
    raise SystemExit(f"workspace create failed: {error.code} {error.read().decode()}")
print(
    json.dumps(
        {
            "workspace_id": created["workspace"]["id"],
            "session_id": created["session"]["id"],
        }
    )
)
PY
)"
workspace_id="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["workspace_id"])' <<<"$live_ids")"
live_session_id="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["session_id"])' <<<"$live_ids")"

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
    SPAWN_LIVE_WORKSPACE_ID="$workspace_id" \
    SPAWN_LIVE_SESSION_ID="$live_session_id" \
    SPAWN_LIVE_UPLOAD_PATH="$upload_path" \
    SPAWN_LIVE_ACCOUNT_ID="$account_id" \
    SPAWN_LIVE_ANCHOR_DEVICE_ID="$anchor_device_id" \
    SPAWN_LIVE_ANCHOR_PUBLIC_KEY="$anchor_public_key" \
    SPAWN_LIVE_ANCHOR_SEED="$anchor_seed" \
    bun - <<'JS'
import { chromium, expect } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";

const webUrl = process.env.SPAWN_LIVE_WEB_URL;
const email = process.env.SPAWN_LIVE_EMAIL;
const password = process.env.SPAWN_LIVE_PASSWORD;
const workspaceId = process.env.SPAWN_LIVE_WORKSPACE_ID;
const sessionId = process.env.SPAWN_LIVE_SESSION_ID;
const uploadPath = process.env.SPAWN_LIVE_UPLOAD_PATH;
const accountId = process.env.SPAWN_LIVE_ACCOUNT_ID;
const anchorDeviceId = process.env.SPAWN_LIVE_ANCHOR_DEVICE_ID;
const anchorPublicKey = process.env.SPAWN_LIVE_ANCHOR_PUBLIC_KEY;
const anchorSeed = process.env.SPAWN_LIVE_ANCHOR_SEED;
if (
  !webUrl || !email || !password || !workspaceId || !sessionId || !uploadPath ||
  !accountId || !anchorDeviceId || !anchorPublicKey || !anchorSeed
) {
  throw new Error("missing live browser smoke environment");
}

const b64urlToBytes = (wire) => {
  const padded = wire + "=".repeat((4 - (wire.length % 4)) % 4);
  return Uint8Array.from(Buffer.from(padded, "base64url"));
};
const bytesToB64url = (bytes) => Buffer.from(bytes).toString("base64url");
const uuidBytes = (value) => {
  const hex = value.replaceAll("-", "");
  return Uint8Array.from({ length: 16 }, (_, i) => Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16));
};

// Endorse the live browser's freshly-registered device from the synthetic
// pinned anchor: SPAWN-ACCT-ENDORSE-V1, byte-identical to
// web/src/lib/acct-endorsement-transcript.ts. Without this edge the mesh
// daemon refuses the browser's signed RTC offers (no chain to an anchor) —
// exactly what the add-device ceremony provides for a real second device.
async function endorseLiveDevice(page) {
  let device = null;
  for (let attempt = 0; attempt < 60 && !device; attempt += 1) {
    const listed = await page.request.get(`${webUrl}/api/browser-devices`);
    if (listed.ok()) {
      const rows = await listed.json();
      device =
        rows.find((row) => row.id !== anchorDeviceId && !row.is_root && row.revoked_at === null) ??
        null;
    }
    if (!device) await page.waitForTimeout(500);
  }
  if (!device) throw new Error("live browser device never registered");

  const magic = new TextEncoder().encode("SPAWN-ACCT-ENDORSE-V1");
  const anchorPk = b64urlToBytes(anchorPublicKey);
  const endorsedPk = b64urlToBytes(device.public_key);
  const transcript = new Uint8Array(magic.length + 1 + 16 + 32 + 32 + 16);
  let offset = 0;
  for (const field of [magic, Uint8Array.of(1), uuidBytes(accountId), anchorPk, endorsedPk, uuidBytes(device.id)]) {
    transcript.set(field, offset);
    offset += field.length;
  }

  const pkcs8 = new Uint8Array([
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70,
    0x04, 0x22, 0x04, 0x20, ...b64urlToBytes(anchorSeed),
  ]);
  const key = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key, transcript));

  const posted = await page.request.post(`${webUrl}/api/trust/account-endorsements`, {
    data: {
      endorser_device_id: anchorDeviceId,
      endorsed_device_id: device.id,
      signature: bytesToB64url(signature),
    },
  });
  if (!posted.ok()) {
    throw new Error(`endorsing the live browser failed: ${posted.status()} ${await posted.text()}`);
  }
  console.log(`live browser device ${device.id} endorsed by the pinned anchor`);
}

const browser = await chromium.launch({
  args: ["--disable-features=WebRtcHideLocalIpsWithMdns"],
});
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
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 15_000 });

  await endorseLiveDevice(page);

  // The workspace and its first shell session already exist — created through
  // the same API the launcher calls, so the live flow starts at the surface
  // this smoke uniquely covers: the real terminal over the real daemon.
  await page.goto(`${webUrl}/w/${workspaceId}`);

  await expect(page.getByLabel("Session terminal")).toBeVisible({ timeout: 20_000 });
  const terminalBox = await page.getByLabel("Session terminal").boundingBox();
  if (!terminalBox || terminalBox.width < 600 || terminalBox.height < 300) {
    throw new Error(`terminal layout too small: ${JSON.stringify(terminalBox)}`);
  }
  await expect(page.locator('[data-testid="terminal-live-host"] .xterm-rows')).toContainText("browser-live-ready", {
    timeout: 20_000,
  });
  await expect(page.locator('[data-testid="terminal-live-host"] .xterm-rows')).toContainText("LIVE_RED", {
    timeout: 20_000,
  });
  const normalColor = await page
    .locator('[data-testid="terminal-live-host"] .xterm-rows span', { hasText: "browser-live-ready" })
    .first()
    .evaluate((node) => window.getComputedStyle(node).color);
  const redColor = await page
    .locator('[data-testid="terminal-live-host"] .xterm-rows span', { hasText: "LIVE_RED" })
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
  await page.getByLabel("Session terminal").click();
  await page.keyboard.type("ping");
  await page.keyboard.press("Enter");
  await expect(page.locator('[data-testid="terminal-live-host"] .xterm-rows')).toContainText("browser-live:ping", {
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
  await secondPage.goto(`${webUrl}/w/${workspaceId}`);
  await expect(secondPage.getByLabel("Session terminal")).toBeVisible({ timeout: 20_000 });
  // A newly opened active terminal claims control automatically. The original
  // viewer becomes dimmed and may explicitly reclaim it.
  await expect(page.getByRole("button", { name: "Take control" })).toBeVisible({
    timeout: 20_000,
  });
  await expect(secondPage.getByRole("button", { name: "Take control" })).toHaveCount(0);
  await secondPage.getByLabel("Session terminal").click();
  await secondPage.keyboard.type("second");
  await secondPage.keyboard.press("Enter");
  await expect(secondPage.locator('[data-testid="terminal-live-host"] .xterm-rows')).toContainText("browser-live:second", {
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

curl -fsS -X DELETE \
  -H "Authorization: Bearer $user_token" \
  "$base_url/api/sessions/$live_session_id" >/dev/null

printf '%s\n' "smoke-local-browser-live: passed"
