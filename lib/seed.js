// Author: had.sh
// Payload B: story graph seed. Format v1.0 (POSITIONAL): the beat TYPE
// dictates exactly which fields follow, in a fixed order. No fact-id bytes,
// no per-beat fact count. theme/salience/season are DERIVED from the type
// server-side, never carried in the seed.
//
// Envelope: <base64url( crc8('had'+beats) | header | beats )>.1[z]
// - The version/compression tag is a minimal SUFFIX, no dot inside it: the
//   URL should open on the actual content, not a technical prefix, and the
//   tag itself must never contain the '.' separator, or the last-dot split
//   breaks.
// - '.1' = raw bytes, '.1z' = deflate-raw compressed.
// - crc8 salted with 'had' (CRC-8/SMBUS) verifies BEFORE reading the first
//   beat, so a flipped byte or a bad copy/paste decodes as "invalid seed"
//   rather than as a wrong story. It is eight bits: that is 255 corruptions
//   out of 256, not all of them, and it is not a signature.
//
// Every read is bounded and every non-canonical encoding is rejected: a
// truncated payload fails as truncated rather than spinning, and reserved
// header bits plus trailing bytes are refused rather than silently accepted.
// See readByte, HEADER_RESERVED_MASK and the tail check in decodeBeats.
//
// Header: a per-beat type BYTE is replaced by a 3-byte PRESENCE BITMASK
// (ceil(17 types / 8)) at the front of the payload. A beat type appears at
// most once by construction, so presence is all the header needs; the beat
// bodies then follow in BEAT_TYPES ascending order, no per-beat marker. This
// is safe because the narrative order is recomputed server-side from
// type/ts/rules, never from stream order - the per-beat order on the wire is
// not load-bearing.
//
// Dates carry month granularity: one ABSOLUTE month-index-since-epoch
// varint per dated beat, self-contained rather than chained as a delta from
// the previous beat. Two effects, both wanted: date size is decoupled from
// stream order (required since canonical order is not chronological order),
// and one bad date can never shift every date after it, because there is no
// "after it" in the chain.
//
// main_story_arc carries no `endings_touched` byte: the game sets
// apollo/artemis/null together the moment ACT3 is reached, so a field
// tracking which ending was reached would discriminate nothing.
// `epilogue_reached`/`artemis_choice` (two exclusive 0-2 enums) are packed
// into one combined byte instead of two.

import {
    base64urlEncode, base64urlDecode, crc8Had, compressionAvailable, deflateRaw, inflateRaw,
} from './compress.js';
import { COMMITMENT_BYTES } from './crockford.js';

export { base64urlEncode, base64urlDecode };

// Frozen beat-type dictionary (index = 1 header byte). Indices are FROZEN:
// a new type is appended, never inserted or renumbered.
const BEAT_TYPES = [
    'first_system', 'community_phase', 'center_journey', 'intergalactic_jump',
    'first_naming', 'journey_ends', 'favorite_base',
    'freighter_named', 'atlas_encounter', 'purple_systems', 'total_playtime',
    'settlements', 'final_session',
    'first_pet', 'multitool_named', 'main_story_arc', 'expedition_lore',
];
const BEAT_TYPE_MAP = Object.fromEntries(BEAT_TYPES.map((t, i) => [t, i]));

// Structurally undated beats: no day-delta in the stream (decoder knows by type).
const UNDATED_TYPES = new Set([
    'first_system', 'community_phase', 'freighter_named', 'total_playtime',
    'multitool_named', 'main_story_arc', 'expedition_lore',
]);

// Frozen, source vendor/NMSE-main/Resources/json/Creature Species.json (Id
// field, JSON output order). 85 values, 1 octet index instead of a string.
// Append-only: new values go at the end, indices are never renumbered.
export const CREATURE_IDS = [
    'FISH', 'FISHFLOCK', 'SWIMCOW', 'SWIMRODENT', 'JELLYFISH', 'CRAB', 'SEASNAKE',
    'SHARK', 'BIRD', 'FLYINGSNAKE', 'FLYINGLIZARD', 'BUTTERFLY', 'SMALLBIRD',
    'BUTTERFLOCK', 'LARGEBUTTERFLY', 'FLYINGBEETLE', 'ANTELOPE', 'ROBOTANTELOPE',
    'TRICERATOPS', 'RODENT', 'MOLE', 'COW', 'CAT', 'PLANTCAT', 'BONECAT', 'STRIDER',
    'STRIDERGLOW', 'TREX', 'TWOLEGANTELOPE', 'SIXLEGCOW', 'SIXLEGCAT', 'GRUNT',
    'BLOB', 'SPIDER', 'ARTHROPOD', 'WALKINGBUILDING', 'FLOATSPIDER', 'PROTOROLLER',
    'PROTOFLYER', 'PROTODIGGER', 'PLOUGH', 'DRILL', 'WEIRDROLL', 'WEIRDFLOAT',
    'WEIRDCRYSTAL', 'WEIRDBUTTERFLY', 'FIEND', 'BUGFIEND', 'BUGQUEEN', 'SCUTTLER',
    'SCUTTLER_PET', 'SLUG', 'MINIFIEND', 'FIENDFISHSMALL', 'FLOATER', 'MINIDRONE',
    'FIENDFISHBIG', 'ROCKCREATURE', 'SANDWORM', 'SPACE_FLOATER', 'LAND_JELLYFISH',
    'JELLYBOSS', 'JELLYBOSS_BROOD', 'ROBO_PET', 'HOVER_PET', 'LAND_SQUID',
    'PURPLE_WEIRD', 'DEEPFISH', 'DEEPFISHLARGE', 'DEEPFISHFLOCK', 'MANTA',
    'MANTAGLOW', 'SEAHORSE', 'SEAHORSEGLOW', 'SQUID', 'HERMITCRAB', 'PRAWN',
    'BONECOW', 'ROBO_RODENT', 'WALKER_CRAB', 'FISHBOWL_PET3', 'LANDSQUID_PET',
    'SPIDERQUAD_PET', 'HORROR_PET', 'QUAD_PET',
];
const CREATURE_ID_MAP = Object.fromEntries(CREATURE_IDS.map((id, i) => [id, i]));

