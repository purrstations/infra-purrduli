# CLAUDE.md — Implementation Kickoff (Purrtein Smart Cat Feeder)

> Audit kesiapan dokumentasi untuk fase implementasi + action list yang **kamu** (Purrtein owner) wajib jalankan sebelum atau parallel dengan tim coding mulai. Dokumen ini adalah satu-satunya tempat di mana kamu lihat "apa yang harus saya kerjakan sekarang".

---

## 1. Audit Per File

| File | Lines | Status | Catatan |
|---|---:|---|---|
| `CLAUDE_integration_contract.md` | 484 | ✅ **Ready** | Single source of truth. Konstanta, MQTT, WS, error code, concurrency lengkap. |
| `CLAUDE_iot.md` | 464 | ⚠️ **Ready dengan blocker H8** | Pin mapping stepper tentative — wajib di-update setelah board datang. Logika firmware OK untuk mulai TDD native test. |
| `CLAUDE_backend.md` | 1175 | ✅ **Ready** | Schema, queue, endpoints, security, scaling, social layer lengkap. Bisa langsung di-`prisma init` + scaffolding. |
| `CLAUDE_frontend.md` | 743 | ✅ **Ready** | Stack final (Vite + RQ). Routing + state + WS handler lengkap. |
| `CLAUDE_uiux.md` | 881 | ⚠️ **Ready dengan blocker U1** | Spec halaman & komponen lengkap, tapi brand kit (logo + color) masih placeholder. Designer bisa mulai dengan placeholder lalu re-skin. |
| `CLAUDE_analysis.md` | 206 | ✅ Reference | Risiko + sprint plan. |

**Verdict global:** **80% siap mulai coding.** 20% blocker = hardware + brand + 7 keputusan bisnis. Implementasi bisa start Week 1 dengan kerja paralel: backend + frontend boleh mulai segera, IoT mulai setelah board + pin map.

---

## 2. BLOCKERS — Wajib Resolve Sebelum Week 1

| # | Item | Owner | Cara resolve |
|---|---|---|---|
| **B1** | **GitHub App ter-install di org `purrstations`** | Kamu | https://github.com/apps/claude → install ke org → pilih repo `infra-purrduli`. Tanpa ini Claude Code & CI tidak bisa push ke repo |
| **B2** | **Infra repo siap**: 3 repo terpisah atau monorepo? | Kamu | Rekomendasi: `purrstations/backend`, `purrstations/frontend`, `purrstations/firmware`, plus `infra-purrduli` (yang ini) untuk infra compose. Bikin sekarang |
| **B3** | **Xendit account + API key + webhook URL** | Kamu | https://dashboard.xendit.co → register → ambil secret key + setup webhook token. Tanpa ini topup tidak bisa di-test |
| **B4** | **FCM project + service account JSON** | Kamu | https://console.firebase.google.com → create project → ambil service account key. Untuk admin notif & user push |
| **B5** | **Domain + TLS cert** | Kamu | Beli/setup domain `purrtein.com`. Subdomain plan: `api.`, `app.`, `admin.`, `stream.`, `mqtt.`. TLS via Let's Encrypt (certbot sudah di docker-compose) |
| **B6** | **Server VPS** untuk infra (Postgres + Redis + EMQX + mediamtx + nginx) | Kamu | Minimum VPS 4 vCPU / 8 GB RAM / 80 GB SSD. Indonesia region (Biznet/Cloudkita) untuk latency MiFi |
| **B7** | **MiFi modem prototype** + kuota | Kamu | Beli 1 unit Telkomsel/XL pocket MiFi untuk test connectivity ESP32 |
| **B8** | **Hardware prototype**: ESP32-S3 N16R8 + OV2640 + stepper + driver + power supply + capacitor + vibration damper | Hardware team | Pesan, jadwalkan datang Week 2 paling lambat. Tanpa ini IoT stuck di pure-logic test |

---

## 3. DECISIONS — Konfirmasi Default atau Override

Default sudah saya isi di contract §15 + per-file open decisions. **Kalau diamkan, implementasi pakai default.** Yang berdampak kode signifikan:

| ID | Pertanyaan | Default | Wajib konfirmasi sebelum |
|---|---|---|---|
| **D1** | Login user: email+password / magic link / Google OAuth? | email+pass | Week 1 backend mulai auth |
| **D2** | Akses peta + livestream wajib login? | Peta publik, stream login | Week 1 frontend routing |
| **D3** | Metode bayar (QRIS only vs multi)? | QRIS + VA + e-wallet | Week 2 Xendit integration |
| **D6** | Cooldown feed per user per device | 5 menit | Week 2 backend feeding queue |
| **D7** | FCM target (semua admin vs per-device) | Semua admin | Week 2 notification queue |
| **L1** | Gift catalog & pricing final | small 1tok / med 3tok+1feed / large 10tok+3feed / epic 50tok+10feed | Week 3 sosial layer |
| **L2** | Anon preview duration | 60 detik/IP/hari | Week 3 |
| **L3** | Viewer list privacy default | opt-in tampil | Week 3 |

