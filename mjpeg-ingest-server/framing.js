// Parser buat multipart/x-mixed-replace (boundary "--frame") — dipakai server.js
// dan diverifikasi standalone di framing.test.js (data dari device bisa datang
// terpotong di batas frame kapan aja, jadi ini paling gampang salah diam-diam).

const BOUNDARY         = Buffer.from('--frame\r\n');
const HEADER_END       = Buffer.from('\r\n\r\n');
const PART_TRAILER_LEN = 2;  // trailing "\r\n" after each JPEG blob

// Extract as many complete multipart parts as are fully buffered from `buf`,
// calling `onFrame(jpegBuffer)` for each. Returns leftover (possibly partial)
// buffer to prepend to the next incoming chunk.
function drainParts(buf, onFrame) {
  for (;;) {
    const boundaryIdx = buf.indexOf(BOUNDARY);
    if (boundaryIdx === -1) return buf;

    const headerStart = boundaryIdx + BOUNDARY.length;
    const headerEndIdx = buf.indexOf(HEADER_END, headerStart);
    if (headerEndIdx === -1) return buf.subarray(boundaryIdx);  // headers not complete yet

    const headerText = buf.toString('latin1', headerStart, headerEndIdx);
    const match = /Content-Length:\s*(\d+)/i.exec(headerText);
    if (!match) {
      // Malformed part — drop up to end of this header and try the next boundary.
      buf = buf.subarray(headerEndIdx + HEADER_END.length);
      continue;
    }

    const jpegLen   = parseInt(match[1], 10);
    const jpegStart = headerEndIdx + HEADER_END.length;
    const jpegEnd   = jpegStart + jpegLen;
    if (buf.length < jpegEnd + PART_TRAILER_LEN) return buf.subarray(boundaryIdx);  // wait for more data

    onFrame(buf.subarray(jpegStart, jpegEnd));
    buf = buf.subarray(jpegEnd + PART_TRAILER_LEN);
  }
}

module.exports = { drainParts };
