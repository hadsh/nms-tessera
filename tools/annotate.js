// Author: had.sh
// Byte-by-byte reader for a seed: walks the payload the way the decoder does
// and reports what every byte is doing, with the bits spelled out.
//
// This file holds the only copy of the field layout outside lib/seed.js, and
// that duplication is deliberate: a spec that is never executed rots. It is
// executed here, and test/selftest.js replays it against the real decoder on
// the worst-case fixture, so any drift in field order or field kind fails a
// check instead of quietly producing a wrong document.


import { base64urlDecode, inflateRaw, crc8Had } from '../lib/compress.js';
import { readVarint, CREATURE_IDS, expandName } from '../lib/seed.js';

// Beat types in BEAT_TYPES/header-bit order. Append-only upstream.
export const BEAT_TYPES = [
    'first_system', 'community_phase', 'center_journey', 'intergalactic_jump',
    'first_naming', 'journey_ends', 'favorite_base',
    'freighter_named', 'atlas_encounter', 'purple_systems', 'total_playtime',
    'settlements', 'final_session',
    'first_pet', 'multitool_named', 'main_story_arc', 'expedition_lore',
];

// Header bitmask width: ceil(17 types / 8).
export const HEADER_BYTES = Math.ceil(BEAT_TYPES.length / 8);

// Fixed destroy-key commitment field, right after the header. Duplicated from
// lib/crockford.js on purpose, like everything else in this file: selftest
// walks the layout here against the shipped decoder, so a drift fails a check
// instead of producing a listing that quietly lies about the bytes.
export const COMMITMENT_BYTES = 15;

// Types carrying no date: no month index before their payload.
export const UNDATED_TYPES = new Set([
    'first_system', 'community_phase', 'freighter_named', 'total_playtime',
    'multitool_named', 'main_story_arc', 'expedition_lore',
]);

// Field kinds:
//   varint  unsigned LEB128
//   addr11  varint holding an 11 hex char system address
//   addr12  same, 12 hex chars (first_system packs the planet index on top)
//   str     varint length then that many UTF-8 bytes
//   name    str (CamelCase-compressed, 16-char capped) + 1 had_no_space byte
//   byte    one raw byte
//   flags1  one byte of arc booleans, bit 0 first
//   flags2  two bytes of arc booleans, bit 0 of the first byte first
//   enum    one byte, small closed set
//   enum2   one byte, two exclusive 0-2 enums packed as value = a*3+b
export const LAYOUT = {
    first_system: [['addr12', 'sysaddress + planet_index'], ['varint', 'start_year']],
    community_phase: [['varint', 'distinct_users']],
    center_journey: [['addr11', 'closest_system'], ['varint', 'blackhole_warps']],
    intergalactic_jump: [['varint', 'to_galaxy']],
    first_naming: [['addr11', 'sysaddress'], ['name', 'system_name'], ['name', 'planet_name']],
    journey_ends: [
        ['varint', 'total_systems'], ['varint', 'total_regions'], ['varint', 'total_galaxies'],
        ['varint', 'total_events'], ['varint', 'active_days'], ['varint', 'total_deaths'],
        ['varint', 'systems_discovered'], ['varint', 'planets_discovered'],
        ['byte', 'dist_fly_class'], ['byte', 'dist_walked_class'], ['varint', 'sentinel_kills'],
    ],
    favorite_base: [['addr11', 'sysaddress'], ['name', 'name'], ['varint', 'bases_built']],
    freighter_named: [
        ['name', 'name'], ['varint', 'frigates'],
        ['varint', 'ships_owned'], ['varint', 'ships_bought'],
    ],
    atlas_encounter: [['addr11', 'sysaddress'], ['varint', 'galaxy'], ['name', 'system_name']],
    purple_systems: [['addr11', 'first_system.sysaddress'], ['varint', 'first_system.galaxy']],
    total_playtime: [['varint', 'seconds']],
    settlements: [['varint', 'total_population'], ['name', 'names[0]'], ['addr11', 'sysaddress']],
    final_session: [['varint', 'events_that_day']],
    first_pet: [
        ['addr11', 'sysaddress'], ['byte', 'creature_id'], ['name', 'name'],
        ['varint', 'pets_owned'], ['varint', 'creatures_fed'], ['varint', 'creatures_discovered'],
    ],
    multitool_named: [['str', 'name'], ['byte', 'is_large | had_no_space']],
    main_story_arc: [
        ['flags1', 'arc flags'], ['enum2', 'epilogue_reached | artemis_choice'],
    ],
    expedition_lore: [
        ['flags2', 'lore flags'],
        ['varint', 'pirates_killed'], ['varint', 'flora_discovered'],
    ],
};

