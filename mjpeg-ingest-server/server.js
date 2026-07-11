#!/usr/bin/env node
// MJPEG-over-HTTP ingest receiver — pengganti mediamtx runOnReady+ffmpeg hack.
//
// ESP32 POST multipart/x-mixed-replace (chunked) ke /ingest/<device_id>. Node's
// http module sudah otomatis decode Transfer-Encoding: chunked di level HTTP —
// yang perlu kita parse manual cuma framing multipart (boundary + Content-Length).
// Frame JPEG mentah di-pipe ke stdin proses ffmpeg (satu proses per device_id,
// reused antar-frame), yang transcode ke H264 dan push RTSP langsung ke mediamtx.
//
// Reconnect resilience: kalau TCP drop (bukan clean stream_stop), ffmpeg tetap
// hidup di mediamtx selama RECONNECT_WINDOW_MS. Waktu ESP32 reconnect, lanjut
// nulis ke ffmpeg yang sama — path mediamtx tidak hilang.

const http = require('http');
const { spawn } = require('child_process');
const { drainParts } = require('./framing');

const PORT                = parseInt(process.env.INGEST_PORT || '8080', 10);
const MEDIAMTX_HOST       = process.env.MEDIAMTX_HOST || '127.0.0.1';
const MEDIAMTX_PORT       = process.env.MEDIAMTX_RTSP_PORT || '8554';
const MEDIAMTX_USER       = process.env.MEDIAMTX_USER || '';
const MEDIAMTX_PASS       = process.env.MEDIAMTX_PASS || '';
const INGEST_TOKEN        = process.env.INGEST_TOKEN;
const RECONNECT_WINDOW_MS = parseInt(process.env.RECONNECT_WINDOW_MS || '15000', 10);
const MAX_BUF_BYTES       = parseInt(process.env.MAX_BUF_BYTES || String(2 * 1024 * 1024), 10);  // 2 MB

// Token check dipindah ke blok startup (require.main) supaya file ini bisa di-require
// oleh test (mis. test-transcode.js pakai ffmpegArgs) tanpa exit / tanpa listen.

// device_id -> { proc, buf, killTimer }
const sessions = new Map();

function mediamtxUrl(deviceId) {
  const auth = MEDIAMTX_USER ? `${MEDIAMTX_USER}:${MEDIAMTX_PASS}@` : '';
  return `rtsp://${auth}${MEDIAMTX_HOST}:${MEDIAMTX_PORT}/${deviceId}`;
}

function ffmpegArgs(deviceId) {
  const fps  = process.env.STREAM_FPS || '15';
  const base = [
    // Stempel tiap frame dgn waktu kedatangan nyata — ESP kirim fps variabel (adaptive),
    // JADI JANGAN pakai -framerate yg mengasumsikan input konstan (bikin PTS meleset →
    // speed<1x → underrun/"loading").
    '-use_wallclock_as_timestamps', '1',
    '-f', 'mjpeg', '-i', 'pipe:0',
    // yuv420p WAJIB: sumber JPEG OV2640 = yuvj422p (4:2:2). H264 4:2:2 lebih berat
    // di-encode & tak ramah decoder browser. Paksa 4:2:0.
    '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
    '-pix_fmt', 'yuv420p',
    // Output CFR: duplikat frame saat input lambat → cadence mulus, PTS = real-time.
    '-fps_mode', 'cfr', '-r', fps,
    // Keyframe reguler tiap 3 dtk supaya segmen HLS (hlsSegmentDuration 3s) rata.
    // -g = fps*3, plus paksa IDR tepat di kelipatan 3 dtk. Kalau ubah durasi buffer,
    // ganti angka 3 di sini DAN hlsSegmentDuration di mediamtx.yml agar sinkron.
    '-g', String(parseInt(fps) * 3),
    '-force_key_frames', 'expr:gte(t,n_forced*3)',
    '-b:v', '1200k', '-bufsize', '1200k',
    '-an',
  ];
  if (process.env.TEST_MODE === '1') {
    // Validate H264 encoding without pushing anywhere. ffmpeg stderr shows errors.
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
    if (s && s.proc === proc) sessions.delete(deviceId);
  });
  proc.on('error', (err) => {
    console.error(`[ingest] ffmpeg for ${deviceId} failed to start: ${err.message}`);
    sessions.delete(deviceId);
  });
  const dest = process.env.TEST_MODE === '1' ? 'null (TEST_MODE)' : mediamtxUrl(deviceId);
  console.log(`[ingest] ffmpeg started for ${deviceId} -> ${dest}`);
  return proc;
}

