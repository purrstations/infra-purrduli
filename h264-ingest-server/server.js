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

const PORT                = parseInt(process.env.INGEST_PORT || '8080', 10);
const MEDIAMTX_HOST       = process.env.MEDIAMTX_HOST || '127.0.0.1';
const MEDIAMTX_PORT       = process.env.MEDIAMTX_RTSP_PORT || '8554';
const MEDIAMTX_USER       = process.env.MEDIAMTX_USER || '';
const MEDIAMTX_PASS       = process.env.MEDIAMTX_PASS || '';
const INGEST_TOKEN        = process.env.INGEST_TOKEN;
const RECONNECT_WINDOW_MS = parseInt(process.env.RECONNECT_WINDOW_MS || '15000', 10);

// device_id di sini HARUS match path regex mediamtx.yml ("~^feeder-[0-9]+$") —
// kalau lebih longgar, ID bisa lolos ingest tapi gak ke-route ke mediamtx (path
// kosong, silent). Kalau path mediamtx berubah, ganti regex ini juga.
const DEVICE_ID_RE = /^\/ingest\/(feeder-[0-9]+)$/;

if (require.main === module && !INGEST_TOKEN) {
  console.error('[ingest] INGEST_TOKEN env var not set — refusing to start unauthenticated on a public port.');
  process.exit(1);
}

// device_id -> { proc, killTimer, activeReq }
// activeReq = request HTTP yang sedang "memiliki" stdin ffmpeg ini — dipakai
// untuk menolak koneksi kedua yang overlap (lihat blok createServer di bawah).
const sessions = new Map();

function mediamtxUrl(deviceId) {
  const auth = MEDIAMTX_USER ? `${MEDIAMTX_USER}:${MEDIAMTX_PASS}@` : '';
  return `rtsp://${auth}${MEDIAMTX_HOST}:${MEDIAMTX_PORT}/${deviceId}`;
}

function ffmpegArgs(deviceId) {
  const base = [
    // ESP diharapkan kirim H.264 Annex-B mentah dgn fps adaptif — rencana: device-
    // side AIMD lewat H264BitrateController (src/core/h264_bitrate_controller.h di
    // repo iot). Wallclock timestamp tetap perlu supaya PTS gak drift walau fps input berubah.
    '-use_wallclock_as_timestamps', '1',
    '-f', 'h264', '-i', 'pipe:0',
    // Remux, bukan transcode — device sudah encode H.264 di hardware (ESP32-P4).
    // -c:v copy = pass-through NAL units apa adanya.
    '-c:v', 'copy',
    '-an',
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
    session = { proc: startFfmpeg(deviceId), killTimer: null, activeReq: null };
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
      console.log(`[chunk ${deviceId}] ${chunk.length}B`);
    }
    if (!myProc.stdin.writable) return;
    const ok = myProc.stdin.write(chunk);
    if (!ok) {
      // Backpressure: ffmpeg (atau RTSP output-nya ke mediamtx) lebih lambat
      // dari input — jeda req sampai stdin ffmpeg siap nerima lagi, supaya Node
      // gak numpuk buffer chunk di memori tanpa batas.
      req.pause();
      myProc.stdin.once('drain', () => req.resume());
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