const hex = (b) => b.toString(16).toUpperCase().padStart(2, '0');
const bits = (b) => b.toString(2).padStart(8, '0');

export function hexBytes(slice) {
    return Array.from(slice).map(hex).join(' ');
}

export function bitBytes(slice) {
    return Array.from(slice).map(bits).join(' ');
}

// Own copy of the month math (mirror of seed.js monthIdxToDate), same
// duplication-on-purpose principle as the rest of this file.
function monthIdxToDate(idx) {
    const total = 7 + idx; // epoch = August 2016, 0-indexed month 7
    const y = 2016 + Math.floor(total / 12);
    const mo = (total % 12) + 1;
    const p = (n) => String(n).padStart(2, '0');
    return `${y}-${p(mo)}-15`;
}

// Splits a seed into its envelope parts and returns the payload bytes.
export async function unwrap(seed) {
    const marker = seed.lastIndexOf('tessera~');
    const body = marker === -1 ? seed.trim() : seed.slice(marker + 8).trim();
    const dot = body.lastIndexOf('.');
    const tag = body.slice(dot + 1);
    const b64 = body.slice(0, dot);
    let framed = base64urlDecode(b64);
    const compressed = tag === '1z';
    if (compressed) framed = await inflateRaw(framed);
    const payload = framed.slice(1);
    return {
        b64, tag, compressed, framed, payload,
        crc: framed[0],
        crcValid: crc8Had(payload) === framed[0],
        wireChars: body.length,
    };
}

