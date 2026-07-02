#!/bin/sh
# Runs on every certbot container start, and every renew loop tick (see the
# certbot service entrypoint in docker-compose.yml).
#
# Let's Encrypt's default perms — archive/<domain>/ = 700 root, privkey*.pem =
# 600 root — block any non-root container (e.g. EMQX, which runs as uid 1000)
# from reading the cert even though the volume is bind-mounted into them.
# nginx doesn't hit this because its master process reads certs while still
# running as root; EMQX runs as a fixed non-root user the whole time.
#
# Fix: grant read access to one fixed shared GID instead of loosening to
# world-readable. Any service in docker-compose.yml that needs the cert just
# adds `group_add: ["10001"]` — no per-service UID hardcoding, no manual SSH
# step, self-heals on every renewal automatically.
set -e
GID=10001
for domain_dir in /etc/letsencrypt/archive/*/; do
  chgrp "$GID" "$domain_dir"
  chmod 750 "$domain_dir"
  chgrp "$GID" "$domain_dir"privkey*.pem
  chmod 640 "$domain_dir"privkey*.pem
done
