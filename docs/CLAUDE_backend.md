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
  display_handle String? @unique                // @ophir, default null pakai first name
  avatar_url    String?
  chat_muted_until DateTime?                    // auto-mute ekspirasi
  chat_warn_count Int    @default(0)
  banned        Boolean  @default(false)
  privacy_show_in_viewers Boolean @default(true)
  created_at    DateTime @default(now())
  updated_at    DateTime @updatedAt

  topups        TokenTopup[]
  usages        TokenUsage[]
  feedings      FeedingLog[]
  refresh_tokens RefreshToken[]
  chats         ChatMessage[]
  gifts         GiftTransaction[]
  viewers       StreamViewer[]

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

### `stream_sessions`

Sesi streaming = scope untuk chat, gift, viewer. Saat stream stop → session closed, chat archived, viewer disconnect. `stream_id` di `commands/stream` (contract §4.4) = session id ini.

```prisma
model StreamSession {
  id                   String   @id @default(uuid()) @db.Uuid
  device_id            String   @db.Uuid
  started_by           String?  @db.Uuid                  // null = auto, kalau admin trigger = admin_id
  started_at           DateTime @default(now())
  ended_at             DateTime?
  ended_reason         String?                            // manual_stop|timeout|error|device_offline
  peak_viewers         Int      @default(0)
  total_unique_viewers Int      @default(0)
  total_chats          Int      @default(0)
  total_gifts          Int      @default(0)
  total_gift_value     Int      @default(0)               // total token revenue dari gift

  device   Device           @relation(fields: [device_id], references: [id])
  chats    ChatMessage[]
  gifts    GiftTransaction[]
  viewers  StreamViewer[]

  @@index([device_id, started_at(sort: Desc)])
}
```

### `chat_messages`

**Storage strategy:** hot path = Redis Streams `stream:chat:{session_id}` (last 200, TTL 24 jam atau session close). Cold archive = Postgres write-behind batch (100 row / 2 detik) via `chat-archive-queue`.

```prisma
model ChatMessage {
  id          String   @id @default(uuid()) @db.Uuid
  session_id  String   @db.Uuid
  user_id     String   @db.Uuid
  content     String   @db.VarChar(280)
  type        String   @default("text")          // text|sticker|system
  sticker_id  String?  @db.Uuid
  deleted_at  DateTime?
  deleted_by  String?  @db.Uuid                  // admin_id atau user (self-delete ≤5 menit)
  flagged     Boolean  @default(false)
  flag_reason String?
  created_at  DateTime @default(now())

  session StreamSession @relation(fields: [session_id], references: [id])
  user    User          @relation(fields: [user_id], references: [id])
  sticker Sticker?      @relation(fields: [sticker_id], references: [id])

  @@index([session_id, created_at(sort: Desc)])
  @@index([user_id, created_at(sort: Desc)])
}
```

### `stickers` (catalog)

Free: 5–10 standard (paw, heart, fish), rate limit 1/2 detik. Premium: kena token (1–3), no rate limit, cap 10/menit.

```prisma
model Sticker {
  id           String   @id @default(uuid()) @db.Uuid
  code         String   @unique                  // "paw_clap", "meow_love"
  name         String
  image_url    String                            // Lottie JSON URL atau APNG
  tier         String                            // "free"|"premium"
  token_cost   Int      @default(0)
  animation_ms Int      @default(2000)
  is_active    Boolean  @default(true)
  created_at   DateTime @default(now())

  chats        ChatMessage[]
}
```

### `gifts` (catalog)

| Tier | Cost | Feed rotations | Animasi |
|---|---|---|---|
| small | 1 token | 0 | sticker enlarged, 2 dtk |
| medium | 3 token | 1 | top-corner banner, 4 dtk |
| large | 10 token | 3 | full-screen takeover, 6 dtk, sound (opt-in) |
| epic | 50 token | 10 + special meal | takeover + slow-mo + ucap nama donor, 10 dtk |

