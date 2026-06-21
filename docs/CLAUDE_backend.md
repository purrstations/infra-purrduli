# CLAUDE.md — Backend (Purrtein Smart Cat Feeder)

> Dokumen ini adalah konteks utama untuk agent AI yang mengerjakan implementasi backend. Baca seluruhnya sebelum mulai coding.
>
> **WAJIB BACA DULU:** `CLAUDE_integration_contract.md` — semua schema payload MQTT, topik, konstanta, error reason, dan WebSocket events ditentukan di sana. Dokumen ini hanya menjelaskan IMPLEMENTASI di sisi backend.

---

## Project Context

Backend Node.js menjadi orkestrator antara user, device, payment gateway, dan media server. Tanggung jawab utama: auth, deduct/credit token, enqueue feeding ke device via MQTT, terima event device, push notifikasi, dan ekspos REST + WebSocket ke 2 frontend (user app & admin dashboard).

---

## Tech Stack

| Layer | Teknologi |
|---|---|
| Runtime | Node.js 20 LTS |
| Framework | Express.js (atau Fastify — pilih satu, jangan mix) |
| Bahasa | TypeScript (strict mode) |
| Database | PostgreSQL 16 |
| ORM | Prisma 5 |
| Cache & Queue store | Redis 7 |
| Queue | BullMQ |
| MQTT broker | **EMQX** (sudah ada di docker-compose) |
| MQTT client | `mqtt` (mqtt.js) |
| Payment Gateway | Xendit (`xendit-node` SDK) |
| Auth | JWT (access + refresh) + httpOnly cookie |
| Hashing | `argon2` (jangan bcrypt — argon lebih tahan GPU attack) |
| WebSocket | Socket.io 4 |
| Push | Firebase Cloud Messaging (FCM HTTP v1) |
| Logging | `pino` + `pino-pretty` (dev) |
| Validation | `zod` |
| Testing | **Vitest** + Supertest + Testcontainers (Postgres/Redis/Mosquitto) + MSW |
| Streaming control | mediamtx HTTP API (`MEDIAMTX_API_URL`) |
| Process mgr | `pm2` atau plain Docker restart policy |

---

## Struktur Direktori

```
backend/
├── src/
│   ├── routes/          # Express route registration
│   ├── controllers/     # HTTP handlers
│   ├── services/        # Business logic (token, feeding, stream)
│   ├── integrations/    # external: xendit, fcm, mediamtx, mqtt
│   ├── workers/         # BullMQ worker processes
│   ├── queues/          # BullMQ queue definitions
│   ├── mqtt/            # MQTT subscriber + publisher abstraction
│   ├── ws/              # Socket.io handlers
│   ├── middlewares/     # auth, rateLimit, validateWebhook, requestId
│   ├── lib/             # redis, prisma, logger, errors
│   ├── schemas/         # zod schemas (shared with mqtt payload validators)
│   └── config/          # env loader (zod-validated)
├── prisma/
│   ├── schema.prisma
│   └── migrations/
├── test/
│   ├── unit/
│   ├── integration/
│   └── fixtures/
├── contracts/          # JSON examples dari CLAUDE_integration_contract — copy via CI
├── .env.example
└── package.json
```

---

## Database Schema (Prisma)

### `users`
```prisma
model User {
  id            String   @id @default(uuid()) @db.Uuid
  name          String
  email         String   @unique
  phone         String?
  password_hash String                          // argon2
  token_balance Int      @default(0)
  created_at    DateTime @default(now())
  updated_at    DateTime @updatedAt

  topups        TokenTopup[]
  usages        TokenUsage[]
  feedings      FeedingLog[]
  refresh_tokens RefreshToken[]

  @@check(token_balance >= 0, name: "non_negative_balance")
}
```

### `admins`
```prisma
model Admin {
  id            String   @id @default(uuid()) @db.Uuid
  email         String   @unique
  password_hash String
  role          String   @default("operator")   // "operator" | "super_admin"
  fcm_token     String?
  created_at    DateTime @default(now())
}
```