**Yang BISA di-defer ke Phase 2:**
- D4 refund policy (auto saja Phase 1)
- D5 admin self-register (seed saja Phase 1)
- D10 OTA firmware (Phase 2 confirmed)
- L7 push notif follow feeder (Phase 2)
- U2 mascot (Phase 2)
- U4 share sosmed (Phase 2)

**Yang URGENT bisnis dengan dampak legal:**
- **Pajak donasi** — konsultasi tax advisor (PPh/PPN untuk donasi vs penjualan token?)
- **KYC threshold** — donasi > Rp X butuh KYC? Cek dengan Xendit
- **Izin pemasangan device di area publik** — koordinasi RT/RW/pengelola lokasi sebelum pasang
- **Privacy policy + ToS** — wajib publish sebelum app go-live. Termasuk disclaimer kamera publik

---

## 4. INFRA PREP — Action Items Paralel (Owner: Kamu/DevOps)

Lakukan paralel dengan Week 1 coding. Target selesai Week 2.

### 4.1 VPS Setup
- [ ] Provision VPS (B6)
- [ ] Install Docker + Docker Compose
- [ ] Clone `infra-purrduli` repo
- [ ] Setup ufw/iptables: allow 443, 8883, 8554. Block 1883, 5432, 6379 dari publik.
- [ ] Setup `fail2ban` untuk SSH + nginx
- [ ] Setup backup harian Postgres + EMQX retained ke S3 atau Wasabi (cron + `pg_dump`)

### 4.2 DNS
- [ ] `api.purrtein.com` → backend
- [ ] `app.purrtein.com` → frontend user
- [ ] `admin.purrtein.com` → frontend admin
- [ ] `stream.purrtein.com` → mediamtx
- [ ] `mqtt.purrtein.com` → EMQX

### 4.3 TLS
- [ ] Certbot dapat cert untuk 5 subdomain (sudah ada di docker-compose, tinggal jalankan)
- [ ] Auto-renew tested (`docker compose exec certbot certbot renew --dry-run`)

### 4.4 EMQX hardening (sangat penting)
- [ ] Disable port 1883 di production (only 8883 TLS)
- [ ] Generate per-device credentials script: `tools/seed-device.sh` (output: device_id + secret + EMQX user)
- [ ] **ACL rule per-device** (mandatory — tanpa ini bisa spoofing):
  ```
  {allow, {username, "device-${device_id}"}, publish, ["purrtein/devices/${device_id}/#"]}.
  {allow, {username, "device-${device_id}"}, subscribe, ["purrtein/devices/${device_id}/commands/#"]}.
  ```
- [ ] Backend user `backend` dengan ACL publish ke `commands/+` dan subscribe ke `status` + `events/+`

### 4.5 mediamtx hardening
- [ ] Disable RTSP plain (only authenticated push)
- [ ] Setup `runOnReadAuth` hook ke `https://api.purrtein.com/internal/stream/auth` (dengan shared secret)
- [ ] `record: false` di config (tidak rekam stream — privacy)

### 4.6 Observability
- [ ] Setup Grafana + Prometheus + Loki (atau Grafana Cloud free tier)
- [ ] Sentry project untuk backend + frontend + firmware
- [ ] Uptime monitoring (UptimeRobot atau Better Uptime) untuk healthcheck endpoint

### 4.7 CI/CD
- [ ] GitHub Actions workflow per repo:
  - Backend: lint → test → build image → deploy SSH (atau push ke ghcr.io + ssh pull)
  - Frontend: lint → test → build → deploy (Vercel/CF Pages atau scp ke nginx)
  - Firmware: PlatformIO native test + lint
- [ ] Pre-commit hook: `prettier` + `eslint` + `commitlint` (conventional commits)
- [ ] Required status checks di branch `main` (no direct push)

---

## 5. ASSETS & CONTENT — Action Items (Owner: Kamu + designer + copywriter)

- [ ] **Brand kit** (U1): logo Purrtein, primary color, font family, 3 stock photo kucing
- [ ] **Tone copywriter** Bahasa Indonesia — review semua copy di `CLAUDE_uiux.md §19`. Hire native (bukan AI translation)
- [ ] **Sticker catalog awal** (10–15 SVG/Lottie): paw clap, heart, fish, meow, etc. Design ulang dari placeholder
- [ ] **Gift animation** (4 tier Lottie file): small, medium, large, epic
- [ ] **Empty state illustrations** (4–6 SVG): peta kosong, riwayat kosong, wallet kosong, dll
- [ ] **Profanity wordlist** Bahasa Indonesia + slang — kurasi bersama tim, simpan di `backend/lib/profanity/id.json`
- [ ] **Privacy policy + ToS** — minta dari legal, publish di `/legal/privacy` dan `/legal/tos`
- [ ] **App icon + favicon** + PWA manifest
- [ ] **Marketing site** (opsional, Phase 1 bisa skip) → langsung peta

