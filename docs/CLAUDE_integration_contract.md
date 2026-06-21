# CLAUDE.md — Integration Contract (Purrtein Smart Cat Feeder)

> **Dokumen ini adalah satu-satunya source of truth untuk kontrak integrasi antara Firmware, Backend, dan Frontend.** File `CLAUDE_iot.md`, `CLAUDE_backend.md`, dan `CLAUDE_frontend.md` WAJIB mengikuti dokumen ini. Jika ada konflik, dokumen ini menang.
>
> Perubahan pada kontrak ini = breaking change untuk minimal 2 dari 3 tim. Wajib reviewed dengan minimal 1 reviewer per layer (IoT, Backend, Frontend) sebelum merge.

---

## 1. Domain & Konvensi Dasar

| Hal | Nilai |
|---|---|
| **Timezone** | Semua timestamp **UTC**. Format **ISO 8601 dengan `Z`** (`2026-06-21T10:00:00.000Z`). Konversi ke local time hanya di sisi UI render. |
| **ID format** | UUID v4 untuk semua entitas backend (`device_id`, `feeding_log_id`, `user_id`, `token_topup.id`). `DEVICE_ID` dari firmware **= UUID device yang sama**, bukan slug `feeder-001`. Slug `feeder-001` hanya `name` untuk display. |
| **`device_id` di topic MQTT** | Pakai UUID device — bukan slug. Topic: `purrtein/devices/{uuid}/...`. |
| **String encoding** | UTF-8 di semua payload. |
| **Anti-replay window** | 30 detik (clock UTC). Berlaku 2-arah: device tolak command lama, backend tolak event `feeding_done` lama. |
| **NTP** | Wajib `pool.ntp.org` + `time.google.com` (fallback). Device tolak semua command jika `time_synced == false`. Backend container WAJIB `chrony`/`systemd-timesyncd` aktif. |
| **Skema versi** | Semua payload MQTT punya field `schema: 1` (integer). Tambah field aman; ubah/hapus field = bump `schema`. |

---

## 2. Stock Tracking Model (Authoritative)

Stock di-derive dari counter rotasi stepper. **Device = source of truth.** Backend = mirror untuk display/analitik.

| Konstanta | Nilai | Lokasi |
|---|---|---|
| `STOCK_CAPACITY_ROTATIONS` | **25** rotasi (kalibrasi lapangan, akan di-iterasi) | Firmware (`config.h`) + Backend (env `STOCK_CAPACITY_ROTATIONS`) |
| `STOCK_LOW_THRESHOLD` | **0.15** (15%) | Firmware (`config.h`) + Backend (env, dipakai untuk trigger alert) + DB default `devices.stock_threshold = 0.15` |
| `ROTATIONS_PER_TOKEN` | **1** rotasi per token (kalibrasi: ±10g pakan per rotasi) | Backend (env) — frontend baca dari `/tokens/packages` meta atau `/config/public` |

**Formula:**
```
stock_level = max(0, 1 - (total_rotations / STOCK_CAPACITY_ROTATIONS))
```

**Reset:** `commands/refill` dari backend (admin-triggered) → device set `total_rotations = 0`, persist NVS, publish `status` retained.

> ⚠️ Backend tidak boleh hard-code threshold berbeda dari firmware. Jika `STOCK_CAPACITY_ROTATIONS` berubah, **wajib OTA push config ke device** (Phase 2 — Phase 1 manual).

---

## 3. MQTT Topics (Final)

Broker: **EMQX** (port 8883 TLS only di produksi; 1883 di-block di firewall).

| Direction | Topic | QoS | Retained | Publisher |
|---|---|---|---|---|
| Device → Backend | `purrtein/devices/{device_id}/status` | 1 | **true** | Device (heartbeat + LWT) |
| Device → Backend | `purrtein/devices/{device_id}/events/feeding_done` | 1 | false | Device |
| Device → Backend | `purrtein/devices/{device_id}/events/stream_state` | 1 | **true** | Device (lifecycle: starting/active/stopped/error) |
| Device → Backend | `purrtein/devices/{device_id}/events/boot` | 1 | false | Device (saat boot — kirim firmware version, total_rotations) |
| Backend → Device | `purrtein/devices/{device_id}/commands/feed` | 1 | false | Backend |
| Backend → Device | `purrtein/devices/{device_id}/commands/stream` | 1 | false | Backend |
| Backend → Device | `purrtein/devices/{device_id}/commands/refill` | 1 | false | Backend (admin auth) |
| Backend → Device | `purrtein/devices/{device_id}/commands/config` | 1 | **true** | Backend (set `STOCK_CAPACITY_ROTATIONS`, heartbeat interval, dll — Phase 2) |