```prisma
model Gift {
  id                  String   @id @default(uuid()) @db.Uuid
  code                String   @unique
  name                String
  image_url           String
  animation_url       String                     // full-screen Lottie
  tier                String                     // small|medium|large|epic
  token_cost          Int                        // >0
  feed_rotations      Int      @default(0)       // 0 = sticker-only, >0 trigger feed
  display_duration_ms Int      @default(3000)
  is_active           Boolean  @default(true)
  created_at          DateTime @default(now())

  transactions        GiftTransaction[]
}
```

### `gift_transactions`

```prisma
model GiftTransaction {
  id             String   @id @default(uuid()) @db.Uuid
  session_id     String   @db.Uuid
  gift_id        String   @db.Uuid
  user_id        String   @db.Uuid
  device_id      String   @db.Uuid
  tokens_spent   Int
  feed_rotations Int                              // snapshot dari gift.feed_rotations
  feeding_log_id String?  @db.Uuid
  status         String   @default("pending")     // pending|completed|failed|refunded
  reason         String?
  refunded       Boolean  @default(false)
  refunded_at    DateTime?
  created_at     DateTime @default(now())

  session     StreamSession @relation(fields: [session_id], references: [id])
  gift        Gift          @relation(fields: [gift_id], references: [id])
  user        User          @relation(fields: [user_id], references: [id])
  device      Device        @relation(fields: [device_id], references: [id])
  feeding_log FeedingLog?   @relation(fields: [feeding_log_id], references: [id])

  @@index([session_id, created_at(sort: Desc)])
  @@index([user_id, created_at(sort: Desc)])
}
```

### `stream_viewers` (presence)

Hot presence = Redis SET `viewer:session:{id}` (member = `user:{uid}` atau `anon:{eph_id}`). Postgres write hanya saat `join`/`leave` untuk audit (tidak setiap heartbeat).

```prisma
model StreamViewer {
  id         String   @id @default(uuid()) @db.Uuid
  session_id String   @db.Uuid
  user_id    String?  @db.Uuid                   // null = anonim
  anon_id    String?                             // ephemeral
  socket_id  String   @unique
  joined_at  DateTime @default(now())
  left_at    DateTime?
  ip_hash    String                              // sha256(ip + salt)

  session StreamSession @relation(fields: [session_id], references: [id])
  user    User?         @relation(fields: [user_id], references: [id])

  @@index([session_id, left_at])
}
```

### `moderation_logs`

