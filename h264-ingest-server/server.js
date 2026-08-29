#!/usr/bin/env node
// H.264-over-HTTP ingest receiver.
//
// ESP32-P4 POST H.264 Annex-B (encode di hardware) chunked ke /ingest/<device_id>.
// Annex-B self-delimiting lewat NAL start code (0x00 0x00 0x00 0x01) — beda dari
// era MJPEG, di sini TIDAK ada framing per-frame yang perlu diparse: body request
// di-pipe langsung ke stdin ffmpeg, yang remux (-c:v copy, bukan transcode) lalu
// push RTSP ke mediamtx.
//
// Reconnect resilience: kalau TCP drop (bukan clean stream_stop), ffmpeg tetap
// hidup di mediamtx selama RECONNECT_WINDOW_MS. Waktu ESP32 reconnect, lanjut
// nulis ke ffmpeg yang sama — path mediamtx tidak hilang.

const http = require('http');
const { spawn } = require('child_process');
const { AuParser } = require('./au-framing');

const PORT                = parseInt(process.env.INGEST_PORT || '8080', 10);
const MEDIAMTX_HOST       = process.env.MEDIAMTX_HOST || '127.0.0.1';
const MEDIAMTX_PORT       = process.env.MEDIAMTX_RTSP_PORT || '8554';
const MEDIAMTX_USER       = process.env.MEDIAMTX_USER || '';
const MEDIAMTX_PASS       = process.env.MEDIAMTX_PASS || '';
const INGEST_TOKEN        = process.env.INGEST_TOKEN;
const RECONNECT_WINDOW_MS = parseInt(process.env.RECONNECT_WINDOW_MS || '15000', 10);

// Pacer (Fase C-lite): keluarkan AU ke ffmpeg dengan tempo tetap, BUKAN
// mengikuti kedatangan. Alasan: ffmpeg men-stamp dengan -r 25 (timeline CFR
// 25fps), jadi player mengonsumsi 25fps TANPA henti — kalau device menghasilkan
// <25fps atau byte nyembur (jitter MiFi), buffer player kering = spinner.
// Pacer menjamin pasokan tepat 25/s:
//   - queue berisi  → keluarkan AU berikutnya (burst diserap, halus)
//   - queue kosong  → ulangi AU terakhir (frame repeat; decoder menampilkan
//     gambar sama — freeze sesaat, BUKAN kelaparan buffer / loncatan)
//   - queue meluap  → buang yang tertua (batas latency, loncatan kecil)
const PACER_INTERVAL_MS  = parseInt(process.env.PACER_INTERVAL_MS || '40', 10);   // 25fps, match -r 25
const PACER_MAX_QUEUE    = parseInt(process.env.PACER_MAX_QUEUE || '10', 10);     // 400ms
const PACER_TARGET_QUEUE = parseInt(process.env.PACER_TARGET_QUEUE || '5', 10);

// device_id di sini HARUS match path regex mediamtx.yml ("~^feeder-[0-9]+$") —
// kalau lebih longgar, ID bisa lolos ingest tapi gak ke-route ke mediamtx (path
// kosong, silent). Kalau path mediamtx berubah, ganti regex ini juga.
const DEVICE_ID_RE = /^\/ingest\/(feeder-[0-9]+)$/;

if (require.main === module && !INGEST_TOKEN) {
  console.error('[ingest] INGEST_TOKEN env var not set — refusing to start unauthenticated on a public port.');
  process.exit(1);
}

// device_id -> { proc, killTimer, activeReq, parser, auQueue, lastAu,
//                stdinDrained, pacer }
// activeReq = request HTTP yang sedang "memiliki" stdin ffmpeg ini — dipakai
// untuk menolak koneksi kedua yang overlap (lihat blok createServer di bawah).
const sessions = new Map();

function mediamtxUrl(deviceId) {
  const auth = MEDIAMTX_USER ? `${MEDIAMTX_USER}:${MEDIAMTX_PASS}@` : '';
  return `rtsp://${auth}${MEDIAMTX_HOST}:${MEDIAMTX_PORT}/${deviceId}`;
}

// Tulis 1 AU ke stdin ffmpeg dengan backpressure-aware. Return true kalau
// pacer boleh lanjut tick berikutnya.
function pacerWrite(session, au) {
  const stdin = session.proc.stdin;
  if (!stdin || !stdin.writable) return false;
  const ok = stdin.write(au);
  if (!ok) {
    // Backpressure: ffmpeg/RTSP lebih lambat — tunggu drain sebelum tick lagi.
    stdin.once('drain', () => { session.stdinDrained = true; });
    return false;
  }
  return true;
}

function startPacer(session, deviceId) {
  session.stdinDrained = true;
  const timer = setInterval(() => {
    if (session.stdinDrained === false) return;

    let au;
    if (session.auQueue.length > 0) {
      // Buang surplus — batas latency (loncatan kecil, bukan kelaparan).
      while (session.auQueue.length > PACER_MAX_QUEUE) session.auQueue.shift();
      au = session.auQueue.shift();
      session.lastAu = au;
    } else {
      au = session.lastAu;  // frame repeat — jaga pasokan 25fps
      if (!au) return;      // belum ada AU sama sekali (awal stream)
    }
    pacerWrite(session, au);
  }, PACER_INTERVAL_MS);
  if (timer.unref) timer.unref();
  return timer;
}

