# R2 implementation report — release / infra / connection health

## Files

- Added `infra/nginx-spawnd.conf.example`.
- Added `infra/coturn.conf.example`.
- Added `docs/NETWORK.md` and linked it from `docs/RELEASE.md`.
- Added the dependency-free `scripts/connection-probe.py`.
- Updated `scripts/health-check.sh`.
- Extended the existing versioning-aware `scripts/deploy-prod.sh` without
  changing its prebuilt/release identity gates.
- Extended `server/tests/test_deploy_prod_script.py`.
- `server/tests/test_update_mobile_script.py` was not changed; its required
  regression suite was run alongside the deploy tests.

## Per-item checklist

### 1. nginx example

- [x] Mirrors the verified TLS/Let's Encrypt `spawnd.dev` vhost and proxies to
  Next on `localhost:3001`.
- [x] Preserves Upgrade headers on `/` and adds a dedicated `/ws/` location.
- [x] Uses `map $http_upgrade $connection_upgrade`.
- [x] Sets `proxy_read_timeout 300s` and `proxy_send_timeout 300s` on `/ws/`.
- [x] Explains that 25-second application pings make 60 seconds survivable but
  300 seconds is intended.

### 2. coturn and network documentation

- [x] Example matches current production: UDP+TCP 3478, `use-auth-secret`,
  `realm=spawnd.dev`, `external-ip=98.83.222.112/10.0.0.127`, and no TLS
  listener.
- [x] Documents an ordinary UDP `turn:` endpoint as mandatory for daemons
  because webrtc-rs 0.17 cannot use TURN-TCP/TLS.
- [x] Documents optional `turns:` on 443 for browser/phone fallback, including
  hostname + Let's Encrypt certificate requirements and the fact that it is
  not enabled in current production.
- [x] Documents the single-IP 443 conflict and second-IP, SNI-routing, and
  STUNner options.
- [x] Documents coturn listener/relay firewall rules and the distinct daemon
  UDP 50000–50100 inbound range, including a concrete UFW LAN rule.
- [x] Documents and names the one-uvicorn-worker constraint and the Redis +
  `owner_dispatch` horizontal-scaling follow-up.

### 3. health and deploy probes

- [x] Public WebSocket probe offers `spawn.alerts.v1` anonymously and validates
  the complete HTTP 101 handshake, negotiated subprotocol/accept key, then
  WebSocket close 1008.
- [x] Probe uses Python 3 standard library only; missing Python/probe support
  warns and skips, while a reachable/configured endpoint that violates the
  contract fails health.
- [x] When `SPAWN_TURN_URLS` is set, health appends `coturn` to `UNITS`, selects
  a configured UDP `turn:` endpoint, sends an RFC 5389 STUN Binding request,
  and validates the success response and transaction ID.
- [x] Missing UDP `turn:` in a configured TURN list is a health failure because
  daemons require it.
- [x] `deploy-prod.sh` retains its internal `/healthz` smoke and also invokes
  the public WebSocket probe using `SPAWN_DEPLOY_PUBLIC_ORIGIN` (default
  `https://spawnd.dev`). Older/minimal deployed checkouts feature-detect the
  absent helper and warn instead of assuming it exists.
- [x] Deploy and health self-tests cover the new pure parsing/wiring without
  contacting SSH, GitHub, systemd, curl endpoints, or production.

### 4. explicitly excluded work

- [x] Did not add `scripts/smoke-connection.sh` or start a local server, daemon,
  or browser smoke environment.

## Verification

```text
$ bash -n scripts/*.sh
(exit 0; no output)

$ scripts/deploy-prod.sh --self-test
connection-probe: self-test ok
health: self-test ok
deploy-prod: self-test ok

$ scripts/health-check.sh --self-test
connection-probe: self-test ok
health: self-test ok

$ cd server && .venv/bin/python -m pytest -q tests/test_update_mobile_script.py tests/test_deploy_prod_script.py
...............                                                          [100%]
15 passed in 16.53s

$ server/.venv/bin/ruff check scripts/connection-probe.py server/tests/test_deploy_prod_script.py
All checks passed!
```

`python3 -m py_compile scripts/connection-probe.py` also passed. `shellcheck`
was unavailable, so it was skipped; the required `bash -n` check passed.

## Undone

- No in-scope implementation work remains.
- The examples were not installed on production and live public WebSocket/TURN
  probes were not run; this stream changes repository code and documentation,
  not production state.
- `turns:` on 443 remains an explicitly documented future deployment option,
  not a claim that production currently serves it.

## Notes

- No git-writing command was run.
- No files outside R2 ownership were edited, apart from this required report.
- The existing daemon release identity, self-update, prebuilt publication,
  `/api/release` proof, and 4003/versioning deploy behavior were left intact.
