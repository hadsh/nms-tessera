// Author: had.sh
//  
//   - no disk scan: receives a list of {name, bytes} (File API on
//     browser, GLib on gjs harness);
//   - no Xbox containers.index support (out of scope for web prototype);
//   - all UA -> sysaddress calculation goes through BigInt: native JS
//     bitwise operators are limited to 32-bit signed while UA
//     occupies ~52 bits, naive porting would silently produce wrong addresses.

import { hasMagic, decodeChunks } from './lz4-block.js';
import {
    MAX_SAVE_BYTES, MAX_JSON_DEPTH, MAX_RECORDS, MAX_SYSTEMS,
    MAX_NAME_LEN, MAX_USER_LEN, MAX_UA_HEX_LEN, sanitizeString, sanitizeTs,
    boundedArray,
} from './limits.js';

// Re-export for UI: detect format before loading mapping.
export { hasMagic as hasLz4Magic };

// No Man's Sky release (August 9, 2016, UTC). No discovery can be
// earlier: an OWS.TS older than this is invalid, not an old date.
export const NMS_RELEASE_TS = Date.UTC(2016, 7, 9) / 1000;

export function buildMapping(mappingJson) {
    // Object.create(null): a raw save key that happens to spell an
    // Object.prototype member ("__proto__", "constructor", "toString", ...)
    // must miss this lookup, not silently resolve to that inherited member.
    const m = Object.create(null);
    for (const e of mappingJson.Mapping) {
        m[e.Key] = e.Value;
    }
    return m;
}

export function deobfuscate(obj, mapping, depth = 0) {
    // Depth bound (anti stack-overflow on pathological JSON):
    // a real NMS save caps around ~25 levels.
    if (depth > MAX_JSON_DEPTH) {
        throw new Error('unrecognized format: abnormally deep JSON, not an NMS save');
    }
    if (Array.isArray(obj)) {
        return obj.map((v) => deobfuscate(v, mapping, depth + 1));
    }
    if (obj !== null && typeof obj === 'object') {
        // Object.create(null): same reasoning as buildMapping, on the other
        // end. A raw key literally named "__proto__" is data here, never the
        // prototype setter - a null-prototype target has no such setter to
        // trigger, so the assignment below is always a plain own property.
        const out = Object.create(null);
        for (const [k, v] of Object.entries(obj)) {
            out[mapping[k] ?? k] = deobfuscate(v, mapping, depth + 1);
        }
        return out;
    }
    return obj;
}

// Mirrors NMSE's RegisterContextTransforms (IO/SaveFileManager.cs): a modern
// save root can carry both BaseContext (normal play) and ExpeditionContext
// (an Expedition/Season save) side by side, with ActiveContext naming which
// one the game is currently in. Prefer ExpeditionContext when ActiveContext
// is "Season", or when ExpeditionContext exists and BaseContext does not;
// otherwise BaseContext; otherwise the root itself (2016 legacy saves keep
// PlayerStateData unnested).
export function resolvePlayerStateData(d) {
    const expeditionPs = d?.ExpeditionContext?.PlayerStateData;
    const basePs = d?.BaseContext?.PlayerStateData;
    if (expeditionPs != null && (basePs == null || d?.ActiveContext === 'Season')) {
        return { ps: expeditionPs, expedition: true };
    }
    if (basePs != null) {
        return { ps: basePs, expedition: false };
    }
    return { ps: d?.PlayerStateData ?? null, expedition: false };
}

//   system_id = (portal_code >> 32) & 0xFFF
//   UA = ((system_id << 8) | galaxy) << 32 | (portal_code & 0xFFFFFFFF)
export function uaToSysaddress(ua) {
    let val;
    if (typeof ua === 'string') {
        // Like int(ua, 16) in Python: a UA string is ALWAYS hex,
        // even if it only contains decimal digits.
        const s = ua.startsWith('0x') || ua.startsWith('0X') ? ua.slice(2) : ua;
        if (s.length > MAX_UA_HEX_LEN || !/^[0-9a-fA-F]+$/.test(s)) {
            throw new Error('Invalid hex UA: ' + ua.slice(0, MAX_UA_HEX_LEN));
        }
        val = BigInt('0x' + s);
    } else if (typeof ua === 'number') {
        // UAs exceed 2^32 but stay < 2^53: Number is exact here.
        val = BigInt(Math.trunc(ua));
    } else {
        val = BigInt(ua);
    }
    const low32 = val & 0xFFFFFFFFn;
    const galaxy = Number((val >> 32n) & 0xFFn);
    const systemId = (val >> 40n) & 0xFFFn;
    const portalCode = (systemId << 32n) | low32;
    const addr = portalCode.toString(16).toUpperCase().padStart(11, '0');
    return { sysaddress: addr, galaxy };
}

