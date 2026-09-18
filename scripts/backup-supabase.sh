#!/usr/bin/env bash
#
# BTS Web (Bireysel Takip Sistemi) - Supabase Yerel Yedek
# Docker/Podman GEREKTIRMEZ. Supabase CLI login/link GEREKMEZ.
#
# Kullanim: bash scripts/backup-supabase.sh
#
# Tek seferlik kurulum:
#   1) pg_dump / pg_dumpall gerekli. EnterpriseDB'nin indirme CDN'i
#      Turkiye gibi bazi bolgelerden gelen istekleri 403 ile engelledigi
#      icin (scoop/winget de ayni CDN'i kullanir), bu proje kendi
#      pg_dump binary'lerini proje kokundeki ".pgtools/bin/" altinda tasir
#      (theseus-rs/postgresql-binaries, GitHub Releases uzerinden).
#      Sistemde zaten pg_dump kuruluysa o kullanilir.
#   2) Proje kokunde bir ".env" dosyasi olustur ve icine ekle:
#        SUPABASE_DB_PASSWORD=...
#      (Sifre: Supabase Dashboard > sag ustte "Connect" > "Session pooler"
#       sekmesi > "Reset database password")

set -euo pipefail

PROJECT_REF="ldxeenczugcoirdrldjv"
REGION="ap-northeast-1"
KEEP_COUNT=15

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

ENV_FILE="$PROJECT_ROOT/.env"
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source <(grep -v '^[[:space:]]*#' "$ENV_FILE" | grep -v '^[[:space:]]*$')
  set +a
fi

if [ -z "${SUPABASE_DB_PASSWORD:-}" ]; then
  echo "HATA: proje kokundeki .env dosyasinda SUPABASE_DB_PASSWORD bulunamadi." >&2
  echo "Ekle: SUPABASE_DB_PASSWORD=... (Dashboard > Connect > Reset database password)" >&2
  exit 1
fi

POOLER_HOST="${SUPABASE_POOLER_HOST:-aws-1-$REGION.pooler.supabase.com}"
POOLER_USER="postgres.$PROJECT_REF"
POOLER_PORT=5432
POOLER_DB="postgres"

LOCAL_PG_BIN="$PROJECT_ROOT/.pgtools/bin"
if command -v pg_dump >/dev/null 2>&1; then
  PG_DUMP="pg_dump"
  PG_DUMPALL="pg_dumpall"
elif [ -x "$LOCAL_PG_BIN/pg_dump.exe" ]; then
  PG_DUMP="$LOCAL_PG_BIN/pg_dump.exe"
  PG_DUMPALL="$LOCAL_PG_BIN/pg_dumpall.exe"
else
  echo "HATA: pg_dump bulunamadi (sistemde de $LOCAL_PG_BIN altinda da yok)." >&2
  exit 1
fi

TIMESTAMP="$(date +%Y-%m-%d_%H%M)"
BACKUP_ROOT="$PROJECT_ROOT/Supabase Yedek"
BACKUP_DIR="$BACKUP_ROOT/$TIMESTAMP"
mkdir -p "$BACKUP_DIR"
echo "Supabase yedegi aliniyor -> $BACKUP_DIR"

export PGPASSWORD="$SUPABASE_DB_PASSWORD"
cleanup() { unset PGPASSWORD; }
trap cleanup EXIT

COMMON_ARGS=(-h "$POOLER_HOST" -p "$POOLER_PORT" -U "$POOLER_USER")

echo "  - Roller..."
if ! "$PG_DUMPALL" "${COMMON_ARGS[@]}" --roles-only -f "$BACKUP_DIR/roles.sql"; then
  echo "UYARI: roller yedeklenemedi (kritik degil)." >&2
fi

echo "  - Sema..."
"$PG_DUMP" "${COMMON_ARGS[@]}" -d "$POOLER_DB" --schema-only --no-owner --no-privileges \
  -f "$BACKUP_DIR/schema.sql"

echo "  - Veri..."
"$PG_DUMP" "${COMMON_ARGS[@]}" -d "$POOLER_DB" --data-only --no-owner --no-privileges \
  --exclude-table=storage.buckets_vectors --exclude-table=storage.vector_indexes \
  -f "$BACKUP_DIR/data.sql"

SIZE_KB=$(du -k -c "$BACKUP_DIR"/*.sql 2>/dev/null | tail -1 | cut -f1)
echo "Tamamlandi: $BACKUP_DIR (${SIZE_KB} KB)"

# Eski yedekleri temizle (son KEEP_COUNT tanesini tut)
mapfile -t ALL_BACKUPS < <(ls -1 "$BACKUP_ROOT" | sort -r)
if [ "${#ALL_BACKUPS[@]}" -gt "$KEEP_COUNT" ]; then
  for old in "${ALL_BACKUPS[@]:$KEEP_COUNT}"; do
    echo "Eski yedek siliniyor: $old"
    rm -rf "$BACKUP_ROOT/$old"
  done
fi

echo "Son yedek: $BACKUP_DIR"
