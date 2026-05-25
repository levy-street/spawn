#!/usr/bin/env bash
set -euo pipefail

kind="${1:-auto}"
tmp_dir="$(mktemp -d)"
label="app.spawn.smoke.$$"
unit="spawn-smoke-$$.service"
unit_path=""
bootstrapped=0
systemd_started=0

cleanup() {
  local status=$?
  if [[ "$bootstrapped" == "1" ]]; then
    launchctl bootout "gui/$(id -u)" "$tmp_dir/$label.plist" >/dev/null 2>&1 || true
  fi
  if [[ "$systemd_started" == "1" ]]; then
    systemctl --user disable --now "$unit" >/dev/null 2>&1 || true
    [[ -n "$unit_path" ]] && rm -f "$unit_path"
    systemctl --user daemon-reload >/dev/null 2>&1 || true
  fi
  rm -rf "$tmp_dir"
  exit "$status"
}
trap cleanup EXIT

write_worker() {
  worker="$tmp_dir/worker.sh"
  cat >"$worker" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
count_file="$1"
pid_file="$2"
count=0
if [[ -f "$count_file" ]]; then
  count="$(cat "$count_file")"
fi
count=$((count + 1))
printf '%s\n' "$count" >"$count_file"
printf '%s\n' "$$" >"$pid_file"
while :; do
  sleep 60
done
SH
  chmod 755 "$worker"
}

wait_count() {
  local expected="$1"
  local count_file="$tmp_dir/count"
  for _ in {1..100}; do
    if [[ -f "$count_file" ]] && [[ "$(cat "$count_file")" -ge "$expected" ]]; then
      return 0
    fi
    sleep 0.1
  done
  printf 'smoke-service-manager: count did not reach %s; got %s\n' \
    "$expected" "$(cat "$count_file" 2>/dev/null || printf 0)" >&2
  return 1
}

kill_worker() {
  local pid_file="$tmp_dir/pid"
  [[ -f "$pid_file" ]] || {
    printf '%s\n' "smoke-service-manager: missing worker pid file" >&2
    return 1
  }
  kill -9 "$(cat "$pid_file")" >/dev/null 2>&1 || true
}

run_launchd() {
  command -v launchctl >/dev/null 2>&1 || {
    printf '%s\n' "smoke-service-manager: launchctl unavailable; skipping"
    return 0
  }
  launchctl print "gui/$(id -u)" >/dev/null 2>&1 || {
    printf '%s\n' "smoke-service-manager: launchd gui domain unavailable; skipping"
    return 0
  }
  write_worker
  plist="$tmp_dir/$label.plist"
  cat >"$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>$worker</string>
    <string>$tmp_dir/count</string>
    <string>$tmp_dir/pid</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$tmp_dir/out.log</string>
  <key>StandardErrorPath</key>
  <string>$tmp_dir/err.log</string>
</dict>
</plist>
EOF
  launchctl bootstrap "gui/$(id -u)" "$plist"
  bootstrapped=1
  wait_count 1
  launchctl print "gui/$(id -u)/$label" >/dev/null
  kill_worker
  wait_count 2
  printf '%s\n' "smoke-service-manager: launchd restart smoke passed"
}

run_systemd_user() {
  command -v systemctl >/dev/null 2>&1 || {
    printf '%s\n' "smoke-service-manager: systemctl unavailable; skipping"
    return 0
  }
  systemctl --user show-environment >/dev/null 2>&1 || {
    printf '%s\n' "smoke-service-manager: user systemd unavailable; skipping"
    return 0
  }
  write_worker
  unit_dir="$HOME/.config/systemd/user"
  mkdir -p "$unit_dir"
  unit_path="$unit_dir/$unit"
  cat >"$unit_path" <<EOF
[Unit]
Description=spawn service-manager smoke

[Service]
Type=simple
ExecStart=$worker $tmp_dir/count $tmp_dir/pid
Restart=always
RestartSec=0.2

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --now "$unit"
  systemd_started=1
  systemctl --user is-enabled "$unit" >/dev/null
  wait_count 1
  systemctl --user is-active "$unit" >/dev/null
  kill_worker
  wait_count 2
  printf '%s\n' "smoke-service-manager: systemd user restart smoke passed"
}

case "$kind" in
  auto)
    case "$(uname -s)" in
      Darwin) run_launchd ;;
      Linux) run_systemd_user ;;
      *) printf '%s\n' "smoke-service-manager: unsupported OS; skipping" ;;
    esac
    ;;
  launchd)
    run_launchd
    ;;
  systemd-user)
    run_systemd_user
    ;;
  *)
    printf 'Usage: %s [auto|launchd|systemd-user]\n' "$0" >&2
    exit 2
    ;;
esac