// Parse a UA (hex string or number) to a BigInt. Shared by both decoders.
function uaToBigInt(ua) {
    if (typeof ua === 'string') {
        const s = ua.startsWith('0x') || ua.startsWith('0X') ? ua.slice(2) : ua;
        if (s.length > MAX_UA_HEX_LEN || !/^[0-9a-fA-F]+$/.test(s)) {
            throw new Error('Invalid hex UA: ' + ua.slice(0, MAX_UA_HEX_LEN));
        }
        return BigInt('0x' + s);
    }
    if (typeof ua === 'number') {
        return BigInt(Math.trunc(ua));
    }
    return BigInt(ua);
}

// Second scalar UA layout, distinct from uaToSysaddress (portal). Used by
// VisitedSystems[], whose entries are voxel-packed (NOT the portal layout):
//   bits  0-11 : VoxelX     bits 12-23 : VoxelZ    bits 24-31 : VoxelY
//   bits 32-43 : SolarSystemIndex (12 bits)        bits 52-59 : RealityIndex (galaxy)
// Applying uaToSysaddress (portal) here reads the low byte of the SSI as a
// galaxy and truncates the SSI to 8 bits: it produced phantom galaxies (a same
// address landing in 17 galaxies). Verified on 3 saves: VisitedSystems is
// always Euclid (galaxy 0). Same region packing (y|z|x) as voxelToSysaddress.
export function scalarVoxelUaToSysaddress(ua) {
    const val = uaToBigInt(ua);
    const x = Number(val & 0xFFFn);
    const z = Number((val >> 12n) & 0xFFFn);
    const y = Number((val >> 24n) & 0xFFn);
    const ssi = Number((val >> 32n) & 0xFFFn);
    const galaxy = Number((val >> 52n) & 0xFFn);
    const region = (y * 0x1000000) + (z * 0x1000) + x;
    const addr = ssi.toString(16).toUpperCase().padStart(3, '0') +
        region.toString(16).toUpperCase().padStart(8, '0');
    return { sysaddress: addr, galaxy };
}

// Structural coherence check for a decoded system. An NMS address, whatever the
// integer layout it came from, ALWAYS resolves to the same physical bounds:
// signed voxels X/Z in [-2048, 2047] (12-bit two's complement, offset 0x7FF),
// Y in [-128, 127] (8-bit, offset 0x7F), galaxy 0-255, SSI a plausible system
// index (1-1200; measured max 1065 on dated systems, 0 = no system). A wrong
// layout violates one of these barriers. Used to pick the right decoder per
// source and as a guard-rail against future format drift.
export function isCoherentSysaddress(sysaddress, galaxy) {
    if (!Number.isInteger(galaxy) || galaxy < 0 || galaxy > 255) {
        return false;
    }
    if (!/^[0-9A-Fa-f]{11}$/.test(sysaddress)) {
        return false;
    }
    const ssi = parseInt(sysaddress.slice(0, 3), 16);
    if (ssi < 1 || ssi > 1200) {
        return false;
    }
    const a = parseInt(sysaddress.slice(3), 16);
    let x = a & 0xFFF, z = (a >> 12) & 0xFFF, y = (a >> 24) & 0xFF;
    if (x > 0x7FF) x -= 0x1000;
    if (z > 0x7FF) z -= 0x1000;
    if (y > 0x7F) y -= 0x100;
    return x >= -2048 && x <= 2047 && z >= -2048 && z <= 2047 &&
        y >= -128 && y <= 127;
}

// Decode a scalar UA using a preferred layout, falling back to the other if the
// preferred result is not a coherent NMS address. The source dictates the
// a-priori (VisitedSystems = voxel, discoveries/interactions = portal); the
// coherence check is the guard-rail that catches drift and disambiguates. When
// BOTH decoders are coherent (a small address can be geometrically valid in
// either) they resolve to DIFFERENT systems, so the source a-priori is what
// keeps us correct, not the geometry: we trust the preferred layout.
export function decodeScalarUa(ua, prefer) {
    const primary = prefer === 'voxel' ? scalarVoxelUaToSysaddress : uaToSysaddress;
    const secondary = prefer === 'voxel' ? uaToSysaddress : scalarVoxelUaToSysaddress;
    const a = primary(ua);
    if (isCoherentSysaddress(a.sysaddress, a.galaxy)) {
        return a;
    }
    const b = secondary(ua);
    if (isCoherentSysaddress(b.sysaddress, b.galaxy)) {
        return b;
    }
    return null; // neither layout yields a valid NMS system: drop this entry
}

export function isoUtc(ts) {
    return new Date(ts * 1000).toISOString().slice(0, 19).replace('T', ' ');
}

