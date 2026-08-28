#!/usr/bin/env node
// Test ffmpeg remux (-c:v copy) tanpa server, tanpa Docker, tanpa mediamtx.
// Pipe H.264 Annex-B ke ffmpeg stdin pakai args yang sama persis dengan
// production, output ke -f null - (remux tapi buang hasil).
//
// Run:
//   node test-transcode.js --h264-file path/to/sample.h264
//   node test-transcode.js                              (auto-generate via ffmpeg)
//
// Profil pengiriman (simulasi jaringan):
//   --profile steady  chunk rata setiap CHUNK_MS (default, perilaku lama)
//   --profile burst   MiFi-like: aktif selama --active-ms lalu diam --pause-ms,
//                     berulang. Data yang tertahan tidak menumpuk — pola
//                     kirim-nyembur persis device saat uplink dip.
//
// Kriteria PASS (regression test timestamp):
//   exit 0, tanpa "Invalid data"/"corrupt",
//   nol "Timestamps are unset" (NOPTS), nol "Non-monotonic DTS".
// Baseline produksi (2026-08): 579x non-monotonic dalam 14 menit — FAIL.
//
// --output rtsp://host:port/path : pakai RTSP muxer (setara produksi). PENTING:
//   warning "Timestamps are unset" dan "Non-monotonic DTS" di produksi berasal
//   dari RTSP muxer — output -f null - (TEST_MODE) tidak memancarkan keduanya,
//   jadi repro timestamp WAJIB lewat --output. Butuh RTSP server yang menerima
//   publish anonim, mis. mediamtx default config.