### `refresh_tokens` (invalidatable)
```prisma
model RefreshToken {
  id          String   @id @default(uuid()) @db.Uuid
  user_id     String   @db.Uuid
  token_hash  String   @unique
  expires_at  DateTime
  revoked_at  DateTime?
  user_agent  String?
  ip          String?
  created_at  DateTime @default(now())

  user        User     @relation(fields: [user_id], references: [id])
  @@index([user_id, expires_at])
}
```

### `devices`
```prisma
model Device {
  id                       String   @id @default(uuid()) @db.Uuid
  name                     String                                  // display, e.g. "feeder-001"
  location_label           String
  lat                      Float
  lng                      Float
  status                   String   @default("offline")            // "online"|"offline"
  stock_level              Float    @default(1.0)
  total_rotations          Int      @default(0)                    // mirror dari device
  stock_threshold          Float    @default(0.15)                 // match contract §2
  stream_status            String   @default("inactive")           // "inactive"|"starting"|"active"|"error"
  stream_id                String?  @db.Uuid                       // current session
  stream_path              String?
  firmware_version         String?
  last_seen                DateTime?
  last_alert_offline_at    DateTime?                               // anti notif spam
  last_alert_stock_at      DateTime?
  device_secret_hash       String                                  // argon2 — secret tidak boleh plain di DB
  activated_at             DateTime?
  created_at               DateTime @default(now())
  updated_at               DateTime @updatedAt

  usages          TokenUsage[]
  feeding_logs    FeedingLog[]
  device_logs     DeviceLog[]
  refill_logs     RefillLog[]
}
```

### `token_packages`
```prisma
model TokenPackage {
  id           String   @id @default(uuid()) @db.Uuid
  name         String
  token_amount Int
  price_idr    Int
  is_active    Boolean  @default(true)
  created_at   DateTime @default(now())

  topups       TokenTopup[]
}
```

### `token_topups`
```prisma
model TokenTopup {
  id                  String    @id @default(uuid()) @db.Uuid
  user_id             String    @db.Uuid
  package_id          String    @db.Uuid
  xendit_external_id  String    @unique
  xendit_payment_id   String?
  payment_method      String?
  token_amount        Int
  amount_idr          Int
  status              String    @default("pending")  // pending|completed|failed|expired
  paid_at             DateTime?
  expired_at          DateTime?
  created_at          DateTime  @default(now())

  user    User         @relation(fields: [user_id], references: [id])
  package TokenPackage @relation(fields: [package_id], references: [id])

  @@index([user_id, created_at(sort: Desc)])
}
```

### `token_usages`
```prisma
model TokenUsage {
  id             String   @id @default(uuid()) @db.Uuid
  user_id        String   @db.Uuid
  device_id      String   @db.Uuid
  feeding_log_id String?  @unique @db.Uuid
  tokens_used    Int      @default(1)
  refunded       Boolean  @default(false)
  refunded_at    DateTime?
  used_at        DateTime @default(now())

  user        User       @relation(fields: [user_id], references: [id])
  device      Device     @relation(fields: [device_id], references: [id])
  feeding_log FeedingLog? @relation(fields: [feeding_log_id], references: [id])
}
```

### `feeding_logs`
```prisma
model FeedingLog {
  id                   String    @id @default(uuid()) @db.Uuid
  device_id            String    @db.Uuid
  triggered_by_user    String    @db.Uuid
  token_usage_id       String    @unique @db.Uuid
  rotations_requested  Int                                     // bukan portion_gram
  rotations_executed   Int?
  total_rotations      Int?                                    // mirror dari device
  stock_level          Float?                                  // mirror
  duration_ms          Int?
  status               String    @default("queued")            // queued|sent|completed|failed|timeout
  reason               String?                                 // enum dari contract §4.3
  fed_at               DateTime  @default(now())
  sent_at              DateTime?
  completed_at         DateTime?

  device      Device     @relation(fields: [device_id], references: [id])
  user        User       @relation(fields: [triggered_by_user], references: [id])
  token_usage TokenUsage @relation(fields: [token_usage_id], references: [id])

  @@index([device_id, fed_at(sort: Desc)])
  @@index([triggered_by_user, fed_at(sort: Desc)])
  @@index([status])
}
```

