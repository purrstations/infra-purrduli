// Runnable check buat drainParts — bagian paling gampang salah diam-diam
// (framing multipart, data device bisa datang terpotong di titik mana pun).
// Node builtin assert, no framework. Jalanin: node framing.test.js

const assert = require('assert');
const { drainParts } = require('./framing');

function part(jpeg) {
  return Buffer.concat([
    Buffer.from(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`),
    jpeg,
    Buffer.from('\r\n'),
  ]);
}

function test(name, fn) {
  fn();
  console.log(`ok - ${name}`);
}

test('single complete part extracted in one pass', () => {
  const jpeg = Buffer.from('fake-jpeg-bytes');
  const frames = [];
  const leftover = drainParts(part(jpeg), (f) => frames.push(f));
  assert.strictEqual(frames.length, 1);
  assert.ok(frames[0].equals(jpeg));
  assert.strictEqual(leftover.length, 0);
});

test('two parts concatenated both extracted in order', () => {
  const a = Buffer.from('frame-a');
  const b = Buffer.from('frame-b-longer');
  const frames = [];
  const leftover = drainParts(Buffer.concat([part(a), part(b)]), (f) => frames.push(f));
  assert.strictEqual(frames.length, 2);
  assert.ok(frames[0].equals(a));
  assert.ok(frames[1].equals(b));
  assert.strictEqual(leftover.length, 0);
});

test('part split across two chunks waits then extracts', () => {
  const jpeg = Buffer.from('split-across-chunks');
  const whole = part(jpeg);
  const splitAt = 10;  // cuts through the header, before jpeg bytes even start
  const frames = [];

  let leftover = drainParts(whole.subarray(0, splitAt), (f) => frames.push(f));
  assert.strictEqual(frames.length, 0);  // not enough data yet

  leftover = drainParts(Buffer.concat([leftover, whole.subarray(splitAt)]), (f) => frames.push(f));
  assert.strictEqual(frames.length, 1);
  assert.ok(frames[0].equals(jpeg));
  assert.strictEqual(leftover.length, 0);
});

test('jpeg bytes themselves split across chunks (mid-binary-data cut)', () => {
  const jpeg = Buffer.from('0123456789ABCDEF');
  const whole = part(jpeg);
  const cut = whole.indexOf(jpeg) + 6;  // cut partway through the JPEG payload
  const frames = [];

  let leftover = drainParts(whole.subarray(0, cut), (f) => frames.push(f));
  assert.strictEqual(frames.length, 0);

  leftover = drainParts(Buffer.concat([leftover, whole.subarray(cut)]), (f) => frames.push(f));
  assert.strictEqual(frames.length, 1);
  assert.ok(frames[0].equals(jpeg));
});

test('malformed part (no Content-Length) is dropped, does not hang', () => {
  const malformed = Buffer.from('--frame\r\nContent-Type: image/jpeg\r\n\r\ngarbage');
  const good = part(Buffer.from('valid-frame'));
  const frames = [];
  const leftover = drainParts(Buffer.concat([malformed, good]), (f) => frames.push(f));
  assert.strictEqual(frames.length, 1);
  assert.ok(frames[0].equals(Buffer.from('valid-frame')));
  assert.strictEqual(leftover.length, 0);
});

test('empty buffer returns empty leftover, no crash', () => {
  const frames = [];
  const leftover = drainParts(Buffer.alloc(0), (f) => frames.push(f));
  assert.strictEqual(frames.length, 0);
  assert.strictEqual(leftover.length, 0);
});

console.log('All framing.test.js checks passed.');
