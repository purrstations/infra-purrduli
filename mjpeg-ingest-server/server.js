#!/usr/bin/env node
// MJPEG-over-HTTP ingest receiver — pengganti mediamtx runOnReady+ffmpeg hack.
//
// ESP32 POST multipart/x-mixed-replace (chunked) ke /ingest/<device_id>. Node's
// http module sudah otomatis decode Transfer-Encoding: chunked di level HTTP —
// yang perlu kita parse manual cuma framing multipart (boundary + Content-Length).
// Frame JPEG mentah di-pipe ke stdin proses ffmpeg (satu proses per device_id,
// reused antar-frame), yang transcode ke H264 dan push RTSP langsung ke mediamtx.
//
// Jalanin: INGEST_PORT=8080 node server.js
// (lihat README.md di folder ini buat deploy systemd/pm2 + env vars lain)

const http = require('http');
const { spawn } = require('child_process');
const { drainParts } = require('./framing');

const PORT             = parseInt(process.env.INGEST_PORT || '8080', 10);
const MEDIAMTX_HOST    = process.env.MEDIAMTX_HOST || '127.0.0.1';
const MEDIAMTX_PORT    = process.env.MEDIAMTX_RTSP_PORT || '8554';
const MEDIAMTX_USER    = process.env.MEDIAMTX_USER || '';
const MEDIAMTX_PASS    = process.env.MEDIAMTX_PASS || '';
const INGEST_TOKEN     = process.env.INGEST_TOKEN;

if (!INGEST_TOKEN) {
  console.error('[ingest] INGEST_TOKEN env var not set — refusing to start unauthenticated on a public port.');
  process.exit(1);
}

// device_id -> { proc, buf }
const sessions = new Map();

function mediamtxUrl(deviceId) {
  const auth = MEDIAMTX_USER ? `${MEDIAMTX_USER}:${MEDIAMTX_PASS}@` : '';
  return `rtsp://${auth}${MEDIAMTX_HOST}:${MEDIAMTX_PORT}/${deviceId}`;
}

function startFfmpeg(deviceId) {
  const url = mediamtxUrl(deviceId);
  const proc = spawn('ffmpeg', [
    '-f', 'mjpeg', '-i', 'pipe:0',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
    '-an',
    '-f', 'rtsp', '-rtsp_transport', 'tcp', url,
  ]);
  proc.stderr.on('data', (d) => process.stderr.write(`[ffmpeg ${deviceId}] ${d}`));
  proc.on('exit', (code) => {
    console.log(`[ingest] ffmpeg for ${deviceId} exited (code=${code})`);
    sessions.delete(deviceId);
  });
  // Without this, a spawn failure (e.g. ffmpeg missing from PATH) is an
  // unhandled 'error' event that crashes the whole process — taking down
  // every other device's stream, not just this one.
  proc.on('error', (err) => {
    console.error(`[ingest] ffmpeg for ${deviceId} failed to start: ${err.message}`);
    sessions.delete(deviceId);
  });
  console.log(`[ingest] ffmpeg started for ${deviceId} -> ${url}`);
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
    session = { proc: startFfmpeg(deviceId), buf: Buffer.alloc(0) };
    sessions.set(deviceId, session);
  }
  console.log(`[ingest] ${deviceId} connected from ${req.socket.remoteAddress}`);

  req.on('data', (chunk) => {
    session.buf = drainParts(Buffer.concat([session.buf, chunk]), (jpeg) => {
      if (session.proc.stdin.writable) session.proc.stdin.write(jpeg);
    });
  });

  const cleanup = () => {
    console.log(`[ingest] ${deviceId} disconnected`);
    const s = sessions.get(deviceId);
    if (s) { s.proc.stdin.end(); sessions.delete(deviceId); }
    if (!res.writableEnded) res.end();
  };
  // 'end' = device sent the terminating chunk (clean stopStream()); 'close' =
  // socket dropped (device reset/network loss) — either way, tear down ffmpeg.
  req.on('end', cleanup);
  req.on('close', cleanup);
});

server.listen(PORT, () => {
  console.log(`[ingest] listening on :${PORT} -> mediamtx at ${MEDIAMTX_HOST}:${MEDIAMTX_PORT}`);
});