```prisma
model ModerationLog {
  id          String   @id @default(uuid()) @db.Uuid
  target_type String                                       // chat|user|gift
  target_id   String   @db.Uuid
  actor_type  String                                       // auto|admin
  actor_id    String?  @db.Uuid
  action      String                                       // hide_chat|mute_24h|ban|unban|warn|refund_gift
  reason      String
  evidence    Json?                                        // snapshot chat sebelum hide
  created_at  DateTime @default(now())

  @@index([target_id, created_at(sort: Desc)])
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

### Livestream Social — Public

| Method | Path | Keterangan |
|---|---|---|
| `GET` | `/streams/active` | List stream aktif (untuk landing/feed sosial) |
| `GET` | `/streams/:session_id/chat?limit=50&before=ts` | Replay chat (read-only utk anon) |
| `GET` | `/streams/:session_id/viewers?limit=20` | Viewer list (avatars). Hide user yg `privacy_show_in_viewers=false` |
| `GET` | `/stickers` | Catalog sticker aktif |
| `GET` | `/gifts` | Catalog gift aktif |

### Livestream Social — User JWT

| Method | Path | Keterangan |
|---|---|---|
| `POST` | `/streams/:session_id/gifts` | Buy + send gift. Atomic: deduct token + record + WS broadcast + (opsional) enqueue feed |
| `PATCH` | `/me/privacy` | `{ show_in_viewers, handle? }` |
| `POST` | `/streams/:session_id/chat/:msg_id/report` | Report chat ke moderation queue |
| `DELETE` | `/streams/:session_id/chat/:msg_id` | Self-delete (≤5 menit) |

### Livestream Social — Admin JWT

| Method | Path | Keterangan |
|---|---|---|
| `GET` | `/admin/streams/:session_id` | Detail session + stats |
| `POST` | `/admin/chat/:msg_id/hide` | Hide chat + log |
| `POST` | `/admin/users/:id/mute` | `{ hours, reason }` |
| `POST` | `/admin/users/:id/ban` | `{ reason }` |
| `POST` | `/admin/users/:id/unban` | |
| `POST` | `/admin/gifts/:id/refund` | Manual refund kalau ada dispute |
| `GET` | `/admin/moderation/queue` | List flagged content |

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

### Queue: `chat-archive-queue`

**Concurrency: 1 (single writer per session shard).**

Batch insert chat dari Redis Stream → Postgres `chat_messages`. Trigger: setiap 2 detik atau batch >100. Mencegah write storm DB saat chat ramai. Idempotent — pakai chat `id` (UUID) sebagai key.

### Queue: `moderation-queue`

**Concurrency: 5.**

Trigger:
- Chat flagged HIGH oleh profanity filter → auto-hide + warn user (langsung tanpa job).
- Chat flagged MID → masuk queue untuk admin review.
- User report → masuk queue.
- 3 user report dalam 1 jam thd msg sama → auto-hide pending review.

Worker action: notif admin via WS `admin:all` + tulis ke `moderation_logs`.

### Integrasi gift dengan `feeding-queue`

Gift dengan `feed_rotations > 0` enqueue job ke `feeding-queue` dengan field tambahan `origin: 'gift', gift_transaction_id`. Worker handle sama dengan feed reguler, tapi:
- Refund failure → refund **seluruh `tokens_spent`** dari gift (bukan cuma porsi feed), update `gift_transactions.refunded = true`, status `refunded`.
- WS emit `gift.feed_done { gift_id, feeding_log_id, status, reason? }` ke room `stream:{session_id}` supaya viewer lain juga lihat hasil.
- System message di chat: "Gift @user otomatis dikembalikan (motor error)" — animasi gift TIDAK di-undo (sudah ditayangkan).

---

## Gift Transaction Flow (Atomic + Compensating)

Gift = transaksi finansial → wajib idempotent + atomic. Tahapan:

```ts
// POST /streams/:session_id/gifts { gift_code, idempotency_key }
async function buyGift(input) {
  // 1. Pre-flight: gift active + stream active
  const gift = await prisma.gift.findUnique({ where: { code, is_active: true }});
  if (!gift) throw new Error('GIFT_NOT_AVAILABLE');
  const session = await prisma.streamSession.findUnique({ where: { id: session_id, ended_at: null }});
  if (!session) throw new Error('STREAM_NOT_ACTIVE');

  // 2. Idempotency (SETNX 24h)
  const idem = `gift:idem:${user_id}:${input.idempotency_key}`;
  const acquired = await redis.set(idem, '1', 'EX', 86400, 'NX');
  if (!acquired) return await findExistingTx(idem);

  // 3. Cooldown gift per user (5s)
  const cd = await redis.set(`gift:cd:${user_id}`, '1', 'EX', 5, 'NX');
  if (!cd) throw new Error('COOLDOWN_ACTIVE');

  // 4. Atomic token deduct
  const remaining = await redis.decrby(`token:balance:${user_id}`, gift.token_cost);
  if (remaining < 0) {
    await redis.incrby(`token:balance:${user_id}`, gift.token_cost);
    throw new Error('INSUFFICIENT_TOKENS');
  }

  // 5. Persist + DB token deduct (transaction)
  let tx;
  try {
    tx = await prisma.$transaction(async (db) => {
      await db.user.update({ where: { id: user_id }, data: { token_balance: { decrement: gift.token_cost }}});
      return db.giftTransaction.create({
        data: { session_id, gift_id: gift.id, user_id, device_id: session.device_id,
                tokens_spent: gift.token_cost, feed_rotations: gift.feed_rotations,
                status: gift.feed_rotations > 0 ? 'pending' : 'completed' },
      });
    });
  } catch (e) {
    await redis.incrby(`token:balance:${user_id}`, gift.token_cost);   // rollback Redis
    throw e;
  }

  // 6. Broadcast WS animation INSTANT (visual harus segera)
  io.to(`stream:${session_id}`).emit('gift.sent', { id: tx.id, user, gift, status: tx.status });

  // 7. Kalau gift trigger feed → enqueue feed job
  if (gift.feed_rotations > 0) {
    const feedingLog = await prisma.feedingLog.create({
      data: { device_id: session.device_id, triggered_by_user: user_id, token_usage_id: null,
              rotations_requested: gift.feed_rotations, status: 'queued' }
    });
    await prisma.giftTransaction.update({ where: { id: tx.id }, data: { feeding_log_id: feedingLog.id }});
    await feedingQueue.add('feed', {
      device_id: session.device_id, feeding_log_id: feedingLog.id,
      user_id, rotations: gift.feed_rotations,
      origin: 'gift', gift_transaction_id: tx.id,
    });
  }

  return tx;
}
```

**Refund kalau feed gagal:** refund seluruh `tokens_spent` (user beli "bundle pengalaman", bukan komponen). Animasi gift tidak di-undo. Post system message ke chat. Status `gift_transactions.status = 'refunded'`.

---

## Chat Pipeline

```
Client emit chat.send
   ↓