### `device_logs`
```prisma
model DeviceLog {
  id          String   @id @default(uuid()) @db.Uuid
  device_id   String   @db.Uuid
  event_type  String   // heartbeat|stock_alert|offline|online|feeding_done|stream_start|stream_stop|boot|refill_done
  payload     Json
  created_at  DateTime @default(now())

  device Device @relation(fields: [device_id], references: [id])

  @@index([device_id, created_at(sort: Desc)])
}
```

### `refill_logs`
```prisma
model RefillLog {
  id                       String   @id @default(uuid()) @db.Uuid
  device_id                String   @db.Uuid
  operator_admin_id        String   @db.Uuid
  previous_total_rotations Int
  status                   String   @default("queued")   // queued|completed|failed|timeout
  created_at               DateTime @default(now())
  completed_at             DateTime?

  device Device @relation(fields: [device_id], references: [id])
}
```

---

## REST API

Semua endpoint prefix `/api/v1`. Format error: lihat contract §10.

### Public

| Method | Path | Keterangan |
|---|---|---|
| `GET` | `/config/public` | Constants (lihat contract §11) — frontend cache 5min |
| `GET` | `/devices` | List device (publik) |
| `GET` | `/devices/:id` | Detail (publik) |
| `GET` | `/devices/:id/stream` | Status + signed `whep_url` (lihat contract §7) — **butuh User JWT** kalau D2 = wajib login |

### User Auth

| Method | Path | Keterangan |
|---|---|---|
| `POST` | `/auth/register` | Daftar (email+password, D1) |
| `POST` | `/auth/login` | Login → set 2 cookie httpOnly |
| `POST` | `/auth/refresh` | Refresh access token |
| `POST` | `/auth/logout` | Invalidate refresh token |
| `GET` | `/auth/me` | Profile saat ini |

### Token & Topup (User JWT)

| Method | Path | Keterangan |
|---|---|---|
| `GET` | `/tokens/packages` | Public list paket aktif |
| `POST` | `/tokens/topup` | Create Xendit invoice |
| `GET` | `/tokens/balance` | Saldo (sync dari Redis, fallback DB) |
| `GET` | `/tokens/history` | Riwayat topup + pemakaian (paginated) |
| `POST` | `/webhooks/xendit` | Public, validasi `x-callback-token` |

### Feeding (User JWT)

| Method | Path | Keterangan |
|---|---|---|
| `POST` | `/feed` | Body: `{device_id, rotations?}`. Default rotations=1. Return 202 + `feeding_log_id` |
| `GET` | `/feed/history` | Riwayat user (paginated) |

### Admin (Admin JWT)

| Method | Path | Keterangan |
|---|---|---|
| `POST` | `/admin/auth/login` | Rate limit ketat (lihat security) |
| `POST` | `/admin/auth/logout` | |
| `GET` | `/admin/devices` | Semua device |
| `POST` | `/admin/devices` | Create device → return `{id, device_secret}` **sekali** |
| `GET` | `/admin/devices/:id` | Detail |
| `PATCH` | `/admin/devices/:id` | Update name/lokasi/threshold |
| `GET` | `/admin/devices/:id/logs` | Device logs (paginated) |
| `GET` | `/admin/devices/:id/pairing-status` | Polling pairing (BLE flow) |
| `POST` | `/admin/devices/:id/reset-secret` | Rotate secret |
| `POST` | `/admin/devices/:id/refill` | Trigger refill via MQTT |
| `POST` | `/admin/devices/:id/stream/start` | |
| `POST` | `/admin/devices/:id/stream/stop` | |
| `GET` | `/admin/feeding-logs` | Filter by device, user, status, date |

### Internal (M2M only, IP whitelist + shared secret)

| Method | Path | Keterangan |
|---|---|---|
| `POST` | `/internal/stream/auth` | mediamtx `runOnReadAuth` hook — validate signed stream_token |

---

## MQTT Integration

Lihat contract §3–§4 untuk topik & schema. Backend WAJIB:

### Subscriber

Connect ke EMQX dengan `clientId = "backend-${pod}-${uuid}"`, `clean: false`, subscribe:

```ts
mqtt.subscribe([
  'purrtein/devices/+/status',
  'purrtein/devices/+/events/+',
], { qos: 1 });
```

### Validation pipeline

