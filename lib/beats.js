// Author: had.sh
//
// anonymizeBeats(), explicit pass that removes
// all third-party pseudonyms from facts before final graph assembly (GDPR
// requirement of Payload B: the beat speaks of the protagonist "you", never other
// players encountered). Function intentionally isolated and independently testable.

import { isoUtc } from './extract.js';
import { distanceToCenterLy } from './report.js';
import { MAIN_STORY_MISSION_IDS, EXPEDITION_LORE_MISSION_IDS } from './seed.js';

// 'YYYY-MM-DD HH:MM:SS' or 'YYYY-MM-DD' -> timestamp ms UTC (naive, like
// Python's naive datetime: only differences matter).
export function parseTs(ts) {
    const s = ts.slice(0, 19);
    const y = +s.slice(0, 4);
    const mo = +s.slice(5, 7);
    const d = +s.slice(8, 10);
    const h = s.length > 10 ? +s.slice(11, 13) : 0;
    const mi = s.length > 10 ? +s.slice(14, 16) : 0;
    const se = s.length > 10 ? +s.slice(17, 19) : 0;
    return Date.UTC(y, mo - 1, d, h, mi, se);
}

function daysBetween(msA, msB) {
    // Python's timedelta.days: floor towards -infinity.
    return Math.floor((msA - msB) / 86400000);
}

export function relDuration(days) {
    if (days < 1) return 'that same day';
    if (days < 4) return 'days later';
    if (days < 20) return 'weeks later';
    if (days < 75) return 'months later';
    if (days < 200) return 'many months later';
    if (days < 420) return 'nearly a year later';
    if (days < 800) return 'over a year later';
    return 'years later';
}

// dist_fly / dist_walked: raw meters would cost 3-4 varint bytes and, being
// highly variable/rare-valued, act as a re-identification fingerprint if
// the seed is shared. Reduced to a 1-byte class instead, thresholds picked
// from the observed range across real saves (0 to tens of millions of
// meters flown, low millions walked). Meaning of each class is fixed
// narrative text.
function flyDistanceClass(meters) {
    const m = meters ?? 0;
    if (m <= 0) return 0;
    if (m < 1000000) return 1;
    if (m < 10000000) return 2;
    if (m < 30000000) return 3;
    return 4;
}

function walkDistanceClass(meters) {
    const m = meters ?? 0;
    if (m <= 0) return 0;
    if (m < 50000) return 1;
    if (m < 300000) return 2;
    if (m < 1000000) return 3;
    return 4;
}

export function season(ms) {
    const m = new Date(ms).getUTCMonth() + 1;
    const idx = { 12: 0, 1: 0, 2: 0, 3: 1, 4: 2, 5: 2, 6: 3, 7: 3, 8: 4, 9: 5, 10: 5, 11: 6 }[m];
    return ['deep winter', 'early spring', 'spring', 'summer',
        'late summer', 'autumn', 'late autumn'][idx];
}

// Intergalactic jump: from the edge of the core (~3200 ly from center)
// to another galaxy. Returns {ts, from_galaxy, to_galaxy, region,
// days_after_center} or null if absent or if center not reached.
// A real intergalactic jump departs from the CORE EDGE (~3200 ly from center):
// you fly to the galactic core, then jump. A galaxy change from the outer rim
// (hundreds of thousands of ly out) is not a jump, it is a taxi (another player
// pulls you in) or a base teleport. We walk YOUR own chronological track and
// return the FIRST galaxy transition whose origin system sits at the core edge.
const CORE_EDGE_LY = 3500;

function findIntergalacticJump(report) {
    const track = report.protagonist_track || [];
    for (let i = 1; i < track.length; i++) {
        const from = track[i - 1];
        const to = track[i];
        if (to.galaxy === from.galaxy) {
            continue;
        }
        // Origin must be at the core edge: otherwise it is a taxi / base warp.
        if (from.distance_to_center_ly > CORE_EDGE_LY) {
            continue;
        }
        return {
            from_galaxy: from.galaxy,
            to_galaxy: to.galaxy,
            ts: to.ts,
            from_system: from.sysaddress,
            from_distance_ly: from.distance_to_center_ly,
        };
    }
    return null; // No core-edge jump: never left home galaxy on your own.
}

