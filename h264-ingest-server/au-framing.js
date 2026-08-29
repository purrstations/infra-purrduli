// Incremental Annex-B access-unit parser untuk H.264 stream mentah.
//
// Device (ESP32-P4) mengirim byte-stream Annex-B tanpa framing per-frame.
// Pacer ingest butuh AU (access unit) terpisah: satu AU = satu gambar
// (baseline profile, tanpa B-frame → setiap VCL NAL = satu frame), dengan
// NAL non-VCL (SPS/PPS/SEI/AUD) menempel ke VCL berikutnya.
//
// Parser incremental: feed() menerima chunk sebarang potongan (byte stream
// dari HTTP tidak menghormati batas NAL) dan mengembalikan AU yang sudah
// lengkap. Start code dinormalisasi ke 4-byte (00 00 00 01) saat rebuild.
//
// Host-testable murni — tanpa dependency. Lihat au-framing.test.js.

const START_CODE = Buffer.from([0x00, 0x00, 0x00, 0x01]);

// NAL VCL: 1 = non-IDR slice, 5 = IDR slice. Baseline profile tidak punya
// B-frame (type 2/3/4 direject encoder hw), jadi VCL NAL = batas AU pasti.
function isVcl(nalType) {
  return nalType === 1 || nalType === 5;
}

class AuParser {
  constructor() {
    this._resetStream();
    this.auQueue = [];  // AU lengkap (Buffer Annex-B), siap dikonsumsi pacer
  }

  _resetStream() {
    this.started = false;   // sudah menemukan start code pertama
    this.zeros = 0;         // run of 0x00 saat scan start code
    this.cur = [];          // byte NAL berjalan (tanpa start code)
    this.nals = [];         // NAL milik AU berjalan
    this.hasVcl = false;    // AU berjalan sudah punya VCL?
  }

  // Feed byte stream mentah. Return AU yang selesai terbentuk oleh chunk ini.
  feed(chunk) {
    const before = this.auQueue.length;
    for (let i = 0; i < chunk.length; i++) this._byte(chunk[i]);
    return this.auQueue.splice(0, this.auQueue.length - before);
  }

  // Akhir stream (clean stop) — tutup NAL berjalan, flush sisa AU.
  finish() {
    if (this.started && this.cur.length > 0) this._endNal();
    this._closeCurrentAu();
    const out = this.auQueue.splice(0);
    this._resetStream();
    return out;
  }

  _byte(b) {
    if (!this.started) {
      if (b === 0x00) {
        this.zeros++;
      } else if (b === 0x01 && this.zeros >= 2) {
        this.started = true;
        this.zeros = 0;
        this.cur = [];
      } else {
        this.zeros = 0;
      }
      return;
    }

    if (b === 0x00) {
      this.zeros++;
      return;
    }
    if (this.zeros >= 2 && b === 0x01) {
      // Start code baru = akhir NAL berjalan.
      this._endNal();
      this.cur = [];
      this.zeros = 0;
      return;
    }
    // Byte biasa (bukan bagian start code) — tuliskan zero-run dulu.
    while (this.zeros > 0) {
      this.cur.push(0x00);
      this.zeros--;
    }
    this.cur.push(b);
  }

  _endNal() {
    if (this.cur.length === 0) return;  // start code beruntun / zero-run saja
    const nal = Buffer.from(this.cur);
    const type = nal[0] & 0x1f;

    // Boundary AU baru: VCL saat AU berjalan sudah punya VCL, atau SPS/AUD —
    // keduanya menandai awal AU baru di Annex-B baseline (pola device:
    // SPS+PPS+IDR diulang tiap GOP). SEI/PPS menempel ke AU berjalan.
    const opensNewAu = isVcl(type) || type === 7 || type === 9;
    if (opensNewAu && this.hasVcl) {
      this._closeCurrentAu();
      this.nals = [nal];
      this.hasVcl = isVcl(type);
    } else {
      this.nals.push(nal);
      if (isVcl(type)) this.hasVcl = true;
    }
  }

  _closeCurrentAu() {
    if (this.nals.length === 0) return;
    const parts = [];
    for (const nal of this.nals) {
      parts.push(START_CODE, nal);
    }
    this.auQueue.push(Buffer.concat(parts));
    this.nals = [];
    this.hasVcl = false;
  }
}

module.exports = { AuParser, START_CODE, isVcl };