---

## 6. TEAM & TIMELINE

### Team minimum Phase 1 (4 minggu)

| Role | Headcount | Tanggung jawab |
|---|---|---|
| **Backend eng** | 1–2 | Express + Prisma + queue + MQTT + WS + sosial layer |
| **Frontend eng** | 1–2 | Vite + RQ + user app + admin dashboard |
| **IoT eng** | 1 | PlatformIO firmware + stepper + camera + RTSP + BLE |
| **Designer** | 1 | Figma tokens + page mockup + Storybook sync |
| **DevOps/Ops** | 1 (part-time) | Infra section §4 |
| **Project lead** | 1 (kamu) | Decisions + UAT + stakeholder Purrtein |

### Sprint Plan (4 minggu, gabung dari `CLAUDE_analysis.md §5`)

**Week 1 — Foundation**
- Infra setup (§4) selesai
- Backend: skeleton + Prisma migrate + auth + zod schemas
- Frontend: monorepo setup + routing + auth + design tokens placeholder
- Firmware: HAL abstraction + native test framework + state machine pure logic
- Designer: Figma foundation + 5 atom + 5 molecule
- **Deliverable**: backend health + frontend login screen + firmware native test pass

**Week 2 — Core Flow**
- Backend: token + Xendit happy path + feed endpoint + feeding-queue + refund-queue
- Frontend: topup + feed confirm + wallet + history
- Firmware: MQTT connect + heartbeat + feed handler + NVS persist + LWT
- Designer: 5 organism + state patterns (loading/empty/error)
- **Deliverable**: user bisa register → topup (mock webhook) → feed device → balance updated

**Week 3 — Stream & Social**
- Backend: stream-queue + signed WHEP + chat pipeline + gift transaction + viewer presence
- Frontend: StreamPlayer + useStreamSocial + chat overlay + gift drawer
- Firmware: camera init + RTSP push + stream lifecycle event
- Designer: livestream sosial page hi-fi + Lottie integration
- Hardware: prototype 1 unit di-flash + lab test
- **Deliverable**: end-to-end test: user login → chat → kirim gift → trigger feed → lihat di stream

**Week 4 — Hardening & Pilot**
- BLE provisioning + admin device CRUD
- Moderation tools admin
- Pen test ringan + axe-core a11y check
- UAT scenarios (lihat §7)
- Deploy 1 device pilot di lokasi pertama (lokasi yang sudah punya izin)
- Soak test 24 jam
- **Deliverable**: produksi MVP live, 1 device aktif menerima donasi real

---

## 7. UAT SCENARIOS (untuk Week 4)

Wajib semua pass sebelum scaling ke device ke-2:

### User flow
- [ ] Register email+password → email verification (kalau ada) → auto login
- [ ] Buka peta tanpa login → klik marker → lihat detail (stream live ke-block dengan CTA login)
- [ ] Login → buka stream → countdown anon **TIDAK** tampil (login user)
- [ ] Anon (logout) → buka stream → countdown 60s muncul → expired → block modal
- [ ] Topup QRIS 10 token → bayar dari HP → balance auto-update via WS
- [ ] Feed 1 rotasi → stream menampilkan motor berputar → `feeding.done` event → balance kurang
- [ ] Feed saat device offline → error `DEVICE_OFFLINE` → balance tidak kepotong
- [ ] Feed device → motor stall (simulate) → `feeding.failed motor_stall` → balance refund

### Sosial
- [ ] Chat di stream → muncul di tab lain (WS broadcast)
- [ ] Chat 4x dalam 10 detik → block dengan rate limit
- [ ] Chat kasar (test profanity) → auto-hide + warn
- [ ] Kirim sticker free → animasi muncul di stream semua viewer
- [ ] Kirim gift medium 3 token → animasi takeover + feed trigger → motor putar 1x
- [ ] Gift saat stream offline (race) → refund full
- [ ] Anon try chat → input disabled dengan label "Login dulu"

### Admin
- [ ] Pairing wizard 4 step end-to-end (device fisik connect via BLE)
- [ ] Refill device → counter reset → stock_level 1.0
- [ ] Start stream → mediamtx menerima → stream_status active
- [ ] Hide chat toxic → di tab lain hilang real-time
- [ ] Mute user 24h → user kena `moderation.muted` event

