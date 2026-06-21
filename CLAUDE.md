# CLAUDE.md — IoT / Firmware (Purrtein Smart Cat Feeder)

Dokumen ini adalah konteks utama untuk agent AI yang mengerjakan implementasi firmware ESP32. Baca seluruhnya sebelum mulai coding.

---

## Project Context

Smart Cat Feeder adalah perangkat fisik yang dipasang di area publik untuk memberi makan kucing jalanan. ESP32 adalah otak perangkat — ia menerima perintah dari backend via MQTT, menggerakkan motor dispenser, membaca sensor stok pakan, dan mendorong stream video dari kamera ke server mediamtx.

---

## Hardware

| Komponen | Fungsi |
|---|---|
| **ESP32** | Microcontroller utama — WiFi + Bluetooth onboard |
| **ESP32-CAM** | Modul kamera untuk push RTSP stream (atau bisa digabung 1 unit jika pakai AI-Thinker ESP32-CAM) |
| **Motor Dispenser** | Servo atau stepper motor untuk mengeluarkan pakan |
| **Sensor Stok** | Sensor level untuk baca ketinggian pakan (ultrasonic / load cell / IR) |
| **Modem / SIM Card** | Koneksi internet mandiri — tidak pakai WiFi publik |
| **Power Supply** | Adaptor stabil untuk semua komponen |

> ⚠️ **KEPUTUSAN HARDWARE (H1):** Jenis sensor stok pakan belum ditentukan (ultrasonic HC-SR04, load cell + HX711, atau IR beam sensor). Ini mempengaruhi kode pembacaan `stock_level`. Konfirmasi dengan tim hardware.

> ⚠️ **KEPUTUSAN HARDWARE (H2):** Apakah ESP32 dan ESP32-CAM adalah modul terpisah yang berkomunikasi via UART/SPI, atau 1 unit ESP32-CAM yang handle keduanya? Ini mempengaruhi arsitektur firmware.

---

## Tech Stack Firmware

| Hal | Pilihan |
|---|---|
| Platform | Arduino framework (via PlatformIO) atau ESP-IDF |
| MQTT Library | `PubSubClient` (Arduino) atau `esp-mqtt` (ESP-IDF) |
| RTSP / Camera | `esp32-camera` library + push RTSP ke mediamtx |
| JSON | `ArduinoJson` |
| WiFi / Modem | `WiFiClientSecure` atau `TinyGSM` (untuk SIM800/SIM7600) |

> ⚠️ **KEPUTUSAN TEKNIS (H3):** Modem SIM card yang dipakai merupakan modem yang sudah jadi, MiFi istilahnya
---

## Koneksi & Credential

Semua credential disimpan di file konfigurasi terpisah (`config.h`), tidak hardcode di main firmware.

```cpp
// config.h
#define DEVICE_ID        "feeder-001"
#define DEVICE_SECRET    "..."           // untuk auth ke MQTT broker

#define MQTT_HOST        "mqtt.purrtein.com"
#define MQTT_PORT        8883            // MQTT over TLS
#define MQTT_USER        "purrtein"
#define MQTT_PASS        DEVICE_SECRET

#define MEDIAMTX_HOST    "stream.purrtein.com"
#define MEDIAMTX_PORT    8554            // RTSP port
#define MEDIAMTX_USER    "purrtein"
#define MEDIAMTX_PASS    "..."           // publishPass dari mediamtx config
```

---

## MQTT Topics

```
Subscribe (terima dari backend):
  purrtein/devices/{DEVICE_ID}/commands/feed
  purrtein/devices/{DEVICE_ID}/commands/stream

Publish (kirim ke backend):
  purrtein/devices/{DEVICE_ID}/status
  purrtein/devices/{DEVICE_ID}/events/feeding_done
```