// Frozen mission-id tables. Ordre alphabetique pour la lisibilite du diff,
// mais l'ordre n'est PAS une propriete requise: seul l'index d'un ID donne
// ne doit jamais bouger une fois publie.
//
// These 2 tables are used ONLY at extraction time (below, groupArcFlags) to
// group raw MissionProgress ids into per-arc booleans. They are NOT
// serialized into the seed: a raw 81/88-bit bitmask of every mission id
// would carry far more than the story needs, so it is reduced here to
// roughly 20 packed flag bits (see MAIN_STORY_ARC_GROUPS /
// EXPEDITION_LORE_GROUPS). AP_ANOMALY*/AP_EXPLORE* ids are excluded
// entirely: AP_ANOMALY is a legacy, pre-NEXUS era, NEXUS is its modern
// replacement, and the two overlap on saves that span both eras, so there is
// no clean either/or split between them; AP_EXPLORE*/AP_EXPLORE1 are
// near-extinct on the saves this was checked against. NEXUS7_ALIVE completes
// the DEAD/ALIVE alternate-branch pair for NEXUS7_DEAD (see
// MAIN_STORY_ARC_GROUPS below).
export const MAIN_STORY_MISSION_IDS = [
    'A3_CHOICE', 'ACT1_STEP1', 'ACT1_STEP10', 'ACT1_STEP11', 'ACT1_STEP12',
    'ACT1_STEP13', 'ACT1_STEP2', 'ACT1_STEP3', 'ACT1_STEP4', 'ACT1_STEP5',
    'ACT1_STEP6', 'ACT1_STEP7', 'ACT1_STEP8', 'ACT1_STEP9', 'ACT2_BEACON',
    'ACT2_STEP1', 'ACT2_STEP10', 'ACT2_STEP11', 'ACT2_STEP12', 'ACT2_STEP13',
    'ACT2_STEP2', 'ACT2_STEP3', 'ACT2_STEP4', 'ACT2_STEP5', 'ACT2_STEP6',
    'ACT2_STEP7', 'ACT2_STEP8', 'ACT2_STEP9', 'ACT3_APOLLO', 'ACT3_ARTEMIS',
    'ACT3_BEACON', 'ACT3_NULL', 'ACT3_STEP1', 'ACT3_STEP2', 'ACT3_STEP3',
    'ACT3_STEP4', 'EPILOGUE_NEWGAL', 'EPILOGUE_STAY', 'NEXUS1', 'NEXUS10',
    'NEXUS11', 'NEXUS12', 'NEXUS13', 'NEXUS14', 'NEXUS15', 'NEXUS1A',
    'NEXUS1_NADA1', 'NEXUS1_POLO1', 'NEXUS1_RECOVER', 'NEXUS2', 'NEXUS3',
    'NEXUS4', 'NEXUS5', 'NEXUS6', 'NEXUS6A_DEAD', 'NEXUS6A_SIM', 'NEXUS7_ALIVE',
    'NEXUS7_DEAD', 'NEXUS8', 'NEXUS9', 'NEXUS_DEFAULT', 'REMEMBRANCE',
    'STORY_INIT',
];
export const EXPEDITION_LORE_MISSION_IDS = [
    'ATLAS1', 'ATLAS10', 'ATLAS11', 'ATLAS2', 'ATLAS3', 'ATLAS4', 'ATLAS5',
    'ATLAS6', 'ATLAS7', 'ATLAS8', 'ATLAS9', 'ATLAS_LOOP_STAR', 'ATLAS_LORE',
    'BIO_FRIG', 'BIO_FRIG_DONE', 'BIO_SHIP1', 'BIO_SHIP2', 'BIO_SHIP3',
    'BIO_SHIP4', 'BIO_SHIP5', 'FARMER1', 'FARMER10', 'FARMER2', 'FARMER3',
    'FARMER4', 'FARMER5', 'FARMER6', 'FARMER7', 'FARMER8', 'FARMER9',
    'FARMER_LORE', 'OVERSEER1', 'OVERSEER10', 'OVERSEER2', 'OVERSEER3',
    'OVERSEER4', 'OVERSEER5', 'OVERSEER6', 'OVERSEER7', 'OVERSEER8',
    'OVERSEER9', 'OVERSEER_LORE', 'PIRATECLUE_COMM', 'PIRATES1', 'PIRATES2',
    'PIRATES3', 'PIRATES_LORE', 'PIRATE_HIDE', 'PIRATE_INIT',
    'PIRATE_MYSTERY1', 'PIRATE_MYSTERY2', 'PIRATE_MYSTERY3',
    'PIRATE_MYSTERY4', 'PIRATE_STATION', 'SCIENTIST1', 'SCIENTIST2',
    'SCIENTIST3', 'SCIENTIST4', 'SCIENTIST5', 'SCIENTIST6', 'SCIENTIST7',
    'SCIENTIST8', 'SCIENTIST9', 'SCIENTIST_LORE', 'SENTINELS_1',
    'SENTINELS_2', 'SENTINELS_3', 'SENTINELS_4', 'SENTINELS_5',
    'SETTLE_CLAIM', 'SETTLE_INTRO', 'SETTLE_MISS', 'SETTLE_SURVIVE',
    'WATERSTORY1', 'WATERSTORY2', 'WATERSTORY3', 'WATERSTORY4', 'WATERSTORY5',
    'WATERSTORY_LORE', 'WEAPGUY1', 'WEAPGUY2', 'WEAPGUY3', 'WEAPGUY4',
    'WEAPGUY5', 'WEAPGUY6', 'WEAPGUY7', 'WEAPGUY_LORE', 'WEAPGUY_REWARDS',
];

