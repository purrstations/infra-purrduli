#!/usr/bin/env bash
# Generate emqx/auth-bootstrap.csv dari .env.
#
# File ini dipakai EMQX untuk seed ulang user built_in_database setiap kali
# authenticator di-create (termasuk setelah node restart — lihat
# bootstrap_user_from_file/2 di emqx_authn_mnesia.erl).
#
# KENAPA PERLU:
# Array `authentication` di emqx/emqx.conf menimpa penuh definisi yang ditulis
# dashboard ke cluster.hocon. Tanpa seed file, user bisa "hilang" setelah
# restart karena definisi authenticator berubah (default hash algorithm beda).
#
# PENTING — override = false:
# EMQX meng-import dengan #{override => false}. User yang SUDAH ADA tidak
# ditimpa. Jadi mengubah password di .env TIDAK otomatis mengganti password
# user di EMQX. Untuk rotate: hapus user lewat dashboard/REST API, lalu
# restart mqtt agar file ini meng-seed ulang.
#
# Usage:
#   bash scripts/gen-emqx-bootstrap.sh          # tulis emqx/auth-bootstrap.csv
#   bash scripts/gen-emqx-bootstrap.sh --check  # validasi .env tanpa menulis
#
# File hasil TIDAK di-commit (berisi password plaintext, ada di .gitignore).

set -euo pipefail
cd "$(dirname "$0")/.." || exit 2

MODE="${1:-write}"

if [ ! -f .env ]; then
  echo "❌ .env tidak ditemukan di $(pwd)" >&2
  exit 1
fi

# Muat .env tanpa mengeksekusinya sebagai shell script penuh.
set -a
# shellcheck disable=SC1091
. ./.env
set +a

fail() { echo "❌ $1" >&2; exit 1; }

[ -n "${MQTT_USERNAME:-}" ]      || fail "MQTT_USERNAME kosong di .env"
[ -n "${MQTT_PASSWORD:-}" ]      || fail "MQTT_PASSWORD kosong di .env"
[ -n "${DEVICE_MQTT_PASSWORD:-}" ] || fail "DEVICE_MQTT_PASSWORD kosong di .env"

# Device code default feeder-1; override lewat DEVICE_MQTT_USERNAME kalau beda.
DEVICE_USER="${DEVICE_MQTT_USERNAME:-feeder-1}"

# Password tidak boleh mengandung koma (pemisah CSV) atau newline.
for pair in "MQTT_PASSWORD:${MQTT_PASSWORD}" "DEVICE_MQTT_PASSWORD:${DEVICE_MQTT_PASSWORD}"; do
  name="${pair%%:*}"
  value="${pair#*:}"
  case "$value" in
    *,*) fail "$name mengandung koma — tidak kompatibel dengan format CSV bootstrap" ;;
  esac
  case "$value" in
    *$'\n'*) fail "$name mengandung newline" ;;
  esac
done

OUT="emqx/auth-bootstrap.csv"

if [ "$MODE" = "--check" ]; then
  echo "✓ .env valid untuk bootstrap:"
  echo "    user backend : ${MQTT_USERNAME}"
  echo "    user device  : ${DEVICE_USER}"
  echo "  (password tidak ditampilkan)"
  exit 0
fi

umask 077
{
  echo "user_id,password,is_superuser"
  printf '%s,%s,false\n' "${MQTT_USERNAME}" "${MQTT_PASSWORD}"
  printf '%s,%s,false\n' "${DEVICE_USER}" "${DEVICE_MQTT_PASSWORD}"
} > "${OUT}.tmp"
mv "${OUT}.tmp" "$OUT"

# ── Permission ────────────────────────────────────────────────────────────
# EMQX berjalan sebagai uid 1000 (non-root) dan harus bisa MEMBACA file ini.
# Kalau tidak, EMQX hanya menulis warning saat start:
#   boostrap_authn_built_in_database_failed, reason: Permission denied
# dan user tidak di-seed — device lalu gagal login.
#
# Default aman = 644 (dunia hanya bisa baca, bukan tulis). Password di dalamnya
# plaintext, jadi kalau ingin lebih ketat pakai GID bersama seperti pola
# certbot/fix-cert-perms.sh:
#     sudo chgrp 10001 emqx/auth-bootstrap.csv && chmod 640 emqx/auth-bootstrap.csv
# (container mqtt sudah punya `group_add: ["10001"]`).
chmod 644 "$OUT"

if [ "$(id -u)" -eq 0 ]; then
  chgrp 10001 "$OUT" 2>/dev/null && chmod 640 "$OUT"
fi

echo "✅ ${OUT} dibuat ($(stat -c '%a' "$OUT")):"
echo "    ${MQTT_USERNAME}"
echo "    ${DEVICE_USER}"
echo
echo "Langkah berikutnya (manual, di VPS):"
echo "    docker compose up -d --force-recreate mqtt"
