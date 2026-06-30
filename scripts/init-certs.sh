#!/bin/bash
# Jalankan SEKALI di VPS sebelum `docker compose up` pertama kali.
# Script ini mengambil TLS cert via certbot standalone (nginx belum jalan).
#
# Usage: ./scripts/init-certs.sh purrduli.tech your@email.com

set -e

DOMAIN=${1:?"Usage: $0 <domain> <email>"}
EMAIL=${2:?"Usage: $0 <domain> <email>"}

mkdir -p certbot/conf certbot/www

echo "==> Mendapatkan cert untuk $DOMAIN (dan www.$DOMAIN, api.$DOMAIN, stream.$DOMAIN)"

docker run --rm \
  -v "$(pwd)/certbot/conf:/etc/letsencrypt" \
  -v "$(pwd)/certbot/www:/var/www/certbot" \
  -p 80:80 \
  certbot/certbot certonly \
    --standalone \
    --non-interactive \
    --agree-tos \
    --email "$EMAIL" \
    -d "$DOMAIN" \
    -d "api.$DOMAIN" \
    -d "stream.$DOMAIN"

echo "==> Cert tersimpan di certbot/conf/live/$DOMAIN/"
echo "==> Sekarang jalankan: docker compose up -d"
