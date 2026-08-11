// Author: had.sh
//
// This report is NOT exported as-is: it serves only as input to
// beats.js (Payload B). Pseudonyms still circulate internally (needed
// to distinguish community_phase / protagonist_arrival); removed
// by beats.js anonymization pass before any export.

import { isoUtc } from './extract.js';

export function signedCoords(regionHex) {
    const a = parseInt(regionHex, 16);
    let x = a & 0xFFF;
    let z = (a >> 12) & 0xFFF;
    let y = (a >> 24) & 0xFF;
    if (x > 0x7FF) x -= 0x1000;
    if (z > 0x7FF) z -= 0x1000;
    if (y > 0x7F) y -= 0x100;
    return [x, y, z];
}

// Distance from system to galactic center in ly (1 voxel = 400 ly).
// signedCoords already recentered on origin (offsets 0x7FF/0x7F).
export function distanceToCenterLy(sysaddress) {
    const [x, y, z] = signedCoords(sysaddress.slice(3));
    return Math.trunc(Math.sqrt(x * x + y * y + z * z) * 400);
}

// Birth location: explicit (GameStartAddress1, 100% reliable) when
// ONE character's playerStates provided, else falls back to
// cradle heuristic (oldest TS region).
// Multiple distinct births (multi-character corpus) = ambiguous,
// also falls back to heuristic.
function resolveBirth(playerStates, cradle) {
    const births = new Map();
    for (const st of playerStates ?? []) {
        if (st.birth) {
            births.set(st.birth.galaxy + '|' + st.birth.sysaddress, st.birth);
        }
    }
    if (births.size === 1) {
        const b = [...births.values()][0];
        return {
            sysaddress: b.sysaddress,
            galaxy: b.galaxy,
            region: b.sysaddress.slice(3),
            planet_index: b.planet_index,
            source: 'save_field',
        };
    }
    return {
        sysaddress: null,
        galaxy: cradle.galaxy,
        region: cradle.hex,
        planet_index: null,
        source: 'inferred',
    };
}

function buildTrajectory(playerStates) {
    const teleports = new Map();
    const bases = new Map();
    for (const st of playerStates ?? []) {
        for (const t of st.teleports ?? []) {
            teleports.set([t.galaxy, t.sysaddress, t.planet_index, t.type, t.name].join('|'), t);
        }
        for (const b of st.bases ?? []) {
            bases.set([b.galaxy, b.sysaddress, b.planet_index, b.base_type, b.name].join('|'), b);
        }
    }
    return { teleports: [...teleports.values()], bases: [...bases.values()] };
}

// Span of the events the save attributes to the PROTAGONIST themselves, as
// opposed to period.first/last which include community records around the
// cradle (a 2016 discovery by a stranger says nothing about when this player
// started).
//
// Why several sources instead of the first discovery record alone: a discovery
// record is dated when the game uploaded it, not when the player was there, so
// it is a LATE and unreliable lower bound. On a real save, the
// first record credited to the protagonist can be dated years after their
// earliest tamed creature, consistent with several other pets from the same
// period. Reading the journey as starting from the discovery record alone
// would then make the narration contradict itself: the opening would claim
// one year while a later paragraph dates a creature to an earlier one.
//
// Every candidate here is an event the player necessarily caused, so the
// minimum over them is a sound lower bound on "was playing by then". All of
// them come through sanitizeTs, which floors at the game's release date, so an
// absurd value (SettlementHistory.PlayerClaimedTime = 983 on save11.hg) can no
// longer win the minimum.
function buildOwnSpan(playerStates, firstProtagonistTs, lastProtagonistTs) {
    const candidates = [];
    const add = (ts, source) => {
        if (typeof ts === 'number' && Number.isFinite(ts) && ts > 0) {
            candidates.push({ ts, source });
        }
    };

    add(firstProtagonistTs, 'discovery_record');
    add(lastProtagonistTs, 'discovery_record');
    for (const st of playerStates ?? []) {
        for (const b of st.bases ?? []) {
            add(b.last_update, 'base_edit');
        }
        const ms = st.milestones ?? {};
        for (const p of ms.pets ?? []) {
            add(p.birth_ts, 'pet_birth');
        }
        for (const s of ms.settlements ?? []) {
            add(s.first_activity, 'settlement_activity');
        }
        for (const h of ms.settlementHistory ?? []) {
            add(h.claimed_ts, 'settlement_claimed');
        }
    }

    if (!candidates.length) {
        return { first: null, last: null, first_source: null, sources: [] };
    }
    candidates.sort((a, b) => a.ts - b.ts);
    const earliest = candidates[0];
    const latest = candidates[candidates.length - 1];
    return {
        first: isoUtc(earliest.ts),
        last: isoUtc(latest.ts),
        first_source: earliest.source,
        // Distinct source kinds that contributed, so a later consistency check
        // can tell "one lonely timestamp" from "corroborated by four kinds".
        sources: [...new Set(candidates.map((c) => c.source))].sort(),
    };
}

