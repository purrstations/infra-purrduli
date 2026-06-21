# Analisis Pasca-Revisi: Hal yang Mungkin Terlewat & Kondisi Lapangan

> Catatan reviewer untuk Purrtein. Setelah selaras 3 file `CLAUDE_*.md` + `CLAUDE_integration_contract.md`, di bawah adalah hal-hal yang BELUM ter-cover atau RISIKO PRODUKSI nyata di lapangan publik.

---

## 1. Friksi Integrasi yang Sudah Diselaraskan

| # | Sebelum | Sesudah |
|---|---|---|
| 1 | Backend pakai `portion_gram`, Firmware pakai `rotations` | **Semua pakai `rotations`** + token = N rotasi (default 1) |
| 2 | Threshold beda (0.15 vs 0.20) | **Single source di contract §2 = 0.15** |
| 3 | Topik `refill` hanya di firmware | Backend dapat **endpoint, worker, RefillLog model** |
| 4 | LWT/retained tidak terhandle backend | Backend wajib **subscribe + parse retained status**, LWT contract diatur §3 |
| 5 | `reason` enum tidak ada di backend | DB `feeding_logs.reason` + mapping → refund/retry/notif policy |
| 6 | Concurrency cuma di firmware | Backend pre-flight cek `device.status` + `stream_status` sebelum enqueue |
| 7 | Tidak ada refund | `refund-queue` + tabel `token_usages.refunded` + WS `feeding.failed` |
| 8 | NTP cuma di firmware | Backend container `chrony` + skew-check, anti-replay 2-arah |
| 9 | BLE provisioning tanpa endpoint backend | `POST /admin/devices` + `pairing-status` + `reset-secret` |
| 10 | `total_rotations` tidak ada di backend | Tambah kolom mirror di `devices` + `feeding_logs` |
| 11 | Stream lifecycle event hilang | Topic `events/stream_state` + worker poll mediamtx API |
| 12 | TDD hanya di firmware | Section mandatory di semua 3 layer, target coverage explicit |
| 13 | Frontend stack open | **Next.js 14 + RQ + Zustand + Axios** ditetapkan (D8) |
| 14 | WHEP URL plain | Signed token TTL 60s, mediamtx auth-hook ke backend |
| 15 | Timezone tidak ditetapkan | UTC ISO8601 dengan `Z` |
| 16 | Idempotency feed cuma optional | LRU 100 + persist NVS di firmware, `feeding_log_id` `@unique` di backend |
| 17 | `schema` versioning | Wajib di semua payload MQTT (versi 1 sekarang) |
| 18 | Anti-replay backend tidak jelas timer | `issued_at` + `deadline_at` eksplisit |
| 19 | Stream URL credentials di MQTT command | Kredensial hardcoded di firmware via provisioning, command cuma trigger |
| 20 | Heartbeat off-cycle | Wajib re-publish saat state berubah |

---

## 2. Yang BELUM Tercover & Harus Diputuskan Sebelum Produksi

### 2.1 Operasi Lapangan

- **Reset factory di lapangan tanpa app**: kalau device "tersesat" (NVS corrupt, secret bocor di-rotate, dll), teknisi butuh cara reset tanpa flash ulang. → Tambahkan **long-press BOOT button 10 detik** di firmware = factory reset (clear NVS, kecuali `device_id` di eFuse OTP). Aksesibilitas dari luar casing harus dipikirkan (recessed pinhole supaya tidak ke-press random).
- **Identifikasi visual di lapangan**: device "feeder-001" perlu label fisik dengan QR berisi `device_id`. Bagaimana print + lapisan tahan cuaca? Sticker laminated.
- **Replace device**: kalau device rusak total, admin perlu "transfer" lokasi GPS + nama ke device baru. Backend butuh endpoint `POST /admin/devices/:old/replace { new_id }` untuk pindahkan `feeding_logs` history (atau biarkan history tetap di old).
- **Akses fisik ke MiFi**: MiFi punya bateri/quota terbatas. Kalau quota habis → device offline. Backend tidak tahu bedanya MiFi mati vs ESP32 mati. → Tambahkan field `last_known_rssi`, `last_known_uptime` di event boot untuk forensik.
- **Maintenance window**: teknisi datang refill → device offline 1 jam. Backend wajib auto-suppress alert offline saat refill in-progress. → Tambah `devices.maintenance_until` field + skip alert sampai lewat.

### 2.2 Bisnis & Legal

- **KYC user**: Indonesia, donasi >Rp 1jt/transaksi bisa kena AML/CFT? Cek dengan Xendit & legal Purrtein.
- **Pajak donasi**: ada PPh / PPN? Invoice untuk donatur?
- **Persetujuan tempat pemasangan**: device di area publik butuh izin lokasi (kelurahan / pengelola RW / shopping mall). Buat checklist pre-install.
- **Kebijakan privasi kamera**: livestream rekam area publik = capture wajah orang lewat. Butuh signage "Kamera aktif" + privacy policy disclosure. **JANGAN simpan rekaman** di Phase 1 — stream live-only, tidak ada `record: true` di mediamtx.
- **Refund money**: bagaimana kalau user request refund Rp ke kartu kredit? Phase 1 = manual via admin. Phase 2 = endpoint Xendit refund API.
- **Penyalahgunaan livestream**: jika user pakai stream untuk surveillance personal (camera memantau rumah tetangga, dll). Need ToS klausa.

