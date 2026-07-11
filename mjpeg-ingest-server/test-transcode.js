#!/usr/bin/env node
// Test ffmpeg transcoding tanpa server, tanpa Docker, tanpa mediamtx.
// Pipe JPEG frames langsung ke ffmpeg stdin pakai args yang sama persis
// dengan production, output ke -f null - (encode tapi buang hasil).
//
// Run:
//   node test-transcode.js --frames-dir ../../iot/debug_frames
//   node test-transcode.js --frames-dir ../../iot/debug_frames --count 60
//
// Pass = ffmpeg exit 0, tidak ada "Invalid data" / "corrupt" di stderr.
// Fail = exit non-0 atau error di stderr.

const { spawn, execFileSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

const argv      = process.argv.slice(2);
const get       = (f, d) => { const i = argv.indexOf(f); return i !== -1 ? argv[i+1] : d; };
const FRAMES_DIR = get('--frames-dir', '');
const COUNT      = parseInt(get('--count', '60'), 10);
const FPS        = parseInt(get('--fps',   '25'), 10);
const INTERVAL   = Math.round(1000 / FPS);

// Args ffmpeg diambil dari production (server.js) via TEST_MODE → tidak ada duplikasi
// yang bisa drift. STREAM_FPS & TEST_MODE dibaca ffmpegArgs saat dipanggil.
process.env.TEST_MODE  = '1';
process.env.STREAM_FPS = String(FPS);
const { ffmpegArgs } = require('./server');

// ── load frames ───────────────────────────────────────────────────────────────

let frames;

if (FRAMES_DIR) {
  if (!fs.existsSync(FRAMES_DIR)) {
    console.error(`frames-dir not found: ${FRAMES_DIR}`);
    process.exit(1);
  }
  const files = fs.readdirSync(FRAMES_DIR)
    .filter(f => /\.(jpg|jpeg)$/i.test(f))
    .sort()
    .slice(0, COUNT);
  if (files.length === 0) {
    console.error(`No .jpg files in ${FRAMES_DIR}`);
    process.exit(1);
  }
  frames = files.map(f => fs.readFileSync(path.join(FRAMES_DIR, f)));
  console.log(`[transcode-test] loaded ${frames.length} real frames from ${FRAMES_DIR}`);
} else {
  // No frames-dir: generate one real JPEG with ffmpeg (640x480 solid color)
  // and repeat it COUNT times. Fake JPEG (SOI+APP0+padding+EOI) won't work —
  // ffmpeg needs an actual decodable SOF+image-data.
  console.log('[transcode-test] no --frames-dir given — generating test frame via ffmpeg...');
  const tmp = path.join(require('os').tmpdir(), 'mjpeg_test_frame.jpg');
  try {
    execFileSync('ffmpeg', [
      '-y', '-f', 'lavfi', '-i', 'color=c=0x3a7bd5:s=640x480:r=1',
      '-vframes', '1', '-q:v', '5', tmp,
    ], { stdio: 'pipe' });
  } catch (e) {
    console.error('ffmpeg not found or failed to generate test frame.');
    console.error('Either install ffmpeg or pass --frames-dir path/to/debug_frames');
    process.exit(1);
  }
  const frame = fs.readFileSync(tmp);
  fs.unlinkSync(tmp);
  frames = Array.from({ length: COUNT }, () => frame);
  console.log(`[transcode-test] generated 1 real frame (${frame.length}B), repeating ${COUNT}x`);
}

// ── validate frames before feeding ───────────────────────────────────────────

let badFrames = 0;
for (const f of frames) {
  const soi = f[0] === 0xff && f[1] === 0xd8;
  const eoi = f[f.length-2] === 0xff && f[f.length-1] === 0xd9;
  if (!soi || !eoi) badFrames++;
}
if (badFrames > 0) {
  console.error(`[transcode-test] ${badFrames}/${frames.length} frames have bad SOI/EOI — aborting`);
  process.exit(1);
}
console.log(`[transcode-test] all ${frames.length} frames pass SOI/EOI check`);
console.log(`[transcode-test] piping to ffmpeg at ${FPS}fps...\n`);

// ── spawn ffmpeg (args identik dengan production, TEST_MODE → -f null -) ───────

const args = ffmpegArgs('transcode-test');
console.log(`[transcode-test] ffmpeg args: ${args.join(' ')}\n`);
const ffmpeg = spawn('ffmpeg', args);

let errors = 0;

ffmpeg.stderr.on('data', (d) => {
  const text = d.toString();
  const progress = text.match(/frame=\s*\d+[^\r\n]*/);
  if (progress) process.stdout.write(`\r${progress[0].trim()}   `);

  if (/invalid data|no jpeg data|found eoi before|corrupt/i.test(text)) {
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
    console.log(`PASS — ${frames.length} frames encoded, ffmpeg exit 0, no errors`);
  } else {
    console.log(`FAIL — exit=${code} errors=${errors}`);
    process.exit(1);
  }
});

// ── pipe frames ───────────────────────────────────────────────────────────────

let idx = 0;
const timer = setInterval(() => {
  ffmpeg.stdin.write(frames[idx % frames.length]);
  idx++;
  if (idx >= COUNT) {
    clearInterval(timer);
    ffmpeg.stdin.end();
  }
}, INTERVAL);