**Wildcards yang di-subscribe device:** `purrtein/devices/{device_id}/commands/#` (QoS 1).

**Backend subscribe:** `purrtein/devices/+/status` + `purrtein/devices/+/events/#` (QoS 1).

**Last Will & Testament (LWT):** device set saat MQTT connect →
```json
topic: purrtein/devices/{device_id}/status
retained: true
qos: 1
payload: {"schema":1,"device_id":"{uuid}","online":false,"reason":"lwt","timestamp":"<connect_time>"}
```

---

## 4. Payload Schemas (Source of Truth)

### 4.1 `status` (device → backend, heartbeat 30s, retained)

```json
{
  "schema": 1,
  "device_id": "uuid",
  "online": true,
  "stock_level": 0.72,
  "total_rotations": 7,
  "firmware_version": "1.0.0",
  "uptime_s": 12345,
  "rssi": -67,
  "free_heap": 145000,
  "stream_active": false,
  "timestamp": "2026-06-21T10:00:00.000Z"
}
```

### 4.2 `commands/feed` (backend → device)

```json
{
  "schema": 1,
  "command": "feed",
  "rotations": 1,
  "feeding_log_id": "uuid",
  "issued_at": "2026-06-21T10:00:00.000Z",
  "deadline_at": "2026-06-21T10:00:30.000Z"
}
```

- `rotations`: integer 1–5 (clamp di device, tolak >5 dengan `reason: invalid_payload`)
- `issued_at`: kapan backend kirim. Device validasi `now - issued_at < 30s` (anti-replay).
- `deadline_at`: kapan command dianggap expired. Device cek juga ini sebagai safety net.
- `feeding_log_id`: **idempotency key**. Device WAJIB simpan list `processed_feeding_log_ids` (LRU, 100 entry, persist NVS). Duplicate → kirim `feeding_done` ulang dengan status sebelumnya, **jangan jalankan motor 2x**.

### 4.3 `events/feeding_done` (device → backend)

```json
{
  "schema": 1,
  "device_id": "uuid",
  "feeding_log_id": "uuid",
  "status": "completed",
  "rotations_requested": 1,
  "rotations_executed": 1,
  "total_rotations": 8,
  "stock_level": 0.68,
  "duration_ms": 2300,
  "reason": null,
  "timestamp": "2026-06-21T10:00:02.300Z"
}
```

**`status` enum:** `completed` | `failed`

**`reason` enum (wajib jika `status="failed"`):**

| `reason` | Arti | Action backend |
|---|---|---|
| `motor_stall` | Stepper stall detect (timing/driver fault) | Mark feeding failed, refund token, alert admin |
| `insufficient_stock` | `total_rotations >= STOCK_CAPACITY_ROTATIONS` | Mark feeding failed, refund token, alert admin (stock_empty) |
| `busy_streaming` | Device sedang stream → tolak feed | Refund token, retry job 30s kemudian (max 3x) |
| `busy_feeding` | Sedang menjalankan feed lain | Refund token, retry job 10s kemudian (max 3x) |
| `command_expired` | `issued_at` > 30s lalu | Refund token, NO retry (backend bug) |
| `invalid_payload` | JSON malformed / field hilang / rotations > 5 | Refund token, NO retry, alert dev |
| `time_not_synced` | NTP belum sync | Refund token, retry 60s kemudian (max 3x) |
| `duplicate` | `feeding_log_id` sudah pernah diproses (echo) | NO refund, NO retry. Backend cek `feeding_logs.status` — sudah `completed` artinya OK |

### 4.4 `commands/stream` (backend → device)

```json
{
  "schema": 1,
  "command": "stream_start",
  "stream_id": "uuid",
  "issued_at": "2026-06-21T10:00:00.000Z",
  "duration_s": 300
}
```

- `command`: `stream_start` | `stream_stop`
- `stream_id`: UUID sesi (untuk korelasi event ↔ command)
- `duration_s` (opsional, default 300 = 5 menit): hard limit di device. Setelah lewat, device auto-stop & publish `stream_state: stopped, reason: timeout`. Mencegah stream nge-leak biaya bandwidth kalau backend lupa stop.

### 4.5 `events/stream_state` (device → backend, retained)