// GalacticAddress voxel (PlayerStateData) -> 11-char sysaddress.
// Region hex = y(8b) | z(12b) | x(12b) in two's complement, prefixed by
// SolarSystemIndex on 3 chars. Consistent with uaToSysaddress: verified by
// roundtrip on UniverseAddress (VoxelX=1199 VoxelY=-3 VoxelZ=-1101 SSI=171)
// and by cradle match on saves where birth is catalogued.
export function voxelToSysaddress(ga) {
    const x = ga.VoxelX & 0xFFF;
    const z = ga.VoxelZ & 0xFFF;
    const y = ga.VoxelY & 0xFF;
    const region = (y * 0x1000000) + (z * 0x1000) + x;
    const ssi = ga.SolarSystemIndex ?? 0;
    return ssi.toString(16).toUpperCase().padStart(3, '0') +
        region.toString(16).toUpperCase().padStart(8, '0');
}

// Birth location and current position from PlayerStateData.
// GameStartAddress1 = character's awakening planet: THE reliable field 100% of the time,
// present in both formats (2016 plaintext and recent obfuscated). Validated
// on 16 saves: the cradle heuristic (oldest TS region) is only correct 9 out of 16 times,
// and the home system may be completely absent from discoveries (born on a planet
// already discovered by a third party).
export function extractPlayerState(d, base) {
    const { ps } = resolvePlayerStateData(d);
    if (!ps) {
        return null;
    }
    const addr = (ua) => {
        const ga = ua?.GalacticAddress;
        // Strict types and bounds: numeric voxels, galaxy 0-255,
        // planet index 0-15. Out of bounds = field ignored, no heroics.
        if (!ga || typeof ga.VoxelX !== 'number' || typeof ga.VoxelY !== 'number' ||
            typeof ga.VoxelZ !== 'number' || typeof (ga.SolarSystemIndex ?? 0) !== 'number') {
            return null;
        }
        const galaxy = ua.RealityIndex ?? 0;
        const planet = ga.PlanetIndex ?? 0;
        if (typeof galaxy !== 'number' || galaxy < 0 || galaxy > 255 ||
            typeof planet !== 'number' || planet < 0 || planet > 15) {
            return null;
        }
        return {
            sysaddress: voxelToSysaddress(ga),
            galaxy,
            planet_index: planet,
        };
    };
    // Certified trajectory, independent of discovery records: visited
    // stations/bases (TeleportEndpoints, ordered) and built bases. Used for
    // story graph. GDPR: we NEVER extract Owner / LastEditedById / LastEditedByUsername
    // from bases.
    const teleports = boundedArray(ps.TeleportEndpoints)
        .map((t) => {
            const a = addr(t.UniverseAddress);
            return a ? { name: sanitizeString(t.Name, MAX_NAME_LEN), type: sanitizeString(t.TeleporterType, 64), ...a } : null;
        })
        .filter(Boolean);
    const bases = boundedArray(ps.PersistentPlayerBases)
        .map((b) => {
            // Base GalacticAddress = full UA, with planet index in
            // bits 52+ (recent hex string "0x...", number in 2016).
            let sys;
            try {
                sys = uaToSysaddress(b.GalacticAddress);
            } catch {
                return null;
            }
            let val;
            try {
                val = typeof b.GalacticAddress === 'string'
                    ? BigInt(b.GalacticAddress.startsWith('0x') ? b.GalacticAddress : '0x' + b.GalacticAddress)
                    : BigInt(Math.trunc(b.GalacticAddress));
            } catch {
                val = 0n;
            }
            return {
                name: sanitizeString(b.Name, MAX_NAME_LEN),
                base_type: sanitizeString(b.BaseType?.PersistentBaseTypes, 64),
                sysaddress: sys.sysaddress,
                galaxy: sys.galaxy,
                planet_index: Number((val >> 52n) & 0xFn),
                // Note: LAST edit date, not creation.
                last_update: sanitizeTs(b.LastUpdateTimestamp),
            };
        })
        .filter(Boolean);
    // ShipOwnership is a fixed-size slot array (commonly 12): unused slots
    // carry an empty Resource.Filename, so a slot count alone overcounts.
    // Only Filename tells owned vs empty (verified against a real save:
    // even unnamed slots keep every other key, Name alone can't tell).
    const shipsOwned = boundedArray(ps.ShipOwnership)
        .filter((s) => !!s?.Resource?.Filename).length;
    return {
        save: base,
        birth: addr(ps.GameStartAddress1),
        // GameStartAddress2 semantics unconfirmed (same voxel, different
        // system; probably first jump destination): exposed raw, without
        // interpretation.
        start2: addr(ps.GameStartAddress2),
        current: addr(ps.UniverseAddress),
        teleports,
        bases,
        ships_owned: shipsOwned,
        milestones: extractMilestones(ps),
        // Total played time (seconds), from CommonStateData at the save root.
        // A reliable global stat (your own clock), unrelated to discoveries.
        play_time_seconds: (() => {
            const t = d?.CommonStateData?.TotalPlayTime;
            return typeof t === 'number' && t > 0 && t < 1e9 ? Math.trunc(t) : null;
        })(),
    };
}

