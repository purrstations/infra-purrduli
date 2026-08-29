#!/usr/bin/env node
// Simulate ESP32-P4 pushing H.264 Annex-B to the ingest server.
//
// Usage:
//   node test-send-h264.js [--host localhost] [--port 8080]
//                          [--h264-file path/to/sample.h264]
//                          [--device feeder-1] [--token secret]
//
// --h264-file: raw H.264 Annex-B file (mis. hasil `ffmpeg -c:v libx264 -f h264
//              out.h264`), atau omit buat generate klip test via ffmpeg.

const http = require('http');
const fs   = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const args = process.argv.slice(2);
const get  = (flag, def) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : def; };

const HOST        = get('--host',   'localhost');
const PORT        = parseInt(get('--port',   '8080'), 10);
const DEVICE      = get('--device', 'feeder-1');
const TOKEN       = get('--token',  process.env.INGEST_TOKEN || 'test-token');
const H264_FILE   = get('--h264-file', '');
const CHUNK_BYTES = parseInt(get('--chunk-bytes', '4096'), 10);
const CHUNK_MS    = parseInt(get('--chunk-ms', '20'), 10);

// ── load / generate H.264 Annex-B ───────────────────────────────────────────
let h264;
if (H264_FILE) {
  h264 = fs.readFileSync(H264_FILE);
  console.log(`[sender] loaded ${h264.length}B from ${H264_FILE}`);
} else {
  console.log('[sender] no --h264-file given — generating test clip via ffmpeg...');
  const tmp = path.join(require('os').tmpdir(), 'h264_send_test.h264');
  execFileSync('ffmpeg', [
    '-y', '-f', 'lavfi', '-i', 'testsrc=size=640x480:rate=20:duration=5',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-f', 'h264', tmp,
  ], { stdio: 'pipe' });
  h264 = fs.readFileSync(tmp);
  fs.unlinkSync(tmp);
  console.log(`[sender] generated ${h264.length}B H.264 Annex-B test clip`);
}

// ── send ──────────────────────────────────────────────────────────────────────
const req = http.request({
  hostname: HOST, port: PORT,
  path: `/ingest/${DEVICE}`,
  method: 'POST',
  headers: {
    'Content-Type': 'video/h264',
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

console.log(`[sender] connecting to http://${HOST}:${PORT}/ingest/${DEVICE}`);
console.log(`[sender] token: ${TOKEN}`);
console.log(`[sender] Ctrl+C to stop (sends clean last-chunk)\n`);

let offset = 0;
let sent   = 0;
const t0   = Date.now();

const timer = setInterval(() => {
  const end   = Math.min(offset + CHUNK_BYTES, h264.length);
  const chunk = h264.subarray(offset, end);
  req.write(chunk);
  sent += chunk.length;
  offset = end;
  if (offset >= h264.length) offset = 0;  // loop the clip

  const elapsed = (Date.now() - t0) / 1000;
  const kbps    = sent * 8 / elapsed / 1000;
  process.stdout.write(`\r[sender] sent=${sent}B  throughput=${kbps.toFixed(0)} kbps   `);
}, CHUNK_MS);

function shutdown() {
  clearInterval(timer);
  req.end('0\r\n\r\n');  // HTTP chunked last-chunk — clean stream_stop
  console.log('\n[sender] sent last-chunk — done');
  setTimeout(() => process.exit(0), 200);
}

process.on('SIGINT',  shutdown);
process.on('SIGTERM', shutdown);