export function buildReport(systems, playerStates = []) {
    // Flat events.
    const events = [];
    for (const s of systems) {
        const a = s.sysaddress ?? '';
        for (const coll of ['planets', 'sources']) {
            for (const p of s[coll] ?? []) {
                if (p.timestamp) {
                    events.push({
                        ts: p.timestamp, sysaddress: a, galaxy: s.galaxy,
                        system_name: s.name ?? null,
                        planet_name: p.name ?? null, user: p.user ?? null,
                        kind: coll === 'planets' ? 'planet' : 'source',
                        save: p.save ?? null,
                    });
                }
            }
        }
    }
    events.sort((x, y) => x.ts - y.ts);

    // Journey always starts in Euclid (galaxy 0): older event in another
    // galaxy is synchronized community record, never "the start"
    const euclidEvents = events.filter((e) => e.galaxy === 0);
    const startEvent = euclidEvents.length ? euclidEvents[0] : events[0];

    // Contributors; protagonist = most prolific (no hardcoded pseudonym).
    const userCounts = new Map();
    for (const e of events) {
        if (e.user) {
            userCounts.set(e.user, (userCounts.get(e.user) ?? 0) + 1);
        }
    }
    // Stable sort by descending count: ties keep insertion order,
    // like Counter.most_common.
    const contributors = [...userCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([user, n]) => ({ user, events: n }));
    const protagonist = contributors.length ? contributors[0].user : null;

    // Earliest PROTAGONIST-dated event per system ("galaxy|sysaddress" -> iso).
    // A discovery's timestamp is the ORIGINAL discoverer's date (often another
    // player), never yours: to place a milestone at YOUR moment we keep only
    // events credited to the protagonist. Systems you crossed but never
    // recorded yourself are absent (no reliable personal date exists).
    const systemFirstTs = {};
    for (const e of events) {
        if (e.user !== protagonist) {
            continue;
        }
        const k = e.galaxy + '|' + e.sysaddress;
        if (!(k in systemFirstTs) || e.ts < systemFirstTs[k]) {
            systemFirstTs[k] = e.ts;
        }
    }
    const systemFirstIso = {};
    for (const [k, ts] of Object.entries(systemFirstTs)) {
        systemFirstIso[k] = isoUtc(ts);
    }

    // Chronological track of the protagonist's OWN dated events, with each
    // system's distance to the galactic center. This is YOUR trajectory (never
    // other players'), used to detect real intergalactic jumps: a genuine jump
    // departs from the core edge (~3200 ly), whereas a galaxy change from the
    // outer rim is a taxi (multiplayer) or a base teleport, not a jump.
    const protagonistTrack = events
        .filter((e) => e.user === protagonist && e.sysaddress)
        .map((e) => ({
            ts: isoUtc(e.ts),
            galaxy: e.galaxy,
            sysaddress: e.sysaddress,
            distance_to_center_ly: distanceToCenterLy(e.sysaddress),
        }));

    // Regions: identity (galaxy, hex), never hex alone.
    // firstTs = earliest event by anyone (original discoverer); protagFirstTs =
    // earliest event credited to the protagonist (YOUR first visit). The former
    // dates the region's discovery, the latter dates when YOU were there.
    const regions = new Map(); // "galaxy|hex" -> {galaxy, hex, systems:Set, users:Set, firstTs, protagFirstTs}
    for (const s of systems) {
        const a = s.sysaddress ?? '';
        if (a.length !== 11) {
            continue;
        }
        const key = s.galaxy + '|' + a.slice(3);
        let r = regions.get(key);
        if (!r) {
            r = { galaxy: s.galaxy, hex: a.slice(3), systems: new Set(), users: new Set(),
                firstTs: null, protagFirstTs: null };
            regions.set(key, r);
        }
        r.systems.add(a);
        for (const coll of ['planets', 'sources']) {
            for (const p of s[coll] ?? []) {
                if (p.user) {
                    r.users.add(p.user);
                }
                if (p.timestamp && (r.firstTs === null || p.timestamp < r.firstTs)) {
                    r.firstTs = p.timestamp;
                }
                if (p.timestamp && p.user === protagonist &&
                    (r.protagFirstTs === null || p.timestamp < r.protagFirstTs)) {
                    r.protagFirstTs = p.timestamp;
                }
            }
        }
    }

    // Cradle = oldest region, Euclid only (see Python).
    const regionList0 = [...regions.values()];
    const euclid = regionList0.filter((r) => r.galaxy === 0);
    const cradlePool = euclid.length ? euclid : regionList0;
    let cradle = cradlePool[0];
    for (const r of cradlePool) {
        if (r.firstTs < cradle.firstTs) {
            cradle = r;
        }
    }
    const [cx, cy, cz] = signedCoords(cradle.hex);

    const regionsDetail = [...regionList0]
        .sort((a, b) => a.firstTs - b.firstTs)
        .map((r) => {
            const [x, y, z] = signedCoords(r.hex);
            // Distance in ly only makes sense within same galaxy.
            const dist = r.galaxy === cradle.galaxy
                ? Math.trunc(Math.sqrt((x - cx) ** 2 + (y - cy) ** 2 + (z - cz) ** 2) * 400)
                : null;
            return {
                region: r.hex,
                galaxy: r.galaxy,
                systems: r.systems.size,
                users: [...r.users].sort(),
                first_seen: isoUtc(r.firstTs),
                protagonist_first_seen: r.protagFirstTs !== null ? isoUtc(r.protagFirstTs) : null,
                coords: { x, y, z },
                distance_from_cradle_ly: dist,
            };
        });

    const firstProtagonist = protagonist
        ? events.find((e) => e.user === protagonist) ?? null
        : null;
    // events is chronological, so the last protagonist-credited one closes the
    // span. Needed as its own candidate: without it, a save whose only own-event
    // timestamps are discovery records got own_span.last === own_span.first, an
    // upper bound of zero width that flagged every later beat as out of range.
    const lastProtagonist = protagonist
        ? [...events].reverse().find((e) => e.user === protagonist) ?? null
        : null;

    // The first place the protagonist actually NAMED (custom system or planet
    // name), not merely their first dated record. first_protagonist_record is
    // the earliest trace (drives narrativeStart) and is often unnamed: a raw
    // scan. This one backs the first_naming beat so that beat keeps its promise.
    const firstNamed = protagonist
        ? events.find((e) => e.user === protagonist
            && (e.system_name || e.planet_name)) ?? null
        : null;

    // First Atlas encounter, derived from the address, not from the engine's
    // CompletedAtlasAddresses (unreliable: slots are often left at
    // 00000000000, and FirstAtlasStationDiscovered can be false even when the
    // player has clearly visited one). Absolute generation rule: a system whose
    // SolarSystemIndex is 0x07A (the first 3 hex of the sysaddress) hosts an
    // Atlas station, one per XYZ region. So the earliest 07A system the
    // protagonist themselves discovered IS their first Atlas. events is already
    // chronological, so the first match is the earliest.
    const ATLAS_SSI_PREFIX = '07A'; // SolarSystemIndex 0x7A, first 3 hex of sysaddress
    const firstAtlas = protagonist
        ? events.find((e) => e.user === protagonist
            && (e.sysaddress ?? '').startsWith(ATLAS_SSI_PREFIX)) ?? null
        : null;

    // Custom-named planets, chronological order.
    const namedPlanets = [];
    for (const s of systems) {
        const a = s.sysaddress ?? '';
        for (const p of s.planets ?? []) {
            const pn = (p.name ?? '').trim();
            if (pn) {
                namedPlanets.push({
                    planet: pn,
                    system: s.name ?? a,
                    sysaddress: a,
                    galaxy: s.galaxy,
                    user: p.user ?? null,
                    date: p.timestamp ? isoUtc(p.timestamp) : null,
                });
            }
        }
    }
    namedPlanets.sort((x, y) => ((x.date ?? '') < (y.date ?? '') ? -1 : (x.date ?? '') > (y.date ?? '') ? 1 : 0));

    // Systems with custom names.
    const namedSystems = systems
        .filter((s) => s.name)
        .map((s) => ({
            name: s.name,
            sysaddress: s.sysaddress ?? null,
            galaxy: s.galaxy,
            distance_to_center_ly: distanceToCenterLy(s.sysaddress ?? '0'.repeat(11)),
        }))
        .sort((x, y) => ((x.name ?? '') < (y.name ?? '') ? -1 : (x.name ?? '') > (y.name ?? '') ? 1 : 0));

    // Race to center: YOUR events only (Euclid). The closest system reached and
    // its date must be the protagonist's own progress, never a community record
    // dated to some other player's discovery. Fallback to all Euclid events only
    // if you have no personal record (foreign/partial save).
    const raceEvents = euclidEvents.filter((e) => e.user === protagonist);
    const raceSource = raceEvents.length ? raceEvents : euclidEvents;
    const progression = [];
    let closest = null; // [distance, sysaddress, ts, galaxy]
    const seenDays = new Set();
    for (const e of raceSource) {
        const d = distanceToCenterLy(e.sysaddress);
        if (closest === null || d < closest[0]) {
            closest = [d, e.sysaddress, e.ts, e.galaxy];
        }
        const day = Math.floor(e.ts / 86400);
        if (!seenDays.has(day)) {
            seenDays.add(day);
            progression.push({
                date: isoUtc(e.ts).slice(0, 10),
                closest_so_far_ly: closest[0],
                system_this_event_ly: d,
            });
        }
    }

    const centerJourney = {
        start_ly: distanceToCenterLy(startEvent.sysaddress),
        start_galaxy: startEvent.galaxy,
        closest_reached_ly: closest[0],
        closest_system: closest[1],
        closest_galaxy: closest[3],
        closest_date: isoUtc(closest[2]),
        progress_ly: distanceToCenterLy(startEvent.sysaddress) - closest[0],
        timeline: progression,
    };

    // Sessions: the PROTAGONIST's events grouped by active day.
    //
    // Was grouped over every event in the save, which made two printed facts
    // describe other players: `active_days` (journey_ends, "across N days of
    // travel") counted days when only strangers recorded anything, and
    // final_session ("your densest session is also your last day", per
    // vendor/tessera/docs/beats.md) could land on someone else's session
    // entirely. Measured on storage7.hg: the last and densest "session" was
    // 2016-12-15 with 5 events, all of them credited to another player, four
    // months after the protagonist's own last record.
    //
    // Fallback to all events only when no protagonist could be identified, so a
    // degenerate save still yields a session list instead of nothing.
    const sessionEvents = protagonist
        ? events.filter((e) => e.user === protagonist)
        : events;
    const dayCounter = new Map();
    for (const e of sessionEvents) {
        const d = isoUtc(e.ts).slice(0, 10);
        dayCounter.set(d, (dayCounter.get(d) ?? 0) + 1);
    }
    const sessions = [...dayCounter.entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
        .map(([date, n]) => ({ date, events: n }));
    const biggestSessions = [...sessions].sort((a, b) => b.events - a.events).slice(0, 10);

    const eventToIso = (e) => ({ ...e, ts: isoUtc(e.ts) });

    return {
        totals: {
            systems: systems.length,
            systems_with_planets: systems.filter((s) => (s.planets ?? []).length).length,
            named_planets: namedPlanets.length,
            named_systems: namedSystems.length,
            events: events.length,
            regions: regions.size,
            active_days: sessions.length,
            galaxies: [...new Set(systems.map((s) => s.galaxy))].sort((a, b) => a - b),
        },
        period: {
            first: isoUtc(startEvent.ts),
            last: isoUtc(events[events.length - 1].ts),
        },
        protagonist,
        contributors,
        cradle: {
            region: cradle.hex,
            galaxy: cradle.galaxy,
            first_seen: isoUtc(cradle.firstTs),
            // Other pseudonyms that left a record IN THE CRADLE REGION, which
            // is what community_phase claims to answer: "who was already around
            // when you started". Reading every pseudonym appearing anywhere in
            // the save instead would count people who were never near the
            // cradle at all, and on a real save the gap between the two counts
            // is large.
            other_users: [...cradle.users].filter((u) => u && u !== protagonist).sort(),
        },
        birth: resolveBirth(playerStates, cradle),
        // Certified trajectory (visited stations, built bases),
        // extracted from PlayerStateData: material for story graph, not
        // exported in payloads at this stage. Deduplicated union across
        // files (mono-save: passthrough).
        trajectory: buildTrajectory(playerStates),
        first_record: eventToIso(startEvent),
        first_protagonist_record: firstProtagonist ? eventToIso(firstProtagonist) : null,
        // Lower/upper bound on the protagonist's own activity (see buildOwnSpan).
        // first_system reads own_span.first for start_year; a dated beat falling
        // outside this span is not to be trusted with a date.
        own_span: buildOwnSpan(
            playerStates,
            firstProtagonist ? firstProtagonist.ts : null,
            lastProtagonist ? lastProtagonist.ts : null
        ),
        first_named_record: firstNamed ? eventToIso(firstNamed) : null,
        first_atlas: firstAtlas ? eventToIso(firstAtlas) : null,
        named_planets: namedPlanets,
        named_systems: namedSystems,
        center_journey: centerJourney,
        biggest_sessions: biggestSessions,
        sessions,
        regions_detail: regionsDetail,
        // Pre-chewed engine milestones (atlas, purple, freighter, wonders,
        // settlements) for Payload B beats. Mono-save: first playerState.
        milestones: playerStates.length ? playerStates[0].milestones ?? null : null,
        // Total played time in seconds (undated global stat). Mono-save.
        play_time_seconds: playerStates.length ? playerStates[0].play_time_seconds ?? null : null,
        // Ships currently owned (ShipOwnership slots with a real Resource.Filename).
        // Mono-save, undated global stat, rides on the freighter_named beat.
        ships_owned: playerStates.length ? playerStates[0].ships_owned ?? 0 : 0,
        // "galaxy|sysaddress" -> iso of earliest PROTAGONIST-dated event, for
        // correlating undated milestones to YOUR timeline (never the discoverer's).
        system_first_ts: systemFirstIso,
        // Chronological list of YOUR dated events with distance to center,
        // for detecting real intergalactic jumps (core-edge departure).
        protagonist_track: protagonistTrack,
    };
}
