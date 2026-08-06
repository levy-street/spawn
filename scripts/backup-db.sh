#!/usr/bin/env bash
# Snapshot the spawn SQLite database.
#
# Uses SQLite's online backup API (`.backup`), not `cp`: the server writes
# while this runs, and copying a live database file yields a torn snapshot
# that only reveals itself on the day you need it. Every snapshot is verified
# with `PRAGMA integrity_check` BEFORE it replaces anything and before old
# snapshots are pruned — a backup that has never been read is a rumour.
set -euo pipefail

# Deliberately OUTSIDE the deployment checkout: deploys refuse to run against
# a dirty tree, and a checkout that is ever reset hard would take the
# snapshots with it.
DB_PATH="${SPAWN_DB_PATH:-/opt/spawn/server/spawn.db}"
BACKUP_DIR="${SPAWN_BACKUP_DIR:-/opt/spawn-backups}"
KEEP="${SPAWN_BACKUP_KEEP:-14}"

usage() {
  cat <<'USAGE'
Usage: backup-db.sh [--db PATH] [--dir PATH] [--keep N]

  --db    SQLite database to snapshot   (default /opt/spawn/server/spawn.db)
  --dir   Where snapshots are written   (default /opt/spawn-backups)
  --keep  How many snapshots to retain  (default 14)

Environment: SPAWN_DB_PATH, SPAWN_BACKUP_DIR, SPAWN_BACKUP_KEEP.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --db) DB_PATH="$2"; shift 2 ;;
    --dir) BACKUP_DIR="$2"; shift 2 ;;
    --keep) KEEP="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "backup-db: unknown argument $1" >&2; usage >&2; exit 2 ;;
  esac
done

say() { echo "backup-db: $*"; }
die() { echo "backup-db: $*" >&2; exit 1; }

[ -f "$DB_PATH" ] || die "database not found: $DB_PATH"
command -v sqlite3 >/dev/null || die "sqlite3 is required"

mkdir -p "$BACKUP_DIR"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
staging="$BACKUP_DIR/.staging-$stamp.db"
final="$BACKUP_DIR/spawn-$stamp.db.gz"

cleanup() { rm -f "$staging" "$staging-journal" "$staging-wal" "$staging-shm"; }
trap cleanup EXIT

# `.backup` copes with concurrent writers; `.dump`/`cp` do not.
sqlite3 "$DB_PATH" ".backup '$staging'"

integrity="$(sqlite3 "$staging" 'PRAGMA integrity_check;' | head -1)"
[ "$integrity" = "ok" ] || die "integrity check FAILED on fresh snapshot: $integrity"

# A structurally valid but empty database would also pass integrity_check;
# require the core table to be readable before trusting this snapshot.
users="$(sqlite3 "$staging" 'SELECT count(*) FROM users;')"
say "snapshot verified (integrity ok, users=$users)"

gzip -c "$staging" > "$final.partial"
mv "$final.partial" "$final"
say "wrote $final ($(du -h "$final" | cut -f1))"

# Prune only after a good snapshot exists, so a failing run never erodes
# history it could not replace.
mapfile -t stale < <(ls -1t "$BACKUP_DIR"/spawn-*.db.gz 2>/dev/null | tail -n +"$((KEEP + 1))")
for old in "${stale[@]:-}"; do
  [ -n "$old" ] || continue
  rm -f "$old"
  say "pruned $(basename "$old")"
done

count="$(ls -1 "$BACKUP_DIR"/spawn-*.db.gz 2>/dev/null | wc -l)"
say "complete: $count snapshot(s) retained in $BACKUP_DIR"