### 2.3 Skalabilitas

- **EMQX cluster**: 1 node = single point of failure. Phase 2 wajib 3-node cluster.
- **mediamtx cluster**: 1 node = bottleneck bandwidth. Plan: per-region mediamtx, device pilih terdekat via DNS.
- **Postgres replica**: Phase 1 single node. Backup harian S3, RTO 4 jam acceptable. Phase 2: streaming replica.
- **Redis persistence**: AOF aktif, RDB snapshot tiap 5 menit. Kehilangan saldo terdeteksi via DB reconciliation cron.
- **Concurrent feed per device limit**: 1 (already enforced). Tapi 100 user antri 1 device = 100 × 5 menit = jam terakhir antrian. → Tambahkan UI "antrian saat ini: N orang, estimasi tunggu: X menit" di confirm feed page.

### 2.4 Security Hardening

- **EMQX ACL per-device** (CRITICAL): tanpa ACL, device A bisa publish ke topik device B → spoofing total stock atau publish fake `feeding_done`. Implementasi:
  ```
  {allow, {username, "device-${device_id}"}, publish, ["purrtein/devices/${device_id}/#"]}.
  {allow, {username, "device-${device_id}"}, subscribe, ["purrtein/devices/${device_id}/commands/#"]}.
  ```
  Username MQTT per-device = `device-{uuid}`, password = `device_secret`.
- **JWT secret rotation**: tidak ada rencana rotate. Tambah `kid` di JWT header, support rotasi tanpa logout massal.
- **Webhook replay**: Xendit kirim signed but tidak ada nonce. → Idempotency `external_id` sudah cover.
- **Brute force admin login**: lockout 15 menit setelah 5 gagal sudah ada, tapi attacker switch IP. → Lockout per-account juga, bukan cuma per-IP.
- **DoS POST /feed**: rate limit per-user 1/2s, tapi attacker bikin 1000 akun. → CAPTCHA di register + email verification + delayed token activation.
- **mediamtx path enumeration**: WHEP path = `device_id`. Kalau attacker tahu device_id → coba akses. Mitigasi: signed token (sudah). Tambah: path randomize per session (`/stream/{session_uuid}` map ke device internal).
- **NVS encryption key**: kalau attacker punya akses fisik (curi feeder), bisa unsolder flash + dump. NVS encryption key di eFuse, tapi eFuse readable kalau secure boot tidak aktif. → Aktifkan Secure Boot V2 untuk Phase 2.

### 2.5 Compliance Data

- **GDPR/UU PDP**: user data (email, phone, payment method) — wajib privacy policy, mekanisme delete account.
- **Data retention**: feeding logs 1 tahun, payment 7 tahun (perpajakan). Beresihan otomatis cron Phase 2.

### 2.6 UX Edge Cases

- **Saldo 0 → user klik "Beri Makan"**: redirect topup. Tapi setelah topup, kembalikan ke `/feeder/:id/feed` (preserve intent via query param `from=`).
- **Stream loading > 5 detik**: tampilkan progress + tombol cancel. Kalau gagal: "Coba refresh atau lihat feeder lain".
- **User feed lalu langsung tutup app**: WS event tidak ke-receive. Saat user buka app lagi → `GET /feed/history` tampilkan status terkini. Kirim push notif FCM ke user device saat `feeding.done`/`failed` (perlu register FCM token).
- **Multi-tab**: user buka 2 tab, masing-masing klik feed. Backend dedup bisa lewat (race). → Idempotency key client-side di `POST /feed` body: `idempotency_key: uuid()` (24 jam window di Redis).
- **Notifikasi browser**: minta permission saat user pertama feeding sukses, supaya next time bisa push event tanpa tab aktif.

### 2.7 Observability Gap

- **Alert ke siapa**: device offline 5 menit → ping siapa? Phase 1 = email admin + FCM. Phase 2 = on-call rotation via PagerDuty.
- **SLA**: belum ditetapkan. Saran:
  - Backend uptime 99.5% (~3.5 jam downtime/bulan).
  - MQTT broker 99.9%.
  - Device uptime 95% (lapangan, wajar).
- **Dashboard monitoring**: Grafana + Prometheus untuk backend, EMQX dashboard untuk MQTT. Belum disebut.
- **Anomaly detection**: feeding sukses tiba-tiba turun drastis = device atau motor rusak. Tambahkan alert "device X feeding success rate < 80% dalam 24 jam".

### 2.8 Testing & Pre-Launch