[Backend Socket.io handler]
   ├─ AuthN cek (login + not muted + not banned)
   ├─ Rate limit cek (Redis SETNX 3s)
   ├─ Content validation (zod, length ≤280)
   ├─ Profanity filter (bloom filter + regex, id+EN slur)
   │     ├─ HIGH severity → auto-hide + warn user
   │     └─ MID severity → kirim tapi flag → moderation queue
   ├─ Persist ke Redis Stream (XADD MAXLEN ~200)
   ├─ Broadcast ke room (batched 100ms)
   ├─ Async: enqueue ke chat-archive-queue (batch insert Postgres)
   └─ Async: enqueue ke moderation-queue kalau flagged
```

**Profanity list** di `lib/profanity/id.json` — Bahasa Indonesia + slang + EN common slur. Update via `PATCH /admin/moderation/profanity`. Leet-speak normalization (`b0d0h` → `bodoh`).

**Auto-warn / mute:**

| Trigger | Action |
|---|---|
| 3 HIGH chat dalam 24h | auto-mute 24h + warn |
| 5 MID chat dalam 7 hari | warn, no mute |
| 3 user report dalam 1 jam thd msg sama | auto-hide pending review |
| Spam (sama content 5x dalam 1 menit) | auto-mute 15 menit |

**Chat replay untuk joiner baru:** server kirim 50 message terakhir dari Redis Stream sebagai initial state, lalu live append. Anonymous = baca replay sama, input area di-mark "🔒 Login untuk chat".

---

## Viewer Presence

**Real-time count:** Redis SET `viewer:session:{id}` cardinality. Broadcast `viewer.joined/left` event throttled 1/detik (cuma kirim count terbaru).

**Unique tracking:** setiap join → cek member SET sebelumnya, kalau belum → `total_unique_viewers++`. Update `peak_viewers` kalau current > peak. Batch update DB tiap 30 detik (bukan per-event).

**Viewer list endpoint** (`GET /streams/:session_id/viewers`): tampil 20 viewer (paginated). Sort login dulu, anonim sebagai bucket. Hide user `privacy_show_in_viewers = false`.

---

## Anonymous Preview Gating

Budget: 60 detik per device per IP per hari. Disimpan Redis `preview:device:{id}:ip:{ipHash}:{todayUTC}`. IP hash = `sha256(ip + PREVIEW_SALT)`.

```ts
const keyDailyBudget = `preview:${device_id}:ip:${ipHash}:${todayUTC()}`;
let remaining = await redis.get(keyDailyBudget);
if (remaining === null) remaining = ANON_PREVIEW_SECONDS_PER_DAY;   // 60
if (remaining <= 0) { socket.emit('preview.expired', {}); socket.disconnect(); return; }
await redis.set(keyDailyBudget, remaining, 'EX', secondsUntilTomorrowUTC());

