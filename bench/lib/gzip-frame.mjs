// JS mirror of apps/sync/internal/store/framing.go's frame/unframe + gzip, used
// to independently verify (from the client side, with no dependency on Go)
// that a DocumentSnapshot row written by the sync relay round-trips correctly.
import zlib from 'node:zlib';

export function gunzip(buf) {
  return zlib.gunzipSync(buf);
}

export function unframe(raw) {
  const blobs = [];
  let offset = 0;
  while (offset + 4 <= raw.length) {
    const len = raw.readUInt32BE(offset);
    offset += 4;
    if (offset + len > raw.length) break;
    blobs.push(raw.subarray(offset, offset + len));
    offset += len;
  }
  return blobs;
}