**QoS yang digunakan:**
- Subscribe commands: **QoS 1** (at least once) — pastikan perintah pasti diterima
- Publish status: **QoS 0** (fire and forget) — heartbeat tidak kritis jika 1 paket hilang
- Publish feeding_done: **QoS 1** — konfirmasi selesai harus sampai ke backend

---

## Payload MQTT

### Publish: `status` (heartbeat setiap 30 detik)

```json
{
  "device_id": "feeder-001",
  "online": true,
  "stock_level": 0.72,
  "timestamp": "2025-07-01T10:00:00Z"
}
```

`stock_level`: float 0.0 (kosong) hingga 1.0 (penuh).

### Subscribe: `commands/feed`

```json
{
  "command": "feed",
  "portion_gram": 30,
  "feeding_log_id": "uuid",
  "timestamp": "ISO8601"
}
```

**Wajib:** Sebelum eksekusi, validasi bahwa `timestamp` tidak lebih dari 30 detik yang lalu. Jika lebih tua → abaikan (cegah replay attack).

### Publish: `events/feeding_done`

```json
{
  "device_id": "feeder-001",
  "feeding_log_id": "uuid",
  "status": "completed",
  "portion_gram": 30,
  "timestamp": "ISO8601"
}
```

Jika motor gagal atau terjadi error → kirim dengan `"status": "failed"`.

### Subscribe: `commands/stream`

```json
{
  "command": "stream_start"
}
```

atau

```json
{
  "command": "stream_stop"
}
```

---

## State Machine Firmware

```
State utama ESP32:

  BOOT
    │
    ▼
  CONNECTING (WiFi/Modem + MQTT)
    │
    ▼
  IDLE ◄──────────────────────────────┐
    │                                  │
    ├── Setiap 30 detik → publish heartbeat
    │                                  │
    ├── Terima feed command ────────► FEEDING
    │     └── Motor aktif → selesai → publish feeding_done ──┘
    │
    ├── Terima stream_start ─────────► STREAMING
    │     └── Push RTSP ke mediamtx
    │         Terima stream_stop ────► IDLE
    │
    └── WiFi/MQTT putus ────────────► RECONNECTING
          └── Berhasil ──────────────► IDLE
```

---

## Feeding Logic

```cpp
void handleFeedCommand(JsonDocument& doc) {
  // 1. Validasi timestamp (anti replay)
  long cmdTimestamp = doc["timestamp"];  // parse ISO ke epoch
  if (millis_since(cmdTimestamp) > 30000) {
    Serial.println("Command expired, ignoring");
    return;
  }

  String feedingLogId = doc["feeding_log_id"];
  float portionGram   = doc["portion_gram"];

  // 2. Aktifkan motor dispenser
  bool success = runMotor(portionGram);

  // 3. Publish konfirmasi
  StaticJsonDocument<256> response;
  response["device_id"]       = DEVICE_ID;
  response["feeding_log_id"]  = feedingLogId;
  response["status"]          = success ? "completed" : "failed";
  response["portion_gram"]    = portionGram;
  response["timestamp"]       = getCurrentISO8601();

  String topic = "purrtein/devices/" + String(DEVICE_ID) + "/events/feeding_done";
  publishMQTT(topic, response, 1);  // QoS 1
}
```

> ⚠️ **KEPUTUSAN HARDWARE (H4):** Bagaimana motor dikendalikan untuk mengukur `portion_gram`? Berdasarkan waktu putar (detik), jumlah rotasi, atau feedback sensor berat? Ini menentukan implementasi `runMotor()`. (jawab : untuk sekarang command berupa jumlah rotasi sebanyak 360 derajat, misal dari backend ada command 1 rotasi berati 360 derajat)

---

## Heartbeat & Stock Reading

