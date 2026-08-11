// Author: had.sh
// Payload A: geographic data (corpus), server-side enrichment of spatial
// databases. No fact calculation here.
//
// geo-v1 = positional BINARY payload. buildGeoPayload builds the
// data structure (discovery-record systems, blackhole routes); encodeGeoV1 packs
// it into the binary flow (header + 2 sections, varint mirrored from seed.js,
// 6-byte fixed addresses); buildGeoPostBody wraps it (crc8 watermark 'had',
// deflate-raw optional, base64url). The server-side decoder is the EXACT mirror.
//
// No bare addresses: a system enters this payload only through a discovery
// record (DiscoveryManagerData), never merely because the save mentions it
// (visited, based on, teleported through). A bare address is dispensable -
// the server can generate one, procedurally, for any address at all - so
// carrying it bought nothing but a map of where a player has been.
//
// Pseudonym rule: the ONLY field carrying a pseudonym is "credit" (first
// discoverer in-game), length-capped like every other free text field.
// Planet entries are intentionally stripped of their user field AND their own
// discovery date: the server has no use for which day a given planet was
// found, only for the system-level credited date (see creditedDiscovery).
// No procedural region/system names: re-derivable server-side.
// Minimisation, deliberate and load-bearing: the one date a system carries is
// cut to the MONTH (no day, no clock), and no duration is ever carried, so
// nothing here reconstructs a session, a rhythm, or a time of day.

import {
    base64urlEncode, compressionAvailable, deflateRaw, crc8Had,
} from './compress.js';
import { pushVarint } from './seed.js';

const CUTOFF_2018 = Date.UTC(2018, 0, 1) / 1000;

// Wire caps, mirrored by the PHP decoder, which REJECTS a payload exceeding
// them rather than truncating. limits.js already bounds these strings at
// extraction (MAX_NAME_LEN / MAX_USER_LEN, in characters); these are the
// second, harder bound, expressed in the unit the wire actually uses, so a
// tampered client cannot hand the server an unbounded field. The counts are
// bounded for the same reason: a real save is orders of magnitude below them.
export const WIRE_MAX_NAME_BYTES = 64;
export const WIRE_MAX_CREDIT_BYTES = 48;
export const WIRE_MAX_PLANETS = 6;
export const WIRE_MAX_SYSTEMS = 16384;
export const WIRE_MAX_ROUTES = 512;

// Window for inferring blackhole exits: first new system dated within this
// long after entry (FLOW.md: "quelques dizaines de minutes maximum" - the
// jump itself is near-instant in-game, so a wide window mostly invites
// unrelated later activity to be mistaken for the exit).
const EXIT_WINDOW_S = 30 * 60;

// A jump under this many light-years is coordinates that barely moved (only
// the star changed) - FLOW.md: "seule l'étoile change, ce n'est pas un vrai
// saut, le joueur n'a probablement pas plongé dedans". Two systems next door
// to each other, briefly visited one after the other, must not be mistaken
// for a black hole dive.
const MIN_JUMP_LY = 3000;

// 1 voxel = 400 ly, the same constant the server side uses.
const VOXEL_LY = 400;

// Region = the last 8 hex chars of an 11-hex sysaddress -> signed voxel
// coordinates. Mirrors the server-side coordinate decoding exactly.
function regionCoords(sysaddress) {
    const addr = parseInt(sysaddress.slice(3), 16);
    let x = addr & 0xFFF;
    let z = (addr >> 12) & 0xFFF;
    let y = (addr >> 24) & 0xFF;
    if (x > 0x7FF) {
        x -= 0x1000;
    }
    if (z > 0x7FF) {
        z -= 0x1000;
    }
    if (y > 0x7F) {
        y -= 0x100;
    }
    return [x, y, z];
}

// Straight-line distance between two addresses, in light-years. Not distance
// to the galactic centre, which stays server-side - this
// is entry-to-candidate-exit only, to tell a real jump from a next-door
// system visited moments later.
function jumpDistanceLy(addrA, addrB) {
    const [x1, y1, z1] = regionCoords(addrA);
    const [x2, y2, z2] = regionCoords(addrB);
    const dx = x2 - x1;
    const dy = y2 - y1;
    const dz = z2 - z1;
    return Math.sqrt(dx * dx + dy * dy + dz * dz) * VOXEL_LY;
}

