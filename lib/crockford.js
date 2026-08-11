// Author: had.sh
// The destroy key: a capability token the depositor alone holds.
//
// A story is served statelessly from its URL, so nothing on the server ties it
// to whoever made it. The destroy key is what lets its author, and only its
// author, take it down later without an account, an email or any proof of who
// they are. The browser draws 120 random bits, shows them once on the printed
// receipt, and the seed carries only SHA-256 of them (see seed.js, the
// commitment field). Nothing is sent anywhere at generation time.
//
// Why the commitment travels INSIDE the seed rather than in a server row or
// next to the URL: a commitment is only worth something if it was fixed before
// the challenge and cannot be swapped afterwards. Sitting inside the payload it
// is covered by the seed's own identity - change it and you have named a
// different story, not stolen this one. Parked beside the seed it would be a
// detachable label: anyone could replace it with a commitment to a key of their
// own and destroy someone else's story without breaking any hash at all.
//
// 120 bits, not 128, because 24 Crockford symbols are exactly 120 bits and 15
// bytes are exactly 120 bits: the encoding lands on a byte boundary with no
// padding

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford: no I, L, O, U
const CHECK_ALPHABET = ALPHABET + '*~$=U';          // 37 symbols for the check

// 15 bytes = 120 bits = 24 symbols, exactly. Plus one check symbol.
export const KEY_BYTES = 15;
export const KEY_SYMBOLS = 24;

// Domain separation. Hashing "tessera-destroy-v1:" + the code rather than the
// code alone keeps this protocol's hashes from ever being meaningful in another
// one. It costs no entropy, and unlike an obfuscation trick it survives being
// read: the bundle is served publicly and meant to be audited, so a secret
// twist in the algorithm would protect nobody while giving the two mirrors of
// this file one more thing to disagree about.
export const DESTROY_DOMAIN = 'tessera-destroy-v1:';

// Commitment length matches the key's entropy: truncating SHA-256 to 15 bytes
// leaves 120 bits of preimage resistance against a 120-bit secret. A 16th byte
// would widen the hash past the thing it commits to and buy nothing.
export const COMMITMENT_BYTES = 15;

// What gets hashed, and what a typed code is compared against. Accepts what a
// human actually types : lower case, missing or extra dashes, spaces from a
// copy/paste, and the letters Crockford deliberately left out of the alphabet
// and returns the single spelling both sides agree on.
//
// The I/L/O substitutions only ever repair typing: the encoder never emits
// those letters, so this is idempotent on any code this file produced.
export function normalize(input) {
    return String(input)
        .toUpperCase()
        .replace(/[\s-]/g, '')
        .replace(/[IL]/g, '1')
        .replace(/O/g, '0');
}

// Bit stream, most significant bit first. 120 bits in, 24 symbols out, no
// padding to decide about.
export function encode(bytes) {
    let value = 0;
    let bits = 0;
    let out = '';
    for (const byte of bytes) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            bits -= 5;
            out += ALPHABET[(value >>> bits) & 31];
        }
    }
    return out;
}

// Inverse of encode. Rejects anything outside the alphabet rather than reading
// it as zero bits, for the same reason base64urlDecode does (compress.js): a
// mangled code must fail as a mangled code, not decode to different bytes.
export function decode(symbols) {
    let value = 0;
    let bits = 0;
    const bytes = [];
    for (const c of symbols) {
        const v = ALPHABET.indexOf(c);
        if (v < 0) {
            throw new Error('crockford: invalid symbol');
        }
        value = (value << 5) | v;
        bits += 5;
        if (bits >= 8) {
            bits -= 8;
            bytes.push((value >>> bits) & 0xFF);
        }
    }
    return new Uint8Array(bytes);
}

// Crockford's check symbol: the value of the whole number modulo 37. Computed
// byte by byte so no big integer is needed - the running remainder stays under
// 37, so 37 * 256 + 255 is the largest intermediate and that fits a plain
// number
export function checkSymbol(bytes) {
    let rem = 0;
    for (const byte of bytes) {
        rem = (rem * 256 + byte) % 37;
    }
    return CHECK_ALPHABET[rem];
}

// XXXXX-XXXXX-XXXXX-XXXXX-XXXXX: 25 symbols in groups of five, the shape people
// have typed a thousand times before. Dictated aloud it stays unambiguous
// because Crockford has no I, L, O or U to confuse with 1, 0 or V.
export function format(code) {
    return code.match(/.{1,5}/g).join('-');
}

// The whole point of typing the key by hand instead of pasting it is that the
// person had to have kept it. This is what makes that survivable: a typo is
// caught here, on the spot, and never becomes a failed request that looks
// exactly like a wrong key.
export function isValid(input) {
    const code = normalize(input);
    if (code.length !== KEY_SYMBOLS + 1) {
        return false;
    }
    try {
        return checkSymbol(decode(code.slice(0, KEY_SYMBOLS))) === code[KEY_SYMBOLS];
    } catch {
        return false;
    }
}

// Refuses rather than degrades when the platform has no CSPRNG. Math.random is
// a xorshift128+ whose internal state is recoverable from a handful of outputs,
// so falling back to it would hand out keys anyone could predict while looking
// exactly like a working feature.
export function generateKey() {
    if (typeof crypto === 'undefined' || typeof crypto.getRandomValues !== 'function') {
        throw new Error('crockford: no CSPRNG available, refusing to generate a key');
    }
    const bytes = crypto.getRandomValues(new Uint8Array(KEY_BYTES));
    return format(encode(bytes) + checkSymbol(bytes));
}

// SHA-256 over the domain-separated canonical code, truncated to 15 bytes: what
// goes into the seed. Reveals nothing - it is the hash of an unstructured 120
// bit random, so it refers to no person, no save and no story.
//
// crypto.subtle needs a secure context (HTTPS or localhost); under file:// it
// is undefined, which is why the offline copy of the page cannot mint keys.
export async function commitment(input) {
    if (typeof crypto === 'undefined' || !crypto.subtle) {
        throw new Error('crockford: crypto.subtle unavailable (needs a secure context)');
    }
    const message = new TextEncoder().encode(DESTROY_DOMAIN + normalize(input));
    const digest = await crypto.subtle.digest('SHA-256', message);
    return new Uint8Array(digest).slice(0, COMMITMENT_BYTES);
}
