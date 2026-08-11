// Author: had.sh
// Base64url encoding and deflate-raw compression for Payload A (geo).
//
// deflate-raw via CompressionStream (native browser API).
// base64url: alphabet -_ instead of +/, no padding, used for binary encoding.

import { MAX_INFLATED_BYTES } from './limits.js';

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function base64urlEncode(bytes) {
    let out = '';
    for (let i = 0; i < bytes.length; i += 3) {
        const b0 = bytes[i];
        const b1 = i + 1 < bytes.length ? bytes[i + 1] : null;
        const b2 = i + 2 < bytes.length ? bytes[i + 2] : null;
        out += B64[b0 >> 2];
        out += B64[((b0 & 3) << 4) | (b1 === null ? 0 : b1 >> 4)];
        if (b1 !== null) {
            out += B64[((b1 & 15) << 2) | (b2 === null ? 0 : b2 >> 6)];
        }
        if (b2 !== null) {
            out += B64[b2 & 63];
        }
    }
    return out; // no padding in base64url
}

// Rejects anything outside the alphabet instead of decoding it as zero bits.
// An unbounded lookup would let `rev[c] === undefined` through, and
// `x | undefined` is `x | 0`, so a seed mangled by a chat client, a wrapping
// email, a smart-quote substitution or a bad scan of the printed receipt
// would come out as different bytes rather than as an error. The crc8 alone
// would catch 255 cases out of 256 and let the 256th through as a plausible
// wrong story. Failing here removes that whole class of mangling from the
// CRC's workload.
export function base64urlDecode(str) {
    const rev = {};
    for (let i = 0; i < B64.length; i++) {
        rev[B64[i]] = i;
    }
    const bytes = [];
    let buf = 0;
    let bits = 0;
    for (const c of str) {
        const v = rev[c];
        if (v === undefined) {
            throw new Error('base64url: invalid character');
        }
        buf = (buf << 6) | v;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            bytes.push((buf >> bits) & 0xFF);
        }
    }
    return new Uint8Array(bytes);
}

// CRC-8/SMBUS (poly 0x07, init 0x00, no reflection, xorout 0x00), salted with
// the ASCII bytes prepended to the payload. The
// salt is a watermark + integrity check, never an anti-forgery secret.
const CRC8_SALT = [0x68, 0x61, 0x64];

export function crc8Had(bytes) {
    let crc = 0x00;
    const feed = (b) => {
        crc ^= b & 0xFF;
        for (let i = 0; i < 8; i++) {
            crc = (crc & 0x80) ? ((crc << 1) ^ 0x07) & 0xFF : (crc << 1) & 0xFF;
        }
    };
    for (const b of CRC8_SALT) feed(b);
    for (const b of bytes) feed(b);
    return crc & 0xFF;
}

export function compressionAvailable() {
    return typeof CompressionStream !== 'undefined' &&
        typeof DecompressionStream !== 'undefined';
}

// Reads the transformed stream chunk by chunk and gives up past `max`, rather
// than buffering whatever comes out. 
async function pipe(bytes, transform, max = Infinity) {
    const reader = new Blob([bytes]).stream().pipeThrough(transform).getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > max) {
            await reader.cancel();
            throw new Error('compress: decompressed payload too large');
        }
        chunks.push(value);
    }
    const out = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) { out.set(c, at); at += c.length; }
    return out;
}

export async function deflateRaw(bytes) {
    return pipe(bytes, new CompressionStream('deflate-raw'));
}

export async function inflateRaw(bytes) {
    return pipe(bytes, new DecompressionStream('deflate-raw'), MAX_INFLATED_BYTES);
}