const { spawn, execFileSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

const argv        = process.argv.slice(2);
const get         = (f, d) => { const i = argv.indexOf(f); return i !== -1 ? argv[i+1] : d; };
const H264_FILE   = get('--h264-file', '');
const PROFILE     = get('--profile', 'steady');
const CHUNK_MS    = parseInt(get('--chunk-ms', '20'), 10);      // simulate network chunking
const CHUNK_BYTES = parseInt(get('--chunk-bytes', '4096'), 10);
const DURATION_S  = parseInt(get('--duration', '25'), 10);      // total durasi stream test
const ACTIVE_MS   = parseInt(get('--active-ms', '700'), 10);    // burst profile
const PAUSE_MS    = parseInt(get('--pause-ms', '900'), 10);     // burst profile
const MAX_NOPTS   = parseInt(get('--max-nopts', '1'), 10);      // paket pertama (pra-parser-init) NOPTS — benign
const MAX_NONMONO = parseInt(get('--max-nonmono', '0'), 10);
const OUTPUT_URL  = get('--output', '');

if (PROFILE !== 'steady' && PROFILE !== 'burst') {
  console.error(`profile tidak dikenal: ${PROFILE} (steady|burst)`);
  process.exit(1);
}

// Args ffmpeg diambil dari production (server.js) → tidak ada duplikasi yang
// bisa drift. Default (TEST_MODE) = -f null -; --output memaksa jalur RTSP
// produksi (target dari env MEDIAMTX_* + deviceId).
const USE_RTSP = OUTPUT_URL !== '';
if (USE_RTSP) {
  // Parse SEBELUM require('./server') — MEDIAMTX_* dibaca sebagai const
  // module-level di sana, jadi env harus terpasang duluan.
  const m = /^rtsp:\/\/(?:([^:@]+)(?::([^@]*))?@)?([^:\/]+)(?::(\d+))?\/(.+)$/.exec(OUTPUT_URL);
  if (!m) {
    console.error(`--output bukan URL rtsp valid: ${OUTPUT_URL}`);
    process.exit(1);
  }
  process.env.MEDIAMTX_USER = m[1] || '';
  process.env.MEDIAMTX_PASS = m[2] || '';
  process.env.MEDIAMTX_HOST = m[3];
  process.env.MEDIAMTX_PORT = m[4] || '8554';
  var RTSP_PATH = m[5];
} else {
  process.env.TEST_MODE = '1';
}
const { ffmpegArgs } = require('./server');

// ── load / generate H.264 Annex-B sample ─────────────────────────────────────

let h264;

if (H264_FILE) {
  if (!fs.existsSync(H264_FILE)) {
    console.error(`h264-file not found: ${H264_FILE}`);
    process.exit(1);
  }
  h264 = fs.readFileSync(H264_FILE);
  console.log(`[transcode-test] loaded ${h264.length}B from ${H264_FILE}`);
} else {
  console.log('[transcode-test] no --h264-file given — generating test clip via ffmpeg...');
  const tmp = path.join(require('os').tmpdir(), 'h264_transcode_test.h264');
  try {
    execFileSync('ffmpeg', [
      '-y', '-f', 'lavfi', '-i', 'testsrc=size=640x480:rate=20:duration=2',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-f', 'h264', tmp,
    ], { stdio: 'pipe' });
  } catch (e) {
    console.error('ffmpeg not found or failed to generate test clip.');
    console.error('Either install ffmpeg or pass --h264-file path/to/sample.h264');
    process.exit(1);
  }
  h264 = fs.readFileSync(tmp);
  fs.unlinkSync(tmp);
  console.log('[transcode-test] generated 2s H.264 Annex-B test clip');
}

// ── validate NAL start code before feeding ───────────────────────────────────

const hasStartCode = h264[0] === 0x00 && h264[1] === 0x00 &&
    (h264[2] === 0x01 || (h264[2] === 0x00 && h264[3] === 0x01));
if (!hasStartCode) {
  console.error('[transcode-test] input does not start with a NAL start code — aborting');
  process.exit(1);
}
console.log(`[transcode-test] input starts with a valid NAL start code`);
console.log(`[transcode-test] profile=${PROFILE} duration=${DURATION_S}s chunk=${CHUNK_BYTES}B/${CHUNK_MS}ms` +
  (PROFILE === 'burst' ? ` active=${ACTIVE_MS}ms pause=${PAUSE_MS}ms` : ''));
console.log(`[transcode-test] piping (looped) ke ffmpeg...\n`);

// ── spawn ffmpeg (args dari server.js; TEST_MODE → -f null -, --output → rtsp) ──

let args;
if (USE_RTSP) {
  args = ffmpegArgs(RTSP_PATH);
} else {
  args = ffmpegArgs('transcode-test');
}
console.log(`[transcode-test] ffmpeg args: ${args.join(' ')}\n`);
const ffmpeg = spawn('ffmpeg', args);

let errors     = 0;
let noptsCount = 0;
let nonMonoCount = 0;

ffmpeg.stderr.on('data', (d) => {
  const text = d.toString();
  const progress = text.match(/frame=\s*\d+[^\r\n]*/);
  if (progress) process.stdout.write(`\r${progress[0].trim()}   `);

  if (/invalid data|corrupt|non-existing (sps|pps)|error while decoding/i.test(text)) {
    errors++;
    process.stderr.write(`\n[FFMPEG ERR] ${text.trim()}\n`);
  }
  if (/Timestamps are unset in a packet/i.test(text)) noptsCount++;
  if (/Non-monotonic DTS/i.test(text)) nonMonoCount++;
});

ffmpeg.on('error', (err) => {
  if (err.code === 'ENOENT') {
    console.error('\nffmpeg not found in PATH');
  } else {
    console.error(`\nffmpeg error: ${err.message}`);
  }
  process.exit(1);
});

ffmpeg.on('exit', (code) => {
  process.stdout.write('\n\n');
  console.log(`[transcode-test] hasil: errors=${errors} nopts=${noptsCount} (max ${MAX_NOPTS}) non-monotonic=${nonMonoCount} (max ${MAX_NONMONO})`);
  const tsClean = noptsCount <= MAX_NOPTS && nonMonoCount <= MAX_NONMONO;
  if (code === 0 && errors === 0 && tsClean) {
    console.log(`PASS — remux bersih, timestamp monolitik`);
  } else {
    if (!tsClean) console.log(`FAIL — timestamp rusak (reproduksi bug stutter)`);
    else console.log(`FAIL — exit=${code} errors=${errors}`);
    process.exit(1);
  }
});

// ── pipe dengan profil jaringan ──────────────────────────────────────────────
// Loop file: SPS/PPS muncul ulang di tengah stream — meniru device yang
// recreate encoder (reconnect / restart). Persis pola produksi 2026-08.

let offset     = 0;
const startedAt = Date.now();

const timer = setInterval(() => {
  const elapsed = Date.now() - startedAt;
  if (elapsed >= DURATION_S * 1000) {
    clearInterval(timer);
    ffmpeg.stdin.end();
    return;
  }

  if (PROFILE === 'burst') {
    const cycle   = ACTIVE_MS + PAUSE_MS;
    const inCycle = elapsed % cycle;
    if (inCycle >= ACTIVE_MS) return;  // jeda uplink — tidak ada byte keluar
  }

  const end   = Math.min(offset + CHUNK_BYTES, h264.length);
  ffmpeg.stdin.write(h264.subarray(offset, end));
  offset = end;
  if (offset >= h264.length) offset = 0;  // loop: SPS/PPS muncul ulang
}, CHUNK_MS);
