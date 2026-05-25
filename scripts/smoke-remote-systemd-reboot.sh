#!/usr/bin/env bash
set -euo pipefail

host="${1:-}"
if [[ -z "$host" ]]; then
  printf 'Usage: SPAWN_ALLOW_REBOOT=1 %s ssh-host\n' "$0" >&2
  exit 2
fi
if [[ "${SPAWN_ALLOW_REBOOT:-}" != "1" ]]; then
  printf '%s\n' "smoke-remote-systemd-reboot: refusing to reboot without SPAWN_ALLOW_REBOOT=1" >&2
  exit 2
fi

timeout="${SPAWN_REBOOT_TIMEOUT:-240}"
id="$$-$(date +%s)"
unit="spawn-reboot-smoke-$id.service"
remote_work=""

remote_cleanup() {
  if [[ -n "$remote_work" ]]; then
    ssh "$host" "SPAWN_REBOOT_SMOKE_WORK='$remote_work' bash -se" <<'REMOTE' >/dev/null 2>&1 || true
set -euo pipefail
work="$SPAWN_REBOOT_SMOKE_WORK"
if [[ -f "$work/meta" ]]; then
  # shellcheck disable=SC1090
  . "$work/meta"
  systemctl --user disable --now "$unit" >/dev/null 2>&1 || true
  rm -f "$HOME/.config/systemd/user/$unit"
  systemctl --user daemon-reload >/dev/null 2>&1 || true
  if [[ "${orig_linger:-}" == "no" ]]; then
    loginctl disable-linger "$USER" >/dev/null 2>&1 || true
  fi
fi
rm -rf "$work"
REMOTE
  fi
}
trap remote_cleanup EXIT

printf '%s\n' "smoke-remote-systemd-reboot: preparing remote user service"
remote_work="$(
  ssh "$host" "SPAWN_REBOOT_SMOKE_ID='$id' SPAWN_REBOOT_SMOKE_UNIT='$unit' bash -se" <<'REMOTE'
set -euo pipefail
need() {
  command -v "$1" >/dev/null 2>&1 || {
    printf 'missing %s\n' "$1" >&2
    exit 1
  }
}
need loginctl
need systemctl

work="$HOME/.cache/spawn-reboot-smoke-$SPAWN_REBOOT_SMOKE_ID"
unit="$SPAWN_REBOOT_SMOKE_UNIT"
mkdir -p "$work" "$HOME/.config/systemd/user"
orig_linger="$(loginctl show-user "$USER" -p Linger --value)"
cat >"$work/meta" <<EOF
unit=$unit
orig_linger=$orig_linger
EOF

cat >"$work/worker.sh" <<'SH'
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
while :; do sleep 60; done
SH
chmod 755 "$work/worker.sh"

loginctl enable-linger "$USER"
cat >"$HOME/.config/systemd/user/$unit" <<EOF
[Unit]
Description=spawn reboot smoke
After=default.target

[Service]
Type=simple
ExecStart=$work/worker.sh $work/count $work/pid
Restart=always
RestartSec=1

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now "$unit" >/dev/null

for _ in {1..100}; do
  if [[ -f "$work/count" ]] && [[ "$(cat "$work/count")" -ge 1 ]]; then
    printf '%s\n' "$work"
    exit 0
  fi
  sleep 0.1
done
printf 'service did not start before reboot\n' >&2
exit 1
REMOTE
)"

printf '%s\n' "smoke-remote-systemd-reboot: rebooting $host"
if [[ -n "${SPAWN_SUDO_PASSWORD:-}" ]]; then
  printf '%s\n' "$SPAWN_SUDO_PASSWORD" | ssh "$host" "sudo -S -p '' systemctl reboot" || true
else
  ssh "$host" "sudo -n systemctl reboot || systemctl reboot" || true
fi

deadline=$((SECONDS + timeout))
while (( SECONDS < deadline )); do
  if ! ssh -o BatchMode=yes -o ConnectTimeout=3 "$host" true >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
while (( SECONDS < deadline )); do
  if ssh -o BatchMode=yes -o ConnectTimeout=5 "$host" true >/dev/null 2>&1; then
    break
  fi
  sleep 3
done
ssh -o BatchMode=yes -o ConnectTimeout=5 "$host" true >/dev/null

printf '%s\n' "smoke-remote-systemd-reboot: verifying service restarted after reboot"
ssh "$host" "SPAWN_REBOOT_SMOKE_WORK='$remote_work' bash -se" <<'REMOTE'
set -euo pipefail
work="$SPAWN_REBOOT_SMOKE_WORK"
# shellcheck disable=SC1090
. "$work/meta"
systemctl --user is-active "$unit" >/dev/null
for _ in {1..120}; do
  if [[ -f "$work/count" ]] && [[ "$(cat "$work/count")" -ge 2 ]]; then
    printf '%s\n' "smoke-remote-systemd-reboot: passed"
    exit 0
  fi
  sleep 0.5
done
printf 'service did not restart after reboot; count=%s\n' "$(cat "$work/count" 2>/dev/null || printf 0)" >&2
exit 1
REMOTE