// Find the most visited / most recently updated base.
// Returns {name, base_type, sysaddress, galaxy, region, last_update_ts} or null.
// last_update_ts is an ISO string, last_update_ms is a number.
// Base types that are not a "home": the freighter interior and the ship base
// are always present and would win by recency without being a place you chose.
const NON_HOME_BASE_TYPES = new Set(['FreighterBase', 'PlayerShipBase']);

function findFavoriteBase(trajectory) {
    if (!trajectory || !trajectory.bases.length) {
        return null;
    }
    // Only planetary/external bases count as a home; drop freighter/ship bases.
    const homes = trajectory.bases.filter((b) => !NON_HOME_BASE_TYPES.has(b.base_type));
    if (!homes.length) {
        return null;
    }
    // Sort by last_update desc (most recent first).
    const sorted = homes.sort((a, b) => {
        const ta = a.last_update ?? 0;
        const tb = b.last_update ?? 0;
        return tb - ta;
    });
    const fav = sorted[0];
    return {
        name: fav.name,
        base_type: fav.base_type,
        sysaddress: fav.sysaddress,
        galaxy: fav.galaxy,
        region: { hex: fav.sysaddress.slice(3), galaxy: fav.galaxy },
        last_update_ms: fav.last_update,
    };
}

export function buildBeats(rep) {
    // Narrative anchor for every when_rel ("weeks later", "years later"): must
    // be the EARLIEST thing the protagonist is known to have done
    // (own_span.first), not merely their first DISCOVERY record.
    //
    // A discovery record is dated when the game uploaded it, so it runs late
    const t0 = rep.own_span?.first
        ? parseTs(rep.own_span.first)
        : rep.first_protagonist_record
            ? parseTs(rep.first_protagonist_record.ts)
            : parseTs(rep.period.first);
    const beats = [];
    const rel = (ms) => relDuration(daysBetween(ms, t0));
    // Player-behavior counters (Stats.^GLOBAL_STATS),into the existing beats below
    const stats = rep.milestones?.stats ?? {};

    // --- Rupture: birth (the awakening place) ---
    // GameStartAddress1 certifies WHERE the character was born, never WHEN:
    // the save stores no creation timestamp. Discovery timestamps around the
    // birth system belong to other players (community records), so no date,
    // season or day-count may be derived for this beat. ts is a sort anchor
    // only (birth precedes everything in the narrative).
    const birthSys = rep.birth.sysaddress;
    // The birth has no timestamp, but the year the JOURNEY started is derivable:
    // it is the year of the protagonist's EARLIEST own event, whatever kind it is
    // (rep.own_span.first). We carry the YEAR only, not a full date: the save
    // records no birth date, so "your journey began in 2022" is honest where
    // "born on 2022-08-13" would not be.
    //
    // Never period.first (a 2016 community record can predate the real start),
    const startYear = rep.own_span?.first
        ? new Date(parseTs(rep.own_span.first)).getUTCFullYear()
        : null;
    beats.push({
        type: 'first_system',
        ts: null,
        when_rel: 'at the very start',
        theme: 'birth',
        salience: 0.95,
        facts: {
            sysaddress: birthSys,
            planet_index: rep.birth.planet_index,
            start_year: startYear,
        },
    });

    // --- Community phase: multiple pseudonyms around the cradle ---
    // Cradle-scoped and protagonist-free, computed in report.js: the beat is
    // about the crowd that was already at your beginning, not about every
    // pseudonym the save has ever seen anywhere.
    const community = rep.cradle?.other_users ?? [];
    if (community.length >= 3) {
        beats.push({
            type: 'community_phase',
            // fr.ts is the first record's discoverer date, not yours: ts:null.
            ts: null,
            when_rel: 'in the first weeks',
            theme: 'shared unknown',
            salience: 0.7,
            // facts trimmed to distinct_users, the only field
            // WRITERS.community_phase reads. sample_users/cradle_* were
            // either GDPR-deleted downstream (anonymizeBeats) or unused.
            facts: {
                // No +1: community already excludes the protagonist, and the
                // prose says "others were here", not "we were N in total".
                distinct_users: community.length,
            },
        });
    }

    // --- Rupture: protagonist's first naming (community -> solo) ---
    // First record credited to the protagonist: the first place THEY named.
    // This is the earliest personal trace, dated (unlike birth). Geography
    // relative to birth is the point: the first baptism is not necessarily
    // near the cradle where the character woke up.
    const fa = rep.first_named_record;
    if (fa) {
        const adt = parseTs(fa.ts);
        beats.push({
            type: 'first_naming',
            ts: fa.ts,
            when_rel: rel(adt),
            season: season(adt),
            theme: 'first trace',
            salience: 0.9,
            // facts trimmed to sysaddress/system_name/planet_name, the only
            // fields WRITERS.first_naming reads (galaxy always 0).
            // user/galaxy/region/distance*/near_birth/protagonist_events/
            // total_events are derived server-side or cut entirely.
            facts: {
                sysaddress: fa.sysaddress,
                system_name: fa.system_name,
                planet_name: fa.planet_name,
            },
        });
    }

    // --- Red thread: the race to center (movement) ---
    // Calculate from birth location if certified, else from first record
    const journeyStart = rep.birth.source === 'save_field' ? rep.birth.sysaddress : rep.first_record.sysaddress;
    const cj = rep.center_journey;
    const birthDist = distanceToCenterLy(journeyStart);
    const actualProgress = birthDist - cj.closest_reached_ly;
    beats.push({
        type: 'center_journey',
        ts: cj.closest_date,
        when_rel: 'over the months',
        theme: actualProgress > 100 ? 'the center as horizon' : 'orbiting the cradle',
        salience: 0.85,
        // facts trimmed to closest_system, the only field
        // WRITERS.center_journey reads (closest_galaxy always 0, start_ly/
        // closest_ly/progress_ly/months/non_linear are all recomputed
        // server-side from cross-beat context).
        facts: {
            closest_system: cj.closest_system,
            // "road to center" theme.
            blackhole_warps: stats.blackhole_warps ?? 0,
        },
    });

    // --- Rupture: first intergalactic jump (from center) ---
    const igj = findIntergalacticJump(rep);
    if (igj) {
        beats.push({
            type: 'intergalactic_jump',
            ts: igj.ts,
            when_rel: rel(parseTs(igj.ts)),
            season: season(parseTs(igj.ts)),
            theme: 'beyond the horizon',
            salience: 0.9,
            // facts trimmed to to_galaxy, the only field
            // WRITERS.intergalactic_jump reads (from = center_journey's
            // closest_system, cut here; from_galaxy always 0).
            facts: {
                to_galaxy: igj.to_galaxy,
            },
        });
    }

    // --- Red thread: the favorite base (place to return to) ---
    // Fallback is the protagonist's OWN last known activity (own_span.last),
    // never rep.period.last: that window includes every other player's events
    // too. 
    const ownLastIso = rep.own_span?.last ?? rep.period.last;
    const favBase = findFavoriteBase(rep.trajectory);
    if (favBase) {
        const lastUpdateTs = favBase.last_update_ms ? isoUtc(favBase.last_update_ms) : ownLastIso;
        const lastUpdateMs = favBase.last_update_ms ?? parseTs(ownLastIso);
        beats.push({
            type: 'favorite_base',
            ts: lastUpdateTs,
            when_rel: rel(lastUpdateMs),
            theme: 'home',
            salience: 0.75,
            facts: {
                sysaddress: favBase.sysaddress,
                name: favBase.name,
                bases_built: rep.trajectory?.bases?.length ?? 0,
            },
        });
    }


    // --- Rupture: last session, densest (abrupt stop) ---
    // biggest_sessions is now protagonist-scoped (report.js), so this compares
    // and dates itself against the protagonist's OWN last day, not the save's
    // overall last day: the beat says "your densest session was also your last
    // day", and only your own days can make that true.
    const big = rep.biggest_sessions[0];
    const ownLastDate = (rep.own_span?.last ?? rep.period.last).slice(0, 10);
    if (big.date === ownLastDate) {
        beats.push({
            type: 'final_session',
            ts: rep.own_span?.last ?? rep.period.last,
            when_rel: 'on the very last day',
            season: season(parseTs(rep.own_span?.last ?? rep.period.last)),
            theme: 'traces left behind',
            salience: 1.0,
            // facts trimmed to events_that_day, the only field
            // WRITERS.final_session reads (closest_*/totals are duplicates
            // of center_journey/journey_ends and cut here).
            facts: {
                events_that_day: big.events,
            },
        });
    }

    // --- Coda: end of journey (ultimate trace) ---
    // Same reasoning as favorite_base/final_session: the beat closes THIS
    // journey, so it dates itself off the protagonist's own last trace, never
    // off a later record left by someone else passing through afterwards.
    const journeyEndsTs = rep.own_span?.last ?? rep.period.last;
    beats.push({
        type: 'journey_ends',
        ts: journeyEndsTs,
        when_rel: 'at the very end',
        season: season(parseTs(journeyEndsTs)),
        theme: 'the last place',
        salience: 1.0,
        // facts: the 6 S fields WRITERS.journey_ends reads. date/span_days are D,
        // recomputed server-side from ts.
        facts: {
            total_systems: rep.totals.systems,
            total_regions: rep.totals.regions,
            total_galaxies: rep.totals.galaxies.length,
            total_events: rep.totals.events,
            active_days: rep.totals.active_days,
            // Stats.^GLOBAL_STATS.^DEATHS: cause breakdown verified non-exhaustive
            // even when present, never surfaced,
            // only the total. Capped at 999 by seed.js WRITERS.journey_ends.
            total_deaths: rep.milestones?.total_deaths ?? 0,
            //  the coda absorbs the
            // exploration/combat tally.
            systems_discovered: stats.systems_discovered ?? 0,
            planets_discovered: stats.planets_discovered ?? 0,
            dist_fly_class: flyDistanceClass(stats.dist_fly),
            dist_walked_class: walkDistanceClass(stats.dist_walked),
            sentinel_kills: stats.sentinel_kills ?? 0,
        },
    });

    // --- Pre-chewed engine milestones (atlas, purple, freighter) ---
    // These are facts the game records without a timestamp. They carry ts:null
    // (never a fake date) and sort to the front of the narrative.
    const ms = rep.milestones;
    if (ms) {
        // Correlate an address-bearing milestone to the discovery timeline:
        // its real moment is the earliest dated event on that system. Returns
        // an iso string, or null when the address is not in dated discoveries.
        const firstTs = rep.system_first_ts ?? {};
        const dateOf = (galaxy, sysaddress) => firstTs[galaxy + '|' + sysaddress] ?? null;
        // Milestones with NO address (freighter/wonders/settlements) cannot be
        // correlated: ts stays null and they sort to the front.
        // fires on a custom name
        // OR any fleet counter, so a player who never renamed the freighter
        // but owns ships/frigates does not silently lose that data
        const hasFleetCount = (stats.frigates ?? 0) > 0 || (rep.ships_owned ?? 0) > 0 ||
            (stats.ships_bought ?? 0) > 0;
        if ((ms.freighter && ms.freighter.name) || hasFleetCount) {
            beats.push({
                type: 'freighter_named',
                ts: null,
                when_rel: 'somewhere along the way',
                theme: 'the mothership',
                salience: 0.55,
                facts: {
                    name: ms.freighter?.name ?? null,
                    frigates: stats.frigates ?? 0,
                    ships_owned: rep.ships_owned ?? 0,
                    ships_bought: stats.ships_bought ?? 0,
                },
            });
        }
        // First Atlas: derived from the address (SSI 0x07A = an Atlas station,
        // one per XYZ region, absolute generation rule), NOT from the engine's
        // CompletedAtlasAddresses. Those slots are unreliable: often left at
        // 00000000000, dated late, and FirstAtlasStationDiscovered can be false
        // even when the player has visited a 07A. rep.first_atlas is the
        // earliest 07A the protagonist discovered themselves, so its date is a
        // true first encounter. The beat exists iff the protagonist visited a
        // 07A at all (absence = silence).
        const atlasTs = rep.first_atlas ? rep.first_atlas.ts : null;
        if (atlasTs) {
            beats.push({
                type: 'atlas_encounter',
                ts: atlasTs,
                when_rel: rel(parseTs(atlasTs)),
                theme: 'the Atlas',
                salience: 0.7,
                // facts trimmed to sysaddress/galaxy/system_name, the fields
                // WRITERS.atlas_encounter reads (date/first/completed_count/
                // destroyed_count are cut).
                facts: {
                    sysaddress: rep.first_atlas.sysaddress,
                    galaxy: rep.first_atlas.galaxy,
                    // Custom system name if the player baptized the Atlas
                    // system (e.g. "Vikning"). Not derivable (personal, not
                    // procedural), so it must ride in the seed. Empty when the
                    // system was left with its procedural name.
                    system_name: rep.first_atlas.system_name || '',
                },
            });
        }
        if (ms.purple && ms.purple.discovered) {
            const purpleTs = ms.purple.first
                ? dateOf(ms.purple.first.galaxy, ms.purple.first.sysaddress)
                : null;
            beats.push({
                type: 'purple_systems',
                ts: purpleTs,
                when_rel: purpleTs ? rel(parseTs(purpleTs)) : 'somewhere along the way',
                theme: 'purple stars',
                salience: 0.65,
                // facts: first_system{sysaddress,galaxy} is the only shape
                // WRITERS.purple_systems reads; date is derived/proxy.
                facts: {
                    first_system: ms.purple.first
                        ? { sysaddress: ms.purple.first.sysaddress, galaxy: ms.purple.first.galaxy }
                        : null,
                },
            });
        }
       
        // Settlements: keep only those the protagonist actually oversees
        // (Owner.USN === protagonist), not the ones merely crossed. No date in
        // the save -> ts:null. GDPR: owner pseudonyms are dropped from facts.
        const owned = (Array.isArray(ms.settlements) ? ms.settlements : [])
            .filter((s) => s.owner && s.owner === rep.protagonist);
        if (owned.length > 0) {
            // True claim date, joined by SeedValue against SettlementHistory
            // Falls back to first_activity when a
            // settlement has no history entry (older saves, format drift).
            const claimBySeed = new Map(
                (ms.settlementHistory ?? [])
                    .filter((h) => h.claimed_ts)
                    .map((h) => [h.seed_value, h.claimed_ts]),
            );
            const claimTsFor = (s) => claimBySeed.get(s.seed_value) ?? s.first_activity ?? null;
            const acts = owned.map(claimTsFor).filter((t) => t);
            const settleTs = acts.length ? isoUtc(Math.min(...acts)) : null;
            // First owned settlement by claim date, for the sysaddress fact
            const first = owned.reduce((best, s) => {
                const t = claimTsFor(s);
                if (!best) return { s, t };
                return t && (!best.t || t < best.t) ? { s, t } : best;
            }, null);
            beats.push({
                type: 'settlements',
                ts: settleTs,
                when_rel: settleTs ? rel(parseTs(settleTs)) : 'somewhere along the way',
                theme: 'the overseer',
                salience: 0.4,
                facts: {
                    names: owned.map((s) => s.name).filter(Boolean),
                    total_population: owned.reduce((n, s) => n + (s.population ?? 0), 0),
                    sysaddress: first?.s?.sysaddress ?? null,
                },
            });
        }

        // --- first_pet: earliest tamed companion by BirthTime ---
        // Always narrable (creature_id/sysaddress survive even without a
        // CustomName): no drop-if-unnamed here, unlike multitool_named below.
        const pets = (ms.pets ?? []).filter((p) => p.birth_ts > 0);
        if (pets.length > 0) {
            const firstPet = pets.reduce((a, b) => (b.birth_ts < a.birth_ts ? b : a));
            const petTs = isoUtc(firstPet.birth_ts);
            beats.push({
                type: 'first_pet',
                ts: petTs,
                when_rel: rel(parseTs(petTs)),
                season: season(parseTs(petTs)),
                theme: 'first companion',
                salience: 0.5,
                facts: {
                    sysaddress: firstPet.sysaddress,
                    creature_id: firstPet.creature_id,
                    name: firstPet.name,
                    pets_owned: stats.pets_owned ?? 0,
                    creatures_fed: stats.creatures_fed ?? 0,
                    creatures_discovered: stats.creatures_discovered ?? 0,
                },
            });
        }

        // --- multitool_named: active tool, only if the player named it
        // No date field exists anywhere for it:
        // undated. Drop entirely if unnamed, nothing else to narrate.
        if (ms.multitool && ms.multitool.name) {
            beats.push({
                type: 'multitool_named',
                ts: null,
                when_rel: 'somewhere along the way',
                theme: 'the tool you carry',
                salience: 0.35,
                facts: {
                    name: ms.multitool.name,
                    is_large: !!ms.multitool.is_large,
                },
            });
        }

        // --- main_story_arc / expedition_lore: MissionProgress checklist ---
        //  Undated state
        // beats: raw boolean ids filtered against the frozen id
        // tables, passed as facts.done_ids. seed.js reduces this to per-arc
        // "complete" booleans at ENCODE timethe raw id list itself never reaches the
        // seed, only the resulting flags do.
        const progress = ms.missionProgress ?? {};
        const doneAgainst = (table) => table.filter((id) => (progress[id] ?? 0) > 0);
        const mainDone = doneAgainst(MAIN_STORY_MISSION_IDS);
        if (mainDone.length > 0) {
            beats.push({
                type: 'main_story_arc',
                ts: null,
                when_rel: 'across the story',
                theme: 'the main thread',
                salience: 0.6,
                facts: { done_ids: mainDone },
            });
        }
        const loreDone = doneAgainst(EXPEDITION_LORE_MISSION_IDS);
        if (loreDone.length > 0) {
            beats.push({
                type: 'expedition_lore',
                ts: null,
                when_rel: 'along the way',
                theme: 'side stories',
                salience: 0.35,
                facts: {
                    done_ids: loreDone,
                    pirates_killed: stats.pirates_killed ?? 0,
                    flora_discovered: stats.flora_discovered ?? 0,
                },
            });
        }
    }

    // --- Meta: total time lived in this save (undated global stat) ---
    if (rep.play_time_seconds) {
        beats.push({
            type: 'total_playtime',
            ts: null,
            when_rel: 'across the whole journey',
            theme: 'time lived',
            salience: 0.5,
            facts: {
                seconds: rep.play_time_seconds,
            },
        });
    }

    // Undated beats (ts === null) are engine milestones with no timestamp in
    // the save: they sort first (before any dated event), then dated beats by ts.
    beats.sort((a, b) => {
        if (a.ts === null && b.ts === null) return 0;
        if (a.ts === null) return -1;
        if (b.ts === null) return 1;
        return a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0;
    });
    return beats;
}

// GDPR pass: removes all pseudonyms from facts.
//   - user === protagonist -> "you"; other pseudonym -> field deleted.
//   - sample_users -> deleted (distinct_users, the count, is sufficient).
// Does not touch planet/system names: game content, not identity.
export function anonymizeBeats(beats, protagonist) {
    return beats.map((b) => {
        const facts = { ...b.facts };
        if ('user' in facts) {
            if (protagonist !== null && facts.user === protagonist) {
                facts.user = 'you';
            } else {
                delete facts.user;
            }
        }
        delete facts.sample_users;
        return { ...b, facts };
    });
}

// The anonymization gate: nothing reaches the seed without passing through
// anonymizeBeats first. That is the whole job, hence the thin return.
//
// `beats` is the only field, because it is the only one anything reads.
// Narration is server-side and dictionary-driven, so the graph does not
// need to carry a schema_version, language, totals, period, or a style
// contract for itself: report already carries totals/period for the
// receipt, and app.js rebuilds { beats } from scratch before handing it
// over. Keeping the wrapper to exactly what is consumed avoids carrying
// fields across the Worker boundary on every run for nothing.
export function buildStoryGraph(rep) {
    return { beats: anonymizeBeats(buildBeats(rep), rep.protagonist) };
}