// Clean stop: flush seluruh queue tanpa pacing, lalu tutup stdin.
function stopPacerAndFlush(session) {
  if (session.pacer) { clearInterval(session.pacer); session.pacer = null; }
  const stdin = session.proc.stdin;
  if (!stdin || !stdin.writable) return;
  for (const au of session.auQueue) stdin.write(au);
  session.auQueue = [];
}

// Timestamp strategy (fix stutter 2026-08):
// Default produksi = input `-r 25` TANPA wallclock flag. Alasan:
//  - Device (ESP32-P4) mengulang SPS+PPS tiap GOP, dan SPS-nya bikin parser
//    h264 ffmpeg menurunkan "25 fps, 50 tbr". `-r 25` memaksa dts frame-count
//    monolitik @25fps dari paket pertama, mengabaikan tebakan parser.
//  - `-use_wallclock_as_timestamps 1` (argv produksi lama) justru MEMPERPARAH:
//    mencampur stamping wallclock (epoch besar) dengan dts parser (frame-count
//    kecil) → muxer melihat DTS mundur dan menulis-ulang ratusan kali per
//    sesi (579x dalam 14 menit di produksi 2026-08) → stutter/jump di WebRTC.
//    Bukti: test-transcode.js — non-monotonic 460 (wallclock) vs 0 (fix).
//  - Paket pertama tetap NOPTS (1x warning per sesi, sebelum parser init) —
//    benign, frame pertama saja.
// Catatan: fps input yang real < 25 (AIMD degraded) → playback terkompresi
// rata, TANPA loncatan. Perbaikan fps dilakukan device-side (Fase B).
//
// TS_MODE (env, khusus testing/rollback):
//   wallclock : argv produksi lama (repro bug)
//   genpts / r25 / copyts / baseline : variasi matriks (baseline = tanpa apa pun)
//   kombinasi dgn '+', mis. TS_MODE=baseline+genpts
function timestampArgs(mode) {
  if (!mode) {
    return ['-r', '25', '||'];
  }
  const parts  = mode.split('+');
  const before = [];  // input options (sebelum -i)
  const after  = [];  // output options (setelah -i)
  for (const p of parts) {
    if (p === 'wallclock') before.push('-use_wallclock_as_timestamps', '1');
    if (p === 'genpts')    before.push('-fflags', '+genpts');
    if (p === 'r25')       before.push('-r', '25');
    if (p === 'copyts')    after.push('-copyts');
  }
  return [...before, '||', ...after];
}

function ffmpegArgs(deviceId) {
  const ts   = timestampArgs(process.env.TS_MODE);
  const sep  = ts.indexOf('||');
  const pre  = ts.slice(0, sep);
  const post = ts.slice(sep + 1);
  const base = [
    // ESP diharapkan kirim H.264 Annex-B mentah dgn fps adaptif — AIMD device-side
    // lewat H264BitrateController (src/core/h264_bitrate_controller.h di repo iot).
    // Input options (mis. -r 25) datang dari timestampArgs() di atas.
    ...pre,
    '-f', 'h264', '-i', 'pipe:0',
    // Remux, bukan transcode — device sudah encode H.264 di hardware (ESP32-P4).
    // -c:v copy = pass-through NAL units apa adanya.
    '-c:v', 'copy',
    '-an',
    ...post,
  ];
  if (process.env.TEST_MODE === '1') {
    // Validate H264 remux without pushing anywhere. ffmpeg stderr shows errors.
    return [...base, '-f', 'null', '-'];
  }
  return [...base, '-f', 'rtsp', '-rtsp_transport', 'tcp', mediamtxUrl(deviceId)];
}

function startFfmpeg(deviceId) {
  const args = ffmpegArgs(deviceId);
  const proc = spawn('ffmpeg', args);
  proc.stderr.on('data', (d) => process.stderr.write(`[ffmpeg ${deviceId}] ${d}`));
  proc.stdin.on('error', (err) => {
    // EPIPE when ffmpeg dies unexpectedly — log and let proc 'exit' clean up.
    console.error(`[ingest] ffmpeg stdin error for ${deviceId}: ${err.message}`);
  });
  proc.on('exit', (code) => {
    console.log(`[ingest] ffmpeg for ${deviceId} exited (code=${code})`);
    const s = sessions.get(deviceId);
    if (s && s.proc === proc) {
      if (s.pacer) { clearInterval(s.pacer); s.pacer = null; }
      sessions.delete(deviceId);
    }
  });
  proc.on('error', (err) => {
    console.error(`[ingest] ffmpeg for ${deviceId} failed to start: ${err.message}`);
    sessions.delete(deviceId);
  });
  const dest = process.env.TEST_MODE === '1' ? 'null (TEST_MODE)' : mediamtxUrl(deviceId);
  console.log(`[ingest] ffmpeg started for ${deviceId} -> ${dest}`);
  return proc;
}