// Credited discovery = the oldest event (sources then planets) that carries
// BOTH a pseudonym and a timestamp, i.e. the one event whose date and credit
// are the same fact. `date` is null whenever `user` is: a per-planet
// discovery day with no attached pseudonym is not worth carrying (osef), and
// there is exactly one date on the wire per system, not one per planet.
function creditedDiscovery(system) {
    let best = null; // {timestamp, user, date}
    for (const coll of [system.sources, system.planets]) {
        for (const ev of coll) {
            if (ev.timestamp && ev.user &&
                (best === null || ev.timestamp < best.timestamp)) {
                best = ev;
            }
        }
    }
    return best ? { user: best.user, date: best.date } : { user: null, date: null };
}

// Earliest dated event of each system, ANY user or none. Jump detection is
// decoupled from identity entirely: it is a question of time, not of who is
// credited. Using only a "protagonist" majority-vote here (the previous
// design) meant a community-synced record's original discoverer could
// silently steal the exit slot from the address that actually mattered, and
// an anonymous timestamp (no OWS.USN attached) could never be a candidate at
// all - both wrong, since a real jump doesn't care who is named on either end.
function firstTimestampPerSystem(systems) {
    const firsts = new Map(); // "galaxy|sysaddress" -> earliest ts
    for (const s of systems) {
        for (const coll of [s.sources, s.planets]) {
            for (const e of coll) {
                if (e.timestamp) {
                    const k = s.galaxy + '|' + s.sysaddress;
                    if (!firsts.has(k) || e.timestamp < firsts.get(k)) {
                        firsts.set(k, e.timestamp);
                    }
                }
            }
        }
    }
    return firsts;
}

// Direct port of blackhole_route construction from 01-extract.py:
// systems 079xxxxxxxx, first valid date >= 2018-01-01, chronologically sorted,
// dedup by sysaddress. Addition: exit_candidate, temporal inference of exit
// (first new, non-079 system dated within EXIT_WINDOW_S after entry, same
// galaxy, ANY user or none - see firstTimestampPerSystem). Candidate only:
// final decision (geometry, progress to center) remains server-side.
//
// A route with NO exit candidate is dropped entirely: its entry system is
// already carried in `systems` (every 079xxx entry is a discovery record in
// its own right, with the same name/credit/date), so without a paired exit
// this section would only repeat it. The pairing is the only new information
// a route adds, so a route with nothing to pair is not written.
export function buildBlackholeRoutes(systems) {
    // For looking up the exit's own name/credit/date: a black hole never
    // changes galaxy (FLOW.md), so the search above already only matches
    // within the entry's own galaxy - exit_candidate carries no galaxy field,
    // it is always route.galaxy.
    const byKey = new Map(systems.map((s) => [s.galaxy + '|' + s.sysaddress, s]));

    const byTs = [];
    for (const s of systems) {
        if (!s.sysaddress.startsWith('079')) {
            continue;
        }
        const tsValid = s.sources.map((x) => x.timestamp).filter(Boolean);
        if (!tsValid.length) {
            continue;
        }
        const minTs = Math.min(...tsValid);
        if (minTs >= CUTOFF_2018) {
            byTs.push([minTs, s]);
        }
    }
    byTs.sort((a, b) => a[0] - b[0]);

    // Earliest dated event of every system, any user or none - the search
    // pool for exits, decoupled from identity (see firstTimestampPerSystem).
    const firsts = firstTimestampPerSystem(systems);
    const firstList = [...firsts.entries()]
        .map(([k, ts]) => {
            const [galaxy, sysaddress] = k.split('|');
            return { ts, galaxy: Number(galaxy), sysaddress };
        })
        .sort((a, b) => a.ts - b.ts);

    const visited = new Set();
    const route = [];
    for (const [ts, s] of byTs) {
        if (visited.has(s.sysaddress)) {
            continue;
        }
        visited.add(s.sysaddress);
        let exit = null;
        for (const f of firstList) {
            if (f.ts <= ts || f.galaxy !== s.galaxy || f.sysaddress === s.sysaddress) {
                continue;
            }
            if (f.ts > ts + EXIT_WINDOW_S) {
                break;
            }
            // FLOW.md guard-rail: a black hole followed by another black hole
            // is exploration, not a dive - keep looking within the window
            // instead of taking it as the exit.
            if (f.sysaddress.startsWith('079')) {
                continue;
            }
            // FLOW.md guard-rail: barely moved (only the star changed) is not
            // a dive either - keep looking within the window.
            if (jumpDistanceLy(s.sysaddress, f.sysaddress) < MIN_JUMP_LY) {
                continue;
            }
            // The gap itself is never carried: how many minutes it actually
            // took is player behaviour, not geography. The server certifies
            // the jump on geometry (progress toward the centre), never on
            // timing.
            //
            // The exit gets the SAME treatment as the entry: name if there is
            // one, credit+date only together, looked up on whatever discovery
            // record exists for that address (may be none at all - the exit
            // can be just as anonymous as the entry).
            const exitSystem = byKey.get(f.galaxy + '|' + f.sysaddress);
            const exitCredited = exitSystem ? creditedDiscovery(exitSystem) : { user: null, date: null };
            exit = {
                sysaddress: f.sysaddress,
                name: exitSystem ? exitSystem.name : null,
                credit: exitCredited.user,
                date: exitCredited.date,
            };
            break;
        }
        // No pairing, no route (see the note above the function).
        if (exit === null) {
            continue;
        }
        // `ts` (any valid source timestamp, no user required) only decided
        // entry ordering and the exit search above, same as the Python port,
        // and is not carried further. What travels on the wire is the
        // credited pair instead, same rule as a system: a name if there is
        // one, and credit+date only together.
        const { user: credit, date } = creditedDiscovery(s);
        route.push({
            sysaddress: s.sysaddress,
            galaxy: s.galaxy,
            name: s.name,
            credit,
            date,
            exit_candidate: exit,
        });
    }
    return route;
}