// Group MAIN_STORY_MISSION_IDS into named arcs, each reduced to a single
// "complete" bool (step/total never leaves the client). Order here is the
// BIT ORDER packed into the seed (alphabetical by flag name), frozen once
// shipped: same append-only discipline as BEAT_TYPES, never reorder.
//
// The naive "every raw id has Progress>0" criterion never fires for several
// arcs, even on saves that finished them. Two real causes, both handled
// here:
//   1. anomaly_complete/ap_explore_complete are DROPPED entirely (not just
//      excluded from a group): AP_ANOMALY*/AP_EXPLORE* are legacy IDs from
//      before NEXUS existed, and a character who played across both eras
//      keeps BOTH id sets active at once, so there is no way to pick one as
//      "the" anomaly arc. NEXUS is the modern equivalent and already covers
//      that ground.
//   2. Entries can be a NESTED ARRAY of alternate ids: satisfied if ANY one
//      of them is done, not all. Needed for exclusive branch outcomes
//      (NEXUS6A_DEAD vs NEXUS6A_SIM, NEXUS7_DEAD vs NEXUS7_ALIVE - a player
//      only ever gets one of each pair, so requiring both made the group
//      structurally unreachable). See isSatisfied() in packArcFlags below.
export const MAIN_STORY_ARC_GROUPS = [
    ['a3_choice_reached', ['A3_CHOICE']],
    ['act1_complete', ['ACT1_STEP1', 'ACT1_STEP2', 'ACT1_STEP3', 'ACT1_STEP4', 'ACT1_STEP5', 'ACT1_STEP6', 'ACT1_STEP7', 'ACT1_STEP8', 'ACT1_STEP9', 'ACT1_STEP10', 'ACT1_STEP11', 'ACT1_STEP12', 'ACT1_STEP13']],
    ['act2_complete', ['ACT2_BEACON', 'ACT2_STEP1', 'ACT2_STEP2', 'ACT2_STEP3', 'ACT2_STEP4', 'ACT2_STEP5', 'ACT2_STEP6', 'ACT2_STEP7', 'ACT2_STEP8', 'ACT2_STEP9', 'ACT2_STEP10', 'ACT2_STEP11', 'ACT2_STEP12', 'ACT2_STEP13']],
    ['act3_complete', ['ACT3_BEACON', 'ACT3_STEP1', 'ACT3_STEP2', 'ACT3_STEP3', 'ACT3_STEP4']],
    // NEXUS1_NADA1/NEXUS1_POLO1/NEXUS14 are excluded: same symptom as
    // expedition_lore's `_LORE` tails below - true on some mid-progress
    // saves but back to -1 on the most-advanced ones checked. Transient
    // checkpoint markers, not stable completion gates: keeping them meant the
    // bool could never fire on the very saves it should. The story matters
    // more than a literal reading of the raw ids - a bool this strict tells
    // no story at all, which is a selection bug, not a fact of the game.
    ['nexus_complete', ['NEXUS1', 'NEXUS1A', 'NEXUS1_RECOVER', 'NEXUS2', 'NEXUS3', 'NEXUS4', 'NEXUS5', 'NEXUS6', ['NEXUS6A_DEAD', 'NEXUS6A_SIM'], ['NEXUS7_DEAD', 'NEXUS7_ALIVE'], 'NEXUS8', 'NEXUS9', 'NEXUS10', 'NEXUS11', 'NEXUS12', 'NEXUS13', 'NEXUS15', 'NEXUS_DEFAULT']],
    ['remembrance_reached', ['REMEMBRANCE']],
    ['story_init_reached', ['STORY_INIT']],
];

// epilogue_reached: exclusive choice, never both on the same save.
// 0 = absent, 1 = stay, 2 = newgal.
export const EPILOGUE_MISSION_IDS = { EPILOGUE_STAY: 1, EPILOGUE_NEWGAL: 2 };
// artemis_choice (Nexus1A "The Purge"): exclusive, same pattern as epilogue.
// 0 = absent, 1 = dead (Allow Artemis to Die), 2 = sim (Upload to the
// Simulation). NEXUS6A_DEAD/NEXUS6A_SIM are mutually exclusive: never both
// present on the same save.
export const ARTEMIS_CHOICE_MISSION_IDS = { NEXUS6A_DEAD: 1, NEXUS6A_SIM: 2 };

// Same principle for EXPEDITION_LORE_MISSION_IDS: 11 arcs, one bool each.
// Bit order frozen once shipped.
//
// Every arc ending in a trailing `_LORE` id
// (atlas/farmer/overseer/pirates/scientist/waterstory/weapguy) can fail to
// reach "complete" even on saves that finished the rest of the arc. `_LORE`
// behaves like an accumulating collectible counter, not a required story
// beat, and its presence/absence is uncorrelated with how far the rest of
// the arc has progressed. Excluded from the completion check on all 7
// affected arcs: "complete" now means "finished the story", not "collected
// every last log". `_LORE` ids are left in EXPEDITION_LORE_MISSION_IDS
// (still real, still catalogued) but no longer gate any bool below.
//
// ATLAS11/ATLAS_LOOP_STAR are excluded from atlas_lore_complete for the same
// reason: they read as a repeatable post-completion "loop" bonus, not a
// required station, and gating on them left the bool unable to fire on
// saves that had clearly finished ATLAS1-10. Rule going forward: if a tail
// id makes a bool unable to fire on saves that otherwise finished the arc,
// it is not gating a real story requirement, and the selection is wrong,
// not the game - the story is what these bools exist to tell, so a bool too
// strict to ever say anything gets corrected, not preserved out of
// literalism.
export const EXPEDITION_LORE_GROUPS = [
    ['atlas_lore_complete', ['ATLAS1', 'ATLAS2', 'ATLAS3', 'ATLAS4', 'ATLAS5', 'ATLAS6', 'ATLAS7', 'ATLAS8', 'ATLAS9', 'ATLAS10']],
    ['bio_frig_complete', ['BIO_FRIG', 'BIO_FRIG_DONE']],
    ['bio_ship_complete', ['BIO_SHIP1', 'BIO_SHIP2', 'BIO_SHIP3', 'BIO_SHIP4', 'BIO_SHIP5']],
    ['farmer_complete', ['FARMER1', 'FARMER2', 'FARMER3', 'FARMER4', 'FARMER5', 'FARMER6', 'FARMER7', 'FARMER8', 'FARMER9', 'FARMER10']],
    ['overseer_complete', ['OVERSEER1', 'OVERSEER2', 'OVERSEER3', 'OVERSEER4', 'OVERSEER5', 'OVERSEER6', 'OVERSEER7', 'OVERSEER8', 'OVERSEER9', 'OVERSEER10']],
    ['pirates_complete', ['PIRATES1', 'PIRATES2', 'PIRATES3', 'PIRATE_INIT', 'PIRATE_HIDE', 'PIRATE_STATION', 'PIRATE_MYSTERY1', 'PIRATE_MYSTERY2', 'PIRATE_MYSTERY3', 'PIRATE_MYSTERY4', 'PIRATECLUE_COMM']],
    ['scientist_complete', ['SCIENTIST1', 'SCIENTIST2', 'SCIENTIST3', 'SCIENTIST4', 'SCIENTIST5', 'SCIENTIST6', 'SCIENTIST7', 'SCIENTIST8', 'SCIENTIST9']],
    ['sentinels_complete', ['SENTINELS_1', 'SENTINELS_2', 'SENTINELS_3', 'SENTINELS_4', 'SENTINELS_5']],
    ['settlement_arc_complete', ['SETTLE_INTRO', 'SETTLE_CLAIM', 'SETTLE_MISS', 'SETTLE_SURVIVE']],
    ['waterstory_complete', ['WATERSTORY1', 'WATERSTORY2', 'WATERSTORY3', 'WATERSTORY4', 'WATERSTORY5']],
    ['weapguy_complete', ['WEAPGUY1', 'WEAPGUY2', 'WEAPGUY3', 'WEAPGUY4', 'WEAPGUY5', 'WEAPGUY6', 'WEAPGUY7', 'WEAPGUY_REWARDS']],
];