module.exports = { ffmpegArgs, startFfmpeg };

const server = http.createServer((req, res) => {
  const match = DEVICE_ID_RE.exec(req.url);
  if (req.method !== 'POST' || !match) {
    res.writeHead(404).end('not found');
    return;
  }
  const deviceId = match[1];
  if (req.headers['x-ingest-token'] !== INGEST_TOKEN) {
    res.writeHead(401).end('unauthorized');
    return;
  }

  let session = sessions.get(deviceId);
  if (!session) {
    session = {
      proc: startFfmpeg(deviceId),
      killTimer: null,
      activeReq: null,
      parser: new AuParser(),
      auQueue: [],
      lastAu: null,
      stdinDrained: true,
      pacer: null,
    };
    session.pacer = startPacer(session, deviceId);
    sessions.set(deviceId, session);
  } else if (session.activeReq) {
    // Koneksi lain untuk device_id yang sama masih aktif nulis ke stdin ffmpeg
    // yang sama — jangan izinkan dua penulis sekaligus (NAL bakal interleaved
    // jadi korup). Device yang reconnect-agresif/double-connect harus retry.
    console.log(`[ingest] ${deviceId} rejected — another connection already streaming`);
    res.writeHead(409).end('already streaming from another connection');
    return;
  } else if (session.killTimer) {
    // ESP32 reconnected before kill timer fired — resume the same ffmpeg session.
    clearTimeout(session.killTimer);
    session.killTimer = null;
    console.log(`[ingest] ${deviceId} reconnected — resuming ffmpeg`);
  }
  session.activeReq = req;
  console.log(`[ingest] ${deviceId} connected from ${req.socket.remoteAddress}`);

  // Pegang referensi proc "milik" request ini secara langsung (bukan lewat
  // sessions.get() tiap event) — supaya kalau ffmpeg mati di tengah jalan, kita
  // tahu pasti itu proc yang sama, dan bisa maksa tutup koneksi HTTP ini (lihat
  // onProcExit) alih-alih diam-diam mendrop chunk ke stdin yang sudah mati.
  const myProc = session.proc;
  let endedClean = false;

  function onProcExit() {
    if (endedClean) return;
    console.log(`[ingest] ${deviceId} ffmpeg died mid-stream — closing connection so device reconnects`);
    req.destroy();
  }
  myProc.once('exit', onProcExit);

  req.on('data', (chunk) => {
    if (process.env.DEBUG_FRAMES === '1') {
      console.log(`[chunk ${deviceId}] ${chunk.length}B queue=${session.auQueue.length}`);
    }
    // Fase C-lite: byte stream di-parse jadi AU, lalu masuk queue pacer —
    // BUKAN langsung ke stdin ffmpeg. Pacer yang menulis dengan tempo 25fps
    // (frame repeat saat pasokan kurang) supaya player tidak kelaparan.
    for (const au of session.parser.feed(chunk)) {
      session.auQueue.push(au);
    }
  });

  req.on('end', () => {
    // ESP32 sent the HTTP chunked terminator (0\r\n\r\n) — clean stream_stop.
    endedClean = true;
    myProc.removeListener('exit', onProcExit);
    console.log(`[ingest] ${deviceId} stream ended (clean stop)`);
    const s = sessions.get(deviceId);
    if (s && s.proc === myProc) {
      if (s.killTimer) clearTimeout(s.killTimer);
      // Flush sisa AU (termasuk NAL berjalan) ke ffmpeg sebelum menutup stdin.
      for (const au of s.parser.finish()) s.auQueue.push(au);
      stopPacerAndFlush(s);
      myProc.stdin.end();
      sessions.delete(deviceId);
    }
    if (!res.writableEnded) res.end();
  });

  req.on('close', () => {
    myProc.removeListener('exit', onProcExit);
    if (endedClean) return;
    // TCP dropped (WiFi glitch, device reset) — keep ffmpeg alive so mediamtx
    // path stays up while ESP32 reconnects.
    console.log(`[ingest] ${deviceId} TCP dropped — keeping ffmpeg for ${RECONNECT_WINDOW_MS / 1000}s`);
    if (!res.writableEnded) res.end();
    const s = sessions.get(deviceId);
    if (s && s.proc === myProc) {
      s.activeReq = null;
      if (!s.killTimer) {
        s.killTimer = setTimeout(() => {
          const s2 = sessions.get(deviceId);
          if (s2 && s2.proc === myProc) {
            console.log(`[ingest] ${deviceId} no reconnect after ${RECONNECT_WINDOW_MS / 1000}s — stopping ffmpeg`);
            myProc.stdin.end();
            sessions.delete(deviceId);
          }
        }, RECONNECT_WINDOW_MS);
      }
    }
  });
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`[ingest] listening on :${PORT} -> mediamtx at ${MEDIAMTX_HOST}:${MEDIAMTX_PORT} (reconnect window ${RECONNECT_WINDOW_MS / 1000}s)`);
  });
}
