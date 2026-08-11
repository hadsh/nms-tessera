// Author: had.sh
// Byte-by-byte reader for a geo-v1 payload, the thing the send button posts.
//
// Same discipline as tools/annotate.js: this is the only reader of the format
// on the JavaScript side, so it carries its own
// copy of the layout and test/selftest.js replays it against a payload it
// encoded itself, field by field. A layout that drifts fails a check instead of
// producing a wrong document.

import { base64urlDecode, inflateRaw, crc8Had } from '../lib/compress.js';
import { readVarint } from '../lib/seed.js';

const hex = (b) => b.toString(16).toUpperCase().padStart(2, '0');

// Month 0 is the game's release month, August 2016. There is no day to show:
// the encoder never sent one.
function monthToDate(month) {
    const total = 2016 * 12 + 7 + month;
    return `${Math.floor(total / 12)}-${String(total % 12 + 1).padStart(2, '0')}`;
}

// Accepts the POST body as JSON text, the bare base64url data string, or the
// already decoded bytes. Returns the framed payload plus envelope facts.
export async function unwrapGeo(input) {
    let data = null;
    let encoding = null;
    if (input instanceof Uint8Array) {
        return { framed: input, payload: input.slice(1), crc: input[0],
            crcValid: crc8Had(input.slice(1)) === input[0], encoding: 'raw bytes',
            wireChars: null, schema: null, comment: null };
    }
    const text = String(input).trim();
    if (text.startsWith('{')) {
        const body = JSON.parse(text);
        data = body.data;
        encoding = body.encoding;
        var schema = body.schema ?? null;
        var comment = body._comment ?? null;
    } else {
        data = text;
        encoding = 'deflate-raw+base64url';
    }
    let framed = base64urlDecode(data);
    if (encoding === 'deflate-raw+base64url') framed = await inflateRaw(framed);
    const payload = framed.slice(1);
    return {
        framed, payload, crc: framed[0], crcValid: crc8Had(payload) === framed[0],
        encoding, wireChars: data.length,
        schema: typeof schema === 'undefined' ? null : schema,
        comment: typeof comment === 'undefined' ? null : comment,
    };
}