// NMS release: 9 August 2016. JS months are 0-indexed, so August = 7.
export const EPOCH_DAY = Date.UTC(2016, 7, 9) / 86400000;

export function pushVarint(out, n) {
    n = Math.max(0, Math.round(n));
    while (n >= 128) {
        out.push((n % 128) + 128);
        n = Math.floor(n / 128);
    }
    out.push(n);
}

// Cumulative player-behavior counters (Stats.^GLOBAL_STATS) share one cap:
// no narrative value differentiating beyond it, and an unbounded outlier
// costs bytes and reads as a fingerprint (same reasoning journey_ends.total_deaths
// already applied before these facts existed).
function capCount(n) {
    return Math.min(9999, Math.max(0, Math.round(n ?? 0)));
}

// Every read below is bounded against bytes.length. Past the end a
// Uint8Array yields `undefined`, `undefined % 128` is NaN and
// `undefined < 128` is false, so an unbounded readVarint would spin forever
// on a truncated stream instead of failing: a payload with a trailing
// continuation byte would freeze the tab, the Worker and the CLI, with the
// event loop blocked so no timer could even report it.
function readByte(bytes, pos) {
    if (pos.i >= bytes.length) {
        throw new Error('seed: truncated payload');
    }
    return bytes[pos.i++];
}

// A varint is canonical only if its terminating (most significant) group is
// nonzero, the single-byte zero being the sole exception: 0x00 is minimal,
// 0x80 0x00 is the same value 0 spelled with a superfluous continuation
// byte. Left unrejected, that spare byte would let one story decode from
// two different byte strings, which breaks hash(seed) identity the same way
// a non-canonical header bit does (see HEADER_RESERVED_MASK above).
export function readVarint(bytes, pos) {
    let value = 0, mult = 1, count = 0;
    while (true) {
        const b = readByte(bytes, pos);
        count++;
        value += (b % 128) * mult;
        if (b < 128) {
            if (count > 1 && b === 0) {
                throw new Error('seed: non-minimal varint encoding');
            }
            return value;
        }
        mult *= 128;
    }
}

// Every integer on the wire is an unsigned varint, with no exception to
// look for: the format carries no signed value anywhere.

function pushString(out, s) {
    const enc = new TextEncoder().encode(s ?? '');
    pushVarint(out, enc.length);
    for (const byte of enc) out.push(byte);
}

function readString(bytes, pos) {
    const len = readVarint(bytes, pos);
    // slice() clamps silently, so an overlong length would otherwise yield a
    // short string and leave pos.i past the end, turning one bad byte into a
    // cascade of nonsense fields.
    if (pos.i + len > bytes.length) {
        throw new Error('seed: string overruns payload');
    }
    const slice = bytes.slice(pos.i, pos.i + len);
    pos.i += len;
    // Fatal decode: every other rejection path in this module refuses rather
    // than degrades (base64urlDecode, crockford.decode). A non-fatal decoder
    // would swap invalid UTF-8 for U+FFFD instead, breaking that discipline
    // and letting a malformed string field through as if it were clean.
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(slice);
    } catch {
        throw new Error('seed: invalid utf-8 in string field');
    }
}

// Custom-name compression, shared by every S name field the format carries
// (first_naming,
// favorite_base, freighter_named, settlements, atlas_encounter, first_pet,
// multitool_named): strip cosmetic tag/clan wrappers, CamelCase-compress
// (reversible) to shave bytes off the 16-char budget, uniform everywhere.

// Strips a leading/trailing bracket/paren/chevron wrapper (with its border
// spaces): "[TAG] Name" -> "Name", "Name (clan)" -> "Name". If nothing is
// left after stripping, returns '' (caller treats as "no name").
function stripNameTag(name) {
    let s = String(name ?? '').trim();
    s = s.replace(/^[\[(<][^\])>]*[\])>]\s*/, '');
    s = s.replace(/\s*[\[(<][^\])>]*[\])>]$/, '');
    return s.trim();
}

// CamelCase-compress: "Le Grand Nid" -> "LeGrandNid". Returns {packed,
// hadNoSpace}: hadNoSpace flags a name that had no space to begin with (the
// had_no_space bit), so the reader never re-splits an already-joined name.
function compressName(name) {
    const s = stripNameTag(name);
    if (!s) return { packed: '', hadNoSpace: false };
    if (!/\s/.test(s)) return { packed: s, hadNoSpace: true };
    const packed = s.split(/\s+/).filter(Boolean)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join('');
    return { packed, hadNoSpace: false };
}

