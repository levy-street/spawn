#!/usr/bin/env bash
# Copy production database snapshots to this machine.
#
# Deliberately a PULL: the production box holds no credentials to anywhere
# else, so compromising it cannot reach the off-box copies — which is the
# entire point of having them. Run from any trusted machine that can already
# ssh to the server.
set -euo pipefail

HOST="${SPAWN_BACKUP_HOST:-spawnd-prod}"
REMOTE_DIR="${SPAWN_BACKUP_REMOTE_DIR:-/opt/spawn-backups}"
LOCAL_DIR="${SPAWN_BACKUP_LOCAL_DIR:-$HOME/backups/spawn-prod}"
KEEP="${SPAWN_BACKUP_KEEP_LOCAL:-30}"

say() { echo "pull-backups: $*"; }
die() { echo "pull-backups: $*" >&2; exit 1; }

mkdir -p "$LOCAL_DIR"
command -v rsync >/dev/null || die "rsync is required"

rsync -az --prune-empty-dirs \
  --include='spawn-*.db.gz' --include='pre-restore-*.db.gz' --exclude='*' \
  "$HOST:$REMOTE_DIR/" "$LOCAL_DIR/"

newest="$(ls -1t "$LOCAL_DIR"/spawn-*.db.gz 2>/dev/null | head -1 || true)"
[ -n "$newest" ] || die "no snapshots pulled from $HOST:$REMOTE_DIR"

# Verify locally rather than trusting that a file arrived: a copy that cannot
# be decompressed is not a backup, and finding that out here is free.
gunzip -t "$newest" || die "newest snapshot failed decompression: $newest"

age_hours=$(( ( $(date +%s) - $(stat -c %Y "$newest") ) / 3600 ))
say "newest: $(basename "$newest") (${age_hours}h old)"
if [ "$age_hours" -gt 48 ]; then
  # Louder than a missing file: the timer looking healthy while producing
  # nothing new is the failure that goes unnoticed for months.
  say "WARNING: newest snapshot is over 48h old — is the remote timer running?"
fi

mapfile -t stale < <(ls -1t "$LOCAL_DIR"/spawn-*.db.gz 2>/dev/null | tail -n +"$((KEEP + 1))")
for old in "${stale[@]:-}"; do
  [ -n "$old" ] || continue
  rm -f "$old"
done

count="$(ls -1 "$LOCAL_DIR"/spawn-*.db.gz 2>/dev/null | wc -l)"
say "complete: $count snapshot(s) in $LOCAL_DIR"
