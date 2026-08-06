#!/usr/bin/env bash
# Restore a spawn database snapshot.
#
# Defaults to a DRY RUN that restores into a scratch path and reports what the
# snapshot contains, because the only backup worth having is one whose restore
# you have actually watched work. Pass --into to restore somewhere specific, or
# --live to replace the running database (which stops the server first and
# keeps a pre-restore snapshot of what it replaced).
set -euo pipefail

SNAPSHOT=""
TARGET=""
LIVE=0
DB_PATH="${SPAWN_DB_PATH:-/opt/spawn/server/spawn.db}"
BACKUP_DIR="${SPAWN_BACKUP_DIR:-/opt/spawn/backups}"

usage() {
  cat <<'USAGE'
Usage: restore-db.sh [SNAPSHOT] [--into PATH] [--live]

  SNAPSHOT   Snapshot to restore (default: newest in the backup dir)
  --into     Restore to this path (default: a scratch file; prints a report)
  --live     Replace the live database: stops spawn-server, snapshots the
             current database first, restores, then starts the server again.

Environment: SPAWN_DB_PATH, SPAWN_BACKUP_DIR.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --into) TARGET="$2"; shift 2 ;;
    --live) LIVE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "restore-db: unknown argument $1" >&2; usage >&2; exit 2 ;;
    *) SNAPSHOT="$1"; shift ;;
  esac
done

say() { echo "restore-db: $*"; }
die() { echo "restore-db: $*" >&2; exit 1; }

if [ -z "$SNAPSHOT" ]; then
  SNAPSHOT="$(ls -1t "$BACKUP_DIR"/spawn-*.db.gz 2>/dev/null | head -1 || true)"
  [ -n "$SNAPSHOT" ] || die "no snapshots found in $BACKUP_DIR"
fi
[ -f "$SNAPSHOT" ] || die "snapshot not found: $SNAPSHOT"
command -v sqlite3 >/dev/null || die "sqlite3 is required"

scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
staged="$scratch/restored.db"
gunzip -c "$SNAPSHOT" > "$staged"

integrity="$(sqlite3 "$staged" 'PRAGMA integrity_check;' | head -1)"
[ "$integrity" = "ok" ] || die "snapshot FAILED integrity check: $integrity"

say "snapshot: $SNAPSHOT"
say "integrity: ok"
for table in users hosts agents browser_devices host_browser_pins trust_bundles; do
  count="$(sqlite3 "$staged" "SELECT count(*) FROM $table;" 2>/dev/null || echo "n/a")"
  say "  $table: $count"
done

if [ "$LIVE" = "1" ]; then
  say "LIVE restore into $DB_PATH"
  sudo -n systemctl stop spawn-server || die "could not stop spawn-server"
  # Keep what we are about to overwrite: a restore chosen in a hurry is the
  # most likely thing to be the wrong choice.
  if [ -f "$DB_PATH" ]; then
    pre="$BACKUP_DIR/pre-restore-$(date -u +%Y%m%dT%H%M%SZ).db.gz"
    mkdir -p "$BACKUP_DIR"
    sqlite3 "$DB_PATH" ".backup '$scratch/pre-restore.db'"
    gzip -c "$scratch/pre-restore.db" > "$pre"
    say "previous database saved to $pre"
  fi
  cp "$staged" "$DB_PATH"
  sudo -n systemctl start spawn-server || die "restored, but spawn-server did not start"
  say "live restore complete; spawn-server restarted"
  exit 0
fi

if [ -n "$TARGET" ]; then
  cp "$staged" "$TARGET"
  say "restored to $TARGET"
  exit 0
fi

say "dry run only — nothing was modified (use --into PATH or --live)"
