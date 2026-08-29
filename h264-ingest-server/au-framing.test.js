// Unit test au-framing.js — node builtin assert, tanpa dependency.
// Run: node au-framing.test.js

const assert = require('assert');
const { AuParser, START_CODE } = require('./au-framing');

const SC3 = Buffer.from([0x00, 0x00, 0x01]);
const SC4 = Buffer.from([0x00, 0x00, 0x00, 0x01]);
const nal = (type, payload) => Buffer.from([type, ...payload]);

function collect(parser, chunks) {
  const out = [];
  for (const c of chunks) out.push(...parser.feed(c));
  return out;
}

// 1. Satu AU: SPS + PPS + IDR (pola device tiap GOP).
// Semantik streaming: AU hanya tertutup saat AU berikutnya terdeteksi
// (boundary = VCL baru / SPS / AUD) atau di finish().
{
  const p = new AuParser();
  const au = collect(p, [
    Buffer.concat([SC4, nal(7, [1]), SC3, nal(8, [2]), SC4, nal(5, [3])]),
  ]);
  assert.strictEqual(au.length, 0, 'AU terbuka sampai ada boundary berikutnya');
  const end = p.finish();
  assert.strictEqual(end.length, 1, 'finish() meluap AU terbuka');
  assert.ok(end[0].equals(Buffer.concat([START_CODE, nal(7, [1]), START_CODE, nal(8, [2]), START_CODE, nal(5, [3])])), 'start code dinormalisasi 4-byte');
}

// 2. Dua AU: IDR lalu P — IDR tertutup saat P terdeteksi (di finish karena
// stream berakhir), boundary benar walau feed() sendiri belum meluap.
{
  const p = new AuParser();
  const au = collect(p, [
    Buffer.concat([SC4, nal(5, [1]), SC4, nal(1, [2])]),
  ]);
  assert.strictEqual(au.length, 0, 'AU tertutup oleh AU berikutnya / finish');
  const end = p.finish();
  assert.strictEqual(end.length, 2);
  assert.ok(end[0].equals(Buffer.concat([START_CODE, nal(5, [1])])), 'AU 1 = IDR');
  assert.ok(end[1].equals(Buffer.concat([START_CODE, nal(1, [2])])), 'AU 2 = P');
}

// 3. Chunk dipotong sembarang (byte stream HTTP) — hasil harus identik
{
  const stream = Buffer.concat([
    SC4, nal(7, [0xaa, 0xbb]), SC4, nal(5, [0x11]), SC4, nal(1, [0x22]), SC4, nal(1, [0x33]),
  ]);
  const whole = collect(new AuParser(), [stream]);
  // acak potongan 1-3 byte
  const chunks = [];
  let i = 0;
  while (i < stream.length) {
    const n = Math.min(1 + (i % 3), stream.length - i);
    chunks.push(stream.subarray(i, i + n));
    i += n;
  }
  const sliced = collect(new AuParser(), chunks).concat(new AuParser().constructor ? [] : []);
  const p2 = new AuParser();
  const slicedOut = [];
  for (const c of chunks) slicedOut.push(...p2.feed(c));
  slicedOut.push(...p2.finish());
  const w = new AuParser();
  const wholeOut = [];
  for (const c of [stream]) wholeOut.push(...w.feed(c));
  wholeOut.push(...w.finish());
  assert.deepStrictEqual(slicedOut, wholeOut, 'hasil slice == hasil utuh');
  assert.strictEqual(slicedOut.length, 3, '3 AU: [SPS+IDR][P][P]');
}

// 4. NAL payload mengandung bytes mirip start code (00 00 01): parser memotong
// di situ — LIMITASI DOKUMENTASI. Aman di produksi: encoder hw ESP32-P4 wajib
// memasang emulation prevention byte sesuai spec H.264, jadi 00 00 01 tak
// pernah muncul di dalam NAL asli. Kalau terjadi, AU tetap 1 (fragmen menempel).
{
  const p = new AuParser();
  const au = collect(p, [
    Buffer.concat([SC3, nal(5, [0x00, 0x00, 0x01, 0x55])]),
  ]);
  const end = au.concat(p.finish());
  assert.strictEqual(end.length, 1, 'fragmen tetap 1 AU, stream tidak kacau');
}

// 5. NAL non-VCL beruntun (AUD+SPS+PPS) menempel ke VCL berikut
{
  const p = new AuParser();
  const au = collect(p, [
    Buffer.concat([SC4, nal(9, [0xf0]), SC4, nal(7, [1]), SC4, nal(8, [2]), SC4, nal(1, [3])]),
  ]);
  assert.strictEqual(au.length, 0, 'belum ada VCL → belum ada AU');
  const end = p.finish();
  assert.strictEqual(end.length, 1);
  assert.strictEqual(end[0][4] & 0x1f, 9, 'AU dibuka AUD');
  assert.ok(end[0].includes(Buffer.from([3])), 'P slice ikut di AU yang sama');
}

// 6. SPS+PPS di tengah stream menempel ke IDR berikutnya (pola device: repeat headers tiap GOP)
{
  const p = new AuParser();
  const aus = collect(p, [
    Buffer.concat([SC4, nal(5, [1]), SC4, nal(1, [2]), SC4, nal(7, [9]), SC4, nal(8, [9]), SC4, nal(5, [3])]),
  ]).concat(p.finish());
  assert.strictEqual(aus.length, 3);
  assert.strictEqual((aus[2][4] & 0x1f), 7, 'AU ketiga dibuka SPS');
  assert.ok(aus[2].includes(nal(5, [3])[1]), 'IDR ikut di AU yang sama dengan SPS+PPS');
}

console.log('PASS — au-framing: 6 skenario');
