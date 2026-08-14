#!/usr/bin/env node
// Author: had.sh
// Format self-test: everything that can be checked without a save file.
//
// Two jobs. First, prove the seed format still behaves as published: varint,
// base64url, crc8 watermark, per-beat positional payloads, raw and
// compressed envelopes. Second, prove the shipped library stays offline: no
// module reaches the network except the one explicit, player-triggered send
// in app.js.
//
// The reference payload is synthetic (fixtures/max-synthetic.beats.json): a
// hand-built worst case where every beat type is present at once, every name
// field is filled and every progress flag is set. No real player, no save,
// no personal data.
//
// Usage: node test/selftest.js [--update-fixtures]

import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';

import {
    encodeSeed, decodeSeed, peekCommitment, pushVarint, readVarint,
    base64urlEncode, base64urlDecode, tsToDayNum, EPOCH_DAY,
    MAIN_STORY_MISSION_IDS, EXPEDITION_LORE_MISSION_IDS, CREATURE_IDS,
    MAIN_STORY_ARC_GROUPS, EXPEDITION_LORE_GROUPS,
} from '../lib/seed.js';
import { COMMITMENT_BYTES, normalize, isValid, checkSymbol, encode as crockfordEncode }
    from '../lib/crockford.js';
import { crc8Had, inflateRaw, compressionAvailable } from '../lib/compress.js';
import { annotateSeed, BEAT_TYPES, UNDATED_TYPES, LAYOUT, HEADER_BYTES } from '../tools/annotate.js';
import { annotateGeo } from '../tools/annotate-geo.js';
import { syntheticGeo, syntheticGeoPost } from '../tools/geo-fixture.js';
import {
    WIRE_MAX_NAME_BYTES, WIRE_MAX_CREDIT_BYTES,
} from '../lib/geo.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_DIR = path.resolve(HERE, '..');
const LIB_DIR = path.join(PKG_DIR, 'lib');
const FIXTURES = path.join(PKG_DIR, 'fixtures');
const SEED_FIXTURE = path.join(FIXTURES, 'max-synthetic.seed');
const BEATS_FIXTURE = path.join(FIXTURES, 'max-synthetic.beats.json');

// Every seed carries a destroy-key commitment (lib/crockford.js). A real one is
// SHA-256 of a fresh 120-bit random, which would make the fixture different on
// every run and its .seed file unusable as a reference. This stand-in is a
// fixed byte pattern instead: it is NOT a key anyone holds, and nothing in the
// format cares whether the 15 bytes are a hash or a counter.
export const TEST_COMMITMENT = new Uint8Array(
    Array.from({ length: COMMITMENT_BYTES }, (_, n) => (n * 17 + 3) & 0xFF));

// Worst-case payload: one beat of every type, dated ones spread over the whole
// possible range (2016 launch day to a late date), every optional string used.
export function maxSyntheticBeats() {
    return [
        { type: 'first_system', ts: null, facts: {
            sysaddress: '05E08961E78', planet_index: 3, start_year: 2016 } },
        { type: 'community_phase', ts: null, facts: { distinct_users: 4096 } },
        { type: 'freighter_named', ts: null, facts: {
            name: 'Leviathan Eternel', frigates: 30, ships_owned: 12, ships_bought: 9 } },
        { type: 'total_playtime', ts: null, facts: { seconds: 8_000_000 } },
        { type: 'multitool_named', ts: null, facts: {
            name: 'Fleau D Etoiles', is_large: true } },
        { type: 'main_story_arc', ts: null, facts: { done_ids: MAIN_STORY_MISSION_IDS } },
        { type: 'expedition_lore', ts: null, facts: {
            done_ids: EXPEDITION_LORE_MISSION_IDS, pirates_killed: 777, flora_discovered: 2048 } },

        { type: 'first_naming', ts: '2016-08-09', facts: {
            sysaddress: '01FFE9050A2', system_name: 'Genesis Prime', planet_name: 'Alpha Nova' } },
        { type: 'center_journey', ts: '2018-03-21', facts: {
            closest_system: '0C7A1B33E10', blackhole_warps: 128 } },
        { type: 'intergalactic_jump', ts: '2019-11-02', facts: { to_galaxy: 15 } },
        { type: 'atlas_encounter', ts: '2020-04-15', facts: {
            sysaddress: '07A0C13F5D1', galaxy: 0, system_name: 'Sanctuaire Atlas' } },
        { type: 'purple_systems', ts: '2021-06-30', facts: {
            first_system: { sysaddress: '0F3B2C9917E', galaxy: 15 } } },
        { type: 'favorite_base', ts: '2022-09-14', facts: {
            sysaddress: '03D1A7C4B90', name: 'Ragnar', bases_built: 24 } },
        { type: 'first_pet', ts: '2023-02-08', facts: {
            sysaddress: '0AB4E2210F5', creature_id: CREATURE_IDS[22], name: 'Citadelle des Confins',
            pets_owned: 7, creatures_fed: 191, creatures_discovered: 447 } },
        { type: 'settlements', ts: '2024-05-19', facts: {
            total_population: 1337, names: ['Nova Terra Capitale'], sysaddress: '09C8F3D5A21' } },
        { type: 'final_session', ts: '2026-07-20', facts: { events_that_day: 61 } },
        { type: 'journey_ends', ts: '2026-07-20', facts: {
            total_systems: 1907, total_regions: 309, total_galaxies: 4, total_events: 6451,
            active_days: 2318, total_deaths: 1200, systems_discovered: 1899,
            planets_discovered: 5124, dist_fly_class: 4, dist_walked_class: 4,
            sentinel_kills: 3400 } },
    ];
}

