# CLAUDE.md — IoT / Firmware (Purrtein Smart Cat Feeder)

> Dokumen ini adalah konteks utama untuk agent AI yang mengerjakan implementasi firmware ESP32-S3. Baca seluruhnya sebelum mulai coding.
>
> **WAJIB BACA DULU:** `CLAUDE_integration_contract.md` — semua schema payload, topik MQTT, konstanta, dan error reason ditentukan di sana. Dokumen ini hanya menjelaskan IMPLEMENTASI di sisi firmware.

---

## Project Context

Smart Cat Feeder adalah perangkat fisik yang dipasang di area publik untuk memberi makan kucing jalanan. ESP32-S3 adalah otak perangkat — terima perintah backend via MQTT, gerakkan stepper dispenser, hitung stok via counter rotasi, dan push stream RTSP ke mediamtx.

---

## Hardware

| Komponen | Fungsi |
|---|---|
| **ESP32-S3 (N16R8)** | Microcontroller utama — 16 MB flash + 8 MB PSRAM, WiFi + BLE onboard. Sudah include kamera OV2640 |
| **Kamera OV2640** | Sensor kamera onboard untuk RTSP push |
| **Motor Stepper + Driver (A4988/DRV8825/TMC2208)** | Stepper dispenser. Step per rev = 200 (1.8°/step), microstep 1/8 → 1600 steps/rotation. Pin mapping di section [Hardware Pin Mapping](#hardware-pin-mapping) |
| **MiFi (Modem WiFi Portable)** | Koneksi internet mandiri |
| **Power Supply 5V/3A** | Adaptor stabil. Stepper driver pakai supply terpisah (12V) supaya tidak ganggu ESP32 |
| **Capacitor decoupling** | 470µF di rail stepper untuk redam back-EMF |

**Resolusi keputusan hardware:**
- **H1 ✅** Tidak ada sensor stok fisik. `stock_level` dihitung dari `total_rotations` (lihat contract §2).
- **H2 ✅** 1 unit ESP32-S3 N16R8 dengan kamera onboard.
- **H3 ✅** MiFi sebagai WiFi client biasa.
- **H4 ✅** Porsi = jumlah putaran 360° (`rotations`).
- **H5 ✅** RTSP push via `Micro-RTSP` lib (fallback MJPEG-over-HTTP).
- **H6 ✅** Low-stock threshold = 0.15 (lihat contract §2).
- **H7 ⏸️** OTA: deferred Phase 2.
- **H8 ⏸️** Pin mapping stepper menunggu hardware datang — lihat section di bawah.

---

## Pre-Firmware Engineering Plan (Week 1–2)

Hardware engineer kerja **paralel** dengan firmware dev. Sebelum board datang dan firmware bisa di-flash, banyak hal harus disusun supaya saat hardware tiba, firmware tinggal validasi assumption — bukan re-engineer dari nol. Section ini = daftar deliverable Week 1–2 yang **non-firmware tapi blocking firmware**.

### A. Schematic Design (Circuit Diagram)

Pakai **KiCad** (open source, native multiplatform) atau **EasyEDA** (browser-based, langsung kirim ke JLCPCB untuk fab). Output: file `.kicad_sch` + PDF + netlist.

**Blok wajib:**

| Blok | Komponen kunci | Catatan |
|---|---|---|
| **Power input** | Konektor DC barrel atau XT60, fuse 3A polyfuse, TVS diode | Input 12 V dari adaptor |
| **Buck 12 V → 5 V** | LM2596 / MP1584 atau modul XL4015 | Arus 2 A min untuk ESP32 + camera + buffer |
| **LDO 5 V → 3.3 V** | AMS1117 atau onboard ESP32-S3 | ESP32-S3 dev board biasanya sudah include |
| **Stepper driver** | A4988 / DRV8825 / TMC2208 (paling sunyi) | Vmot 12 V, logic 3.3 V (cek datasheet driver) |
| **Decoupling** | 470 µF elco di Vmot stepper, 10 µF + 100 nF di tiap IC | Tanpa ini → camera reset saat stepper aktif |
| **Reset / Boot** | BOOT button (GPIO 0), RST button | BOOT untuk factory reset (long-press 10s) |
| **Status LED** | RGB onboard (GPIO 48) atau LED diskrit | Indikator state BLE / online / error |
| **Camera connector** | OV2640 sudah onboard ESP32-S3 N16R8 | Tidak perlu wiring tambahan |
| **USB-C programming** | USB-C female + USB-CDC built-in ESP32-S3 | Untuk flash + serial debug |
| **Stepper output** | 4-pin JST-XH ke motor | Twisted pair (reduce EMI) |
| **Protection** | Brown-out detector aktif (default), TVS di USB, EMI ferrite di stepper line | — |

**Output schematic Week 1**: PDF + netlist, di-review oleh 1 reviewer eksternal (electronics eng lain) sebelum lanjut PCB / breadboard.

### B. Pin Map Detailing (Resolve H8)

ESP32-S3 N16R8 + OV2640 sudah pakai banyak GPIO untuk camera bus. Pin yang **tersisa** untuk stepper + button + LED harus dipilih dari yang aman.

**GPIO yang reserved (jangan dipakai):**
- Strapping pins (jangan tied input saat boot): GPIO 0, 3, 45, 46
- PSRAM: GPIO 35, 36, 37 (ESP32-S3 N16R8)
- Camera DVP: GPIO 4, 5, 11, 12, 13, 14, 15, 16, 17, 18 (cek datasheet board spesifik — variasi antar vendor)
- USB-CDC: GPIO 19, 20
- Onboard RGB LED: GPIO 48 (kalau ada)

**GPIO yang aman dipakai (umumnya):** 1, 2, 21, 38, 39, 40, 41, 42, 47.

**Final pin map yang harus diisi** (override section "Hardware Pin Mapping" di doc ini):

| Fungsi | GPIO kandidat | Catatan |
|---|---|---|
| Stepper STEP | 38 | Frekuensi tinggi, gunakan RMT/MCPWM peripheral |
| Stepper DIR | 39 | Slow change |
| Stepper EN (active low) | 40 | Default HIGH (motor off) di boot |
| Stepper DIAG/FAULT | 41 | Opsional (TMC2208 stallGuard) |
| BLE/factory reset button | 0 | BOOT button sudah ada |
| Status LED tambahan | 47 | Kalau LED RGB onboard tidak cukup |

**Output Week 1**: tabel pin map FINAL — di-review dengan reviewer eksternal — di-commit ke `CLAUDE_iot.md` menggantikan section tentative.

### C. Power Budget

| Mode | Draw | Catatan |
|---|---|---|
| Idle (WiFi connected, MQTT loop) | 80–150 mA @ 5 V | ESP32-S3 + camera standby |
| Streaming aktif (camera DMA + JPEG + RTSP) | 250–350 mA @ 5 V | Bisa lebih kalau quality tinggi |
| Stepper running (1.5 A coils) | 1.5–2.5 A @ 12 V | Spike 2× saat start/stop |
| **Peak feeding + streaming** | ESP side 350 mA @ 5V + stepper 2 A @ 12V | **Adapter wajib 12 V / 3 A min** |
| Brown-out threshold | ~2.7 V VBAT | Default ESP32-S3 aktif |

**Output Week 1**: tabel power budget di-commit. Adapter spec di BOM.

### D. Calibration Plan (eksekusi Week 2)

Setelah hardware datang, **sebelum** flash firmware production, jalankan kalibrasi bench. Target: resolve `STOCK_CAPACITY_ROTATIONS` dan `ROTATIONS_PER_TOKEN` actual.

**Test rig minimal:**
- Bench power supply 12 V / 5 A adjustable (atau adapter + Watt meter)
- Digital scale 0.1 g resolusi
- Stopwatch / serial logger
- Tabung pakan terisi penuh
- Bowl wadah pakai

**Test 1: gram per rotasi**
- Rotasi 1× → timbang → catat.
- Ulangi 10× → ambil rata-rata + stddev.
- Target: gram/rotasi konsisten ±10%.
- Hasil → set `ROTATIONS_PER_TOKEN` di env (mis. kalau 1 rotasi = 10 g dan 1 token = 10 g target → ratio 1:1).

**Test 2: stock capacity**
- Isi tabung penuh, jalankan rotasi terus-menerus sampai pakan habis (dispenser kosong).
- Catat total rotasi sampai habis.
- Hasil → set `STOCK_CAPACITY_ROTATIONS` (mis. 200 rotasi untuk tabung 2 kg).

**Test 3: stepper speed sweet spot**
- Coba speed 100, 200, 400, 800 steps/sec.
- Cari yang tidak bikin pakan clog tapi tidak terlalu lambat.
- Set speed final di firmware constant.

**Test 4: vibration on camera**
- Pasang kamera dengan + tanpa damper.
- Streaming + run stepper → cek frame.
- Validasi acceptable blur.

**Test 5: power sag**
- Hook scope ke 5 V rail.
- Trigger stepper saat streaming.
- Cek tegangan tidak drop < 4.6 V (brown-out).
- Kalau drop → upgrade adapter atau tambah cap.

**Output Week 2**: laporan kalibrasi + constants final di `CLAUDE_iot.md` config.h.

### E. Test Rig & Dev Environment (siapkan Week 1)

- [ ] Bench power supply atau adapter + multimeter
- [ ] Soldering station + flux + helping hands
- [ ] Logic analyzer / scope (untuk debug MQTT + stepper timing)
- [ ] **Mosquitto MQTT broker lokal** (Docker) untuk dev tanpa cloud
- [ ] **Mock backend** Python script: terima `events/*`, publish `commands/feed` periodik (template ada di `tools/mock_backend.py` — dibuat Week 1)
- [ ] Mock MiFi: router WiFi dengan SSID/pass yang match config
- [ ] Serial monitor minimal 921600 baud (default ESP32-S3)
- [ ] PlatformIO + Visual Studio Code + C/C++ extension
- [ ] Git client (commit per fitur)

### F. Compliance (Indonesia)

Untuk dipasang di area publik dan menerima donasi, perangkat sebaiknya:

- **SDPPI sertifikasi** — perangkat radio (WiFi + BLE) wajib sertifikasi Kominfo untuk dijual. Pakai ESP32 yang sudah ber-sertifikat (banyak vendor jual modul sudah include sertifikat dengan tambahan biaya). Phase 1 prototype tidak butuh, scaling iya.
- **SNI adapter** — power adapter wajib lulus SNI 04-6203.1.
- **IP rating** — IP65 minimum untuk outdoor (semi-tertutup), IP67 kalau sepenuhnya outdoor terbuka.
- **Safety motor pinch** — guard fisik supaya jari tidak masuk ke dispenser mekanis. Penting untuk lokasi dengan anak-anak.

**Output**: catatan compliance + estimasi biaya sertifikasi (kalau scaling).

### G. Vendor & Supplier Map

Identifikasi minimal 2 supplier per komponen kritis (avoid single-source risk):

| Kategori | Primary | Backup |
|---|---|---|
| ESP32-S3 board | DigiWare (Jakarta) | AliExpress (lead time +1 minggu) |
| Stepper | Phaeton Robotics | Tokopedia "NEMA 17 1.8" |
| Driver | DigiWare TMC2208 | Tokopedia A4988 module |
| MiFi + SIM | Telkomsel Orbit | XL Home |
| 3D print | Vendor lokal (cek review Tokopedia) | In-house printer Phase 2 |
| PCB fab (Phase 2) | JLCPCB (China, $5/5pcs + shipping) | PCBWay |

**Output Week 1**: kontak vendor + harga + lead time per komponen.

### H. Field Pilot Lokasi Survey (Week 2)

Untuk pilot Week 4, scout lokasi yang memenuhi:

- [ ] Sinyal MiFi cukup (min RSSI -75 dBm). Tes pakai HP app "WiFi Analyzer" di lokasi.
- [ ] Stop kontak AC 220 V tersedia dalam jarak < 3 m. Atau extension cord aman.
- [ ] Atap teduh — hindari direct sunlight ke kamera + tabung pakan (panas → spoil).
- [ ] Akses teknisi mudah untuk refill rutin (≤ 30 menit perjalanan dari basecamp).
- [ ] Populasi kucing terkonfirmasi (survei 3 hari, hitung visit kucing).
- [ ] Izin pemilik lokasi (RT/RW/pengelola).
- [ ] Tidak rawan vandalisme / pencurian (lighting cukup, ada CCTV area).

**Output**: 3 kandidat lokasi dengan ranking + foto + koordinat GPS.

---

## Deliverable Checklist Week 1 (IoT)

- [ ] **Schematic** PDF + netlist final (KiCad/EasyEDA)
- [ ] **Pin map final** override H8 di `CLAUDE_iot.md`
- [ ] **Power budget** tabel
- [ ] **Test rig** siap di bench (Mosquitto + mock backend)
- [ ] **Vendor map** dengan minimal 2 supplier per komponen kritis
- [ ] **HAL abstraction** firmware siap (interface untuk motor, camera, NVS, WiFi, MQTT — supaya native test bisa jalan)
- [ ] **Native test suite** pertama: `computeStockLevel()`, JSON parser, state machine — semua pass tanpa hardware

## Deliverable Week 2 (IoT)

- [ ] Hardware tiba + assembly prototype 1 unit
- [ ] Smoke test: power on → boot → BLE GATT aktif
- [ ] Pairing test dengan mock app (BLE)
- [ ] WiFi + MQTT TLS handshake on-target
- [ ] Stepper rotasi controlled via MQTT command (mock backend)
- [ ] Kalibrasi gram/rotasi → set `ROTATIONS_PER_TOKEN`
- [ ] Kalibrasi capacity → set `STOCK_CAPACITY_ROTATIONS`
- [ ] Camera init + RTSP push ke mediamtx lokal (Docker)
- [ ] 24h soak test (jalankan device terus-menerus, hitung NVS write, heap, reset count)
- [ ] **Lokasi pilot dipilih** (top 1 dari 3 kandidat survei)

---

## Catatan untuk Hardware Engineer

- **Jangan over-engineer** prototype Phase 1. Pakai dev board off-the-shelf (ESP32-S3-CAM dengan OV2640 sudah include), driver module breakout, jumper wire. PCB custom = Phase 2 setelah BOM stabil.
- **Dokumentasikan setiap kompromi** ke `CLAUDE_iot.md` — kalau pilih A4988 vs TMC2208 karena cost, catat alasannya supaya next eng tidak terkaget.
- **Foto + video** assembly process. Berguna untuk training teknisi lapangan.
- **Backup unit** — pesan 2 dev board ESP32 sekaligus. Kalau 1 rusak saat dev, prototype tidak stall.

---



| Hal | Pilihan |
|---|---|
| Platform | **Arduino framework via PlatformIO** |
| MQTT | `PubSubClient` (Joël Gähwiler `arduino-mqtt` sebagai fallback) — wajib support TLS, LWT, retained, QoS 1 |
| Stepper Motor | `FastAccelStepper` — non-blocking, akurat |
| Camera | `esp32-camera` (Espressif) |
| RTSP | `Micro-RTSP` (Geert Vandevelde) |
| JSON | `ArduinoJson` v7 |
| WiFi | `WiFi.h` / `WiFiClientSecure` |
| BLE Provisioning | `NimBLE-Arduino` |
| Persistent Storage | `Preferences` (NVS) — **dengan NVS encryption aktif** (`CONFIG_NVS_ENCRYPTION=y`, key di eFuse) |
| Watchdog | `esp_task_wdt` |
| NTP | `esp_sntp` (built-in) |
| Testing | PlatformIO Unity + FFF (Fake Function Framework) |

---

## Konvensi & Konstanta

> **Semua konstanta numerik MATCH dengan `CLAUDE_integration_contract.md §11`.** CI script `tools/check_constants.py` validasi konsistensi.

```cpp
// config.h — wajib match contract §11
#define DEVICE_ID                  "<uuid-v4>"     // diisi via BLE provisioning, simpan NVS
#define DEVICE_SECRET              "<base64>"      // diisi via BLE provisioning, simpan NVS encrypted

#define WIFI_SSID                  "MiFi-XXXX"     // diisi via BLE provisioning
#define WIFI_PASS                  "..."

#define MQTT_HOST                  "mqtt.purrtein.com"
#define MQTT_PORT                  8883
#define MQTT_USER                  "purrtein"
#define MQTT_PASS                  DEVICE_SECRET
#define MQTT_KEEPALIVE_S           60
#define MQTT_CLEAN_SESSION         false           // WAJIB false — supaya QoS 1 queue tahan reboot

#define MEDIAMTX_HOST              "stream.purrtein.com"
#define MEDIAMTX_PORT              8554
#define MEDIAMTX_USER              "purrtein"
#define MEDIAMTX_PASS              "..."

#define STOCK_CAPACITY_ROTATIONS   25
#define STOCK_LOW_THRESHOLD        0.15f
#define MAX_ROTATIONS_PER_REQUEST  5
#define HEARTBEAT_INTERVAL_S       30
#define COMMAND_REPLAY_WINDOW_S    30
#define STREAM_MAX_DURATION_S      300
#define DEVICE_FEED_COOLDOWN_S     30
#define WATCHDOG_TIMEOUT_S         30
#define NTP_RESYNC_INTERVAL_S      3600

#define FIRMWARE_VERSION           "1.0.0"
#define SCHEMA_VERSION             1
```

Wajib pakai **Root CA cert** untuk MQTT TLS — bundle CA Let's Encrypt di flash (`certs/lets_encrypt_r10.pem`).

---

## MQTT (Kontrak)

Lihat `CLAUDE_integration_contract.md §3 & §4` untuk topik & schema payload.

**Highlights wajib:**
- `clean_session = false` saat connect → broker simpan pending QoS 1 untuk device offline.
- LWT WAJIB di-set sebelum `connect()` (lihat contract §3).
- Setelah connect berhasil → publish `status` retained dengan `online: true` (override LWT retained).
- Subscribe `purrtein/devices/{DEVICE_ID}/commands/#` QoS 1.
- Re-publish retained `status` setiap kali state berubah (online/stream_active/dll).

---

## State Machine

```
BOOT
  ├─ NTP sync? (timeout 30s)
  │    ├─ no → keep retry, tolak semua command sampai sync
  │    └─ ok → lanjut
  ├─ NVS cek: ada WiFi credential + device_id + secret?
  │    ├─ no  → PROVISIONING
  │    └─ yes → CONNECTING
  ▼
PROVISIONING (BLE GATT)
  └─ terima credential, validasi format, save NVS → reboot

CONNECTING (WiFi → NTP → MQTT)
  ├─ WiFi fail 5x → PROVISIONING (anggap MiFi pass berubah)
  ├─ MQTT fail 5x → exponential backoff (max 60s)
  └─ ok → publish events/boot → IDLE

IDLE ◄──────────────────────────────────────────────┐
  ├─ tiap 30s → publish status (heartbeat)          │
  ├─ feed cmd → validate (lihat di bawah) → FEEDING │
  ├─ stream_start → STREAMING                       │
  ├─ refill cmd → reset counter → IDLE              │
  └─ WiFi/MQTT lost → RECONNECTING ─────────────────┘

FEEDING
  ├─ run stepper rotations 360°
  ├─ update total_rotations, persist NVS
  ├─ publish events/feeding_done
  └─ IDLE (cooldown 30s di-enforce sebelum feed berikut)

STREAMING
  ├─ esp_camera_init → publish stream_state: starting
  ├─ RTSP push aktif → publish stream_state: active (retained)
  ├─ stream_stop OR deadline → esp_camera_deinit → publish stream_state: stopped
  └─ IDLE
```

---

## Feed Command Handler (Reference Implementation)

```cpp
static LRU<String, FeedingResult> processedFeeds(100);  // idempotency cache, persist NVS

void onFeedCommand(JsonDocument& doc) {
  // 1. Schema check
  if (doc["schema"] != SCHEMA_VERSION) { publishFail(NULL, "invalid_payload"); return; }

  String logId = doc["feeding_log_id"];
  if (logId.isEmpty()) { publishFail(NULL, "invalid_payload"); return; }

  // 2. Idempotency
  if (processedFeeds.has(logId)) {
    publishFeedingDone(processedFeeds.get(logId));  // echo previous result
    return;
  }

  // 3. NTP check
  if (!ntp.isSynced()) { publishFail(logId, "time_not_synced"); return; }

  // 4. Anti-replay
  time_t issuedAt = parseISO8601(doc["issued_at"]);
  if (now() - issuedAt > COMMAND_REPLAY_WINDOW_S) { publishFail(logId, "command_expired"); return; }

  // 5. Concurrency — feed BOLEH saat streaming (lihat contract §5)
  //    Stepper, camera DMA, RTSP push paralel via peripheral + dual-core.
  //    Yang tetap di-block: 2 feed bersamaan (1 motor 1 job).
  if (state == FEEDING)    { publishFail(logId, "busy_feeding"); return; }

  // 6. Rotation count validation
  int rotations = doc["rotations"] | 1;
  if (rotations < 1 || rotations > MAX_ROTATIONS_PER_REQUEST) {
    publishFail(logId, "invalid_payload"); return;
  }

  // 7. Stock check
  if (g_totalRotations + rotations > STOCK_CAPACITY_ROTATIONS) {
    publishFail(logId, "insufficient_stock"); return;
  }

  // 8. Cooldown
  if (now() - lastFeedAt < DEVICE_FEED_COOLDOWN_S) {
    publishFail(logId, "busy_feeding"); return;
  }

  // 9. Execute
  state = FEEDING;
  uint32_t startMs = millis();
  bool ok = runStepperRotations(rotations);  // BLOCKING-but-yielded via FastAccelStepper poll
  uint32_t durMs = millis() - startMs;

  // 10. Persist counter ATOMICALLY
  if (ok) {
    g_totalRotations += rotations;
    persistCounter(g_totalRotations);  // NVS write w/ wear-aware throttling
    lastFeedAt = now();
  }

  // 11. Build result + cache + publish
  FeedingResult r {
    .logId = logId, .status = ok ? "completed" : "failed",
    .reason = ok ? "" : "motor_stall",
    .requested = rotations, .executed = ok ? rotations : detectExecutedSteps(),
    .totalRotations = g_totalRotations, .durationMs = durMs
  };
  processedFeeds.put(logId, r);
  persistProcessedFeeds();  // persist LRU
  publishFeedingDone(r);
  state = IDLE;
}
```

---

## Hardware Pin Mapping (H8 — TENTATIVE)

> Akan di-final setelah board datang. Format ini contoh, ganti pin sesuai schematic.

| Fungsi | GPIO |
|---|---|
| Stepper STEP | GPIO 38 |
| Stepper DIR | GPIO 39 |
| Stepper EN (active low) | GPIO 40 |
| Stepper DIAG/FAULT (optional, TMC2208 stallGuard) | GPIO 41 |
| Status LED (on-board RGB) | GPIO 48 |
| Camera (sudah hard-wired ke OV2640) | — |
| BLE bonding button (factory reset) | GPIO 0 (BOOT button) |

**Stall detection:** kalau driver tanpa fault pin, pakai timing-based: ukur waktu eksekusi 1 rotasi; jika > expected ±20%, anggap stall.

---

## Stock Tracking — NVS Wear

Counter ditulis ke NVS **setiap feed selesai** → bisa 100k tulis dalam setahun (8x/hari × 365). NVS rated ~100k cycles per partition.

**Mitigasi:**
- Tulis ke NVS hanya saat counter BERTAMBAH ≥1 dari nilai tersimpan terakhir (no-op kalau idle).
- Pakai struct `{ total, magic, crc }` — validasi CRC saat load; korup → fallback ke nilai 0 + log error event.
- Phase 2: rotasi 2 key NVS supaya wear leveling.

```cpp
void persistCounter(uint32_t total) {
  prefs.begin("stock", false);
  if (prefs.getUInt("total", 0) != total) {
    prefs.putUInt("total", total);
    prefs.putUInt("crc",   crc32(total));
  }
  prefs.end();
}
```

---

## Heartbeat (Retained)

```cpp
void sendHeartbeat() {
  StaticJsonDocument<384> doc;
  doc["schema"]           = SCHEMA_VERSION;
  doc["device_id"]        = DEVICE_ID;
  doc["online"]           = true;
  doc["stock_level"]      = computeStockLevel(g_totalRotations);
  doc["total_rotations"]  = g_totalRotations;
  doc["firmware_version"] = FIRMWARE_VERSION;
  doc["uptime_s"]         = millis() / 1000;
  doc["rssi"]             = WiFi.RSSI();
  doc["free_heap"]        = ESP.getFreeHeap();
  doc["stream_active"]    = (state == STREAMING);
  doc["timestamp"]        = getCurrentISO8601();

  String topic = "purrtein/devices/" + String(DEVICE_ID) + "/status";
  publishMQTT(topic.c_str(), doc, /*qos*/1, /*retained*/true);
}
```

Re-publish heartbeat **sekarang juga** (off-cycle) saat state berubah (feed selesai, stream start/stop, refill) supaya dashboard tidak lag 30 detik.

---

## RTSP Streaming

URL publish: `rtsp://{MEDIAMTX_USER}:{MEDIAMTX_PASS}@{MEDIAMTX_HOST}:{MEDIAMTX_PORT}/{DEVICE_ID}`

Konfigurasi awal:
- VGA 640×480
- 10–15 fps
- JPEG quality 12
- Frame buffer di PSRAM (2 buffer rotating)

**Stream lifecycle event** (lihat contract §4.5) — publish setiap transisi.

**Auto-stop:** start timer `duration_s` (default 300s). Saat habis → publish `stream_state: stopped, reason: timeout` → deinit. Mencegah bandwidth bleed kalau backend lupa stop.

**Concurrency:** stream + stepper BOLEH bersamaan — itu memang fitur yang diinginkan user (lihat reaksi kucing saat motor jalan). Stepper jalan via RMT/MCPWM peripheral, kamera capture via DMA, JPEG encode + RTSP push di core 0, MQTT di core 1 → tidak saling tabrak. Yang di-tolak hanya **2 feed bersamaan** (motor sama, 1 job aktif). Frame blur 1–2 detik saat motor jalan = acceptable. Vibration damper di mounting kamera mengurangi efek (urusan hardware). Lihat contract §5.

---

## Reconnection & Backoff

```cpp
uint32_t backoffMs = 1000;
const uint32_t MAX_BACKOFF_MS = 60000;

void ensureConnected() {
  if (WiFi.status() != WL_CONNECTED) {
    WiFi.begin(WIFI_SSID, WIFI_PASS);
    if (!WiFi.waitForConnectResult(10000)) {
      backoffMs = min(backoffMs * 2, MAX_BACKOFF_MS);
      delay(backoffMs);
      if (++wifiFailCount > 5) enterProvisioning();
      return;
    }
    backoffMs = 1000;
  }
  if (!mqttClient.connected()) {
    setupLWT();
    if (mqttClient.connect(DEVICE_ID, MQTT_USER, MQTT_PASS, lwtTopic, 1, true, lwtPayload)) {
      mqttClient.subscribe(("purrtein/devices/" + String(DEVICE_ID) + "/commands/#").c_str(), 1);
      publishStatusRetained(true);
      publishBootEvent();
    }
  }
}
```

---

## Watchdog

Aktifkan TWDT 30s. Reset di akhir tiap iterasi `loop()`. Subtask FreeRTOS (mis. RTSP task) WAJIB `esp_task_wdt_add(NULL)` juga.

Brown-out detector default aktif → auto-reboot saat tegangan drop.

---

## NTP

Wajib sync sebelum subscribe commands. Resync tiap 1 jam.
- Server: `pool.ntp.org`, `time.google.com`, `id.pool.ntp.org`.
- TZ: UTC (`setenv("TZ", "UTC0", 1); tzset();`).

```cpp
bool ntpSync(uint32_t timeoutMs) {
  configTzTime("UTC0", "pool.ntp.org", "time.google.com");
  uint32_t start = millis();
  while (time(nullptr) < 1700000000 && millis() - start < timeoutMs) delay(200);
  return time(nullptr) >= 1700000000;
}
```

Jika sync gagal → device IDLE tetap heartbeat (timestamp = "1970...") TAPI tolak semua command dengan `reason: time_not_synced`.

---

## BLE Provisioning

Lihat contract §8.

- BLE GATT server pakai `NimBLE-Arduino`.
- Service UUID custom: `0000B100-...` (define di `ble_uuids.h`).
- Pairing: PIN 6-digit yang ditampilkan via Serial saat boot pertama (atau OOB QR — bonded ke device secret di backend).
- Payload write characteristic di-encrypt AES-128-GCM dengan key = PBKDF2(PIN, salt=device_mac).
- Setelah handshake sukses → device save NVS encrypted → reboot.

Karakteristik:
- `<UUID>-0001` (write): credential payload
- `<UUID>-0002` (notify): status `{state: "ok"|"err", message}` → app polling
- `<UUID>-0003` (read): device info (firmware version, MAC)

---

## Security Checklist

- [x] MQTT TLS 8883, plain disabled di prod
- [x] Device secret unik per unit, simpan NVS encrypted
- [x] CA pinning (bundle Let's Encrypt root)
- [x] Anti-replay 30s window (lihat contract §1)
- [x] NTP wajib
- [x] BLE provisioning ter-encrypt PIN
- [x] Watchdog 30s
- [x] Idempotency `feeding_log_id` (lihat contract §4.2)
- [x] Stepper EN low di state IDLE supaya motor dingin
- [x] Brown-out reboot aktif

---

## Testing Strategy (TDD — Mandatory)

### Layer 1 — Native (`test/native`, Unity + FFF)

Wajib test untuk:
- `computeStockLevel(total)` — boundary 0, 25, > 25
- `parseFeedCommand(json)` — schema mismatch, missing fields, replay, invalid rotations
- `LRU<feeding_log_id>` — idempotency
- `state transitions` — feeding→idle, idle→streaming
- `NVS encode/decode + CRC` — corruption fallback
- `backoff calculator` — cap di 60s

### Layer 2 — Embedded (`test/embedded`, di ESP32-S3 fisik)

- WiFi connect, MQTT TLS handshake, LWT trigger (cabut power)
- NVS persist + read across reboot
- Stepper actual rotation count (encoder loopback)
- Kamera init + RTSP push (cek mediamtx menerima frame)
- BLE provisioning happy path + wrong PIN

### Layer 3 — Software-in-the-Loop (SIL)

CI job: Mosquitto + mock backend di docker → flash firmware native build (Linux port via Wokwi sim atau QEMU) → assert MQTT round-trip.

**Coverage target:** ≥80% pure logic.

### Mock backend untuk dev

Run `mosquitto` lokal + `tools/mock_backend.py` (publish feed cmd setiap 60s, log feeding_done). Device point ke broker lokal via override `config_dev.h`.

---

## Power Management

- Dispenser AC-powered 24/7 → **tidak pakai deep sleep**.
- Brown-out detector aktif.
- Watchdog 30s.
- Setelah outage → boot otomatis, restore counter NVS, publish boot event, publish status retained.

---

## Logging (Opsional Phase 1)

Publish ke `purrtein/devices/{DEVICE_ID}/logs` QoS 0 — throttle 1/s, dedup duplicate messages. Backend pipe ke Loki.

Format:
```json
{"schema":1,"device_id":"...","level":"info","msg":"feed completed","ts":"..."}
```

Serial log tetap aktif untuk debugging lapangan.

---

## Production-Disaster Checklist Spesifik Firmware

- ❗ **NVS write storm**: kalau bug bikin loop tulis tiap iterasi → flash mati < 1 minggu. WAJIB throttle + dedup.
- ❗ **Stepper EN pin floating** saat boot → motor random gerak. Pull-up via 10k.
- ❗ **PSRAM tidak init** → camera alloc fail silent → stream "active" tapi tidak ada frame. Validasi `psramFound()` di setup; abort kalau false.
- ❗ **MQTT pub blocking** saat WiFi flaky → loop hang → watchdog reboot loop. Pakai `mqttClient.publish` non-block dengan timeout 5s.
- ❗ **JSON allocator fragmentation** → heap rusak. Pakai `StaticJsonDocument` (stack) untuk payload < 512 byte, `DynamicJsonDocument` di PSRAM untuk stream metadata.
- ❗ **Time wraps `millis()`** tiap 49.7 hari → bug heartbeat. Pakai `(int32_t)(millis() - last) >= interval` (signed subtraction).
- ❗ **Counter desync** kalau reboot di tengah feed → device anggap belum, backend anggap sudah. Mitigasi: tulis counter PRA-rotation (pessimistic) + flag "in_progress" di NVS; saat boot detect flag → publish `feeding_done` dengan status `failed`, reason `motor_stall` (presumed) + `recovered_after_reboot: true`.
- ❗ **Stream URL credential di MQTT payload command** → kalau MQTT bocor, kredensial RTSP leak. Solusi: kredensial RTSP **hardcoded di firmware** dari provisioning, command `stream_start` cuma trigger (tidak bawa URL).