- **Soak test device**: jalankan device 24/7 selama 7 hari di lab sebelum produksi. Hitung NVS write count, heap leak, stepper steps.
- **MiFi failure simulation**: cabut MiFi 10 menit → device reconnect → LWT terkirim → backend mark offline → MiFi nyala → device publish status retained → backend mark online. Test ini E2E.
- **Power outage simulation**: cabut power di tengah feeding → reboot → counter recovery + `feeding_done failed` dengan reason `motor_stall, recovered_after_reboot: true`.
- **Concurrent feed dari 10 user**: backend antrian benar, device tidak double-feed.
- **Pen test**: white-box (kode review) + black-box (Burp Suite intercept) sebelum launch.

### 2.9 Cost Awareness

- **Mobile data MiFi**: stream VGA 10fps JPEG ≈ 200 KB/s × 60s = 12 MB/menit. 1 jam stream = 720 MB. Jika 5 device aktif rata-rata 1 jam/hari = ~3.6 GB/hari = ~108 GB/bulan. **Kuota MiFi**?
  → Streaming wajib di-cap durasi (default 5 menit, lihat contract §11 `STREAM_MAX_DURATION_S`).
- **Mediamtx egress**: ke viewer browser. 100 concurrent viewer × 200 KB/s = 20 MB/s = ~60 GB/jam. → CDN / WebRTC SFU di Phase 2 supaya scale.
- **Xendit fee**: ~Rp 2000 / transaksi QRIS. Minimum topup paket Rp 10rb? Margin tipis. Decision bisnis.

### 2.10 Internationalization (Phase 2)

- Strings di-extract ke `i18n` package. ID-only di Phase 1, EN di Phase 2 (untuk turis).

---

## 3. Risiko Tinggi (Top 10 untuk Pre-Launch Review)

| # | Risiko | Likelihood | Impact | Mitigasi |
|---|---|---|---|---|
| 1 | Backend tidak refund token saat feeding failed → user marah | High | High | `refund-queue` + integration test wajib |
| 2 | Stream URL leak → bandwidth bleed → MiFi quota habis | High | High | Signed token + STREAM_MAX_DURATION |
| 3 | EMQX tanpa per-device ACL → spoofing | High | Critical | ACL rule wajib SEBELUM device pertama deploy |
| 4 | NTP gagal → device "freeze" tolak semua command | Medium | High | Fallback multi-server, alert kalau > 30 menit no-sync |
| 5 | Counter rotasi out-of-sync setelah power loss | Medium | Medium | In-progress flag NVS + recovery flow |
| 6 | Double-credit Xendit webhook | Low | Critical (financial) | Transaksi + advisory lock |
| 7 | Double-feed (race kondisi backend ↔ device) | Medium | Medium | Idempotency `feeding_log_id` + LRU NVS device |
| 8 | Admin secret bocor | Low | Critical | Argon2 + 2FA Phase 2 + audit log |
| 9 | Kamera capture wajah → privacy issue | High | Medium-High | Signage + tidak rekam + privacy policy |
| 10 | MiFi quota habis di tengah operasi | Medium | High | Monitor uptime + jadwal isi quota + notif admin |

---

## 4. Backlog Phase 2+ (Yang Sengaja Dibuang dari MVP)

- OTA firmware update (H7).
- Multi-region mediamtx.
- AI cat detection (auto-feed saat ada kucing).
- Water dispenser integration.
- Refund API (auto-refund money ke kartu).
- 2FA admin (TOTP).
- SOS button di app (user laporkan kondisi feeder rusak).
- Komunitas / leaderboard donatur.
- Subscription monthly (auto-topup).
- Dashboard analytics user (chart pengeluaran token, kucing favorit).
- BLE audio command (suara meow ke kucing via speaker — Phase 4?).

---

## 5. Rekomendasi Urutan Implementasi (Sprint Plan)

**Week 1**: Setup infra (EMQX, mediamtx, Postgres, Redis, nginx TLS, CI/CD). Backend skeleton + Prisma migrate. Frontend monorepo setup. Firmware HAL + native test framework.

**Week 2**: Backend auth + token + Xendit happy path. Frontend register/login/topup flow. Firmware MQTT connect + heartbeat + feed handler (mocked motor).

**Week 3**: Integrasi end-to-end (feed → MQTT → mock device → response → WS → UI). Stream signed URL + WHEP. BLE provisioning. Hardware datang → flash & calibrate.

**Week 4**: UAT, pen test ringan, fix critical bugs, deploy produksi 1 device pilot, monitor 1 minggu sebelum scale.

---

## 6. Kontrak Versi Saat Ini

- `CLAUDE_integration_contract.md` — **v1.0.0** (2026-06-21)
- Compatible firmware: `>=1.0.0 <2.0.0`
- Compatible backend: `>=1.0.0 <2.0.0`
- Compatible frontend api-client: `>=1.0.0 <2.0.0`

Update contract = update semua sisi serentak + bump versi.
