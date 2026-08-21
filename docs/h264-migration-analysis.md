# H.264 Streaming Migration Analysis

**Date:** 2026-08-21  
**Scope:** Status of MJPEG -> H.264 migration across `infra` (ingest server + MediaMTX + Docker Compose) and `purr/iot` (ESP32-P4 firmware).

---

## 1. Executive Summary & Verdict

- **Overall Status:** **Partially Completed & High Readiness for Integration**
- **Firmware Status (`purr/iot`):** ESP32-P4 firmware scaffold (`firmware-esp32p4/`) is built with ESP-IDF v5.3+ & `esp_h264` hardware encoder support, CSI/ISP capture pipeline (OV5647), and HTTP chunked Annex-B pusher. SoftAP provisioning, WiFi STA, SPIRAM, and MQTT TLS fixes were verified on-target (2026-08-21).
- **Infra Status (`infra`):** The H.264 ingest server in `h264-ingest-server/` replaces MJPEG multipart parsing with direct Annex-B piping into `ffmpeg -c:v copy` RTSP remuxing to MediaMTX.
- **Blocker Status (Historical B1):** **RESOLVED.** Hardware P4 firmware now exists and produces H.264 elementary streams rather than MJPEG frames.

---

## 2. Component Analysis

### A. Ingest Server (`h264-ingest-server/server.js`)
1. **Piping & Remuxing:**
   - Input format: `video/h264` / Annex-B chunked HTTP POST to `/ingest/feeder-<id>`.
   - Remux args: `-f h264 -i pipe:0 -c:v copy -an -f rtsp -rtsp_transport tcp`.
   - Removed CPU-intensive libx264 software transcoding.
2. **Resilience & Bugfixes Applied:**
   - **Backpressure handling:** Handled via `req.pause()` and `myProc.stdin.once('drain', ...)`.
   - **Mid-stream process death:** `onProcExit` hook triggers `req.destroy()` to force immediate device reconnect.
   - **Concurrency / Overlap:** Rejects overlapping stream requests for the same `device_id` with HTTP 409 (`already streaming`).
   - **Device ID validation:** Strict regex `/^\/ingest\/(feeder-[0-9]+)$/` aligned with `mediamtx.yml` path patterns.

### B. Firmware Streaming (`purr/iot/firmware-esp32p4`)
1. **Hardware Pipeline:**
   - Sensor: OV5647 via MIPI-CSI (2-lane RAW8 800x640).
   - ISP: RAW8 -> YUV420 (`ESP_H264_RAW_FMT_O_UYY_E_VYY`).
   - Hardware Encoder: `esp_h264` single hardware encoder writing Annex-B NAL units to PSRAM.
   - Pusher: `esp_http_client` chunked POST with `X-Ingest-Token`.
2. **Current State:**
   - CSI/ISP and encoder pipeline implemented in `CameraOV5647`.
   - SPIRAM configuration patched in `sdkconfig.defaults`.

---

## 3. Remaining Verification & Integration Checklist

1. **Hardware Stream End-to-End Test:**
   - Execute live stream from ESP32-P4 device to `h264-ingest` container.
   - Verify WHEP/WebRTC playback latency on MediaMTX (`http://<host>:8889/feeder-1`).
2. **GOP / Keyframe Cadence Verification:**
   - Verify IDR interval on `esp_h264` encoder matches MediaMTX HLS segment requirements (default ~3s).
3. **Merge Conflict Resolution:**
   - Apply clean staged changes from stash to dedicated branch (`feat/esp32-p4-h264`) cleanly rebased on `main`.