// Push notif 15s / 5s / 0s sebelum expiry
[remaining-15, remaining-5, 0].filter(t => t > 0).forEach(t => {
  setTimeout(() => socket.emit('preview.expiring', { remaining_s: remaining - t }), t * 1000);
});
setTimeout(() => { socket.emit('preview.expired', {}); socket.disconnect(); }, remaining * 1000);
```

Saat tab ditutup sebelum habis → sisa budget kembali (decrement actual usage). IP berubah (mobile network) → hash beda → budget reset. Phase 1 acceptable (soft gate); Phase 2 tambah CAPTCHA + device fingerprint.

---

## Moderation Tools

**In-stream (admin overlay):**
- Long-press chat bubble → menu: `Hide` | `Mute author 24h` | `Ban author`
- Toggle **Slow mode** → paksa cooldown 10 detik untuk semua user di session
- **Pause chat** → hentikan semua chat (system message: "Chat di-pause oleh admin")
- **End stream** dengan konfirmasi 2x

**Dashboard:**
- `/admin/moderation/queue` — list flagged. Per item: snapshot, context (5 msg sebelum/sesudah), button approve / hide / ban.
- `/admin/moderation/users` — search user, warn count, mute/ban history.
- Semua admin action → `moderation_logs` + audit_log (sudah ada).

**SLA Phase 1:** report < 1 jam reviewed (manual). HIGH severity auto-hide < 2 detik. Ban appeal via email `support@purrtein.com`.

---

## Scaling Pertimbangan Sosial Layer

**Target Phase 1:**
- 50 device live concurrent.
- 200 viewer concurrent per device popular.
- 10.000 total concurrent socket.
- 500 msg/sec chat aggregate.

**Bottleneck assessment:**

| Komponen | Bottleneck | Mitigasi |
|---|---|---|
| Socket.io | RAM ~10 KB/connection × 10k = 100 MB | Vertical scale 1–2 pod 2GB + redis-adapter |
| Redis pub/sub | message fan-out | Dedicated socket-Redis vs cache-Redis (Phase 2: cluster) |
| Postgres chat insert | high write | Batch write-behind 100/2s via `chat-archive-queue` |
| WHEP egress (video) | bandwidth mediamtx | Cap viewer / stream Phase 1, CDN Phase 2 |
| EMQX | tidak terdampak (sosial layer di Node) | — |

**Cap defensif Phase 1:**
- Max concurrent viewer per device: **300**. Setelah itu → "Stream penuh, antri sebentar" (queue Redis sorted set, polling 5s).
- Max chat per detik per session: **50** (`SESSION_MAX_CHAT_PER_SEC`). Lewat threshold → slow mode auto 10s untuk semua user di session.
- Max sticker animation visible at once: 1 large/epic (queue).

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
- ❗ **Chat flood DoS**: tanpa rate limit + cap → backend crash. Rate limit di socket level + `SESSION_MAX_CHAT_PER_SEC = 50` cap, slow mode auto kalau lewat.
- ❗ **WS Redis adapter down** → broadcast tidak sinkron antar pod → viewer lihat chat berbeda. Health check + alert.
- ❗ **Race gift transaction**: client tap 5x sebelum response → 5x deduct. **Fix:** `idempotency_key` di body wajib + Redis SETNX 24h.
- ❗ **Gift triggers feed saat device offline (race)**: gift bayar tapi feed gagal sampai. **Fix:** pre-flight `stream_state === active`. Kalau race terjadi → refund **full** `tokens_spent` + system message ke chat.
- ❗ **Anon preview bypass via VPN/clear cookie** → bandwidth bleed. Phase 1 acceptable (soft gate), Phase 2 CAPTCHA + device fingerprint.
- ❗ **Mute bypass via re-register**: user banned bikin akun baru. Email + phone verify minimal.
- ❗ **Chat history loss saat Redis restart** → 24h ephemeral hilang. Acceptable, archive Postgres tetap aman via `chat-archive-queue`.
- ❗ **Profanity false positive** → user normal kena auto-hide. Whitelist mechanism + manual review queue (sla 1 jam).
- ❗ **Toxic chat publik viral di sosmed** → reputasi rusak. Profanity filter day-1 + ban tools tested + admin response SLA.
- ❗ **GDPR/UU PDP request hapus chat**: hard delete user → chat lain context-nya rusak. **Fix:** anonymize `user_id` jadi "deleted_user", konten tetap (anonim) untuk preserve thread.
