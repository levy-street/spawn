#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/smoke-deploy-prod.sh

Runs an isolated smoke test for scripts/deploy-prod.sh using temporary Git
repositories and fake ssh/systemctl commands. No real remote host is contacted.
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

die() {
  printf 'smoke-deploy-prod: %s\n' "$*" >&2
  exit 1
}

repo_root="$(git rev-parse --show-toplevel 2>/dev/null)" ||
  die "run from inside the spawn repo"
cd "$repo_root"

deploy_script="$repo_root/scripts/deploy-prod.sh"
[[ -f "$deploy_script" ]] || die "missing $deploy_script"

tmpdir="$(mktemp -d /tmp/spawn-deploy-smoke.XXXXXX)"
trap 'rm -rf "$tmpdir"' EXIT INT TERM

git_init_defaults() {
  git config user.email smoke@example.com
  git config user.name "spawn smoke"
}

write_fake_bin() {
  fake_bin="$1"
  mkdir -p "$fake_bin"

  cat > "$fake_bin/ssh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
host="$1"
shift
printf 'host=%s command=%s\n' "$host" "$*" >> "$SPAWN_FAKE_SSH_LOG"
bash -c "$*"
EOF
  chmod 755 "$fake_bin/ssh"

  cat > "$fake_bin/systemctl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$SPAWN_FAKE_SYSTEMCTL_LOG"
EOF
  chmod 755 "$fake_bin/systemctl"
}

setup_repos() {
  case_dir="$tmpdir/$1"
  origin="$case_dir/origin.git"
  local_repo="$case_dir/local"
  remote_repo="$case_dir/remote"
  fake_bin="$case_dir/bin"
  ssh_log="$case_dir/ssh.log"
  systemctl_log="$case_dir/systemctl.log"

  mkdir -p "$case_dir"
  git init --bare "$origin" >/dev/null
  git clone "$origin" "$local_repo" >/dev/null 2>&1
  (
    cd "$local_repo"
    git_init_defaults
    mkdir -p scripts
    cp "$deploy_script" scripts/deploy-prod.sh
    chmod 755 scripts/deploy-prod.sh
    printf 'initial\n' > app.txt
    git add scripts/deploy-prod.sh app.txt
    git commit -m initial >/dev/null
    branch="$(git branch --show-current)"
    git push -u origin "$branch" >/dev/null 2>&1
  )
  branch="$(cd "$local_repo" && git branch --show-current)"
  git clone "$origin" "$remote_repo" >/dev/null 2>&1
  (cd "$remote_repo" && git_init_defaults)
  write_fake_bin "$fake_bin"
}

run_deploy() {
  (
    cd "$local_repo"
    PATH="$fake_bin:$PATH" \
      SPAWN_FAKE_SSH_LOG="$ssh_log" \
      SPAWN_FAKE_SYSTEMCTL_LOG="$systemctl_log" \
      SPAWN_DEPLOY_PATH="$remote_repo" \
      SPAWN_DEPLOY_BUILD=0 \
      SPAWN_DEPLOY_SUDO= \
      SPAWN_DEPLOY_SERVICES="spawn-server spawn-web" \
      scripts/deploy-prod.sh fake-prod
  )
}

expect_fail() {
  local expected="$1"
  local output status
  set +e
  output="$(run_deploy 2>&1)"
  status=$?
  set -e
  [[ "$status" -ne 0 ]] || die "expected deploy to fail with: $expected"
  grep -Fq "$expected" <<<"$output" ||
    die "expected failure containing '$expected', got: $output"
}

assert_no_ssh() {
  [[ ! -s "$ssh_log" ]] || die "ssh should not have been called"
}

assert_systemctl_called() {
  grep -Fxq -- "restart spawn-server" "$systemctl_log" ||
    die "spawn-server restart was not requested"
  grep -Fxq -- "restart spawn-web" "$systemctl_log" ||
    die "spawn-web restart was not requested"
  grep -Fxq -- "--no-pager --full status spawn-server" "$systemctl_log" ||
    die "spawn-server status was not checked"
  grep -Fxq -- "--no-pager --full status spawn-web" "$systemctl_log" ||
    die "spawn-web status was not checked"
}

setup_repos success
(
  cd "$local_repo"
  printf 'deployed\n' > app.txt
  git add app.txt
  git commit -m deployable-change >/dev/null
  git push >/dev/null 2>&1
)
run_deploy >/dev/null
remote_head="$(cd "$remote_repo" && git rev-parse HEAD)"
origin_head="$(cd "$local_repo" && git rev-parse "origin/$branch")"
[[ "$remote_head" == "$origin_head" ]] ||
  die "remote repo did not deploy origin/$branch"
grep -Fxq "deployed" "$remote_repo/app.txt" ||
  die "remote repo did not contain deployed content"
assert_systemctl_called

setup_repos local-dirty
printf 'dirty\n' >> "$local_repo/app.txt"
expect_fail "local checkout has uncommitted changes"
assert_no_ssh

setup_repos local-unpushed
(
  cd "$local_repo"
  printf 'unpushed\n' > app.txt
  git add app.txt
  git commit -m unpushed >/dev/null
)
expect_fail "unpushed commit"
assert_no_ssh

setup_repos remote-dirty
printf 'remote dirty\n' >> "$remote_repo/app.txt"
expect_fail "remote checkout has uncommitted changes"
[[ -s "$ssh_log" ]] || die "ssh should have been called for remote dirty check"

setup_repos remote-local-only
(
  cd "$remote_repo"
  printf 'remote local only\n' > app.txt
  git add app.txt
  git commit -m remote-local-only >/dev/null
)
expect_fail "production branch has"
[[ -s "$ssh_log" ]] || die "ssh should have been called for remote local-only check"

printf 'smoke-deploy-prod: ok\n'