```json
{
  "schema": 1,
  "device_id": "uuid",
  "stream_id": "uuid",
  "state": "active",
  "rtsp_path": "feeder-001",
  "reason": null,
  "timestamp": "2026-06-21T10:00:01.500Z"
}
```

**`state` enum:** `starting` | `active` | `stopped` | `error`

**`reason` (jika `error`/`stopped`):** `timeout` | `camera_init_failed` | `rtsp_connect_failed` | `network_lost` | `manual_stop` | `device_busy`

### 4.6 `commands/refill` (backend → device, admin-only)

```json
{
  "schema": 1,
  "command": "refill",
  "refill_id": "uuid",
  "operator": "admin@purrtein.com",
  "issued_at": "2026-06-21T10:00:00.000Z"
}
```

Device handle: idempotency check via `refill_id`, set `total_rotations = 0`, persist NVS, publish `status` retained, publish `events/feeding_done`-like event ke topic baru `events/refill_done`:

```json
{
  "schema": 1,
  "device_id": "uuid",
  "refill_id": "uuid",
  "status": "completed",
  "previous_total_rotations": 23,
  "timestamp": "..."
}
```

### 4.7 `events/boot` (device → backend, saat boot)

```json
{
  "schema": 1,
  "device_id": "uuid",
  "firmware_version": "1.0.0",
  "boot_reason": "power_on",
  "total_rotations": 8,
  "timestamp": "..."
}
```

`boot_reason`: `power_on` | `software_reset` | `watchdog` | `brownout` | `panic` | `unknown`

---

## 5. Concurrency Rules (Final, Enforced di 2 Sisi)

Backend WAJIB cek state device sebelum enqueue command. Firmware enforce ulang sebagai pertahanan terakhir.

| State device | `feed` cmd | `stream_start` cmd | `refill` cmd |
|---|---|---|---|
| IDLE | ✅ | ✅ | ✅ |
| FEEDING | ❌ `busy_feeding` | ⏳ tolak `device_busy` | ✅ (queue setelah feed selesai) |
| STREAMING | ❌ `busy_streaming` | `stream_stop` lalu start | ✅ |
| OFFLINE (>120s no heartbeat) | ❌ Backend tolak di endpoint `/feed` 503 | ❌ Backend tolak 503 | ❌ |

Backend ambil `device.status`, `device.stream_status`, `device.last_seen` dari DB (cache 5s di Redis). Jika "stale" → fallback ke last MQTT retained `status`.

---

## 6. Token Economy

| Hal | Nilai |
|---|---|
| 1 token = | **1 rotasi 360°** (≈10–15 gram, kalibrasi lapangan) |
| Field `rotations` di payload MQTT | = jumlah token yang dipakai user |
| Max rotations per request | **5** (anti-abuse) |
| Min interval feed per device per user | **5 menit** cooldown (anti-spam, lihat B7 → diputuskan) |
| Min interval feed per device global | **30 detik** (pelindung motor) |

**Refund rules:**
- Token sudah di-deduct di Redis SAAT user POST `/feed` (optimistic).
- Jika `feeding_done.status = failed` ATAU job timeout 45s tanpa ACK → **refund 1 token** ke Redis + DB (transactional).
- Jika `reason = duplicate` → tidak refund (device echo).
- WebSocket emit `feeding.failed { reason }` ke user supaya UI tahu.

---

## 7. Stream URL Authorization

WHEP URL **tidak boleh** publik. Untuk Phase 1:

- `GET /devices/:id/stream` (Public OR User JWT — lihat B2/F1):
  - Return: `{ status, whep_url, stream_token, expires_at }`
  - `whep_url` mengandung **signed token** (HMAC SHA256, TTL 60 detik) — `https://stream.purrtein.com/{device_id}/whep?token=...`
  - mediamtx validate token via `runOnReadAuth` hook ke backend `/internal/stream/auth`.
  - Token refresh: client polling tiap 50 detik untuk reconnect WHEP.

Tanpa ini, attacker bisa share WHEP URL & habisin bandwidth.

---

## 8. Device Provisioning Flow (BLE Pairing)

**Aktor:** Admin teknisi memasang device di lapangan dengan mobile app.