Tiap message:
1. Parse JSON → kalau gagal → log + drop.
2. Validasi dengan zod schema (per topic).
3. Cek `schema` field — kalau version mismatch → log warning, drop.
4. Ekstrak `device_id` dari topic, cross-check dengan `payload.device_id` — beda → log security event, drop (potential spoof).
5. Anti-replay: `now - timestamp < 30s` → drop kalau lewat.
6. Dispatch ke handler per `event_type`.

```ts
// example
mqtt.on('message', async (topic, buf) => {
  const id = req_id();
  const parsed = safeJSON(buf);
  if (!parsed) return logger.warn({id, topic}, 'json_invalid');
  const match = topic.match(/^purrtein\/devices\/([0-9a-f-]+)\/(.*)$/);
  if (!match) return;
  const [, deviceId, sub] = match;
  if (parsed.device_id !== deviceId) {
    return logger.error({id, deviceId, payload: parsed.device_id}, 'device_id_mismatch');
  }
  // ... per sub-topic dispatch
});
```

### Publisher

Backend publish 4 jenis command (lihat contract §4):
- `commands/feed` (QoS 1)
- `commands/stream` (QoS 1)
- `commands/refill` (QoS 1)
- `commands/config` (QoS 1 + retained) — Phase 2

Tiap publish: tambahkan `request_id` di payload supaya bisa di-trace di event balik.

### Connection resilience

`mqtt.js` auto-reconnect built-in. Tambahan:
- Health check: setiap 60s publish ke `purrtein/backend/health`, alert PagerDuty kalau gagal 3x.
- Multi-instance: pakai EMQX shared subscription `$share/backend/purrtein/devices/+/status` supaya cuma 1 instance pemroses tiap message → no duplicate processing.

---

## Queue System (BullMQ)

### Queue: `feeding-queue`

**Concurrency: 1 per `device_id`** (pakai `group` BullMQ Pro atau Redis distributed lock).

Job payload:
```ts
{
  device_id: string,
  feeding_log_id: string,
  user_id: string,
  rotations: number,           // BUKAN portion_gram
  request_id: string,
  attempt: number
}
```

Worker flow:
1. Acquire Redis lock `lock:device:{device_id}` (SET NX EX 60).
2. Cek `devices.status === 'online'` saja — kalau offline, release lock, fail dengan `DEVICE_OFFLINE` → enqueue refund. **Stream aktif tidak menghalangi feed** (lihat contract §5).
3. Update `feeding_logs.status = 'sent'`, `sent_at = now()`.
4. Publish MQTT `commands/feed` (lihat contract §4.2) — set `deadline_at = now + 30s`.
5. Setup promise that resolves on:
   - MQTT `events/feeding_done` with matching `feeding_log_id` — via in-memory map `pendingFeeds[logId] = resolve`.
   - Timeout 45s — reject.
6. Sukses → update DB `completed`, `completed_at`, mirror `total_rotations`, `stock_level`, release lock, emit WS.
7. Timeout/failed → update DB, **enqueue `refund-queue`**, emit WS `feeding.failed`, release lock.

**Retry policy (untuk reason yang retry-able):**
- `busy_feeding`: retry 3x dengan backoff 15s/30s/60s.
- `time_not_synced`: retry 3x backoff 60s.
- `motor_stall`, `insufficient_stock`, `invalid_payload`, `command_expired`: NO retry, langsung refund.
- `duplicate`: success — device sudah eksekusi sebelumnya.

### Queue: `refund-queue`

**Concurrency: 10.**

Job: `{user_id, feeding_log_id, reason}`. Worker:
```ts
await prisma.$transaction(async (tx) => {
  const usage = await tx.tokenUsage.findUnique({ where: { feeding_log_id }});
  if (usage.refunded) return; // idempotent
  await tx.user.update({
    where: { id: user_id },
    data: { token_balance: { increment: usage.tokens_used }}
  });
  await tx.tokenUsage.update({
    where: { id: usage.id },
    data: { refunded: true, refunded_at: new Date() }
  });
});
await redis.incrby(`token:balance:${user_id}`, usage.tokens_used);
ws.to(`user:${user_id}`).emit('feeding.failed', { feeding_log_id, reason, token_refunded: true });
```

### Queue: `notification-queue`

**Concurrency: 5.**