```cpp
void sendHeartbeat() {
  float stock = readStockSensor();  // 0.0 – 1.0

  StaticJsonDocument<200> doc;
  doc["device_id"]   = DEVICE_ID;
  doc["online"]      = true;
  doc["stock_level"] = stock;
  doc["timestamp"]   = getCurrentISO8601();

  String topic = "purrtein/devices/" + String(DEVICE_ID) + "/status";
  publishMQTT(topic, doc, 0);  // QoS 0
}

// Panggil di loop() setiap 30 detik
unsigned long lastHeartbeat = 0;
void loop() {
  if (millis() - lastHeartbeat >= 30000) {
    sendHeartbeat();
    lastHeartbeat = millis();
  }
  mqttClient.loop();
}
```

---

## RTSP Streaming ke mediamtx

ESP32 s3-CAM push stream ke mediamtx via RTSP.

```
URL: rtsp://{MEDIAMTX_USER}:{MEDIAMTX_PASS}@{MEDIAMTX_HOST}:{MEDIAMTX_PORT}/{DEVICE_ID}
Contoh: rtsp://purrtein:secret@stream.purrtein.com:8554/feeder-001
```

Flow streaming:
1. Terima `commands/stream` dengan `command: "stream_start"`
2. Inisialisasi kamera (`esp_camera_init`)
3. Mulai push frame ke URL RTSP mediamtx
4. Terima `commands/stream` dengan `command: "stream_stop"` → hentikan push, deinit kamera

> ⚠️ **KEPUTUSAN TEKNIS (H5):** ESP32-CAM dengan framework Arduino menggunakan library `esp32-camera`. Namun push RTSP dari ESP32-CAM ke mediamtx memerlukan implementasi RTSP client atau pakai firmware khusus seperti `ESP32-CAM-RTSP`. Konfirmasi approach yang dipakai dengan tim. 

---

## Reconnection Logic

```cpp
void ensureConnected() {
  if (!modem.isConnected()) {
    connectModem();
  }
  if (!mqttClient.connected()) {
    mqttClient.connect(DEVICE_ID, MQTT_USER, MQTT_PASS);
    mqttClient.subscribe("purrtein/devices/" + String(DEVICE_ID) + "/commands/#", 1);
  }
}
```

Panggil `ensureConnected()` di awal setiap `loop()` iteration. Gunakan exponential backoff jika gagal connect berulang.

---

## Security

- **MQTT over TLS** (port 8883) — jangan pakai plain MQTT (port 1883) di production
- **Device Secret** unik per unit — jika satu device dikompromis, tidak affect device lain
- **Validasi timestamp command** — tolak command yang lebih dari 30 detik yang lalu
- **Jangan simpan credential** di flash memory yang mudah di-dump — gunakan NVS (Non-Volatile Storage) ESP32 yang terenkripsi jika memungkinkan

---

## ⚠️ Keputusan yang Belum Ditentukan

Item berikut harus dikonfirmasi sebelum firmware bisa diimplementasi penuh.

| # | Pertanyaan | Dampak ke Firmware |
|---|---|---|
| H1 | Jenis sensor stok pakan? (ultrasonic, load cell, IR) | Implementasi `readStockSensor()` — library dan kalibrasi berbeda |
| H2 | ESP32 dan ESP32-CAM 1 unit atau 2 modul terpisah? | Arsitektur firmware: satu atau dua program |
| H3 | Modem SIM card yang dipakai? (SIM800L, SIM7600, dll) | Library koneksi internet — `TinyGSM` dengan config berbeda per modem |
| H4 | Kontrol porsi pakan: berbasis waktu putar, rotasi, atau sensor berat? | Implementasi `runMotor()` dan akurasi `portion_gram` di payload |
| H5 | Approach RTSP push dari ESP32-CAM: library Arduino, custom firmware, atau modul terpisah? | Implementasi streaming dan cara integrasi dengan mediamtx |
| H6 | Berapa batas bawah `stock_level` yang dianggap "habis" untuk trigger alert? | Nilai default `stock_threshold` di firmware (backend juga punya ini, harus konsisten) |
| H7 | Apakah device perlu bisa di-OTA update (Over-the-Air firmware update)? | Perlu tambah partisi OTA di flash dan endpoint update |