```
1. Admin login ke app → POST /admin/devices                 → backend issue { device_id, device_secret }
2. App tampilkan QR (berisi {device_id, device_secret})
3. Teknisi power-on device → device boot ke PROVISIONING state → BLE GATT aktif (nama "Purrtein-XXXX")
4. App scan BLE → pairing dengan PIN 6-digit (tampil di app, masukkan di device side... atau OOB dari QR)
5. App kirim via BLE write (encrypted dengan PIN):
   { wifi_ssid, wifi_pass, device_id, device_secret, mqtt_host, mqtt_port, ntp_servers }
6. Device save ke NVS (encrypted) → reboot → connect → publish events/boot → backend mark device.status = "online", device.activated_at = now()
7. App polling GET /admin/devices/:id sampai status = online → tampilkan sukses.
```

**Endpoint backend yang harus ada:**
- `POST /admin/devices` → create device, return `{device_id, device_secret}` (return secret SEKALI, tidak boleh di-fetch ulang).
- `GET /admin/devices/:id/pairing-status` → polling.
- `POST /admin/devices/:id/reset-secret` → rotate secret (kalau hilang).

**Re-provisioning:** device gagal connect WiFi 5× → fallback BLE PROVISIONING.

---

## 9. WebSocket Events (Server → Client)

Socket.io rooms: `user:{user_id}` (private), `device:{device_id}` (admin only), `admin:all` (broadcast).

| Event | Payload | Room |
|---|---|---|
| `device.status` | `{ device_id, status, stock_level, total_rotations, updated_at }` | `device:{id}` + `admin:all` |
| `device.alert` | `{ device_id, type: "stock_low"\|"stock_empty"\|"offline"\|"motor_stall", message }` | `admin:all` |
| `device.stream` | `{ device_id, state, whep_url? }` | `device:{id}` + `admin:all` |
| `feeding.queued` | `{ feeding_log_id, device_id }` | `user:{user_id}` |
| `feeding.done` | `{ feeding_log_id, device_id, status, rotations }` | `user:{user_id}` + `device:{id}` |
| `feeding.failed` | `{ feeding_log_id, device_id, reason, token_refunded }` | `user:{user_id}` |
| `token.credited` | `{ balance, topup_id }` | `user:{user_id}` |
| `token.debited` | `{ balance, reason }` | `user:{user_id}` |
| `topup.failed` | `{ external_id, reason }` | `user:{user_id}` |

Frontend WAJIB handle reconnect WS + idempotent UI update (event bisa double).

---

## 10. Error Codes (REST API)

Semua error response: `{ error: { code, message, details? }, request_id }`

| HTTP | `code` | Kapan |
|---|---|---|
| 400 | `INVALID_PAYLOAD` | Validasi gagal |
| 401 | `UNAUTHENTICATED` | JWT invalid/missing |
| 403 | `FORBIDDEN` | Role tidak cukup |
| 409 | `INSUFFICIENT_TOKENS` | `POST /feed` saldo < 1 |
| 409 | `DEVICE_BUSY` | `POST /feed` device sedang feed/stream/offline |
| 409 | `COOLDOWN_ACTIVE` | User feed device yg sama dalam 5 menit |
| 423 | `DEVICE_OFFLINE` | `POST /feed` last_seen > 120s |
| 429 | `RATE_LIMITED` | Rate limit |
| 503 | `DOWNSTREAM_FAILURE` | Xendit / mediamtx down |
| 504 | `FEEDING_TIMEOUT` | Polling status > 45s tanpa ACK |

---

## 11. Configurable Constants (Single Source)

Semua konstanta numerik berikut WAJIB dibaca dari env, **bukan hardcode**. Backend expose via `GET /config/public` (untuk frontend) — firmware via OTA config (Phase 2).

```env
STOCK_CAPACITY_ROTATIONS=25
STOCK_LOW_THRESHOLD=0.15
ROTATIONS_PER_TOKEN=1
MAX_ROTATIONS_PER_REQUEST=5
HEARTBEAT_INTERVAL_S=30
DEVICE_OFFLINE_AFTER_S=120
COMMAND_REPLAY_WINDOW_S=30
FEEDING_ACK_TIMEOUT_S=45
USER_FEED_COOLDOWN_S=300
DEVICE_FEED_COOLDOWN_S=30
STREAM_MAX_DURATION_S=300
STREAM_TOKEN_TTL_S=60
WS_AUTH_TIMEOUT_S=10
NTP_RESYNC_INTERVAL_S=3600
WATCHDOG_TIMEOUT_S=30
```

Frontend cache `/config/public` di React Query dengan `staleTime: 5min`. Firmware Phase 1: compile-time constants di `config.h` — wajib MATCH dengan env backend (CI check direkomendasikan).