### Resilience
- [ ] Cabut MiFi → 120s kemudian device offline + WS alert
- [ ] Cabut power device saat feeding → reboot → recovery `feeding_done failed`
- [ ] Restart backend → MQTT QoS 1 message tidak hilang
- [ ] 200 concurrent viewer di 1 stream → no crash, latency < 500ms

---

## 8. ANTI-PATTERN — Jangan dilakukan

Untuk dilarang ke setiap agent coder:

### Backend
- ❌ Hardcode konstanta di kode (gunakan env, sinkron dengan `contract §11`)
- ❌ `prisma db push` di production (selalu `migrate`)
- ❌ Token deduct tanpa Redis atomic
- ❌ Webhook Xendit tanpa transaction + advisory lock
- ❌ MQTT publish tanpa validate `payload.device_id === topic device_id`
- ❌ Hapus chat user (anonymize saja untuk GDPR)
- ❌ Log credential/secret/token plain di structured logger
- ❌ EMQX tanpa ACL per-device (CRITICAL)

### Frontend
- ❌ JWT di localStorage (httpOnly cookie only)
- ❌ Zustand untuk server state (TanStack Query)
- ❌ Hardcode warna (selalu via Tailwind token)
- ❌ Spinner full-screen saat loading (skeleton)
- ❌ Toast tanpa retry CTA untuk 5xx
- ❌ WHEP PC tidak di-cleanup di useEffect return
- ❌ Pakai `Date.now()` di SSR/hydration (mode SPA aja Phase 1 jadi aman)

### IoT
- ❌ NVS write per iterasi loop (wear cepat)
- ❌ MQTT publish tanpa idempotency cek `feeding_log_id` LRU
- ❌ Blocking call > 5s di main loop (watchdog reboot)
- ❌ Camera init tanpa cek `psramFound()`
- ❌ Stream URL credential di payload MQTT (hardcode dari provisioning)
- ❌ Hardcode device_id di firmware (NVS dari BLE provisioning)

### UI/UX
- ❌ Disable tombol tanpa helper text alasannya
- ❌ Error toast tanpa `request_id` displayed (untuk support trace)
- ❌ Chat overlay full opaque (gradient fade untuk lihat video)
- ❌ Gift animation > 10 detik (max epic 10s)
- ❌ Privacy default opt-out (user tidak sadar mereka tampil)

---

## 9. POST-LAUNCH — Setelah Pilot Sukses

Phase 1.1 (Month 2):
- Scale ke 3–5 device pilot di lokasi berbeda
- Onboard 50–100 user beta (closed)
- Iterasi `STOCK_CAPACITY_ROTATIONS` berdasarkan kalibrasi nyata
- Refine profanity list berdasarkan chat real

Phase 1.2 (Month 3):
- Open beta (publik)
- Marketing landing page
- Sosial media presence

Phase 2 (Month 4+):
- OTA firmware update
- AI cat detection
- Multi-region mediamtx
- 2FA admin
- Push notif user follow feeder

---

## 10. NEXT STEP HARI INI

**Yang kamu lakukan dalam 24 jam ini:**

1. ⏰ **Resolve B1** — install GitHub App Claude Code di org `purrstations`
2. ⏰ **Resolve B5** — beli domain `purrtein.com` (kalau belum) atau konfirmasi nama lain
3. 📝 **Jawab 7 decisions urgent (D1, D2, D3, D6, D7, L1, L2)** — minimal komen di issue GitHub atau notion
4. 🎨 **Mulai hubungi designer** untuk brand kit (U1) — minimal logo + 3 warna utama
5. 📝 **Hubungi legal** untuk privacy policy + ToS draft
6. 📦 **Pesan hardware** (B8) — ESP32-S3, stepper, dll. Lead time biasanya 1–2 minggu

**Minggu depan:**
1. Onboard 1 backend eng + 1 frontend eng + 1 IoT eng
2. Setup VPS + DNS + TLS (§4.1–§4.3)
3. Backend + frontend mulai Week 1 sprint
4. IoT mulai native test (tanpa hardware dulu)

Begitu hardware datang → IoT lanjut on-target test sambil backend + frontend siap integrasi.

---

## 11. APA YANG SAYA (CLAUDE) BISA BANTU SETELAH INI

Setelah kamu beri sinyal kickoff, saya bisa di session berikutnya:

- Generate `schema.prisma` lengkap + migration SQL file pertama
- Generate boilerplate backend (Express + Prisma + zod + folder structure)
- Generate boilerplate frontend (Vite + RQ + RouterDom + Tailwind + shadcn init)
- Generate boilerplate firmware (PlatformIO project + HAL abstraction + native test scaffolding)
- Generate `mediamtx.yml`, EMQX ACL config, nginx config
- Generate `tools/seed-device.sh`, profanity starter list, GitHub Actions workflow

Tinggal bilang "generate X" satu per satu, atau "scaffold semua" untuk batch.