// Stats[].GroupId == '^GLOBAL_STATS', nested Stats[].Id == id, value at
// .Value.IntValue|FloatValue. Same shape verified for '^DEATHS' below;
// some early-game saves carry an empty {} instead of 0 for an untouched
// stat, treated as 0, not "missing".
function globalStat(ps, id) {
    const groups = boundedArray(ps.Stats);
    const globalStats = groups.find((g) => g?.GroupId === '^GLOBAL_STATS');
    const entries = boundedArray(globalStats?.Stats);
    const entry = entries.find((e) => e?.Id === id);
    const v = entry?.Value;
    if (typeof v?.IntValue === 'number') return v.IntValue;
    if (typeof v?.FloatValue === 'number') return v.FloatValue;
    return 0;
}

// Pre-chewed beats the game itself records in PlayerStateData: no inference,
// these are engine facts. Milestones feed Payload B (beats.js), NOT the
// geographic payload. GDPR: no third-party pseudonym is read here.
export function extractMilestones(ps) {
    // Nested-format UA (VoxelX/Y/Z + SolarSystemIndex) -> {sysaddress, galaxy},
    // null on bad shape. Same guard as extractPlayerState.addr but standalone.
    const nested = (ua) => {
        const ga = ua?.GalacticAddress;
        if (!ga || typeof ga.VoxelX !== 'number' || typeof ga.VoxelY !== 'number' ||
            typeof ga.VoxelZ !== 'number') {
            return null;
        }
        return { sysaddress: voxelToSysaddress(ga), galaxy: ua.RealityIndex ?? 0 };
    };
    const nestedList = (arr) => boundedArray(arr).map(nested).filter(Boolean);

    // Scalar UA (number or hex string) -> {sysaddress, galaxy}, null on error.
    const scalar = (ua) => {
        if (typeof ua !== 'string' && typeof ua !== 'number') {
            return null;
        }
        try {
            return uaToSysaddress(ua);
        } catch {
            return null;
        }
    };

    // Wonder records carry NO name and NO timestamp: only a GenerationID
    // (opaque) and a WonderStatValue (record magnitude). The only exploitable
    // beat is the COUNT per category ("N planet records set") plus the best
    // stat value. seen = how many surfaced in the game frontend.
    const wonders = (arr) => {
        const list = boundedArray(arr);
        let best = null;
        let seen = 0;
        for (const w of list) {
            const v = typeof w?.WonderStatValue === 'number' ? w.WonderStatValue : null;
            if (v !== null && (best === null || v > best)) {
                best = v;
            }
            if (w?.SeenInFrontend === true) {
                seen += 1;
            }
        }
        return { count: list.length, seen, best };
    };

    return {
        atlas: {
            first: ps.FirstAtlasStationDiscovered === true,
            completed: nestedList(ps.CompletedAtlasAddresses),
            destroyed: nestedList(ps.DestroyedAtlasAddresses),
        },
        purple: {
            discovered: ps.HasDiscoveredPurpleSystems === true,
            first: scalar(ps.FirstPurpleSystemUA),
        },
        freighter: {
            name: sanitizeString(ps.PlayerFreighterName ?? '', MAX_NAME_LEN),
        },
        // Player-behavior stats, not game lore: Stats.^GLOBAL_STATS
        // counters, same lookup as total_deaths below.
        stats: {
            systems_discovered: globalStat(ps, '^DISC_SYSTEMS'),
            planets_discovered: globalStat(ps, '^DISC_PLANETS'),
            creatures_discovered: globalStat(ps, '^DISC_CREATURES'),
            flora_discovered: globalStat(ps, '^DISC_FLORA'),
            creatures_fed: globalStat(ps, '^CREATURES_FED'),
            pets_owned: globalStat(ps, '^PETS_OWNED'),
            frigates: globalStat(ps, '^FRIGATES'),
            ships_bought: globalStat(ps, '^SHIPS_BOUGHT'),
            sentinel_kills: globalStat(ps, '^SENTINEL_KILLS'),
            pirates_killed: globalStat(ps, '^PIRATES_KILLED'),
            blackhole_warps: globalStat(ps, '^BLACKHOLE_WARPS'),
            dist_fly: globalStat(ps, '^DIST_FLY'),
            dist_walked: globalStat(ps, '^DIST_WALKED'),
        },
        wonders: {
            planet: wonders(ps.WonderPlanetRecords),
            creature: wonders(ps.WonderCreatureRecords),
            flora: wonders(ps.WonderFloraRecords),
            mineral: wonders(ps.WonderMineralRecords),
            treasure: wonders(ps.WonderTreasureRecords),
            basePart: wonders(ps.WonderWeirdBasePartRecords),
            custom: wonders(ps.WonderCustomRecords),
        },
        // SettlementStatesV2 lists ALL settlements crossed, most owned by other
        // players. Keep name + owner pseudonym so beats.js can filter to the
        // ones the protagonist actually oversees (Owner.USN === protagonist).
        // first_activity = earliest of the settlement's activity timestamps: no
        // "acquired at" field exists, so the oldest recorded activity (population
        // change, judgement, mission) is the best proxy for when you took charge.
        // SeedValue links a state to its SettlementHistory entry (PlayerClaimedTime,
        // the real claim date) and its scalar
        // UniverseAddress (portal layout, same decoder as uaToSysaddress).
        settlements: boundedArray(ps.SettlementStatesV2)
            .map((s) => {
                const activity = [
                    s?.LastPopulationChangeTime, s?.MiniMissionStartTime,
                    s?.LastJudgementTime, s?.LastDebtChangeTime,
                ]
                    .map((t) => sanitizeTs(t))
                    .filter((t) => t);
                const loc = scalar(s?.UniverseAddress);
                return {
                    name: sanitizeString(s?.Name ?? '', MAX_NAME_LEN),
                    owner: sanitizeString(s?.Owner?.USN ?? '', MAX_USER_LEN),
                    population: typeof s?.Population === 'number' ? s.Population : null,
                    first_activity: activity.length ? Math.min(...activity) : null,
                    seed_value: s?.SeedValue ?? null,
                    sysaddress: loc ? loc.sysaddress : null,
                    galaxy: loc ? loc.galaxy : null,
                };
            }),
        // PlayerClaimedTime per settlement (by SeedValue), the true "took charge"
        // date, distinct from first_activity's proxy.
        settlementHistory: boundedArray(ps.SettlementHistory)
            .map((h) => ({
                seed_value: h?.SeedValue ?? null,
                claimed_ts: sanitizeTs(h?.PlayerClaimedTime),
            }))
            .filter((h) => h.seed_value !== null),
        // First tamed companion. Pets[] slots with
        // BirthTime=0 are unused. UA is portal-layout (same decoder as discoveries).
        pets: boundedArray(ps.Pets)
            .map((pet) => {
                // Through sanitizeTs like every other save timestamp: this
                // takes any positive number, and it is only a lower bound on
                // when the journey started - a pet's birth can predate the
                // first discovery record by years on some saves.
                const birth = sanitizeTs(pet?.BirthTime);
                if (!birth) {
                    return null;
                }
                const loc = scalar(pet?.UA);
                if (!loc) {
                    return null;
                }
                const rawName = sanitizeString(pet?.CustomName ?? '', MAX_NAME_LEN);
                return {
                    birth_ts: birth,
                    creature_id: (sanitizeString(pet?.CreatureID ?? '', 64) ?? '').replace(/^\^/, ''),
                    name: rawName && rawName !== '^' ? rawName : null,
                    sysaddress: loc.sysaddress,
                    galaxy: loc.galaxy,
                };
            })
            .filter(Boolean),
        // Active multitool: no timestamp available,
        // beat exists only if a custom Name is set.
        multitool: (() => {
            const idx = typeof ps.ActiveMultioolIndex === 'number' ? ps.ActiveMultioolIndex : 0;
            const list = boundedArray(ps.Multitools);
            const mt = list[idx];
            const name = sanitizeString(mt?.Name ?? '', MAX_NAME_LEN);
            if (!mt || !name) {
                return null;
            }
            return { name, is_large: mt?.IsLarge === true };
        })(),
        // Total deaths: Stats[].GroupId ==
        // '^GLOBAL_STATS', its nested Stats[].Id == '^DEATHS', value at
        // .Value.IntValue (verified against a real save: Stats entries are
        // {GroupId, Stats:[{Id, Value:{IntValue|FloatValue}}]}, NOT the flat
        // {StatsID,IntValue} shape assumed pre-verification).
        // Cause breakdown verified non-exhaustive even when present: never surfaced.
        total_deaths: (() => {
            const groups = boundedArray(ps.Stats);
            const globalStats = groups.find((g) => g?.GroupId === '^GLOBAL_STATS');
            const entries = boundedArray(globalStats?.Stats);
            const deaths = entries.find((e) => e?.Id === '^DEATHS');
            return typeof deaths?.Value?.IntValue === 'number' ? deaths.Value.IntValue : null;
        })(),
        // MissionProgress: split raw into procedural (Seed != 0, discarded, pure
        // gameplay noise) and unique (Seed == 0), returned as {id: progress}
        // for beats.js to intersect against MAIN_STORY_MISSION_IDS /
        // EXPEDITION_LORE_MISSION_IDS.
        // Mission id field is `Mission` (verified against a real save), not
        // `MissionID` (that name exists elsewhere in NMSE's schema, unrelated
        // to this array).
        missionProgress: (() => {
            const list = boundedArray(ps.MissionProgress);
            // Object.create(null): `id` is a free-form string from the save
            // (a mission id), same reasoning as deobfuscate() above - a raw
            // value spelling "__proto__" must become a plain own key, not
            // touch the object's actual prototype.
            const out = Object.create(null);
            for (const m of list) {
                const seed = m?.Seed;
                const isZero = seed === 0 || seed === '0' || seed == null ||
                    (Array.isArray(seed) && seed.every((x) => x === 0));
                if (!isZero) {
                    continue; // procedural repeatable mission: no narrative value
                }
                const id = (sanitizeString(m?.Mission ?? '', 64) ?? '').replace(/^\^/, '');
                const progress = typeof m?.Progress === 'number' ? m.Progress : 0;
                if (id && progress > 0) {
                    out[id] = progress;
                }
            }
            return out;
        })(),
    };
}