Trigger:
- Device offline (last_seen > 120s, dedup by `last_alert_offline_at`)
- `stock_level < stock_threshold` (dedup by `last_alert_stock_at`)
- Feeding `failed` + `reason in [motor_stall, insufficient_stock]`

Worker → FCM ke semua admin (D7).

**Anti-spam:** update `last_alert_*_at` setelah notif terkirim; tolak alert sejenis dalam 1 jam.

### Queue: `stream-queue`

**Concurrency: 1 per device_id.**

Flow: validate state → publish MQTT `commands/stream` → tunggu `events/stream_state` matching `stream_id` (timeout 15s) → update DB → poll mediamtx API `/v3/paths/get/{device_id}` untuk verify path live (timeout 10s) → emit WS.

### Queue: `refill-queue`

**Concurrency: 1 per device_id.**

Publish `commands/refill` → tunggu `events/refill_done` → reset `devices.total_rotations = 0`, `stock_level = 1.0`, log refill.

---

## Token Deduction (Atomic)

```ts
// POST /feed
async function debitToken(userId: string): Promise<number> {
  const key = `token:balance:${userId}`;
  const remaining = await redis.decrby(key, 1);
  if (remaining < 0) {
    await redis.incrby(key, 1);
    throw new InsufficientTokensError();
  }
  // DB update async (worker) — Redis = hot path
  await prisma.user.update({
    where: { id: userId },
    data: { token_balance: { decrement: 1 }}
  });
  return remaining;
}
```

**Source of truth:** DB. Redis = cache. Sync Redis dari DB saat login & cache miss.

**Pre-flight checks sebelum debit:**
- User cooldown: Redis `SET NX EX 300 cooldown:user:{u}:device:{d}` — gagal → COOLDOWN_ACTIVE.
- Device cooldown: Redis `SET NX EX 30 cooldown:device:{d}` — gagal → DEVICE_BUSY.
- Device online: cek `devices.last_seen > now() - 120s` — tidak → DEVICE_OFFLINE.

---

## Xendit Integration

### Buat invoice
```ts
xendit.Invoice.create({
  external_id: `topup-${userId}-${uuid()}`,
  amount: pkg.price_idr,
  currency: 'IDR',
  payer_email: user.email,
  description: `Topup ${pkg.token_amount} token`,
  success_redirect_url: `${FRONTEND_URL}/topup/pending?ext=${external_id}`,
  failure_redirect_url: `${FRONTEND_URL}/topup/pending?ext=${external_id}`,
  invoice_duration: 3600,
});
```

### Webhook idempotency
```ts
// middleware
const token = req.headers['x-callback-token'];
if (timingSafeEqual(token, XENDIT_WEBHOOK_TOKEN)) {
  // continue
} else {
  return res.status(401).json({error:{code:'INVALID_WEBHOOK'}});
}

// handler — wajib dalam transaction + advisory lock
await prisma.$transaction(async (tx) => {
  const topup = await tx.tokenTopup.findUnique({
    where: { xendit_external_id: body.external_id },
  });
  if (!topup) return; // unknown
  if (topup.status === 'completed') return; // idempotent

  if (body.status === 'PAID') {
    await tx.tokenTopup.update({ where: {id: topup.id}, data: { status: 'completed', paid_at: new Date() }});
    await tx.user.update({ where: {id: topup.user_id}, data: { token_balance: { increment: topup.token_amount }}});
  } else if (['FAILED','EXPIRED'].includes(body.status)) {
    await tx.tokenTopup.update({ where: {id: topup.id}, data: { status: 'failed' }});
  }
});
// post-commit
await redis.incrby(`token:balance:${topup.user_id}`, topup.token_amount);
ws.to(`user:${topup.user_id}`).emit('token.credited', {balance: ..., topup_id: topup.id});
```

---

## WebSocket (Socket.io)

Lihat contract §9 untuk events. Implementasi:

```ts
io.use(async (socket, next) => {
  const token = parseCookie(socket.handshake.headers.cookie).access;
  const payload = verifyJWT(token);
  socket.data.userId = payload.sub;
  socket.data.role = payload.role;
  next();
});

io.on('connection', (socket) => {
  socket.join(`user:${socket.data.userId}`);
  if (socket.data.role === 'admin') {
    socket.join('admin:all');
    socket.on('subscribe.device', (deviceId) => socket.join(`device:${deviceId}`));
  }
});
```