// Walks the payload and returns one row per field, plus one header row per
// beat. Throws if a field runs past the end, which is what makes a stale
// layout table impossible to miss.
export async function annotateSeed(seed) {
    const env = await unwrap(seed);
    const b = env.payload;
    const rows = [];
    let i = 0;

    const take = (n) => {
        if (i + n > b.length) throw new Error(`layout overruns payload at offset ${i}`);
        const s = b.slice(i, i + n);
        i += n;
        return s;
    };
    const takeVarint = () => {
        const start = i;
        const pos = { i };
        const v = readVarint(b, pos);
        i = pos.i;
        return { value: v, slice: b.slice(start, i), offset: start };
    };

    // Header: one presence bitmask row, then the present types in ascending
    // BEAT_TYPES order (own independent read of the bits, see the BREAKING
    // note at the top of this file).
    const headerOffset = i;
    const headerBytes = take(HEADER_BYTES);
    const presentTypes = [];
    for (let idx = 0; idx < BEAT_TYPES.length; idx++) {
        if (headerBytes[idx >> 3] & (1 << (idx % 8))) presentTypes.push(BEAT_TYPES[idx]);
    }
    rows.push({
        beat: null, kind: 'header', label: 'presence bitmask',
        offset: headerOffset, bytes: headerBytes,
        value: `${presentTypes.length} beats: ${presentTypes.join(', ')}`,
    });

    // The destroy-key commitment: a fixed 15-byte field between the header and
    // the first beat, on every seed. Shown as the hash it is, never decoded
    // into anything - it commits to a random the depositor alone holds.
    const commitmentOffset = i;
    const commitmentBytes = take(COMMITMENT_BYTES);
    rows.push({
        beat: null, kind: 'commit', label: 'destroy-key commitment',
        offset: commitmentOffset, bytes: commitmentBytes,
        value: [...commitmentBytes].map((x) => x.toString(16).padStart(2, '0')).join(''),
    });

    for (const type of presentTypes) {
        // Type is now free (derived from the header bit, no per-beat byte):
        // this row marks where the beat's body starts, zero bytes wide.
        rows.push({
            beat: type, kind: 'type', label: 'beat present (header bit)',
            offset: i, bytes: b.slice(i, i), value: type,
        });

        if (!UNDATED_TYPES.has(type)) {
            const v = takeVarint();
            rows.push({
                beat: type, kind: 'varint', label: 'month index',
                offset: v.offset, bytes: v.slice,
                value: `month ${v.value} -> ${monthIdxToDate(v.value)}`,
            });
        }

        for (const [kind, label] of LAYOUT[type]) {
            if (kind === 'varint' || kind === 'addr11' || kind === 'addr12') {
                const v = takeVarint();
                const width = kind === 'addr12' ? 12 : 11;
                const value = kind === 'varint' ? v.value
                    : v.value.toString(16).toUpperCase().padStart(width, '0');
                rows.push({ beat: type, kind, label, offset: v.offset, bytes: v.slice, value });
            } else if (kind === 'str') {
                const len = takeVarint();
                const raw = take(len.value);
                rows.push({
                    beat: type, kind: 'str', label,
                    offset: len.offset, bytes: b.slice(len.offset, i),
                    value: `${len.value} bytes: "${new TextDecoder().decode(raw)}"`,
                });
            } else if (kind === 'name') {
                const len = takeVarint();
                const raw = take(len.value);
                const flagOff = i;
                const hadNoSpace = !!take(1)[0];
                const packed = new TextDecoder().decode(raw);
                const expanded = packed ? expandName(packed, hadNoSpace) : '';
                rows.push({
                    beat: type, kind: 'name', label,
                    offset: len.offset, bytes: b.slice(len.offset, flagOff + 1),
                    value: `${len.value} bytes, had_no_space=${hadNoSpace ? 1 : 0}: "${expanded}"`,
                });
            } else if (kind === 'byte' || kind === 'enum') {
                const off = i;
                const v = take(1)[0];
                const extra = label === 'creature_id' ? ` (${CREATURE_IDS[v] ?? '?'})` : '';
                rows.push({
                    beat: type, kind, label, offset: off,
                    bytes: b.slice(off, i), value: `${v}${extra}`,
                });
            } else if (kind === 'enum2') {
                // Two exclusive 0-2 enums packed as one byte, value = a*3+b
                // own independent
                // labels, not imported from seed.js, same duplication
                // principle as the rest of this file).
                const off = i;
                const v = take(1)[0];
                const epilogueLabels = [null, 'stay', 'newgal'];
                const artemisLabels = [null, 'dead', 'sim'];
                const epilogue = epilogueLabels[Math.floor(v / 3)] ?? '?';
                const artemis = artemisLabels[v % 3] ?? '?';
                rows.push({
                    beat: type, kind, label, offset: off, bytes: b.slice(off, i),
                    value: `${v}: epilogue_reached=${epilogue}, artemis_choice=${artemis}`,
                });
            } else if (kind === 'flags1' || kind === 'flags2') {
                const n = kind === 'flags1' ? 1 : 2;
                const off = i;
                const slice = take(n);
                let set = 0;
                for (const byte of slice) for (let k = 0; k < 8; k++) if (byte & (1 << k)) set++;
                rows.push({
                    beat: type, kind, label, offset: off, bytes: slice,
                    value: `${set} flags set, bit 0 first`,
                });
            } else {
                throw new Error(`unknown field kind ${kind}`);
            }
        }
    }
    return { env, rows, consumed: i };
}

// Renders the walk as the listing used in docs/seed-format.md.
export function formatAnnotation({ env, rows }, { showBits = true } = {}) {
    const out = [];
    out.push(`envelope   ${env.compressed ? 'deflate-raw' : 'raw'} (.${env.tag}), ` +
        `${env.wireChars} chars on the wire, ${env.payload.length} payload bytes`);
    out.push(`crc8       0x${hex(env.crc)} (${bits(env.crc)}) over "had" + payload, ` +
        `${env.crcValid ? 'valid' : 'INVALID'}`);
    out.push('');
    out.push('off  bytes                    kind           field                        value');
    out.push('---  -----------------------  -------------  ---------------------------  -----');
    let beat = null;
    for (const r of rows) {
        if (r.beat !== beat) {
            beat = r.beat;
            out.push('');
        }
        const raw = hexBytes(r.bytes);
        const shown = raw.length > 23 ? raw.slice(0, 20) + '...' : raw;
        out.push(
            String(r.offset).padStart(3) + '  ' + shown.padEnd(23) + '  ' +
            r.kind.padEnd(13) + '  ' + String(r.label).padEnd(27) + '  ' + r.value);
        if (showBits && r.bytes.length <= 3 && r.kind !== 'byte' && r.kind !== 'enum' && r.kind !== 'enum2') {
            out.push('     ' + bitBytes(r.bytes));
        }
    }
    return out.join('\n');
}
