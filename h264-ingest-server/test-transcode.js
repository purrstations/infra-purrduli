#!/usr/bin/env node
// Test ffmpeg remux (-c:v copy) tanpa server, tanpa Docker, tanpa mediamtx.
// Pipe H.264 Annex-B ke ffmpeg stdin pakai args yang sama persis dengan
// production, output ke -f null - (remux tapi buang hasil).
//
// Run:
//   node test-transcode.js --h264-file path/to/sample.h264
//   node test-transcode.js                              (auto-generate via ffmpeg)
//
// Pass = ffmpeg exit 0, tidak ada "Invalid data" / "corrupt" di stderr.
// Fail = exit non-0 atau error di stderr.

const { spawn, execFileSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

const argv       = process.argv.slice(2);
const get        = (f, d) => { const i = argv.indexOf(f); return i !== -1 ? argv[i+1] : d; };
const H264_FILE   = get('--h264-file', '');
const CHUNK_MS     = parseInt(get('--chunk-ms', '20'), 10);    // simulate network chunking
const CHUNK_BYTES  = parseInt(get('--chunk-bytes', '4096'), 10);

// Args ffmpeg diambil dari production (server.js) via TEST_MODE → tidak ada duplikasi
// yang bisa drift.
process.env.TEST_MODE = '1';
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
  console.log(`[transcode-test] generated ${h264.length}B H.264 Annex-B test clip`);
}

// ── validate NAL start code before feeding ───────────────────────────────────

const hasStartCode = h264[0] === 0x00 && h264[1] === 0x00 &&
    (h264[2] === 0x01 || (h264[2] === 0x00 && h264[3] === 0x01));
if (!hasStartCode) {
  console.error('[transcode-test] input does not start with a NAL start code — aborting');
  process.exit(1);
}
console.log('[transcode-test] input starts with a valid NAL start code');
console.log(`[transcode-test] piping ${h264.length}B to ffmpeg in ${CHUNK_BYTES}B chunks...\n`);

// ── spawn ffmpeg (args identik dengan production, TEST_MODE → -f null -) ───────

const args = ffmpegArgs('transcode-test');
console.log(`[transcode-test] ffmpeg args: ${args.join(' ')}\n`);
const ffmpeg = spawn('ffmpeg', args);

let errors = 0;

ffmpeg.stderr.on('data', (d) => {
  const text = d.toString();
  const progress = text.match(/frame=\s*\d+[^\r\n]*/);
  if (progress) process.stdout.write(`\r${progress[0].trim()}   `);

  if (/invalid data|corrupt|non-existing (sps|pps)|error while decoding/i.test(text)) {
    errors++;
    process.stderr.write(`\n[FFMPEG ERR] ${text.trim()}\n`);
  }
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
  if (code === 0 && errors === 0) {
    console.log(`PASS — ${h264.length}B remuxed, ffmpeg exit 0, no errors`);
  } else {
    console.log(`FAIL — exit=${code} errors=${errors}`);
    process.exit(1);
  }
});

// ── pipe in chunks (simulate device sending over network) ──────────────────────

let offset = 0;
const timer = setInterval(() => {
  const end = Math.min(offset + CHUNK_BYTES, h264.length);
  ffmpeg.stdin.write(h264.subarray(offset, end));
  offset = end;
  if (offset >= h264.length) {
    clearInterval(timer);
    ffmpeg.stdin.end();
  }
}, CHUNK_MS);