Adapter: `@socket.io/redis-adapter` untuk multi-instance. Tanpa ini, broadcast hanya sampai ke pod yang terkoneksi client.

---

## Device Offline Detection

Scheduled job (BullMQ repeatable, every 30s):

```ts
const cutoff = new Date(Date.now() - DEVICE_OFFLINE_AFTER_S * 1000);
const offlineDevices = await prisma.device.findMany({
  where: { status: 'online', last_seen: { lt: cutoff }}
});
for (const d of offlineDevices) {
  await prisma.device.update({ where: {id: d.id}, data: { status: 'offline' }});
  ws.to('admin:all').emit('device.status', { device_id: d.id, status: 'offline', ... });
  await notificationQueue.add('device-offline', { device_id: d.id });
}
```

---

## Stream Authorization Hook

mediamtx config `runOnReadAuth: "curl ${MEDIAMTX_API_URL}/internal/stream/auth ..."`.

Backend endpoint validate signed token:
```ts
POST /internal/stream/auth
body: { path, ip, query, token }

verify HMAC(stream_token, secret, ttl=60s, path-bound)
=> 200 OK or 401
```

---

## Configuration (env)

```env
NODE_ENV=production
PORT=4000
LOG_LEVEL=info

DATABASE_URL=postgresql://...
REDIS_URL=redis://...
MQTT_BROKER_URL=mqtts://mqtt.purrtein.com:8883
MQTT_USERNAME=backend
MQTT_PASSWORD=...
MQTT_CA_PATH=/etc/ssl/certs/lets_encrypt.pem

JWT_ACCESS_SECRET=...
JWT_REFRESH_SECRET=...
JWT_ACCESS_TTL_S=900
JWT_REFRESH_TTL_S=604800
COOKIE_DOMAIN=.purrtein.com
COOKIE_SECURE=true

XENDIT_SECRET_KEY=...
XENDIT_WEBHOOK_TOKEN=...

FCM_SERVICE_ACCOUNT_JSON=/etc/secrets/fcm.json

MEDIAMTX_API_URL=http://mediamtx:9997
MEDIAMTX_PUBLISH_USER=purrtein
MEDIAMTX_PUBLISH_PASS=...
STREAM_TOKEN_SECRET=...        # untuk signed WHEP token

FRONTEND_URL=https://app.purrtein.com
ADMIN_URL=https://admin.purrtein.com

# Constants — WAJIB match contract §11 dan firmware config.h
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
```

CI: script `tools/check_constants.py` parse `.env.example` dan `firmware/config.h` — fail kalau drift.

---

## Security Checklist

- [x] Argon2 untuk password hashing (memory cost 64MB, parallel 4)
- [x] JWT di httpOnly cookie, `SameSite=Lax`, `Secure` di prod
- [x] Rate limit `/admin/auth/login`: 5 req/min/IP, lockout 15min setelah 5 gagal
- [x] Rate limit `/auth/*`: 10 req/min/IP
- [x] Rate limit `/feed`: 1 req/2s per user
- [x] `helmet()` + CORS whitelist eksplisit (no wildcard)
- [x] Webhook Xendit timing-safe compare
- [x] Semua DB query via Prisma (parameterized)
- [x] Redis tidak expose port publik
- [x] Secret Xendit di GitHub secret + env runtime — bukan repo
- [x] MQTT broker auth: backend pakai user khusus (`backend`), device pakai per-device credentials
- [x] EMQX ACL: device hanya boleh publish ke topiknya sendiri + subscribe commands sendiri (regex ACL rule per device)
- [x] `request_id` di setiap log untuk audit trail
- [x] Audit log untuk semua endpoint admin (separate table)

---

## Testing Strategy (TDD — Mandatory)

CI block merge kalau coverage `< target` atau test gagal.

### Unit (Vitest)
- Services: token deduct/refund, stock calculator, payload validators, signed URL HMAC.
- Coverage target **80%**.

### Integration (Testcontainers: Postgres + Redis + Mosquitto)
- Setiap endpoint: happy + 3 error path minimum.
- Webhook idempotency: kirim 2x payload sama → satu transaksi credit.
- MQTT round trip: publish feed → mock device respond `feeding_done` → DB updated, WS emitted.
- Feeding refund: respond `motor_stall` → token user kembali ke nilai semula.
- Coverage target **100% route + 90% workers**.

