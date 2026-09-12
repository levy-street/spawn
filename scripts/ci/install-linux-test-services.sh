#!/usr/bin/env bash
# Provision only the disposable Ubuntu CI image, never its Docker host.
set -euo pipefail
[[ "${SPAWN_RUNNER_ISOLATION:-}" == container && "$EUID" == 0 ]]
. /etc/os-release
[[ "$ID/$VERSION_ID" == ubuntu/22.04 ]]
export DEBIAN_FRONTEND=noninteractive

if [[ -x /usr/lib/postgresql/16/bin/postgres ]] && redis-server --version | grep -q 'v=7\.'; then
  /usr/lib/postgresql/16/bin/postgres --version
  redis-server --version
  exit 0
fi

# Keep the same PostgreSQL 16 / Redis 7 majors as the former Docker fixtures.
# Both package feeds are signed by their upstream project's scoped key.
install -d -m 755 /usr/share/keyrings /etc/apt/sources.list.d
curl -fsSL --retry 3 https://www.postgresql.org/media/keys/ACCC4CF8.asc \
  -o /usr/share/keyrings/spawnd-ci-pgdg.asc
curl -fsSL --retry 3 https://packages.redis.io/gpg \
  | gpg --batch --yes --dearmor -o /usr/share/keyrings/spawnd-ci-redis.gpg
chmod 644 /usr/share/keyrings/spawnd-ci-pgdg.asc /usr/share/keyrings/spawnd-ci-redis.gpg
printf '%s\n' 'deb [signed-by=/usr/share/keyrings/spawnd-ci-pgdg.asc] https://apt.postgresql.org/pub/repos/apt jammy-pgdg main' \
  > /etc/apt/sources.list.d/spawnd-ci-pgdg.list
printf '%s\n' 'deb [signed-by=/usr/share/keyrings/spawnd-ci-redis.gpg] https://packages.redis.io/deb jammy main' \
  > /etc/apt/sources.list.d/spawnd-ci-redis.list
install -d -m 755 /etc/apt/preferences.d /etc/postgresql-common
printf '%s\n' 'Package: redis-server redis-tools' 'Pin: version 6:7.*' 'Pin-Priority: 1001' \
  > /etc/apt/preferences.d/spawnd-ci-redis
printf '%s\n' 'create_main_cluster = false' > /etc/postgresql-common/createcluster.conf
apt-get update
apt-get install -y --no-install-recommends postgresql-16 'redis-server=6:7.*' 'redis-tools=6:7.*'
/usr/lib/postgresql/16/bin/postgres --version
redis-server --version | grep 'v=7\.'