const server = http.createServer((req, res) => {
  const match = /^\/ingest\/([A-Za-z0-9_-]+)$/.exec(req.url);
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
    session = { proc: startFfmpeg(deviceId), buf: Buffer.alloc(0), killTimer: null };
    sessions.set(deviceId, session);
  } else if (session.killTimer) {
    // ESP32 reconnected before kill timer fired — resume the same ffmpeg session.
    clearTimeout(session.killTimer);
    session.killTimer = null;
    session.buf = Buffer.alloc(0);  // discard stale partial frame from old TCP connection
    console.log(`[ingest] ${deviceId} reconnected — resuming ffmpeg`);
  }
  console.log(`[ingest] ${deviceId} connected from ${req.socket.remoteAddress}`);

  req.on('data', (chunk) => {
    const combined = Buffer.concat([session.buf, chunk]);
    if (combined.length > MAX_BUF_BYTES) {
      console.error(`[ingest] ${deviceId} buf exceeded ${MAX_BUF_BYTES} bytes — resetting (stream corrupt?)`);
      session.buf = Buffer.alloc(0);
      return;
    }
    session.buf = drainParts(combined, (jpeg) => {
      if (process.env.DEBUG_FRAMES === '1') {
        const soi = jpeg[0] === 0xff && jpeg[1] === 0xd8;
        const eoi = jpeg[jpeg.length - 2] === 0xff && jpeg[jpeg.length - 1] === 0xd9;
        console.log(`[frame ${deviceId}] ${jpeg.length}B  SOI:${soi ? 'ok' : 'BAD'}  EOI:${eoi ? 'ok' : 'BAD'}`);
      }
      if (session.proc.stdin.writable) session.proc.stdin.write(jpeg);
    });
  });

  let endedClean = false;

  req.on('end', () => {
    // ESP32 sent the HTTP chunked terminator (0\r\n\r\n) — clean stream_stop.
    endedClean = true;
    console.log(`[ingest] ${deviceId} stream ended (clean stop)`);
    const s = sessions.get(deviceId);
    if (s) {
      if (s.killTimer) clearTimeout(s.killTimer);
      s.proc.stdin.end();
      sessions.delete(deviceId);
    }
    if (!res.writableEnded) res.end();
  });

  req.on('close', () => {
    if (endedClean) return;
    // TCP dropped (WiFi glitch, device reset) — keep ffmpeg alive so mediamtx
    // path stays up while ESP32 reconnects.
    console.log(`[ingest] ${deviceId} TCP dropped — keeping ffmpeg for ${RECONNECT_WINDOW_MS / 1000}s`);
    if (!res.writableEnded) res.end();
    const s = sessions.get(deviceId);
    if (s && !s.killTimer) {
      s.killTimer = setTimeout(() => {
        const s2 = sessions.get(deviceId);
        if (s2 && s2.proc === s.proc) {
          console.log(`[ingest] ${deviceId} no reconnect after ${RECONNECT_WINDOW_MS / 1000}s — stopping ffmpeg`);
          s2.proc.stdin.end();
          sessions.delete(deviceId);
        }
      }, RECONNECT_WINDOW_MS);
    }
  });
});

// Startup hanya saat dijalankan langsung (node server.js), bukan saat di-require test.
if (require.main === module) {
  if (!INGEST_TOKEN) {
    console.error('[ingest] INGEST_TOKEN env var not set — refusing to start unauthenticated on a public port.');
    process.exit(1);
  }
  server.listen(PORT, () => {
    console.log(`[ingest] listening on :${PORT} -> mediamtx at ${MEDIAMTX_HOST}:${MEDIAMTX_PORT} (reconnect window ${RECONNECT_WINDOW_MS / 1000}s)`);
  });
}

// Diekspor supaya test memakai args ffmpeg yang SAMA PERSIS dengan production
// (single source of truth — cegah drift seperti sebelumnya).
module.exports = { ffmpegArgs };