### Contract Test
- Validasi semua zod schema dengan example payload dari `contracts/` (di-share via git submodule atau npm package internal).

### E2E (Playwright atau Postman/Newman)
- Happy path: register → topup (mock Xendit webhook) → feed → balance updated.

### Load (k6, opsional di staging)
- 100 concurrent users, 10 device, target p99 < 500ms untuk `POST /feed`.

---

## Logging & Observability

- **Structured JSON** (`pino`). Wajib field tiap line: `level, time, request_id, user_id?, device_id?, event, latency_ms?`.
- **Trace ID**: `X-Request-ID` di-propagate ke worker job + MQTT payload.
- **Metrics**: Prometheus exporter — counter feed_total, gauge device_online, histogram feed_latency.
- **Sentry**: error reporting + release tagging.
- **Audit log**: tabel `admin_audit_log` (admin_id, action, target_id, payload_redacted, ip, ua, ts).

---

## Health & Readiness

- `GET /healthz` → 200 jika proses hidup (no deps).
- `GET /readyz` → 200 jika DB + Redis + MQTT ready. Kalau salah satu down → 503.
- Liveness probe Docker pakai `/healthz`, readiness `/readyz`.

---

## Migration & Seed

- `prisma migrate deploy` di entrypoint container.
- Seed script (`prisma/seed.ts`): buat super admin awal, seed 3 token package, 1 device dummy untuk dev.
- Seed file pakai `.env.seed` terpisah, **tidak run di prod**.

---

## Production-Disaster Checklist Spesifik Backend

- ❗ **Double-credit on Xendit webhook retry**: kalau idempotency lewat (bug, race) → user dapat token 2x. **Fix:** transaction + check `status === 'completed'` SEBELUM kredit. Tambah index unique pada `(xendit_external_id, status='completed')` adalah anti-pattern — pakai advisory lock per `external_id`.
- ❗ **Token Redis drift dari DB**: kalau Redis flush atau pod restart → saldo hilang. **Mitigasi:** TTL `token:balance:{user}` 5 menit, refresh dari DB; `POST /feed` selalu re-cek DB kalau Redis miss.
- ❗ **MQTT subscriber lost message saat redeploy**: clean_session=false + persistent session. Pakai shared subscription supaya 1 pod = 1 owner per device.
- ❗ **BullMQ job lost on Redis OOM**: aktifkan `maxmemory-policy noeviction`, monitor redis memory.
- ❗ **Refund race**: device kirim `feeding_done` setelah backend timeout (45s) → backend sudah refund + tandai timeout, lalu terima `completed` → user feed gratis. **Fix:** sebelum process `feeding_done`, cek `feeding_logs.status` — kalau sudah `timeout`/`failed`, masih process update tapi JANGAN un-refund (atau lakukan refund reversal + alert).
- ❗ **WebSocket multi-pod**: tanpa Redis adapter, broadcast hanya ke pod terkoneksi. Adapter wajib.
- ❗ **Stream URL leak**: WHEP URL tanpa signed token bisa di-share publik. Implementasi mandatory (contract §7).
- ❗ **Admin endpoint expose secret**: response `POST /admin/devices` bawa `device_secret` plain (sekali). Wajib logging redacted (`***`).
- ❗ **MQTT topic spoofing**: device A publish ke topik device B. **Fix:** EMQX ACL per-device + backend cross-check `payload.device_id === topic device_id`.
- ❗ **Stream auth M2M**: kalau M2M secret bocor, attacker bisa bypass auth. Pakai mTLS antara backend↔mediamtx atau IP whitelist.
- ❗ **Clock skew di pod**: pod tanpa NTP → anti-replay false positive. Container WAJIB sync host clock (`hostNetwork` atau Kubernetes time-sync sidecar).
- ❗ **Prisma migrate di multi-pod startup**: race lock. Pakai init container terpisah / `pre-deploy hook`.
- ❗ **MQTT keepalive < heartbeat**: kalau keepalive < 30s, broker disconnect cepat. Set client keepalive 60s.