// --- geo-v1 binary encoder (positional, mirror of the server-side decoder) --------
//
// Field kinds:
//   a = address : 6 fixed little-endian bytes = parseInt(sysaddress, 16)
//                 (11 hex = 44 bits, fits 6 bytes). NO varint, NO delta.
//   n = number  : varint (pushVarint from seed.js).
//   s = string  : varint(byte length UTF-8) + UTF-8 bytes.

function pushAddr6(out, sysaddress) {
    // 11-hex address -> 6 fixed little-endian bytes. parseInt loses precision
    // above 2^53, but 44 bits is safe; BigInt keeps it exact and future-proof.
    let n = BigInt('0x' + sysaddress);
    for (let i = 0; i < 6; i++) {
        out.push(Number(n & 0xFFn));
        n >>= 8n;
    }
}

// Cuts UTF-8 bytes at maxBytes without splitting a code point: back off while
// the first dropped byte is a continuation byte (10xxxxxx).
function truncateUtf8(bytes, maxBytes) {
    let end = maxBytes;
    while (end > 0 && (bytes[end] & 0xC0) === 0x80) {
        end--;
    }
    return bytes.subarray(0, end);
}

function pushString(out, str, maxBytes) {
    let bytes = new TextEncoder().encode(str ?? '');
    if (bytes.length > maxBytes) {
        bytes = truncateUtf8(bytes, maxBytes);
    }
    pushVarint(out, bytes.length);
    for (const b of bytes) out.push(b);
}

// Caps a string to maxBytes UTF-8 bytes, called from buildGeoPayload so the
// cap applies to the payload OBJECT itself - what the readable-JSON download
// shows, what the log's byte counts are computed from - not just to the wire
// bytes 100 lines away in encodeGeoV1. Null stays null. pushString above
// keeps its own truncation too, as a second, independent bound at the point
// the bytes actually leave the machine.
function capUtf8Bytes(str, maxBytes) {
    if (str === null || str === undefined) {
        return null;
    }
    const bytes = new TextEncoder().encode(str);
    if (bytes.length <= maxBytes) {
        return str;
    }
    return new TextDecoder().decode(truncateUtf8(bytes, maxBytes));
}

// month = whole months since the NMS release month (2016-08 = 0), varint.
// Day of month, hours, minutes and seconds are ALL dropped, and dropped at
// buildGeoPayload time (see capToMonth below), not merely at wire-encoding:
// the readable JSON already shows "2016-08", never the source's
// "2016-08-13 22:10:30" - same "cap at the source, not 100 lines later"
// discipline as capUtf8Bytes.
const EPOCH_YEAR = 2016;
const EPOCH_MONTH = 8; // August, 1-indexed
function monthFromDate(dateStr) {
    const m = String(dateStr ?? '').match(/(\d{4})-(\d{2})/);
    if (!m) {
        return 0;
    }
    return Math.max(0, (Number(m[1]) - EPOCH_YEAR) * 12 + (Number(m[2]) - EPOCH_MONTH));
}

