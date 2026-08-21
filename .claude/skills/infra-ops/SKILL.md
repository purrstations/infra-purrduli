---
name: infra-ops
description: Use when modifying docker-compose.yml, nginx configurations, certbot TLS certs, EMQX broker configs, MediaMTX streaming server, ingest server scripts, adding or modifying container services, inspecting docker networks, running smoke tests, or debugging port bindings and reverse proxy routing.
---

# Infrastructure Operations: Compose, Networking, & Proxy Protocol

Standard operating procedures for managing the containerized infrastructure stack.

---

## 1. Stack Topology & Port Bindings

| Service | Container Name | Host Port | Container Port | Protocol / Purpose |
|---|---|---|---|---|
| Nginx Reverse Proxy | `nginx-proxy` | 80, 443 | 80, 443 | HTTP/HTTPS ingress |
| Certbot | `certbot` | - | - | Let's Encrypt automated TLS renewal |
| EMQX Broker | `emqx` | 1883, 8083, 8084 | 1883, 8083, 8084 | MQTT, WS, WSS (18083 dashboard loopback only) |
| MediaMTX | `mediamtx` | 8554, 8889 | 8554, 8889 | RTSP ingress, WHEP/WebRTC egress |
| MJPEG / H264 Ingest | `mjpeg-ingest-server` | 8081 | 8081 | TCP/HTTP camera stream ingestion -> MediaMTX |
| PostgreSQL | `postgres` | 127.0.0.1:5432 | 5432 | Database storage (Loopback only) |
| Redis | `redis` | 127.0.0.1:6379 | 6379 | Cache & message broker (Loopback only) |

---

## 2. Modification Rules

1. **Host Binding Security:**
   - Database and management dashboards (PostgreSQL, Redis, EMQX dashboard) MUST bind strictly to `127.0.0.1` unless routed through authenticated Nginx reverse proxy. Never expose raw database ports to `0.0.0.0`.
2. **Configuration Validation:**
   - After editing `docker-compose.yml`, run `docker compose config` to validate syntax and environment interpolation.
   - After editing Nginx configs under `nginx/`, run `docker compose exec nginx-proxy nginx -t` (or validate syntax locally) before reloading.
3. **Environment Parity:**
   - Any new environment variable referenced in `docker-compose.yml` MUST be added to `.env.example` with a safe dummy value.
4. **Done-When Verification:**
   - Run `bash scripts/smoke.sh` or targeted curl/healthcheck endpoints to confirm service availability before declaring work complete.
