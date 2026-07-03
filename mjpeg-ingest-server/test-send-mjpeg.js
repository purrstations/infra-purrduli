#!/usr/bin/env node
// Simulate ESP32 pushing MJPEG to the ingest server.
//
// Usage:
//   node test-send-mjpeg.js [--host localhost] [--port 8080] [--fps 15]
//                           [--frames path/to/debug_frames/]
//                           [--device feeder-1] [--token secret]
//
// --frames: directory of .jpg files (from mjpeg_debug_receiver.py --save-frames),
//           or omit to generate synthetic JPEG frames instead.

const http  = require('http');
const fs    = require('fs');
const path  = require('path');

const args  = process.argv.slice(2);
const get   = (flag, def) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : def; };

const HOST       = get('--host',   'localhost');
const PORT       = parseInt(get('--port',   '8080'), 10);
const FPS        = parseInt(get('--fps',    '15'),   10);
const DEVICE     = get('--device', 'feeder-1');
const TOKEN      = get('--token',  process.env.INGEST_TOKEN || 'test-token');
const FRAMES_DIR = get('--frames', '');

const INTERVAL_MS = Math.round(1000 / FPS);

// ── fake JPEG ─────────────────────────────────────────────────────────────────
// Minimal valid JPEG: SOI + APP0 + comment pad + EOI
function fakeJpeg(sizeBytes = 9500) {
  const soi  = Buffer.from([0xff, 0xd8]);
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46,
                             0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const eoi  = Buffer.from([0xff, 0xd9]);
  const need = sizeBytes - soi.length - app0.length - eoi.length;
  // JPEG comment: 0xff 0xfe + length(2B includes itself) + data
  const com  = need > 4
    ? Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from([(need - 2) >> 8, (need - 2) & 0xff]), Buffer.alloc(need - 4)])
    : Buffer.alloc(0);
  return Buffer.concat([soi, app0, com, eoi]);
}

// ── load frames ───────────────────────────────────────────────────────────────
let frames;
if (FRAMES_DIR) {
  const files = fs.readdirSync(FRAMES_DIR).filter(f => f.endsWith('.jpg')).sort();
  if (files.length === 0) { console.error('No .jpg files found in', FRAMES_DIR); process.exit(1); }
  frames = files.map(f => fs.readFileSync(path.join(FRAMES_DIR, f)));
  console.log(`[sender] loaded ${frames.length} real frames from ${FRAMES_DIR}`);
} else {
  // Generate 30 synthetic frames of varying sizes to exercise the framing code.
  frames = Array.from({ length: 30 }, (_, i) => fakeJpeg(8000 + i * 100));
  console.log(`[sender] using ${frames.length} synthetic JPEG frames`);
}

// ── send ──────────────────────────────────────────────────────────────────────
function buildPart(jpeg) {
  return Buffer.concat([
    Buffer.from(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`),
    jpeg,
    Buffer.from('\r\n'),
  ]);
}

const req = http.request({
  hostname: HOST, port: PORT,
  path: `/ingest/${DEVICE}`,
  method: 'POST',
  headers: {
    'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
    'Transfer-Encoding': 'chunked',
    'Connection': 'keep-alive',
    'X-Ingest-Token': TOKEN,
  },
});

req.on('response', (res) => {
  console.log(`[sender] server responded: ${res.statusCode}`);
  if (res.statusCode !== 200) {
    res.resume();
    req.destroy();
    process.exit(1);
  }
});

req.on('error', (err) => {
  console.error(`[sender] request error: ${err.message}`);
  process.exit(1);
});

console.log(`[sender] connecting to http://${HOST}:${PORT}/ingest/${DEVICE} @ ${FPS}fps`);
console.log(`[sender] token: ${TOKEN}`);
console.log(`[sender] Ctrl+C to stop (sends clean last-chunk)\n`);

let frameIdx = 0;
let sent     = 0;
const t0     = Date.now();

const timer = setInterval(() => {
  const jpeg = frames[frameIdx % frames.length];
  req.write(buildPart(jpeg));
  sent += jpeg.length;
  frameIdx++;

  if (frameIdx % FPS === 0) {
    const elapsed = (Date.now() - t0) / 1000;
    const kbps    = sent * 8 / elapsed / 1000;
    console.log(`[sender] frame=${frameIdx}  fps=${(frameIdx / elapsed).toFixed(1)}  throughput=${kbps.toFixed(0)} kbps`);
  }
}, INTERVAL_MS);

function shutdown() {
  clearInterval(timer);
  req.end('0\r\n\r\n');  // HTTP chunked last-chunk — clean stream_stop
  console.log('\n[sender] sent last-chunk — done');
  setTimeout(() => process.exit(0), 200);
}

process.on('SIGINT',  shutdown);
process.on('SIGTERM', shutdown);