// Bare-address extraction (StoredInteractions, VisitedSystems, pets, eggs,
// bases, teleport endpoints, birth/previous/nexus voxels, Atlas stations) is
// DELIBERATELY NOT part of Payload A: none of it is a discovery record, so it
// would carry presence only ("this save mentions this address") and nothing a
// server can't already derive from the address alone. What follows is the
// discovery-record path (DiscoveryManagerData) only.

// True ISO-8859-1: byte N decodes to code point U+00N, always, for the full
// 0x00-0xFF range. NOT the same as TextDecoder('iso-8859-1'): browsers alias
// that label to windows-1252, which remaps 0x80-0x9F to printable characters
// instead of leaving them 1:1. NMS save JSON is written by the game engine in
// this raw byte-per-char form (see NMSE reference), with binary data
// sometimes embedded directly inside string values, so decoding must never
// lose or reinterpret a byte at this stage.
function decodeLatin1(bytes) {
    let out = '';
    const CHUNK = 0x8000; // avoid String.fromCharCode.apply stack limits on large saves
    for (let i = 0; i < bytes.length; i += CHUNK) {
        out += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return out;
}

const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

// NMSE's own JsonReader.ReadSkipWhitespace treats every byte <= 0x20 (space,
// tab, CR, LF, and null 0x00) as skippable, specifically because NMS save
// files can carry null-byte padding around the JSON content (truncated
// writes, reused save slots). Mirror that tolerance here: native JSON.parse
// only accepts the four real JSON whitespace characters and would reject a
// leading NUL outright, so the JSON start must be located manually first.
function skipLeadingJunk(bytes) {
    let i = 0;
    while (i < bytes.length && bytes[i] <= 0x20) {
        i++;
    }
    return i;
}

// JSON.parse reviver: a JSON string produced by decodeLatin1() may actually
// be UTF-8 text (player names, region names, etc. with non-ASCII characters)
// that the game encoded as raw UTF-8 bytes inside a Latin-1-encoded save.
// Re-decode it as UTF-8 when the bytes validate as such; otherwise it is
// genuine binary data, and the untouched Latin-1 byte-for-byte string (no
// data loss) is kept.
function reviveMixedEncoding(key, value) {
    if (typeof value !== 'string') {
        return value;
    }
    let hasHighByte = false;
    for (let i = 0; i < value.length; i++) {
        if (value.charCodeAt(i) > 0x7F) {
            hasHighByte = true;
            break;
        }
    }
    if (!hasHighByte) {
        return value;
    }
    const bytes = new Uint8Array(value.length);
    for (let i = 0; i < value.length; i++) {
        bytes[i] = value.charCodeAt(i);
    }
    try {
        return utf8Decoder.decode(bytes);
    } catch {
        return value;
    }
}

// PS4/PS5 SaveWizard streaming header, 8 ASCII bytes: "NOMANSKY".
const NOMANSKY_MAGIC = [0x4e, 0x4f, 0x4d, 0x41, 0x4e, 0x53, 0x4b, 0x59];
// JSON payload always starts right after the fixed 0x70-byte header.
const NOMANSKY_HEADER_LEN = 0x70;
// Payload byte length is stored as a little-endian uint32 at this offset.
const NOMANSKY_SIZE_OFFSET = 0x5c;

function hasNomanSkyMagic(bytes) {
    if (bytes.length < NOMANSKY_MAGIC.length) {
        return false;
    }
    for (let i = 0; i < NOMANSKY_MAGIC.length; i++) {
        if (bytes[i] !== NOMANSKY_MAGIC[i]) {
            return false;
        }
    }
    return true;
}

// Mirrors NMSE's ParseObjectBody auto-detection (Models/JsonParser.cs): the
// decision to deobfuscate is driven by whether the parsed root's own keys
// look obfuscated, never by which container format the bytes came in as.
// This matters specifically for NOMANSKY (PS4/PS5) saves, which NMSE notes
// may mix human-readable root keys (e.g. "Version") with obfuscated ones -
// treating "NOMANSKY implies unobfuscated" would be wrong.
function looksObfuscated(d, mapping) {
    if (d === null || typeof d !== 'object') {
        return false;
    }
    for (const k of Object.keys(d)) {
        if (k in mapping) {
            return true;
        }
    }
    return false;
}

export function loadSave(bytes, mapping) {
    // Reject on first significant byte, BEFORE any parsing: an NMS save starts
    // with LZ4 magic E5 A1 ED FE (recent PC/Switch format), the NOMANSKY
    // header (PS4/PS5 SaveWizard streaming format), or '{' (2016 plaintext
    // JSON), the latter possibly preceded by null/whitespace padding (see
    // skipLeadingJunk). Any other content is never decompressed nor parsed.
    if (bytes.length < 4) {
        throw new Error('unrecognized format: empty or truncated file, not an NMS save');
    }
    if (bytes.length > MAX_SAVE_BYTES) {
        throw new Error('file too large for an NMS save ' +
            `(${Math.round(bytes.length / 1048576)} MB, maximum ${MAX_SAVE_BYTES / 1048576} MB)`);
    }
    const isNomanSky = hasNomanSkyMagic(bytes);
    const plainStart = (hasMagic(bytes) || isNomanSky) ? -1 : skipLeadingJunk(bytes);
    if (!hasMagic(bytes) && !isNomanSky && (plainStart >= bytes.length || bytes[plainStart] !== 0x7B)) {
        throw new Error('unrecognized format: neither NMS LZ4 (magic E5A1EDFE), NOMANSKY header, ' +
            'nor plaintext JSON, not an NMS save');
    }
    let text;
    if (hasMagic(bytes)) {
        const decoded = decodeChunks(bytes);
        // Decompressed stream must also be JSON, modulo the same padding tolerance.
        const decodedStart = skipLeadingJunk(decoded);
        if (decodedStart >= decoded.length || decoded[decodedStart] !== 0x7B) {
            throw new Error('unrecognized format: decompressed content is not JSON, ' +
                'not an NMS save');
        }
        text = decodeLatin1(decoded.subarray(decodedStart));
    } else if (isNomanSky) {
        if (bytes.length < NOMANSKY_HEADER_LEN) {
            throw new Error('unrecognized format: truncated NOMANSKY header, not an NMS save');
        }
        let jsonSize = (bytes[NOMANSKY_SIZE_OFFSET] | (bytes[NOMANSKY_SIZE_OFFSET + 1] << 8) |
            (bytes[NOMANSKY_SIZE_OFFSET + 2] << 16) | (bytes[NOMANSKY_SIZE_OFFSET + 3] << 24)) >>> 0;
        if (jsonSize <= 0 || NOMANSKY_HEADER_LEN + jsonSize > bytes.length) {
            jsonSize = bytes.length - NOMANSKY_HEADER_LEN;
        }
        let end = NOMANSKY_HEADER_LEN + jsonSize;
        while (end > NOMANSKY_HEADER_LEN && bytes[end - 1] === 0) {
            end--;
        }
        const payloadStart = skipLeadingJunk(bytes.subarray(NOMANSKY_HEADER_LEN, end)) + NOMANSKY_HEADER_LEN;
        if (payloadStart >= end || bytes[payloadStart] !== 0x7B) {
            throw new Error('unrecognized format: NOMANSKY payload is not JSON, not an NMS save');
        }
        // Decoded as Latin-1 like every other format, not the raw UTF-8 NMSE
        // uses for this specific format: the reviveMixedEncoding reviver
        // below already recovers genuine UTF-8 content losslessly (a PS4/PS5
        // save's actual encoding), so one decode path covers both without
        // needing to special-case this branch.
        text = decodeLatin1(bytes.subarray(payloadStart, end));
    } else {
        let end = bytes.length;
        while (end > 0 && bytes[end - 1] === 0) {
            end--;
        }
        text = decodeLatin1(bytes.subarray(plainStart, end));
    }
    let d;
    try {
        d = JSON.parse(text, reviveMixedEncoding);
    } catch {
        throw new Error('unrecognized format: this file is not an NMS save');
    }
    if (looksObfuscated(d, mapping)) {
        d = deobfuscate(d, mapping);
    }
    // Immediate discriminant: a character save always has PlayerStateData
    // (root in 2016, under BaseContext later, or under ExpeditionContext for
    // an Expedition/Season save - see resolvePlayerStateData).
    // accountdata.hg, mf_*, etc. do not: clear error immediately.
    const { ps, expedition } = resolvePlayerStateData(d);
    if (!ps) {
        throw new Error('unrecognized format: not a character save ' +
            '(PlayerStateData absent; accountdata and manifests are not saves)');
    }
    if (expedition) {
        // Expedition/Season saves carry their own progress structure under
        // ExpeditionContext (missions, milestones, reward tables) rather than
        // the persistent-galaxy discovery data this pipeline is built to
        // read. Reject cleanly instead of misreading unrelated fields as
        // discoveries.
        const err = new Error('expedition/season save: not processed here ' +
            '(ActiveContext is the Expedition, not the base save)');
        err.expedition = true;
        throw err;
    }
    return d;
}

// files: [{name, bytes: Uint8Array}]
// Returns { systems, errors, rejectedTs, undated } where systems is the sorted list
// (galaxy, sysaddress) of systems with at least one dated event,
// identical format to discoveries.json: {sysaddress, galaxy, ua, name,
// planets: [{name, vp1_raw, save, user, timestamp, date}], sources: [...]}.
export function extractFromFiles(files, mapping, log = () => {}) {
    const systems = new Map(); // "galaxy|sysaddress" -> entry (dated discoveries)
    const playerStates = []; // one per readable save (mono-save: only one)
    const errors = [];
    const seenRecords = new Set(); // dedup between copies of same save
    const rejectedTs = new Map();  // invalid ts -> occurrences

    let recordsSeen = 0;

    function processSaveData(d, base) {
        let records = d?.DiscoveryManagerData?.['DiscoveryData-v1']?.Store?.Record ?? [];
        if (!Array.isArray(records)) {
            records = [];
        }
        log(`${base}: ${records.length} records`);
        for (const r of records) {
            // Volume bounds: beyond this, abnormal file, truncate hard.
            if (++recordsSeen > MAX_RECORDS || systems.size > MAX_SYSTEMS) {
                log(`${base}: abnormal record volume, truncation at ${MAX_RECORDS}`);
                break;
            }
            const dd = r?.DD ?? {};
            const dt = dd.DT;
            if (dt !== 'SolarSystem' && dt !== 'Planet') {
                continue;
            }
            const ua = dd.UA;
            // Only expected types accepted: hex string or number.
            if (typeof ua !== 'string' && typeof ua !== 'number') {
                continue;
            }
            // Discoveries are portal-layout in the vast majority, but some
            // entries are voxel-packed (same drift as VisitedSystems) and a raw
            // portal decode would invent a galaxy. Use the coherence cascade
            // (portal a-priori, voxel fallback, drop if neither is a valid NMS
            // address) to keep the galaxy honest.
            let addr, galaxy;
            try {
                const dec = decodeScalarUa(ua, 'portal');
                if (!dec) {
                    continue;
                }
                ({ sysaddress: addr, galaxy } = dec);
            } catch {
                continue;
            }

            const ows = r?.OWS ?? {};
            const dm = r?.DM ?? {};
            // Systematic sanitization: expected types, controls removed,
            // lengths and temporal bounds imposed.
            const user = sanitizeString(ows.USN, MAX_USER_LEN);
            const cn = sanitizeString(dm.CN, MAX_NAME_LEN);
            const rawTs = sanitizeTs(ows.TS);
            // OWS.TS sometimes before game release: invalid value,
            // rejected (see detailed comment in 01-extract.py).
            const ts = (rawTs && rawTs >= NMS_RELEASE_TS) ? rawTs : null;
            if (rawTs && ts === null) {
                rejectedTs.set(rawTs, (rejectedTs.get(rawTs) ?? 0) + 1);
            }
            const source = {
                save: base,
                user,
                timestamp: ts,
                date: ts ? isoUtc(ts) : null,
            };

            // Raw VP[1], without interpretation or planet-specific dedup: no
            // reliable formula known (see 01-extract.py).
            let vp1Raw = null;
            if (dt === 'Planet' && Array.isArray(dd.VP)) {
                vp1Raw = typeof dd.VP[1] === 'number' ? dd.VP[1] : null;
            }

            const dedupKey = [dt, String(ua), vp1Raw, user, rawTs].join('');
            if (seenRecords.has(dedupKey)) {
                continue;
            }
            seenRecords.add(dedupKey);

            const key = galaxy + '|' + addr;
            let entry = systems.get(key);
            if (!entry) {
                entry = { sysaddress: addr, galaxy, ua: String(ua), name: null, planets: [], sources: [] };
                systems.set(key, entry);
            }
            entry.ua = String(ua);
            if (dt === 'SolarSystem') {
                if (cn && !entry.name) {
                    entry.name = cn;
                }
                entry.sources.push(source);
            } else {
                entry.planets.push({ name: cn, vp1_raw: vp1Raw, ...source });
            }
        }
    }

    for (const f of files) {
        let d;
        try {
            d = loadSave(f.bytes, mapping);
        } catch (e) {
            log(e.expedition ? `${f.name}: SKIPPED, ${e.message}` : `${f.name}: ERROR ${e.message}`);
            errors.push({ file: f.name, error: String(e.message ?? e) });
            continue;
        }
        processSaveData(d, f.name);
        const st = extractPlayerState(d, f.name);
        if (st) {
            playerStates.push(st);
            if (st.birth) {
                log(`${f.name}: birth ${st.birth.sysaddress} galaxy ${st.birth.galaxy} ` +
                    `planet ${st.birth.planet_index}`);
            }
        }
    }

    let outList = [...systems.values()].sort((a, b) =>
        (a.galaxy - b.galaxy) || (a.sysaddress < b.sysaddress ? -1 : a.sysaddress > b.sysaddress ? 1 : 0));

    // Exclude systems with no dated events (unusable for the chronological story).
    const isDated = (e) => e.sources.some((x) => x.timestamp) || e.planets.some((x) => x.timestamp);
    const undated = outList.filter((e) => !isDated(e)).map((e) => e.sysaddress);
    outList = outList.filter(isDated);

    return { systems: outList, playerStates, errors, rejectedTs, undated };
}
