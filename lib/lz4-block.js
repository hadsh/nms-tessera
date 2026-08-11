// Author: had.sh
// Minimal LZ4 decompressor for No Man's Sky's recent .hg format.
//
// Two levels:
//   - decodeChunks(bytes): the NMS chunked container (16-byte header per
//     chunk: magic E5 A1 ED FE + compSize u32le + decompSize u32le + reserved),
//     loop while magic matches, concatenate decompressed blocks then
//     strip final \x00 padding (port of decode_chunks from 01-extract.py).
//   - lz4DecompressBlock(src, destSize): standard LZ4 "block" format
//     (token 4+4 bits, literals, offset u16le, match minimum 4), with no
//     external dependency. destSize is known (present in chunk header).

export const LZ4_MAGIC = [0xe5, 0xa1, 0xed, 0xfe];

export function hasMagic(bytes, pos = 0) {
    return bytes.length >= pos + 4 &&
        bytes[pos] === LZ4_MAGIC[0] && bytes[pos + 1] === LZ4_MAGIC[1] &&
        bytes[pos + 2] === LZ4_MAGIC[2] && bytes[pos + 3] === LZ4_MAGIC[3];
}

export function lz4DecompressBlock(src, destSize) {
    const dst = new Uint8Array(destSize);
    let si = 0;
    let di = 0;
    const slen = src.length;
    while (si < slen) {
        const token = src[si++];
        // Literals
        let litLen = token >>> 4;
        if (litLen === 15) {
            let b;
            do {
                b = src[si++];
                litLen += b;
            } while (b === 255);
        }
        if (litLen > 0) {
            dst.set(src.subarray(si, si + litLen), di);
            si += litLen;
            di += litLen;
        }
        if (si >= slen) {
            break; // last block: literals only, no match
        }
        // Match
        const offset = src[si] | (src[si + 1] << 8);
        si += 2;
        if (offset === 0) {
            throw new Error('LZ4: invalid offset 0');
        }
        let matchLen = (token & 0x0f) + 4;
        if ((token & 0x0f) === 15) {
            let b;
            do {
                b = src[si++];
                matchLen += b;
            } while (b === 255);
        }
        // Byte-by-byte copy mandatory: matches can overlap
        // (offset < matchLen), this is LZ4's RLE mechanism.
        let mi = di - offset;
        if (mi < 0) {
            throw new Error('LZ4: offset before buffer start');
        }
        // matchLen is attacker-controlled (a chain of 0xFF continuation
        // bytes inflates it far beyond destSize) and the loop below has no
        // bounds check of its own: rejecting it here, before the copy,
        // stops a crafted chunk from burning CPU on a byte-by-byte loop
        // that was always going to fail the destSize check at the end.
        if (di + matchLen > destSize) {
            throw new Error('LZ4: match exceeds destination size');
        }
        for (let i = 0; i < matchLen; i++) {
            dst[di++] = dst[mi++];
        }
    }
    if (di !== destSize) {
        throw new Error(`LZ4: decompressed size ${di} != expected ${destSize}`);
    }
    return dst;
}

function readU32le(bytes, pos) {
    return (bytes[pos] | (bytes[pos + 1] << 8) | (bytes[pos + 2] << 16) |
        (bytes[pos + 3] << 24)) >>> 0;
}

import { MAX_CHUNK_DECOMP_BYTES, MAX_TOTAL_DECOMP_BYTES, MAX_CHUNKS } from './limits.js';

export function decodeChunks(bytes) {
    const parts = [];
    let total = 0;
    let pos = 0;
    let chunks = 0;
    while (pos < bytes.length && hasMagic(bytes, pos)) {
        const compSize = readU32le(bytes, pos + 4);
        const decompSize = readU32le(bytes, pos + 8);
        pos += 16;
        // Coherence guards: aberrant header (arbitrary file starting with
        // magic) must never trigger giant allocation nor out-of-buffer read.
        // Bounds per chunk, by chunk count, and total decompressed volume.
        if (compSize === 0 || pos + compSize > bytes.length ||
            decompSize === 0 || decompSize > MAX_CHUNK_DECOMP_BYTES ||
            ++chunks > MAX_CHUNKS || total + decompSize > MAX_TOTAL_DECOMP_BYTES) {
            throw new Error('LZ4: incoherent chunk header or aberrant volume, not an NMS save');
        }
        const chunk = bytes.subarray(pos, pos + compSize);
        pos += compSize;
        const out = lz4DecompressBlock(chunk, decompSize);
        parts.push(out);
        total += out.length;
    }
    let joined = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
        joined.set(p, off);
        off += p.length;
    }
    // rstrip(b'\x00'): game pads JSON end with zeros.
    let end = joined.length;
    while (end > 0 && joined[end - 1] === 0) {
        end--;
    }
    return joined.subarray(0, end);
}