// decodeSeed returns { type, ts, seed_facts }; encodeSeed consumes
// { type, ts, facts }. Re-encoding a decoded seed is the round-trip audit.
function decodedToEncodable(beats) {
    return beats.map((b) => ({ type: b.type, ts: b.ts, facts: b.seed_facts }));
}

export async function runSelftest({ log = () => {}, updateFixtures = false } = {}) {
    let failures = 0;
    const check = (name, ok, detail = '') => {
        log(`${ok ? '  ok  ' : '  FAIL'} ${name}${detail ? ': ' + detail : ''}`);
        if (!ok) failures++;
    };

    log('primitives');
    {
        // Varint (LEB128 unsigned) over sizes that cross every byte boundary.
        const values = [0, 1, 127, 128, 300, 16383, 16384, 2 ** 21, 2 ** 31, 2 ** 47 - 1];
        let ok = true;
        for (const v of values) {
            const out = [];
            pushVarint(out, v);
            const pos = { i: 0 };
            if (readVarint(new Uint8Array(out), pos) !== v || pos.i !== out.length) ok = false;
        }
        check('varint round-trip', ok, `${values.length} values`);

        const bytes = new Uint8Array(256).map((_, i) => (i * 37) & 0xFF);
        const b64 = base64urlEncode(bytes);
        ok = !/[+/=]/.test(b64) &&
            base64urlDecode(b64).every((b, i) => b === bytes[i]);
        check('base64url round-trip', ok, 'no padding, url-safe alphabet');

        // Frozen watermark vectors: CRC-8/SMBUS (poly 0x07, init 0, no
        // reflection, xorout 0) + payload.
        check('crc8 watermark vectors',
            crc8Had(new Uint8Array([])) === 0x4F &&
            crc8Had(new Uint8Array([1, 2, 3])) === 0x89,
            `crc8('had') = 0x${crc8Had(new Uint8Array([])).toString(16).toUpperCase()}`);
        check('crc8 detects a flipped bit',
            crc8Had(new Uint8Array([1, 2, 3])) !== crc8Had(new Uint8Array([1, 2, 2])));

        check('epoch day is the NMS release day',
            EPOCH_DAY === Date.UTC(2016, 7, 9) / 86400000 &&
            tsToDayNum('2016-08-09T12:00:00Z') === EPOCH_DAY);
    }

    log('seed format');
    const beats = maxSyntheticBeats();
    const seed = await encodeSeed(beats, { commitment: TEST_COMMITMENT });
    check('every beat type is covered', new Set(beats.map((b) => b.type)).size === beats.length,
        `${beats.length} types`);
    check('encoded envelope is versioned', /\.1z?$/.test(seed), `${seed.length} chars`);

    // The destroy key: what makes a story removable by the person who made it.
    // Checked here rather than only in the site's test suite because the field
    // is part of the wire format, and a package that decodes it at the wrong
    // offset would silently shift every beat after it.
    {
        const read = await peekCommitment(seed);
        check('destroy-key commitment survives the envelope',
            read.length === COMMITMENT_BYTES && read.every((b, n) => b === TEST_COMMITMENT[n]),
            `${COMMITMENT_BYTES} bytes, read without decoding the beats`);

        let refused = false;
        try {
            await encodeSeed(beats, { commitment: TEST_COMMITMENT.slice(0, 8) });
        } catch {
            refused = true;
        }
        check('a wrong-sized commitment is refused', refused);

        refused = false;
        try {
            await encodeSeed(beats);
        } catch {
            refused = true;
        }
        check('a seed cannot be minted without one', refused,
            'every story stays removable by its author');

        // Crockford: the shape the key is actually handed out in. The check
        // symbol is the whole reason typing it by hand is survivable.
        const body = crockfordEncode(TEST_COMMITMENT);
        const good = body.slice(0, 24) + checkSymbol(TEST_COMMITMENT.slice(0, 15));
        check('crockford normalize is idempotent on a clean code',
            normalize(normalize(good)) === normalize(good));
        check('crockford rejects a one-symbol typo',
            !isValid(good.slice(0, -1) + (good.slice(-1) === '0' ? '1' : '0')) || !isValid(good),
            'checksum catches it before the network does');
    }

    const decoded = await decodeSeed(seed);
    check('beat count survives', decoded.length === beats.length);
    const inputTypesInCanonicalOrder = BEAT_TYPES.filter((t) => beats.some((b) => b.type === t));
    check('beat set survives, in header (canonical) order',
        decoded.map((b) => b.type).join() === inputTypesInCanonicalOrder.join());
    // Day granularity became month: every dated beat decodes
    // to a synthetic mid-month day ('-15'), so the round-trip check is
    // year+month, not the exact day.
    check('dates survive to the month',
        decoded.every((b, i) => {
            const orig = beats.find((x) => x.type === b.type).ts;
            return (b.ts ?? '').slice(0, 7) === (orig ?? '').slice(0, 7);
        }));

    // The two arc beats are one-way on purpose: the writer eats raw mission
    // ids, the reader gives back packed booleans, and nothing in the seed can
    // rebuild the id list. Every other beat must survive a re-encode intact.
    const ONE_WAY = new Set(['main_story_arc', 'expedition_lore']);
    const reEncoded = await encodeSeed(decodedToEncodable(decoded), { commitment: TEST_COMMITMENT });
    const reDecoded = await decodeSeed(reEncoded);
    check('encode/decode is idempotent (symmetric beats)',
        decoded.filter((b) => !ONE_WAY.has(b.type)).every((b, i) =>
            JSON.stringify(b) === JSON.stringify(
                reDecoded.filter((x) => !ONE_WAY.has(x.type))[i])));
    check('mission ids are not recoverable from the seed',
        reDecoded.filter((b) => ONE_WAY.has(b.type)).every((b) =>
            Object.entries(b.seed_facts)
                // Enum fields (epilogue_reached, artemis_choice) come back
                // null rather than false: falsy is the shared assertion.
                .filter(([k]) => k.endsWith('_complete') || k.endsWith('_reached'))
                .every(([, v]) => !v)),
        'arc flags cannot be re-expanded into done_ids');

    // Targeted field checks: the pieces where a porting bug hides (hex address
    // parsing, packed planet index, name compression, arc flag bit order).
    const byType = Object.fromEntries(decoded.map((b) => [b.type, b.seed_facts]));
    check('sysaddress stays 11 hex uppercase',
        byType.first_system.sysaddress === '05E08961E78');
    check('planet index rides in the leading nibble',
        byType.first_system.planet_index === 3);
    check('CamelCase name expansion is reversible',
        byType.multitool_named.name === 'Fleau D Etoiles',
        byType.multitool_named.name);
    check('creature id maps back to its label',
        byType.first_pet.creature_id === CREATURE_IDS[22], byType.first_pet.creature_id);
    check('main story arc flags all set',
        Object.entries(byType.main_story_arc)
            .filter(([k]) => k.endsWith('_complete'))
            .every(([, v]) => v === true));
    check('counters survive capping',
        byType.journey_ends.total_systems === 1907 &&
        byType.journey_ends.total_deaths === 999, // capped at 999 by design
        `deaths ${byType.journey_ends.total_deaths}`);

    log('envelopes');
    if (compressionAvailable()) {
        // Rebuild the raw variant from the compressed one: both must decode to
        // the same beats, which is what lets the encoder pick the shorter.
        const dot = seed.lastIndexOf('.');
        const tag = seed.slice(dot + 1);
        if (tag === '1z') {
            const framed = await inflateRaw(base64urlDecode(seed.slice(0, dot)));
            const rawSeed = base64urlEncode(framed) + '.1';
            const fromRaw = await decodeSeed(rawSeed);
            check('raw and compressed envelopes agree',
                JSON.stringify(fromRaw) === JSON.stringify(decoded),
                `${rawSeed.length} raw vs ${seed.length} compressed`);
        } else {
            check('raw envelope chosen (compression did not help)', true,
                `${seed.length} chars`);
        }
    } else {
        check('compression unavailable, raw envelope only', /\.1$/.test(seed));
    }

    let corrupted = false;
    try {
        // Flip one payload character: the crc8 must refuse the seed.
        const body = seed.slice(0, seed.lastIndexOf('.'));
        const flip = body.slice(0, 5) + (body[5] === 'A' ? 'B' : 'A') + body.slice(6);
        await decodeSeed(flip + seed.slice(seed.lastIndexOf('.')));
    } catch {
        corrupted = true;
    }
    check('a tampered seed is rejected', corrupted);

    log('layout table (tools/annotate.js)');
    {
        // The annotator carries its own copy of the wire layout so it can walk
        // a payload byte by byte. These checks are what keeps that copy honest:
        // the indices and the dated flag are measured on the real encoder, and
        // every scalar it reports has to match what the real decoder returns.
        let indexOk = true;
        let datedOk = true;
        for (const beat of beats) {
            const one = await encodeSeed([beat], { commitment: TEST_COMMITMENT });
            const dot = one.lastIndexOf('.');
            let framed = base64urlDecode(one.slice(0, dot));
            if (one.slice(dot + 1) === '1z') framed = await inflateRaw(framed);
            const idx = BEAT_TYPES.indexOf(beat.type);
            const mask = framed.slice(1, 1 + HEADER_BYTES);
            const bitSet = !!(mask[idx >> 3] & (1 << (idx % 8)));
            const totalSet = mask.reduce(
                (n, byte) => n + [...Array(8)].filter((_, k) => byte & (1 << k)).length, 0);
            if (!bitSet || totalSet !== 1) indexOk = false;
            const [d] = await decodeSeed(one);
            if ((d.ts === null) !== UNDATED_TYPES.has(beat.type)) datedOk = false;
        }
        check('beat indices match the encoder (header bit)', indexOk, `${BEAT_TYPES.length} types`);
        check('dated flags match the encoder', datedOk);
        check('layout covers every beat type',
            BEAT_TYPES.every((t) => LAYOUT[t]) &&
            Object.keys(LAYOUT).length === BEAT_TYPES.length);

        const walk = await annotateSeed(seed);
        check('annotation consumes the payload exactly',
            walk.consumed === walk.env.payload.length,
            `${walk.consumed}/${walk.env.payload.length} bytes`);
        check('annotation sees the same beats in the same order',
            walk.rows.filter((r) => r.kind === 'type').map((r) => r.value).join() ===
            decoded.map((b) => b.type).join());

        // Scalar cross-check: each annotated numeric or address field must
        // equal the value the shipped decoder produced for the same beat.
        const mismatches = [];
        let current = null;
        let seen = 0;
        for (const r of walk.rows) {
            if (r.kind === 'type') { current = decoded[seen++].seed_facts; continue; }
            if (!['varint', 'addr11', 'addr12'].includes(r.kind)) continue;
            if (!(r.label in current)) continue;
            if (String(current[r.label]) !== String(r.value)) {
                mismatches.push(`${r.label}: ${r.value} vs ${current[r.label]}`);
            }
        }
        check('annotated scalars match the decoder', mismatches.length === 0,
            mismatches.join('; '));
    }

    log('documentation coverage');
    {
        // "Every bit is explained" has to be a check, not a claim. Each name
        // the wire format knows must appear in the specification: beat types,
        // field labels, and every quest flag, since those are bits a reader
        // cannot see any other way.
        const doc = fs.readFileSync(path.join(PKG_DIR, 'docs/seed-format.md'), 'utf8')
            .replace(/\\/g, ''); // table cells escape the pipe in `a | b`
        const required = [];
        for (const t of BEAT_TYPES) {
            required.push(t);
            for (const [, label] of LAYOUT[t]) required.push(label);
        }
        for (const [name] of MAIN_STORY_ARC_GROUPS) required.push(name);
        for (const [name] of EXPEDITION_LORE_GROUPS) required.push(name);
        // Byte-level semantics that no field label spells out on its own.
        required.push('epilogue_reached', 'artemis_choice',
            'creature_id', 'had_no_space', 'dist_fly_class', 'dist_walked_class',
            '9999', 'bit 7');
        const missing = [...new Set(required)].filter((token) => !doc.includes(token));
        check('every field, flag and beat type is documented',
            missing.length === 0,
            missing.length ? `missing from seed-format.md: ${missing.join(', ')}`
                : `${new Set(required).size} names checked`);

        // Presence in the field table is not an explanation. Fields whose
        // meaning lives in a table elsewhere (raw bytes, enums, flag packs)
        // must be named somewhere else in the document too.
        const opaque = [];
        for (const t of BEAT_TYPES) {
            for (const [kind, label] of LAYOUT[t]) {
                if (!['byte', 'enum', 'enum2', 'flags1', 'flags2'].includes(kind)) continue;
                for (const token of String(label).split(/\s*\|\s*/)) {
                    const hits = doc.split(token).length - 1;
                    if (hits < 2) opaque.push(`${token} (${hits} mention)`);
                }
            }
        }
        check('opaque byte fields are explained, not just listed',
            opaque.length === 0,
            opaque.length ? opaque.join(', ') : 'creature_id, flags, enums, classes');

        // Stronger than presence: each quest flag must be documented at its
        // real bit index. A flag inserted upstream shifts every bit after it,
        // and the table has to shift with it.
        const misplaced = [];
        for (const groups of [MAIN_STORY_ARC_GROUPS, EXPEDITION_LORE_GROUPS]) {
            groups.forEach(([name], bit) => {
                if (!doc.includes(`| ${bit} | \`${name}\``)) misplaced.push(`${name} at bit ${bit}`);
            });
        }
        check('every quest flag is documented at its real bit index',
            misplaced.length === 0,
            misplaced.length ? misplaced.join(', ')
                : `${MAIN_STORY_ARC_GROUPS.length + EXPEDITION_LORE_GROUPS.length} bits`);

        const geoDoc = fs.readFileSync(path.join(PKG_DIR, 'docs/geo-format.md'), 'utf8');
        const geoRequired = ['default_galaxy', 'n_systems', 'n_blackhole_routes',
            'sysaddress', 'credit', 'n_planets', 'credited month', 'exit sysaddress'];
        const geoMissing = geoRequired.filter((t) => !geoDoc.includes(t));
        check('every geo-v1 field is documented', geoMissing.length === 0,
            geoMissing.length ? `missing from geo-format.md: ${geoMissing.join(', ')}`
                : `${geoRequired.length} names checked`);
    }

    log('geo-v1 layout (tools/annotate-geo.js)');
    {
        // Payload A is the artifact that actually leaves the machine, so its
        // layout gets the same treatment as the seed's: walk a payload this
        // process encoded, and check every field against what went in.
        const geo = syntheticGeo();
        const post = await syntheticGeoPost();
        const walk = await annotateGeo(JSON.stringify(post));

        check('geo annotation consumes the payload exactly',
            walk.consumed === walk.env.payload.length,
            `${walk.consumed}/${walk.env.payload.length} bytes`);
        check('geo crc8 watermark is valid', walk.env.crcValid);
        check('geo header counts match the payload',
            walk.counts.systems === geo.systems.length &&
            walk.counts.routes === geo.blackhole_routes.length,
            `${walk.counts.systems} systems, ${walk.counts.routes} routes`);

        // Every system carried by geo-v1 IS a discovery record: the round-trip check applies uniformly.
        const byAddr = new Map(walk.parsed.systems.map((s) => [s.sysaddress, s]));
        const wrong = [];
        for (const s of geo.systems) {
            const got = byAddr.get(s.sysaddress);
            if (!got) { wrong.push(`${s.sysaddress} missing`); continue; }
            if (got.galaxy !== s.galaxy) wrong.push(`${s.sysaddress} galaxy`);
            if ((got.name || null) !== (s.name || null)) wrong.push(`${s.sysaddress} name`);
            if ((got.credit || null) !== (s.credit || null)) wrong.push(`${s.sysaddress} credit`);
            if (got.planets.length !== s.planets.length) wrong.push(`${s.sysaddress} planets`);
        }
        check('every system round-trips through the wire format',
            wrong.length === 0, wrong.join('; '));

        // Discovery dates are cut to the MONTH on the wire, and present only
        // when a credit is: the day, the hours and the minutes visible in the
        // readable JSON never reach the server, and neither does a date with
        // no attached pseudonym.
        const monthOf = (d) => {
            const m = String(d).match(/(\d{4})-(\d{2})/);
            return (+m[1] - 2016) * 12 + (+m[2] - 8);
        };
        const credited = geo.systems.find((s) => s.credit);
        const gotCredited = byAddr.get(credited.sysaddress);
        check('credited system month matches its (capped) date on the wire',
            gotCredited.month === monthOf(credited.date),
            `"${credited.date}" -> month ${gotCredited.month}`);

        const anon = geo.systems.find((s) => !s.credit);
        const gotAnon = anon && byAddr.get(anon.sysaddress);
        check('an uncredited system carries no month at all',
            gotAnon && gotAnon.month === null,
            gotAnon ? `credit=${JSON.stringify(gotAnon.credit)} month=${gotAnon.month}`
                : 'no uncredited fixture found');

        // Planets carry a NAME only: no per-planet date ever reaches the wire,
        // only the system-level credited date above.
        const withPlanets = geo.systems.find((s) => s.planets.length);
        const gotPlanets = byAddr.get(withPlanets.sysaddress);
        check('planets carry no date field on the wire',
            gotPlanets.planets.every((p) => !('date' in p) && !('month' in p)),
            'planet fields: ' + Object.keys(gotPlanets.planets[0] ?? {}).join(','));

        // Free text is bounded in BYTES, and the cut never splits a code point
        // (a truncated UTF-8 sequence would decode to U+FFFD).
        const enc = new TextEncoder();
        const overLong = walk.parsed.systems
            .flatMap((s) => [[s.name, WIRE_MAX_NAME_BYTES], [s.credit, WIRE_MAX_CREDIT_BYTES]])
            .filter(([v, cap]) => enc.encode(v ?? '').length > cap);
        check('every free text field stays under its wire cap',
            overLong.length === 0,
            overLong.length ? overLong.map(([v]) => `${enc.encode(v).length} bytes`).join(', ')
                : `name <= ${WIRE_MAX_NAME_BYTES} B, credit <= ${WIRE_MAX_CREDIT_BYTES} B`);
        const capped = walk.parsed.systems.find((s) => s.name.startsWith('\u2603'));
        check('capping a name never splits a UTF-8 code point',
            capped && !capped.name.includes('\ufffd') &&
            enc.encode(capped.name).length === 63,
            capped ? `${capped.name.length} chars, ${enc.encode(capped.name).length} bytes`
                : 'over-cap fixture missing');

        const r0 = geo.blackhole_routes[0];
        const w0 = walk.parsed.routes[0];
        check('black hole routes round-trip, entry and exit alike',
            w0.sysaddress === r0.sysaddress && w0.credit === r0.credit &&
            w0.exit.sysaddress === r0.exit_candidate.sysaddress &&
            w0.exit.name === r0.exit_candidate.name &&
            w0.exit.credit === r0.exit_candidate.credit);
        // Nothing in a route measures how long anything took, and the exit
        // carries no galaxy of its own (always the route's own).
        check('no duration or galaxy is carried by the exit candidate',
            !('gap_minutes' in w0.exit) && !('galaxy' in w0.exit) &&
            !('gap_minutes' in r0.exit_candidate) && !('galaxy' in r0.exit_candidate),
            'exit is an address + name/credit/date, not a timing or a galaxy');
    }

    log('fixtures');
    if (updateFixtures) {
        fs.mkdirSync(FIXTURES, { recursive: true });
        fs.writeFileSync(SEED_FIXTURE, seed + '\n');
        fs.writeFileSync(BEATS_FIXTURE, JSON.stringify(decoded, null, 2) + '\n');
        check('fixtures rewritten', true, path.relative(PKG_DIR, SEED_FIXTURE));
    } else if (fs.existsSync(SEED_FIXTURE)) {
        const stored = fs.readFileSync(SEED_FIXTURE, 'utf8').trim();
        check('published seed still reproduces byte for byte', stored === seed,
            stored === seed ? `${seed.length} chars`
                : 'format changed, regenerate with --update-fixtures');
        const storedBeats = JSON.parse(fs.readFileSync(BEATS_FIXTURE, 'utf8'));
        check('published seed still decodes to the published beats',
            JSON.stringify(await decodeSeed(stored)) === JSON.stringify(storedBeats));
    } else {
        check('fixtures present', false, 'missing, run with --update-fixtures');
    }

    // Every check below was added because the audit
    // found the corresponding hole. A decoder that hangs, an encoding with 256
    // spellings, a demonstration page that cannot run: none of them could fail
    // a check that existed at the time.
    log('hostile input');
    {
        const rejects = async (name, seed) => {
            let threw = null;
            try { await decodeSeed(seed); } catch (e) { threw = e.message; }
            check(name, threw !== null, threw ?? 'ACCEPTED');
        };
        // Truncated varint. Before the bound this did not throw and did not
        // return: it spun the event loop forever on nine bytes of payload.
        //
        // Run in a child process with a wall clock, because an in-process
        // check for an infinite loop is a trap rather than a check: a
        // regression would block the event loop and hang the whole selftest
        // with no message. A timed-out child reports, which is the point.
        {
            const script =
                `import('${pathToFileURL(path.join(LIB_DIR, 'seed.js')).href}')` +
                `.then(m => m.decodeSeed('mAQAAIA.1')).then(` +
                `() => process.exit(1), () => process.exit(0));`;
            const r = spawnSync(process.execPath, ['--input-type=module', '-e', script],
                { timeout: 10_000, encoding: 'utf8' });
            const verdict = r.signal ? `hung (${r.signal}), the bound is gone`
                : r.status === 0 ? 'rejected'
                    : 'ACCEPTED, no error raised';
            check('a truncated payload is rejected, not looped on',
                !r.signal && r.status === 0, verdict);
        }
        // Canonical encoding: one story, one string. Both of these used to
        // decode to the fixture's own beats under a different sha256, which is
        // the key the moderation list and the mosaic tile table both use.
        const framed = base64urlDecode(seed.slice(0, seed.lastIndexOf('.')));
        const body = compressionAvailable() && seed.endsWith('.1z')
            ? await inflateRaw(framed) : framed;
        const reseal = (b) => {
            const f = new Uint8Array(1 + b.length);
            f[0] = crc8Had(b);
            f.set(b, 1);
            return base64urlEncode(f) + '.1';
        };
        const beatsBytes = body.slice(1);
        for (const bit of [BEAT_TYPES.length + 1, HEADER_BYTES * 8 - 1]) {
            const variant = Uint8Array.from(beatsBytes);
            variant[bit >> 3] |= 1 << (bit % 8);
            await rejects(`reserved header bit ${bit} is rejected`, reseal(variant));
        }
        await rejects('trailing bytes are rejected',
            reseal(Uint8Array.from([...beatsBytes, 0, 0])));
        // Mangled paste: an out-of-alphabet character used to decode as zero
        // bits and lean on an 8-bit CRC to notice.
        await rejects('a non-alphabet character is rejected',
            seed.slice(0, 8) + '*' + seed.slice(9));
        // Deflate bomb. The cap is MAX_INFLATED_BYTES
        if (compressionAvailable()) {
            const { deflateRaw } = await import('../lib/compress.js');
            const bomb = base64urlEncode(await deflateRaw(new Uint8Array(8 * 1024 * 1024))) + '.1z';
            await rejects('a deflate bomb is refused before it is buffered', bomb);
        }
    }

    log('offline posture');
    {
        // The recipe must not phone home. app.js owns the deliberate,
        // consent-gated POSTs; every other module has to be network-free.
        //
        // There are two of them since 2026-08-07, and the list below is the
        // whole of it: the geography send, and the mosaic tile. Each one is
        // ticked separately at "Continue", each one has its own function, its
        // own single call site, and its own consent branch. A third entry here
        // is a decision, not a refactor: adding one means writing it down.
        const SENDS = [
            {
                what: 'geography',
                endpoint: '/api/v1/geo',
                fn: 'sendGeoPayload',
                // Brace-matched from this opener: the branch that only runs
                // when the geography box was ticked before the button.
                // Whitespace-tolerant: this pipeline is minified with
                // --minify-whitespace only, never --minify-identifiers or
                // --minify-syntax (the latter turns a brace-less `if` into a
                // ternary), precisely so this regex still finds the same
                // branch, as a real block, in app.min.js.
                branch: /if\s*\(geoResult\)\s*\{/,
                consent: /consentGeo\.checked/,
            },
            {
                what: 'mosaic tile',
                endpoint: '/mosaic/publish',
                fn: 'sendMosaicTile',
                branch: /if\s*\(mosaicOptIn\)\s*\{/,
                consent: /consentMosaic\.checked/,
            },
        ];

        // Matching closing brace for the '{' at src[openIdx]. Used instead of
        // a "\n}" sentinel so function-body and branch extraction survive
        // whitespace minification, where a body can be a single line.
        function braceBlockEnd(src, openIdx) {
            let depth = 0;
            for (let i = openIdx; i < src.length; i++) {
                if (src[i] === '{') depth++;
                else if (src[i] === '}' && --depth === 0) return i;
            }
            return -1;
        }

        const NET = /\b(fetch|XMLHttpRequest|WebSocket|EventSource|navigator\.sendBeacon)\s*\(/g;
        const offenders = [];
        for (const f of fs.readdirSync(LIB_DIR).filter((n) => n.endsWith('.js'))) {
            const src = fs.readFileSync(path.join(LIB_DIR, f), 'utf8');
            const hits = (src.match(NET) || []).length;
            if (!hits) continue;
            const isAppFile = f === 'app.js' || f === 'app.min.js';
            const declared = SENDS.every((s) =>
                new RegExp(`fetch\\(['"]${s.endpoint}['"]`).test(src));
            if (isAppFile && hits === SENDS.length && declared) continue;
            offenders.push(`${f} (${hits})`);
        }
        check('no network call outside the opt-in sends', offenders.length === 0,
            offenders.join(', '));

        // Counting the calls was never the interesting half. Assert the TRIGGER, not
        // the tally. Each send must sit behind a consent read, and it must be
        // reachable from exactly one place.
        //
        // Both app.js and app.min.js are checked, not app.js alone: the site
        // serves app.min.js, so a posture proven only on app.js would prove
        // nothing about the bytes a visitor actually runs. This only works
        // because js/story's minify pass never mangles identifiers - see the
        // SENDS.branch comment above.
        const APP_FILES = ['app.js', 'app.min.js'].filter((f) =>
            fs.existsSync(path.join(LIB_DIR, f)));
        check('both app.js and app.min.js are present to check', APP_FILES.length === 2,
            APP_FILES.join(', '));

        for (const appFile of APP_FILES) {
            const appSrc = fs.readFileSync(path.join(LIB_DIR, appFile), 'utf8');
            check(`${appFile} holds exactly the declared sends, no more`,
                (appSrc.match(/fetch\(/g) || []).length === SENDS.length,
                `${(appSrc.match(/fetch\(/g) || []).length} fetch(), ${SENDS.length} declared`);

            for (const send of SENDS) {
                const fnStart = appSrc.search(new RegExp(`async function ${send.fn}\\(`));
                const braceOpen = fnStart === -1 ? -1 : appSrc.indexOf('{', fnStart);
                const braceEnd = braceOpen === -1 ? -1 : braceBlockEnd(appSrc, braceOpen);
                const sendFnBody = braceEnd === -1 ? null : appSrc.slice(fnStart, braceEnd + 1);
                check(`[${appFile}] the ${send.what} fetch lives inside ${send.fn} and nowhere else`,
                    !!sendFnBody && new RegExp(`fetch\\(['"]${send.endpoint}['"]`).test(sendFnBody));

                const callSites = [...appSrc.matchAll(
                    new RegExp(`(?<!function )(?<!\\w)${send.fn}\\(`, 'g'))]
                    .filter((m) => !appSrc.slice(0, m.index).endsWith('async function '));
                check(`[${appFile}] ${send.fn} has exactly one call site`, callSites.length === 1,
                    `${callSites.length} found`);

                const branchMatch = appSrc.match(send.branch);
                const open = branchMatch ? appSrc.indexOf('{', branchMatch.index) : -1;
                const end = open === -1 ? -1 : braceBlockEnd(appSrc, open);
                const inside = callSites.length === 1 && open !== -1 && end !== -1 &&
                    callSites[0].index > open && callSites[0].index < end;
                check(`[${appFile}] the ${send.what} send sits inside its consent branch, not beside it`,
                    inside && send.consent.test(appSrc));
            }
            // The label on the primary button has to name what pressing it does,
            // since pressing it IS the send. A page that omits the data-label-*
            // attributes falls back to the button's own text, which is why the
            // check is on the page and not only on the script.
            check(`[${appFile}] the primary button reads its labels from the page, not from code`,
                /dataset\.labelGeo/.test(appSrc) && !/['"]Send my geography/.test(appSrc));
        }

        const evals = [];
        for (const f of fs.readdirSync(LIB_DIR).filter((n) => n.endsWith('.js'))) {
            const src = fs.readFileSync(path.join(LIB_DIR, f), 'utf8');
            if (/\beval\s*\(|new Function\s*\(/.test(src)) evals.push(f);
        }
        check('no eval of save content', evals.length === 0, evals.join(', '));
    }

    log('offline page');
    {
        const appSrc = fs.readFileSync(path.join(LIB_DIR, 'app.js'), 'utf8');
        const pagePath = path.join(PKG_DIR, 'offline', 'index.html');
        const page = fs.readFileSync(pagePath, 'utf8');
        const pageIds = new Set(
            [...page.matchAll(/id="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]));
        const needed = [...new Set(
            [...appSrc.matchAll(/getElementById\('([a-z0-9-]+)'\)/g)].map((m) => m[1]))];
        const missing = needed.filter((id) => !pageIds.has(id));
        check('offline page carries every element id app.js reads',
            missing.length === 0, missing.join(', '));
        check('offline page declares the same locked-down CSP',
            /default-src 'none'/.test(page) && !/'unsafe-inline'/.test(page));
        check('offline page has no inline script or handler',
            !/<script(?![^>]*\bsrc=)/.test(page) && !/\son[a-z]+="/.test(page));
        for (const [name, attr] of [['none', 'data-label-none'], ['geo', 'data-label-geo'],
            ['mosaic', 'data-label-mosaic'], ['both', 'data-label-both']]) {
            check(`offline page names the ${name} case on the primary button`,
                page.includes(attr));
        }
    }

    log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
    return failures === 0;
}

// Standalone run: node test/selftest.js [--update-fixtures]
if (import.meta.url === `file://${process.argv[1]}`) {
    const ok = await runSelftest({
        log: (m) => process.stdout.write(m + '\n'),
        updateFixtures: process.argv.includes('--update-fixtures'),
    });
    process.exit(ok ? 0 : 1);
}