// Walks the payload and returns one row per field. Throws if the layout runs
// past the end, which is the tripwire for a stale table.
export async function annotateGeo(input) {
    const env = await unwrapGeo(input);
    const b = env.payload;
    const rows = [];
    let i = 0;

    const take = (n) => {
        if (i + n > b.length) throw new Error(`layout overruns payload at offset ${i}`);
        const s = b.slice(i, i + n);
        i += n;
        return s;
    };
    const row = (section, kind, label, offset, bytes, value) =>
        rows.push({ section, kind, label, offset, bytes, value });
    const varint = (section, label) => {
        const off = i;
        const pos = { i };
        const v = readVarint(b, pos);
        i = pos.i;
        row(section, 'varint', label, off, b.slice(off, i), v);
        return v;
    };
    // 6 fixed little-endian bytes, never a varint: the decoder can seek.
    const addr6 = (section, label) => {
        const off = i;
        const s = take(6);
        let n = 0n;
        for (let k = 5; k >= 0; k--) n = (n << 8n) | BigInt(s[k]);
        const hexAddr = n.toString(16).toUpperCase().padStart(11, '0');
        row(section, 'addr6', label, off, s, hexAddr);
        return hexAddr;
    };
    const str = (section, label) => {
        const off = i;
        const pos = { i };
        const len = readVarint(b, pos);
        i = pos.i;
        const raw = take(len);
        const text = new TextDecoder().decode(raw);
        row(section, 'str', label, off, b.slice(off, i),
            len ? `${len} bytes: "${text}"` : 'empty');
        return text;
    };
    // Present only when the credit just read was non-empty (same event,
    // same fact, mirror of geo.js encodeGeoV1's `if (credit)`).
    const monthIfCredited = (section, label, credit) => {
        if (!credit) return null;
        const off = i;
        const pos = { i };
        const v = readVarint(b, pos);
        i = pos.i;
        row(section, 'varint', label, off, b.slice(off, i), `${v} -> ${monthToDate(v)}`);
        return v;
    };

    const parsed = { systems: [], routes: [] };

    const defaultGalaxy = varint('header', 'default_galaxy');
    const nSystems = varint('header', 'n_systems');
    const nRoutes = varint('header', 'n_blackhole_routes');

    for (let k = 0; k < nSystems; k++) {
        const sysaddress = addr6('systems', `[${k}] sysaddress`);
        const flag = varint('systems', `[${k}] galaxy (0 = default)`);
        const name = str('systems', `[${k}] name`);
        const credit = str('systems', `[${k}] credit`);
        const month = monthIfCredited('systems', `[${k}] credited month`, credit);
        const nPlanets = varint('systems', `[${k}] n_planets`);
        const planets = [];
        for (let p = 0; p < nPlanets; p++) {
            const pname = str('systems', `[${k}].planet[${p}] name`);
            planets.push({ name: pname });
        }
        parsed.systems.push({
            sysaddress, galaxy: flag === 0 ? defaultGalaxy : flag,
            name, credit, month, planets,
        });
    }

    for (let k = 0; k < nRoutes; k++) {
        const sysaddress = addr6('routes', `[${k}] entry sysaddress`);
        const flag = varint('routes', `[${k}] galaxy (0 = default)`);
        const name = str('routes', `[${k}] entry name`);
        const credit = str('routes', `[${k}] entry credit`);
        const month = monthIfCredited('routes', `[${k}] entry credited month`, credit);
        // No galaxy on the exit: a black hole never changes galaxy, it is
        // always the route's own. No has_exit_candidate flag either: the
        // encoder never emits a route without one.
        const exitAddr = addr6('routes', `[${k}] exit sysaddress`);
        const exitName = str('routes', `[${k}] exit name`);
        const exitCredit = str('routes', `[${k}] exit credit`);
        const exitMonth = monthIfCredited('routes', `[${k}] exit credited month`, exitCredit);
        parsed.routes.push({
            sysaddress, galaxy: flag === 0 ? defaultGalaxy : flag, name, credit, month,
            exit: { sysaddress: exitAddr, name: exitName, credit: exitCredit, month: exitMonth },
        });
    }

    return { env, rows, consumed: i, parsed, defaultGalaxy, counts: {
        systems: nSystems, routes: nRoutes } };
}

export function formatGeoAnnotation({ env, rows, counts }, { maxRows = 0 } = {}) {
    const out = [];
    out.push(`schema     ${env.schema ?? 'geo-v1'}, encoding ${env.encoding}` +
        (env.wireChars ? `, ${env.wireChars} chars in data` : ''));
    out.push(`payload    ${env.payload.length} bytes: ${counts.systems} systems, ` +
        `${counts.routes} routes`);
    out.push(`crc8       0x${hex(env.crc)} over "had" + payload, ` +
        `${env.crcValid ? 'valid' : 'INVALID'}`);
    out.push('');
    out.push('off  bytes                    kind    section   field                          value');
    out.push('---  -----------------------  ------  --------  -----------------------------  -----');
    let section = null;
    let shown = 0;
    for (const r of rows) {
        if (maxRows && shown >= maxRows) {
            out.push(`...  (${rows.length - shown} more rows, use --full)`);
            break;
        }
        if (r.section !== section) {
            section = r.section;
            out.push('');
        }
        const raw = Array.from(r.bytes).map(hex).join(' ');
        const cell = raw.length > 23 ? raw.slice(0, 20) + '...' : raw;
        out.push(String(r.offset).padStart(3) + '  ' + cell.padEnd(23) + '  ' +
            r.kind.padEnd(6) + '  ' + r.section.padEnd(8) + '  ' +
            String(r.label).padEnd(29) + '  ' + r.value);
        shown++;
    }
    return out.join('\n');
}