// Re-inject a space before each internal word-start uppercase letter,
// mirror-reversing compressName. hadNoSpace true: never re-split (the name
// never had a space). Foreign/accented letters (Unicode \p{Lu}) are matched
// too, but never right after an apostrophe ('/'): "L'Atlas" stays intact
// instead of splitting into "L' Atlas", since compressName never breaks a
// word there either (the split is on whitespace only).
export function expandName(packed, hadNoSpace) {
    if (!packed) return '';
    if (hadNoSpace) return packed;
    return packed.replace(/(?<![\s'’]|^)(\p{Lu})/gu, ' $1');
}

// Push a name field truncated to 16 chars, a schema-wide cap. hadNoSpace
// travels as its own byte so readName can invert compressName exactly -
// every S name field uses this one writer/reader pair, no exceptions, so
// the cap and the compression can never drift field by field.
function pushName(out, name) {
    const { packed, hadNoSpace } = compressName(name);
    pushString(out, packed.slice(0, 16));
    out.push(hadNoSpace ? 1 : 0);
}

function readName(b, p) {
    const packed = readString(b, p);
    const hadNoSpace = !!readByte(b, p);
    return packed ? expandName(packed, hadNoSpace) : '';
}

// Address helpers: hex <-> varint of parseInt(hex,16). sysaddress = 11 hex;
// first_system packs the planet index as the leading hex digit (portal format
// PSSSYYZZZXXX), so the packed birth address is 12 hex (48 bits, safe integer).
function pushAddr(out, hex) { pushVarint(out, parseInt(hex, 16)); }
function readAddr(n, width) {
    const hex = n.toString(16).toUpperCase();
    // padStart only ever grows a string, so an oversized varint (more hex
    // digits than the field's width) would otherwise pass through
    // unshortened: a "sysaddress" a byte longer than any real one.
    if (hex.length > width) {
        throw new Error('seed: address exceeds ' + width + ' hex digits');
    }
    return hex.padStart(width, '0');
}

// Galaxy index: 0 (Euclid) through the last addressable galaxy - see
// App/Core/magic-numbers.php and the address format in CLAUDE.md ("1-256",
// 1-indexed there; every WRITER above documents 0 = Euclid, so 0-indexed
// here). A free varint would otherwise let a beat claim a galaxy the
// spatial databases don't have.
function readGalaxy(b, p) {
    const g = readVarint(b, p);
    if (g > 255) {
        throw new Error('seed: galaxy index out of range');
    }
    return g;
}

// dist_fly_class/dist_walked_class: flyDistanceClass/walkDistanceClass in
// beats.js only ever write 0-4 (5 buckets each). A raw byte read allows
// 0-255; rejecting the other 251 keeps the field a function of the bucket
// it names rather than of whatever byte a crafted seed carries.
function readDistClass(b, p) {
    const c = readByte(b, p);
    if (c > 4) {
        throw new Error('seed: distance class out of range');
    }
    return c;
}

export function tsToDayNum(dateStr) {
    const m = String(dateStr ?? '').match(/(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return EPOCH_DAY;
    return Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000;
}

function dayNumToDate(day) {
    const d = new Date(day * 86400000);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

// --- Arc flags: reduce a raw done_ids[] list to N packed booleans, one per
// named arc/group. Computed HERE at extraction/encode time so the raw
// 81/88-id bitmask never enters the seed - only the resulting bits do. The
// server-side reader consumes the same bit order and never recomputes
// "complete" itself (there is nothing left to derive it from).

// A group entry is either a plain id (required) or a nested array of
// alternate ids (satisfied if ANY one of them is done) - see
// MAIN_STORY_ARC_GROUPS nexus_complete for the exclusive-branch case this
// exists for (NEXUS6A_DEAD vs NEXUS6A_SIM, NEXUS7_DEAD vs NEXUS7_ALIVE).
function isSatisfied(doneSet, idOrAlts) {
    if (Array.isArray(idOrAlts)) return idOrAlts.some((id) => doneSet.has(id));
    return doneSet.has(idOrAlts);
}

/** doneIds: Set|array of mission-id strings actually done for this save. */
function packArcFlags(out, doneIds, groups) {
    const doneSet = doneIds instanceof Set ? doneIds : new Set(doneIds);
    let byte = 0;
    let bit = 0;
    for (const [, ids] of groups) {
        const complete = ids.every((idOrAlts) => isSatisfied(doneSet, idOrAlts));
        if (complete) byte |= 1 << bit;
        bit++;
        if (bit === 8) { out.push(byte); byte = 0; bit = 0; }
    }
    if (bit > 0) out.push(byte);
}

function unpackArcFlags(bytes, pos, groups) {
    const nBytes = Math.ceil(groups.length / 8);
    if (pos.i + nBytes > bytes.length) {
        throw new Error('seed: arc flags overrun payload');
    }
    const facts = {};
    for (let i = 0; i < groups.length; i++) {
        const byteVal = bytes[pos.i + (i >> 3)];
        facts[groups[i][0]] = !!(byteVal & (1 << (i % 8)));
    }
    pos.i += nBytes;
    return facts;
}

/** epilogue_reached: exclusive, 0=absent/1=stay/2=newgal. If both mission
 * ids are somehow present (should not happen), 'stay' wins, an arbitrary
 * but documented tie-break. */
function packEpilogueByte(doneIds) {
    const doneSet = doneIds instanceof Set ? doneIds : new Set(doneIds);
    if (doneSet.has('EPILOGUE_STAY')) return 1;
    if (doneSet.has('EPILOGUE_NEWGAL')) return 2;
    return 0;
}

function unpackEpilogueReached(byteVal) {
    return byteVal === 1 ? 'stay' : byteVal === 2 ? 'newgal' : null;
}

/** artemis_choice: exclusive, 0=absent/1=dead/2=sim. Mirror of packEpilogueByte. */
function packArtemisChoiceByte(doneIds) {
    const doneSet = doneIds instanceof Set ? doneIds : new Set(doneIds);
    if (doneSet.has('NEXUS6A_DEAD')) return 1;
    if (doneSet.has('NEXUS6A_SIM')) return 2;
    return 0;
}

function unpackArtemisChoice(byteVal) {
    return byteVal === 1 ? 'dead' : byteVal === 2 ? 'sim' : null;
}

// Per-type positional payload, in a FROZEN order per type. A writer pushes
// the SEED fields only; everything derived (region name, distances,
// when_rel, season, date, display names) is re-computed server-side, never
// carried here. 'galaxy' fields are 0 (Euclid) unless the beat documents
// otherwise; no shipped beat currently carries a non-Euclid galaxy field,
// but readers already tolerate any varint value.
const WRITERS = {
    first_system(out, f) {
        const packed = (f.planet_index ?? 0).toString(16).toUpperCase() + f.sysaddress;
        pushAddr(out, packed); // 12 hex, 48 bits
        pushVarint(out, f.start_year || 0); // year the journey began (0 = unknown)
    },
    community_phase(out, f) { pushVarint(out, f.distinct_users); },
    // "flotte": freighter name (player baptism) + fleet counters
    // (Stats.^GLOBAL_STATS) ride together on this beat. bio_ship_complete
    // stays its own beat; any fusion is prose-level only, never a mechanical
    // link between the two.
    freighter_named(out, f) {
        pushName(out, f.name);
        pushVarint(out, capCount(f.frigates));
        pushVarint(out, capCount(f.ships_owned));
        pushVarint(out, capCount(f.ships_bought));
    },
    total_playtime(out, f) { pushVarint(out, f.seconds); },
    first_naming(out, f) {
        pushAddr(out, f.sysaddress);
        pushName(out, f.system_name);
        pushName(out, f.planet_name);
    },
    settlements(out, f) {
        pushVarint(out, f.total_population);
        pushName(out, (f.names ?? [])[0] ?? '');
        // sysaddress of the first-claimed settlement. galaxy always 0,
        // claimed_ts is the beat's own ts (proxy regime).
        pushAddr(out, f.sysaddress ?? '00000000000');
    },
    center_journey(out, f) {
        pushAddr(out, f.closest_system);
        // blackhole_warps (Stats.^GLOBAL_STATS) rides here under the
        // "road to center" theme.
        pushVarint(out, capCount(f.blackhole_warps));
    },
    intergalactic_jump(out, f) { pushVarint(out, f.to_galaxy); },
    atlas_encounter(out, f) {
        pushAddr(out, f.sysaddress);           // 07A* system (SSI 0x7A = Atlas station)
        pushVarint(out, f.galaxy || 0);         // galaxy (0 = Euclid, default)
        pushName(out, f.system_name ?? '');     // custom name if baptized, else empty
    },
    purple_systems(out, f) {
        pushAddr(out, f.first_system.sysaddress);
        pushVarint(out, f.first_system.galaxy || 0); // galaxy (0 = Euclid)
    },
    favorite_base(out, f) {
        pushAddr(out, f.sysaddress);
        pushName(out, f.name);
        // bases_built (rep.trajectory.bases.length). Known-unreliable source
        // on some save exports, carried as-is: out of scope here.
        pushVarint(out, capCount(f.bases_built));
    },
    journey_ends(out, f) {
        pushVarint(out, f.total_systems);
        pushVarint(out, f.total_regions);
        pushVarint(out, f.total_galaxies);
        pushVarint(out, f.total_events);
        pushVarint(out, f.active_days);
        // total_deaths: Stats.^GLOBAL_STATS.^DEATHS, capped at 999: no
        // narrative value differentiating beyond that.
        pushVarint(out, Math.min(999, f.total_deaths ?? 0));
        // The closing beat also carries the exploration/combat tally.
        pushVarint(out, capCount(f.systems_discovered));
        pushVarint(out, capCount(f.planets_discovered));
        out.push((f.dist_fly_class ?? 0) & 0xFF);
        out.push((f.dist_walked_class ?? 0) & 0xFF);
        pushVarint(out, capCount(f.sentinel_kills));
    },
    final_session(out, f) { pushVarint(out, f.events_that_day); },
    first_pet(out, f) {
        pushAddr(out, f.sysaddress);
        out.push(CREATURE_ID_MAP[f.creature_id] ?? 0);
        pushName(out, f.name ?? ''); // strip-tag + CamelCase, empty if unnamed
        // The companion beat also carries the wider creature-keeping stats
        // (Stats.^GLOBAL_STATS).
        pushVarint(out, capCount(f.pets_owned));
        pushVarint(out, capCount(f.creatures_fed));
        pushVarint(out, capCount(f.creatures_discovered));
    },
    multitool_named(out, f) {
        const { packed, hadNoSpace } = compressName(f.name);
        pushString(out, packed.slice(0, 16));
        out.push((f.is_large ? 1 : 0) | (hadNoSpace ? 2 : 0));
    },
    // f.done_ids: raw MissionProgress ids. Reduced HERE to arc flags, never
    // carried raw in the seed (see MAIN_STORY_ARC_GROUPS/EXPEDITION_LORE_GROUPS
    // above).
    main_story_arc(out, f) {
        const doneSet = new Set(f.done_ids ?? []);
        packArcFlags(out, doneSet, MAIN_STORY_ARC_GROUPS); // 1 byte, 7 bools
        // epilogue_reached (0-2) and artemis_choice (0-2) packed into one
        // byte, 0-8. No byte tracks which ending was reached: the game sets
        // apollo/artemis/null together, so that fact would discriminate
        // nothing.
        out.push(packEpilogueByte(doneSet) * 3 + packArtemisChoiceByte(doneSet));
    },
    expedition_lore(out, f) {
        packArcFlags(out, f.done_ids ?? [], EXPEDITION_LORE_GROUPS); // 2 bytes, 11 bools
        // Trailing counters, not a redesign of the bools-only pack above:
        // pirates_killed and flora_discovered ride on this beat alongside
        // the arc flags rather than getting a beat of their own.
        pushVarint(out, capCount(f.pirates_killed));
        pushVarint(out, capCount(f.flora_discovered));
    },
};

const READERS = {
    first_system(b, p) {
        const packed = readAddr(readVarint(b, p), 12);
        const start_year = readVarint(b, p);
        return { sysaddress: packed.slice(1), planet_index: parseInt(packed[0], 16), start_year };
    },
    community_phase(b, p) { return { distinct_users: readVarint(b, p) }; },
    freighter_named(b, p) {
        const name = readName(b, p);
        const frigates = readVarint(b, p);
        const ships_owned = readVarint(b, p);
        const ships_bought = readVarint(b, p);
        return { name, frigates, ships_owned, ships_bought };
    },
    total_playtime(b, p) { return { seconds: readVarint(b, p) }; },
    first_naming(b, p) {
        return {
            sysaddress: readAddr(readVarint(b, p), 11),
            system_name: readName(b, p),
            planet_name: readName(b, p),
        };
    },
    settlements(b, p) {
        const total_population = readVarint(b, p);
        const name = readName(b, p);
        const sysaddress = readAddr(readVarint(b, p), 11);
        return { total_population, names: name ? [name] : [], sysaddress };
    },
    center_journey(b, p) {
        return {
            closest_system: readAddr(readVarint(b, p), 11),
            blackhole_warps: readVarint(b, p),
        };
    },
    intergalactic_jump(b, p) { return { to_galaxy: readGalaxy(b, p) }; },
    atlas_encounter(b, p) {
        return {
            sysaddress: readAddr(readVarint(b, p), 11),
            galaxy: readGalaxy(b, p),
            system_name: readName(b, p),
        };
    },
    purple_systems(b, p) {
        return {
            first_system: { sysaddress: readAddr(readVarint(b, p), 11), galaxy: readGalaxy(b, p) },
        };
    },
    favorite_base(b, p) {
        const sysaddress = readAddr(readVarint(b, p), 11);
        const name = readName(b, p);
        const bases_built = readVarint(b, p);
        return { sysaddress, name, bases_built };
    },
    journey_ends(b, p) {
        return {
            total_systems: readVarint(b, p), total_regions: readVarint(b, p),
            total_galaxies: readVarint(b, p), total_events: readVarint(b, p),
            active_days: readVarint(b, p),
            total_deaths: readVarint(b, p),
            systems_discovered: readVarint(b, p),
            planets_discovered: readVarint(b, p),
            dist_fly_class: readDistClass(b, p),
            dist_walked_class: readDistClass(b, p),
            sentinel_kills: readVarint(b, p),
        };
    },
    final_session(b, p) { return { events_that_day: readVarint(b, p) }; },
    first_pet(b, p) {
        const sysaddress = readAddr(readVarint(b, p), 11);
        const creatureIdx = readByte(b, p);
        if (creatureIdx >= CREATURE_IDS.length) {
            throw new Error('seed: creature index out of range');
        }
        const creature_id = CREATURE_IDS[creatureIdx];
        const name = readName(b, p);
        const pets_owned = readVarint(b, p);
        const creatures_fed = readVarint(b, p);
        const creatures_discovered = readVarint(b, p);
        return {
            sysaddress, creature_id, name: name || null,
            pets_owned, creatures_fed, creatures_discovered,
        };
    },
    multitool_named(b, p) {
        const packed = readString(b, p);
        const flags = readByte(b, p);
        const is_large = !!(flags & 1);
        const had_no_space = !!(flags & 2);
        return { name: expandName(packed, had_no_space), is_large };
    },
    main_story_arc(b, p) {
        const facts = unpackArcFlags(b, p, MAIN_STORY_ARC_GROUPS);
        const combined = readByte(b, p);
        // Valid range is 0-8 (epilogue_reached 0-2) * 3 + (artemis_choice
        // 0-2)): 247 of the 256 possible byte values are not a writer
        // output, and most of them alias one of the 9 real combinations.
        // Rejecting them keeps the byte a function of the story rather than
        // of whichever alias last encoded it.
        if (combined > 8) {
            throw new Error('seed: main_story_arc combined byte out of range');
        }
        facts.epilogue_reached = unpackEpilogueReached(Math.floor(combined / 3));
        facts.artemis_choice = unpackArtemisChoice(combined % 3);
        return facts;
    },
    expedition_lore(b, p) {
        const facts = unpackArcFlags(b, p, EXPEDITION_LORE_GROUPS);
        facts.pirates_killed = readVarint(b, p);
        facts.flora_discovered = readVarint(b, p);
        return facts;
    },
};

// Header bitmask: ceil(17 types / 8) = 3 bytes, bit `idx` (BEAT_TYPES[idx])
// set when that beat is present. A type appears at most once, so presence is
// enough; bodies then follow in BEAT_TYPES ascending order.
const HEADER_BYTES = Math.ceil(BEAT_TYPES.length / 8);

// mosaic_public: consent bit for the public mosaic gallery, set by the
// depositor at generation time and read server-side before ever creating a
// public tile. NOT a beat type: lives in the same header bytes but at a
// fixed index past BEAT_TYPES.length, so it costs nothing (the header
// already transmits HEADER_BYTES*8 bits, only BEAT_TYPES.length of them are
// spoken for).
const MOSAIC_PUBLIC_BIT = BEAT_TYPES.length;

// Bits 18..23 of the header are spare capacity, not free space, and a
// decoder rejects a seed that sets any of them. Leaving them unchecked
// would make them 64 ways to spell the same story: 64 distinct seed
// strings, 64 distinct sha256 values, one story, which breaks anything that
// keys off hash(seed), the moderation blocklist and the gallery tile
// identity included. Rejecting them on decode makes the encoding canonical,
// so seed identity is a property of the story rather than of whoever last
// re-encoded it. Reserved for future bits: the day one is spoken for, this
// mask shrinks and old seeds keep decoding, since they carry zeros there by
// construction.
const HEADER_RESERVED_MASK = [];
for (let n = 0; n < HEADER_BYTES; n++) {
    let m = 0;
    for (let bit = 0; bit < 8; bit++) {
        const idx = n * 8 + bit;
        if (idx >= BEAT_TYPES.length && idx !== MOSAIC_PUBLIC_BIT) m |= 1 << bit;
    }
    HEADER_RESERVED_MASK.push(m);
}

function pushHeader(out, presentTypes, { mosaicPublic = false } = {}) {
    const mask = new Array(HEADER_BYTES).fill(0);
    for (const type of presentTypes) {
        const idx = BEAT_TYPE_MAP[type];
        if (idx === undefined) {
            throw new Error('seed: unknown beat type ' + type);
        }
        mask[idx >> 3] |= 1 << (idx % 8);
    }
    if (mosaicPublic) {
        mask[MOSAIC_PUBLIC_BIT >> 3] |= 1 << (MOSAIC_PUBLIC_BIT % 8);
    }
    for (const byte of mask) out.push(byte);
}

function readHeader(bytes, pos) {
    const mask = [];
    for (let n = 0; n < HEADER_BYTES; n++) mask.push(readByte(bytes, pos));
    for (let n = 0; n < HEADER_BYTES; n++) {
        if (mask[n] & HEADER_RESERVED_MASK[n]) {
            throw new Error('seed: reserved header bit set');
        }
    }
    const types = [];
    for (let idx = 0; idx < BEAT_TYPES.length; idx++) {
        if (mask[idx >> 3] & (1 << (idx % 8))) types.push(BEAT_TYPES[idx]);
    }
    const mosaicPublic = !!(mask[MOSAIC_PUBLIC_BIT >> 3] & (1 << (MOSAIC_PUBLIC_BIT % 8)));
    return { types, mosaicPublic };
}

// The destroy-key commitment: 15 raw bytes, right after the header and before
// the first beat, on EVERY seed. See crockford.js for what it is and why it
// lives here rather than in a server row (short version: parked beside the seed
// it would be a detachable label anyone could swap for a commitment to a key of
// their own; carried inside, it is covered by the seed's own identity).
//
// Unconditional, so it costs no header bit and bits 18..23 stay reserved for
// future beat types. Making it optional would have bought 15 bytes back on the
// seeds that declined, at the price of a class of stories nobody can ever take
// down - the exact gap this field exists to close.
//
// Incompressible by construction (it is a hash), so deflate never wins anything
// on these bytes: budget the full 15 against the QR ceiling, never less.
function pushCommitment(out, commitment) {
    if (!commitment || commitment.length !== COMMITMENT_BYTES) {
        throw new Error('seed: commitment must be ' + COMMITMENT_BYTES + ' bytes');
    }
    for (const byte of commitment) out.push(byte);
}

// Reads through readByte so a truncated seed fails as truncated here, rather
// than silently handing back a short commitment that could never match.
function readCommitment(bytes, pos) {
    const out = new Uint8Array(COMMITMENT_BYTES);
    for (let n = 0; n < COMMITMENT_BYTES; n++) out[n] = readByte(bytes, pos);
    return out;
}

// Month-granularity date: one absolute month index since NMS release
// (2016-08), plain unsigned varint, no chaining - see the header comment at
// the top of this file for why (decouples date size from stream order, and
// one bad value can no longer desync the dates after it). Decoded back to a
// synthetic mid-month day ('-15'): nothing downstream (season, date_human,
// relDuration, the narrative ordering's ts comparator) reads finer than
// month or year.
function monthsSinceEpoch(dateStr) {
    const m = String(dateStr ?? '').match(/(\d{4})-(\d{2})/);
    if (!m) return 0;
    return Math.max(0, (+m[1] - 2016) * 12 + (+m[2] - 8));
}

// Same plausibility ceiling limits.js already applies to every timestamp
// read from a save (MAX_PLAUSIBLE_TS, 2100-01-01): a free varint here would
// let a dated beat claim a year the rest of the pipeline already treats as
// impossible. 1000 is the last index inside that ceiling (2099-12).
const MAX_MONTH_INDEX = 1000;

function monthIdxToDate(idx) {
    if (idx > MAX_MONTH_INDEX) {
        throw new Error('seed: month index out of range');
    }
    const total = 7 + idx; // epoch = August 2016, 0-indexed month 7
    const y = 2016 + Math.floor(total / 12);
    const mo = (total % 12) + 1;
    const p = (n) => String(n).padStart(2, '0');
    return `${y}-${p(mo)}-15`;
}

function encodeBeats(beats, { mosaicPublic = false, commitment = null } = {}) {
    const out = [];
    const byType = new Map(beats.map((b) => [b.type, b]));
    pushHeader(out, beats.map((b) => b.type), { mosaicPublic });
    pushCommitment(out, commitment);
    for (const type of BEAT_TYPES) {
        const b = byType.get(type);
        if (!b) continue;
        if (!UNDATED_TYPES.has(type)) {
            pushVarint(out, monthsSinceEpoch(b.ts));
        }
        WRITERS[type](out, b.facts);
    }
    return new Uint8Array(out);
}

function decodeBeats(bytes) {
    const pos = { i: 0 };
    const beats = [];
    const { types: presentTypes } = readHeader(bytes, pos);
    readCommitment(bytes, pos); // fixed field, skipped here - see peekCommitment
    for (const type of presentTypes) {
        let ts = null;
        if (!UNDATED_TYPES.has(type)) {
            ts = monthIdxToDate(readVarint(bytes, pos));
        }
        beats.push({ type, ts, seed_facts: READERS[type](bytes, pos) });
    }
    // Trailing bytes are the second way a seed could be non-canonical:
    // appending anything after the last beat would let the decoder stop
    // early, producing the same story under a different string and a
    // different hash(seed). Same reasoning as HEADER_RESERVED_MASK above -
    // one story, one encoding.
    if (pos.i !== bytes.length) {
        throw new Error('seed: trailing bytes after the last beat');
    }
    return beats;
}

// Envelope: crc8('had'+beats) as 1 leading byte, then the beats stream.
function frame(beatsBytes) {
    const framed = new Uint8Array(1 + beatsBytes.length);
    framed[0] = crc8Had(beatsBytes);
    framed.set(beatsBytes, 1);
    return framed;
}

function unframe(framed) {
    if (framed.length < 1) {
        throw new Error('seed: empty payload');
    }
    const crc = framed[0];
    const beatsBytes = framed.slice(1);
    if (crc8Had(beatsBytes) !== crc) {
        throw new Error('seed: crc8 mismatch (corruption or missing watermark)');
    }
    return beatsBytes;
}

// encodeSeed is async: deflate-raw compression is attempted when available
// (CompressionStream), the shorter of raw/compressed wins. Suffix records
// which was used so decodeSeed never has to guess.
export async function encodeSeed(beats, { mosaicPublic = false, commitment = null } = {}) {
    const framed = frame(encodeBeats(beats, { mosaicPublic, commitment }));
    const rawSeed = base64urlEncode(framed) + '.1';
    if (!compressionAvailable()) {
        return rawSeed;
    }
    const packed = await deflateRaw(framed);
    const packedSeed = base64urlEncode(packed) + '.1z';
    return packedSeed.length < rawSeed.length ? packedSeed : rawSeed;
}

// Shared envelope unwrap (tag parse, base64url/inflate, crc8 check via
// unframe): decodeSeed and peekMosaicPublic both need a crc-verified beats
// byte string, never two divergent parsing paths for the same bytes.
async function unwrapSeed(seed) {
    const dot = seed.lastIndexOf('.');
    if (dot === -1) {
        throw new Error('seed: missing version suffix');
    }
    const tag = seed.slice(dot + 1);
    const body = seed.slice(0, dot);
    let framed;
    if (tag === '1') {
        framed = base64urlDecode(body);
    } else if (tag === '1z') {
        if (!compressionAvailable()) {
            throw new Error('seed: compressed seed, but DecompressionStream unavailable');
        }
        framed = await inflateRaw(base64urlDecode(body));
    } else {
        throw new Error('seed: unsupported version (expected 1 or 1z)');
    }
    return unframe(framed);
}

export async function decodeSeed(seed) {
    return decodeBeats(await unwrapSeed(seed));
}

// Reads ONLY the mosaic_public consent bit, without decoding the full beat
// stream - crc8 is still verified first (unwrapSeed -> unframe): never trust
// a header bit read from a seed that fails its own integrity check.
export async function peekMosaicPublic(seed) {
    const beatsBytes = await unwrapSeed(seed);
    const { mosaicPublic } = readHeader(beatsBytes, { i: 0 });
    return mosaicPublic;
}

// Reads ONLY the destroy-key commitment, without decoding the beats: what the
// destroy endpoint needs to verify a typed key, and nothing more. crc8 is
// verified first (unwrapSeed -> unframe), so a corrupted seed never yields a
// commitment to compare against.
export async function peekCommitment(seed) {
    const beatsBytes = await unwrapSeed(seed);
    const pos = { i: 0 };
    readHeader(beatsBytes, pos);
    return readCommitment(beatsBytes, pos);
}