// Cuts a date string down to "YYYY-MM", null if unparseable. Called from
// buildGeoPayload so the payload OBJECT already carries only what the wire
// carries - day, hour, minute, second never survive past this point.
function capToMonth(dateStr) {
    const m = String(dateStr ?? '').match(/(\d{4})-(\d{2})/);
    return m ? `${m[1]}-${m[2]}` : null;
}

// Packs the geo structure into the geo-v1 binary flow. Dominant galaxy is
// carried once in the header (galaxy-exception rule): a system in that galaxy
// pays a 0 in its galaxy slot instead of a galaxy varint.
export function encodeGeoV1(geo) {
    const out = [];
    const systems = geo.systems.slice(0, WIRE_MAX_SYSTEMS);
    const routes = geo.blackhole_routes.slice(0, WIRE_MAX_ROUTES);

    // Dominant galaxy = the most frequent one (usually 0 = Euclid).
    const galaxyCounts = new Map();
    for (const s of systems) {
        galaxyCounts.set(s.galaxy, (galaxyCounts.get(s.galaxy) ?? 0) + 1);
    }
    let defaultGalaxy = 0;
    let best = -1;
    for (const [g, n] of galaxyCounts) {
        if (n > best) {
            best = n;
            defaultGalaxy = g;
        }
    }

    // Header.
    pushVarint(out, defaultGalaxy);
    pushVarint(out, systems.length);
    pushVarint(out, routes.length);

    // systems section: positional per entry.
    for (const s of systems) {
        pushAddr6(out, s.sysaddress);
        // galaxy_flag: 0 = default_galaxy, else the galaxy varint follows.
        if (s.galaxy === defaultGalaxy) {
            pushVarint(out, 0);
        } else {
            pushVarint(out, s.galaxy);
        }
        pushString(out, s.name ?? '', WIRE_MAX_NAME_BYTES);
        pushString(out, s.credit ?? '', WIRE_MAX_CREDIT_BYTES);
        // The month follows the credit ONLY when a credit exists: the two
        // come from the SAME event (creditedDiscovery), so their presence is
        // the same fact, never encoded twice. No date at all otherwise - a
        // timestamp with no attached pseudonym is not worth a byte.
        if (s.credit) {
            pushVarint(out, monthFromDate(s.date));
        }
        // Planets carry a NAME only: which day a given planet was discovered
        // is not information the server wants (osef), only the count and the
        // baptised names matter.
        const planets = s.planets.slice(0, WIRE_MAX_PLANETS);
        pushVarint(out, planets.length);
        for (const p of planets) {
            pushString(out, p.name ?? '', WIRE_MAX_NAME_BYTES);
        }
    }

    // blackhole_routes section: same name/credit/date rule as a system, on
    // BOTH ends - a name if there is one, and credit+date only together (see
    // systems above). No has_exit_candidate flag: buildBlackholeRoutes never
    // emits a route without one (see the note on that function), so the exit
    // is always here. No galaxy on the exit either: a black hole never
    // changes galaxy (FLOW.md), so it is always route.galaxy - writing either
    // a flag that is always 1 or a galaxy that is always the same one would
    // just be wasted bytes.
    for (const r of routes) {
        pushAddr6(out, r.sysaddress);
        pushVarint(out, r.galaxy === defaultGalaxy ? 0 : r.galaxy);
        pushString(out, r.name ?? '', WIRE_MAX_NAME_BYTES);
        pushString(out, r.credit ?? '', WIRE_MAX_CREDIT_BYTES);
        if (r.credit) {
            pushVarint(out, monthFromDate(r.date));
        }
        const exit = r.exit_candidate;
        pushAddr6(out, exit.sysaddress);
        pushString(out, exit.name ?? '', WIRE_MAX_NAME_BYTES);
        pushString(out, exit.credit ?? '', WIRE_MAX_CREDIT_BYTES);
        if (exit.credit) {
            pushVarint(out, monthFromDate(exit.date));
        }
    }

    return new Uint8Array(out);
}

