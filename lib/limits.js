// Author: had.sh
// Hard pipeline bounds: defense-in-depth against aberrant or hostile files.
// A real NMS save is far from these caps (file ~15 MB, ~30 MB decompressed,
// ~3,500 records, JSON nested ~25 levels, discovery buffer capped by the game
// itself around 3200): reaching them = abnormal file = rejection, never
// heroic processing. No save content is ever executed or interpreted:
// JSON.parse only, DOM output as textContent only.

// Size of accepted .hg input file.
export const MAX_SAVE_BYTES = 64 * 1024 * 1024;

// LZ4 decompression: per chunk, total, and chunk count. Total kept at ~3x a
// real decompressed save rather than the ~4:1 worst-case compression ratio,
// since the ratio itself is the attack surface (see lz4-block.js bound check).
export const MAX_CHUNK_DECOMP_BYTES = 4 * 1024 * 1024;
export const MAX_TOTAL_DECOMP_BYTES = 96 * 1024 * 1024;
export const MAX_CHUNKS = 512;

// Maximum depth of JSON traversed by deobfuscate (anti stack-overflow).
export const MAX_JSON_DEPTH = 48;

// Ceiling on what a '.1z' seed may inflate to. A real seed is a few hundred
// bytes, so this is three orders of magnitude of headroom. A pasted seed
// goes through this bound like everything else in the pipeline.
export const MAX_INFLATED_BYTES = 4 * 1024 * 1024;

// Volumes of processed records/systems. The game's own discovery buffer caps
// around 3200 records; MAX_RECORDS gives it ~2.5x headroom. MAX_SYSTEMS
// covers the wider geo union (teleports, bases, visited voxels, pets/eggs),
// not bound by the same mechanism, hence double MAX_RECORDS.
export const MAX_RECORDS = 8192;
export const MAX_SYSTEMS = 16384;

// Lengths of retained strings (names, pseudonyms). In-game name fields cap
// around 30-40 characters; platform usernames cap at 32 (Steam) or less.
export const MAX_NAME_LEN = 64;
export const MAX_USER_LEN = 32;

// Every PlayerStateData array other than DiscoveryManagerData's own Record[]
// (bounded separately by MAX_RECORDS/MAX_SYSTEMS): bases, teleports, pets,
// eggs, settlements, missions, wonder records, etc. None of these carries an
// in-game count anywhere near this, so truncating here is always "abnormal
// file", never a real save.
export const MAX_ARRAY_LEN = 8192;

// Max hex digits accepted for a UA/GalacticAddress string before BigInt
// parsing. A real UA fits in 64 bits (16 hex digits); double that for margin
// without letting an attacker hand BigInt() a multi-megabyte digit string.
export const MAX_UA_HEX_LEN = 32;

// Array.isArray(v) ? v.slice(0, max) : [] - the one place every "other
// PlayerStateData array" read goes through, so none of them can force
// per-element work (sanitizeString, BigInt, regex) proportional to an
// attacker-chosen array length instead of a real save's.
export function boundedArray(v, max = MAX_ARRAY_LEN) {
    return Array.isArray(v) ? v.slice(0, max) : [];
}

// Temporal bounds: timestamp outside [NMS release, 2100] is invalid. No event
// in a No Man's Sky save can predate the game shipping on 2016-08-09.
export const MAX_PLAUSIBLE_TS = Date.UTC(2100, 0, 1) / 1000;
export const MIN_PLAUSIBLE_TS = Date.UTC(2016, 7, 9) / 1000;

// Retained string: string type, C0/C1 controls removed, bounded length.
// Anything else (object, number, array where text expected) -> null.
export function sanitizeString(v, maxLen) {
    if (typeof v !== 'string' || !v.length) {
        return null;
    }
    const clean = v.replace(/[\x00-\x1f\x7f-\u009f]/g, '');
    return clean.length ? clean.slice(0, maxLen) : null;
}

// Exploitable timestamp: finite number within plausible bounds, else null.
// The lower bound is the one this file always claimed and never enforced:
// `v > 0` let absurd values through, and they reached the prose. Measured on
// save11.hg, SettlementHistory.PlayerClaimedTime = 983 (1970-01-01 00:16:23),
// which any "earliest event" reduction would have read as the year the journey
// started. Discovery records were already floored at the release date on their
// own; every other timestamp source in the save was not.
export function sanitizeTs(v) {
    return (typeof v === 'number' && Number.isFinite(v) &&
        v >= MIN_PLAUSIBLE_TS && v < MAX_PLAUSIBLE_TS) ? v : null;
}
