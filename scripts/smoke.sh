#!/usr/bin/env bash
# Smoke test stack Purrtein infra — jalankan DI VPS dari folder repo:
#   bash scripts/smoke.sh
#
# Memverifikasi tiap service hidup & reachable supaya nggak ada kejutan pas dipakai:
#   - semua container compose "Up"
#   - Postgres  : pg_isready + query SELECT 1
#   - Redis     : PING = PONG (+ AUTH kalau REDIS pakai password)
#   - EMQX      : broker "is started"
#   - mediamtx  : port WHEP :8889 merespons
#   - ingest    : port :8080 terbuka
#   - Keamanan  : Postgres/Redis HANYA bind 127.0.0.1 (bukan publik)
#
# Exit code 0 = semua lolos, non-zero = ada yang gagal (aman dipakai di CI).

set -uo pipefail
cd "$(dirname "$0")/.." || exit 2

# Muat .env kalau ada (buat POSTGRES_USER/DB, dsb)
if [ -f .env ]; then
  set -a; . ./.env; set +a
fi
POSTGRES_USER="${POSTGRES_USER:-purrtein}"
POSTGRES_DB="${POSTGRES_DB:-purrtein}"

# Deteksi command redis-cli password (kalau command redis pakai --requirepass, isi REDIS_PASSWORD di .env)
REDIS_AUTH=()
[ -n "${REDIS_PASSWORD:-}" ] && REDIS_AUTH=(-a "$REDIS_PASSWORD")

GREEN='\033[0;32m'; RED='\033[0;31m'; YEL='\033[0;33m'; NC='\033[0m'
PASS=0; FAIL=0

ok()   { echo -e "  ${GREEN}✓${NC} $1"; PASS=$((PASS+1)); }
bad()  { echo -e "  ${RED}✗${NC} $1"; FAIL=$((FAIL+1)); }
info() { echo -e "${YEL}==>${NC} $1"; }

dc() { docker compose "$@"; }

# ── 1. Container semua Up ────────────────────────────────────────────────
info "Status container"
NOT_UP=$(dc ps --format '{{.Name}} {{.State}}' 2>/dev/null | grep -v -E ' running$' || true)
if dc ps >/dev/null 2>&1; then
  if [ -z "$NOT_UP" ]; then ok "semua container running"; else bad "ada container tidak running:\n$NOT_UP"; fi
else
  bad "docker compose tidak bisa diakses"
fi

# ── 2. Postgres ──────────────────────────────────────────────────────────
info "Postgres"
if dc exec -T postgres pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1; then
  ok "pg_isready OK"
else
  bad "pg_isready gagal (cek POSTGRES_* di .env)"
fi
if dc exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc 'SELECT 1' 2>/dev/null | grep -q '^1$'; then
  ok "query SELECT 1 OK"
else
  bad "query gagal (auth/db salah?)"
fi

# ── 3. Redis ─────────────────────────────────────────────────────────────
info "Redis"
PONG=$(dc exec -T redis redis-cli "${REDIS_AUTH[@]}" ping 2>/dev/null | tr -d '\r')
if [ "$PONG" = "PONG" ]; then
  ok "PING = PONG"
else
  bad "PING gagal (got: '$PONG') — kalau pakai requirepass, set REDIS_PASSWORD di .env"
fi
# Pastikan AOF aktif (persistence job BullMQ)
AOF=$(dc exec -T redis redis-cli "${REDIS_AUTH[@]}" config get appendonly 2>/dev/null | tr -d '\r' | tail -1)
[ "$AOF" = "yes" ] && ok "appendonly (AOF) aktif" || bad "appendonly bukan 'yes' (got: '$AOF')"

# ── 4. EMQX ──────────────────────────────────────────────────────────────
info "EMQX (mqtt)"
if dc exec -T mqtt emqx ctl status 2>/dev/null | grep -q "is started"; then
  ok "broker is started"
else
  bad "broker belum started"
fi

# ── 5. mediamtx WHEP ─────────────────────────────────────────────────────
info "mediamtx"
CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://localhost:8889/ 2>/dev/null || echo 000)
if [ "$CODE" != "000" ]; then ok "port WHEP :8889 merespons (HTTP $CODE)"; else bad "WHEP :8889 tak merespons"; fi

# ── 6. h264-ingest ───────────────────────────────────────────────────────
info "h264-ingest"
# GET / → 404 (server hanya terima POST /ingest/<id>), tapi koneksi = port hidup
ICODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://localhost:8080/ 2>/dev/null || echo 000)
if [ "$ICODE" != "000" ]; then ok "port :8080 terbuka (HTTP $ICODE)"; else bad ":8080 tak merespons"; fi

# ── 7. Security: DB tidak publik ─────────────────────────────────────────
info "Keamanan (DB harus loopback only)"
check_loopback() {
  local port="$1" name="$2"
  # Cari listener di port; harus 127.0.0.1, JANGAN 0.0.0.0/::
  local listen
  listen=$(ss -tlnH "sport = :$port" 2>/dev/null || netstat -tln 2>/dev/null | grep ":$port ")
  if [ -z "$listen" ]; then
    bad "$name :$port tidak terlihat listening di host"
  elif echo "$listen" | grep -qE '0\.0\.0\.0:'"$port"'|(\*|\[::\]):'"$port"; then
    bad "$name :$port terbuka ke PUBLIK (0.0.0.0) — harusnya 127.0.0.1!"
  else
    ok "$name :$port hanya loopback"
  fi
}
check_loopback 5432 "Postgres"
check_loopback 6379 "Redis"

# ── Ringkasan ────────────────────────────────────────────────────────────
echo
echo -e "Hasil: ${GREEN}${PASS} lolos${NC}, ${RED}${FAIL} gagal${NC}"
[ "$FAIL" -eq 0 ] || exit 1