// Body of the POST to the server: geo-v1 binary payload, prefixed by a 1-byte
// crc8 watermark (crc8('had' + payload)), optionally deflate-raw compressed,
// then base64url encoded in `data`. `_comment` is a readable, purely decorative
// first key (the server ignores it). Fallback encoding "b64url" (binary, no
// deflate) when CompressionStream is absent: the positional format is already
// compact, no fat JSON fallback.
export async function buildGeoPostBody(geo) {
    const comment =
        'Public NMS geographical data, as visible to any player in-game. ' +
        'Pseudonymous, not anonymous: each system carries the first ' +
        "discoverer's in-game username (credit, which may not be the " +
        "depositor's), public information anyone can read by visiting. No " +
        'other personal data, and no address the save merely visited: only ' +
        'in-game discovery records. Discovery dates are cut to the month, ' +
        'every free text field is length-capped. Positional binary (geo-v1), ' +
        'deflate-raw + base64url in data.';
    const payload = encodeGeoV1(geo);
    // crc8 watermark byte prefixed to the payload, then the whole thing is
    // (optionally) deflated and base64url-encoded.
    const framed = new Uint8Array(payload.length + 1);
    framed[0] = crc8Had(payload);
    framed.set(payload, 1);

    if (compressionAvailable()) {
        const packed = await deflateRaw(framed);
        return {
            _comment: comment,
            schema: 'geo-v1',
            encoding: 'deflate-raw+base64url',
            data: base64urlEncode(packed),
        };
    }
    return {
        _comment: comment + ' (fallback: compression unavailable, raw binary)',
        schema: 'geo-v1',
        encoding: 'b64url',
        data: base64urlEncode(framed),
    };
}

// Payload A carries every DISCOVERY RECORD the save transports (Array.isArray
// (s.sources) systems, from DiscoveryManagerData), and nothing else. A record
// is not necessarily the depositor's own: a community-synchronized save
// carries other players' discoveries too, dated to their original discovery,
// which is exactly what makes `credit` sometimes name a third party rather
// than the depositor. `date` is the ONE date this format carries per system:
// the day of the credited discovery (see creditedDiscovery), never a
// per-planet date, which the server has no use for.
// Blackhole routes are inferred from the same set (they need timestamps),
// and BEFORE the empty-system filter below: a route's own value is the
// entry-exit pairing, independent of whether its entry also clears that bar.
//
// Every wire cap (WIRE_MAX_*) is applied HERE, not only in encodeGeoV1: the
// object this function returns is what the readable-JSON download shows and
// what the pipeline logs byte counts from, so it has to already be the
// truncated/capped data, not a promise that gets kept 100 lines later.
export function buildGeoPayload(systems) {
    const capName = (s) => capUtf8Bytes(s, WIRE_MAX_NAME_BYTES);
    const capCredit = (s) => capUtf8Bytes(s, WIRE_MAX_CREDIT_BYTES);

    const mapped = systems.map((s) => {
        const { user, date } = creditedDiscovery(s);
        return {
            galaxy: s.galaxy,
            sysaddress: s.sysaddress,
            name: capName(s.name),
            planets: s.planets.slice(0, WIRE_MAX_PLANETS).map((p) => ({ name: capName(p.name) })),
            credit: capCredit(user),
            date: capToMonth(date),
        };
    });
    // A system with no name, no credit and no planet is worth nothing beyond
    // its address - an anonymous, undocumented discovery record is bare-address
    // noise wearing a discovery record's shape, and it is excluded here.
    // Dropped here, not upstream: it may still anchor a blackhole route below.
    const keptSystems = mapped
        .filter((s) => s.name !== null || s.credit !== null || s.planets.length > 0)
        .slice(0, WIRE_MAX_SYSTEMS);

    const routes = buildBlackholeRoutes(systems)
        .slice(0, WIRE_MAX_ROUTES)
        .map((r) => ({
            ...r,
            name: capName(r.name),
            credit: capCredit(r.credit),
            date: capToMonth(r.date),
            exit_candidate: {
                sysaddress: r.exit_candidate.sysaddress,
                name: capName(r.exit_candidate.name),
                credit: capCredit(r.exit_candidate.credit),
                date: capToMonth(r.exit_candidate.date),
            },
        }));

    return {
        schema: 'geo-v1',
        systems: keptSystems,
        blackhole_routes: routes,
    };
}