---

## 12. Observability & Logging

| Layer | Standard |
|---|---|
| Backend | Structured JSON logs (`pino`). Wajib field: `level`, `time`, `request_id`, `user_id?`, `device_id?`, `event`, `latency_ms?`. |
| Firmware | Serial log + opsional publish ke `purrtein/devices/{id}/logs` (QoS 0, throttle 1/s) — di-pipe ke Loki via mqtt-to-loki bridge. |
| Frontend | Sentry untuk error. Web Vitals untuk perf. |
| Trace | `request_id` di header `X-Request-ID` di-propagate ke worker job & MQTT payload (field `request_id`) supaya bisa trace user click → feeding_done. |

---

## 13. TDD Mandate (Semua Layer)

**Setiap PR yang menambah behavior WAJIB punya test yang gagal sebelum, lulus setelah.** CI blok merge jika coverage turun.

| Layer | Framework | Target |
|---|---|---|
| Firmware | PlatformIO `test/native` (Unity + FFF mock) | 80% pure logic, ≥1 integration test per fitur hardware |
| Backend | Vitest/Jest + Supertest + Testcontainers (Postgres + Redis + Mosquitto) | 80% unit, 100% endpoint smoke, 100% webhook idempotency |
| Frontend | Vitest + React Testing Library + MSW (mock API) + Playwright (e2e) | 70% komponen, 100% halaman flow utama (feed, topup, login) |

Test contract integrasi: simpan `*.contract.json` examples di `/contracts/` (di-share antar repo) → semua sisi parsing harus pass.

---

## 14. Deployment & Rollback

- **MQTT broker (EMQX)** + **mediamtx**: kontainer di server `infra-purrduli`, behind nginx TLS.
- **Backend**: deploy via GitHub Actions (build → push image → SSH deploy compose pull). Migrasi DB pakai `prisma migrate deploy` di entrypoint. Rollback = redeploy tag sebelumnya.
- **Firmware**: Phase 1 = flash manual saat teknisi pasang. Phase 2 = OTA via `esp_https_ota` (H7).
- **Frontend**: Vercel atau Cloudflare Pages (static SPA / SSR Next.js).

**Disaster:** restore DB dari snapshot harian S3, restore EMQX retained messages dari volume backup, ulang publish `commands/config` ke semua device.

---

## 15. Open Decisions (Konsolidasi)

| ID | Pertanyaan | Owner | Default kalau belum dijawab |
|---|---|---|---|
| **D1** | Login user: email+pass / magic link / Google OAuth? | Bisnis | **Email+password** (paling cepat) |
| **D2** | Akses peta + livestream wajib login? | Bisnis | **Peta publik, stream wajib login** (cegah abuse bandwidth) |
| **D3** | Token expiry? | Bisnis | **Tidak expired** (Phase 1) |
| **D4** | Refund policy? | Bisnis | Auto-refund on `failed` + `timeout`. Tidak ada manual refund Phase 1. |
| **D5** | Admin register: self / seed? | Bisnis | **Seed script saja** (Phase 1) |
| **D6** | Cooldown feed per user per device? | Bisnis | **5 menit** (anti-spam) |
| **D7** | FCM target: semua admin / per-device assign? | Bisnis | **Semua admin** Phase 1 |
| **D8** | Frontend stack: Next/React, Zustand/RQ? | Tech | **Next.js 14 + React Query + Zustand + Axios** |
| **D9** | Logo / brand color? | Bisnis | Placeholder Tailwind default |
| **D10** | OTA firmware update? | Tech | Deferred ke Phase 2 |
| **D11** | Pin mapping stepper ESP32-S3? | Hardware | Pending — section khusus di `CLAUDE_iot.md` |
| **D12** | Kapasitas tabung dalam rotasi (`STOCK_CAPACITY_ROTATIONS`) | Hardware | **25** (placeholder, kalibrasi setelah prototype) |

---

## 16. Change Management

Mengubah dokumen ini → wajib bump versi semantic di footer:

**Contract version:** `1.0.0` — 2026-06-21
**Compatible firmware versions:** `>=1.0.0 <2.0.0`
**Compatible backend versions:** `>=1.0.0 <2.0.0`

Major bump (X.0.0) = breaking, semua layer wajib upgrade serentak.
Minor (1.X.0) = additive (field baru opsional, topic baru).
Patch (1.0.X) = klarifikasi tanpa side effect.
