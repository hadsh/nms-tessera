// Author: had.sh
// Complete pipeline orchestration: files -> extract -> geo/post ->
// report -> beats -> seed. No DOM or disk access: usable identically from
// Web Worker (worker.js), inline fallback (app.js without Worker), and the
// vendor/tessera Node CLI/selftest harness.
//
// log(msg) receives the same journal lines regardless of host;
// loadMappingJson() is provided by host (returns the bundled mapping.json.js
// module, no fetch) and is only called if obfuscated save (LZ4) detected.
//
// Split into 4 stages (scanSystems -> buildGeoForOptIn -> buildGraphFromSystems
// -> finalizeSeed) so the interactive UI (worker.js) can pause between them for
// consent (geo/mosaic opt-in) and beat review before a seed is ever computed.
// runPipeline recomposes all 4 in the same order as before this split, with no
// gate: it is the stable entry point vendor/tessera's CLI and selftest rely on,
// their return-shape contract (`{..., seed}`) is unchanged.

import { buildMapping, extractFromFiles, hasLz4Magic } from './extract.js';
import { buildGeoPayload, buildGeoPostBody } from './geo.js';
import { buildReport } from './report.js';
import { buildStoryGraph } from './beats.js';
import { encodeSeed } from './seed.js';
import { generateKey, commitment } from './crockford.js';

// Stage 1: extract + validate. The only stage that needs to know about raw
// files/mapping. Throws (mono-save: one unreadable file = immediate error,
// not a pipeline that outputs zeros) if nothing usable was found.
export function scanSystems(files, { log = () => {}, mapping = {} } = {}) {
    log('extracting discoveries...');
    const { systems, playerStates, errors, rejectedTs, undated } =
        extractFromFiles(files, mapping, log);
    if (!systems.length) {
        throw new Error(errors.length ? errors[0].error : 'no systems extracted');
    }
    log(`  ${systems.length} unique dated systems`);
    if (undated.length) {
        log(`  ${undated.length} systems excluded (no dated events)`);
    }
    let rejectedCount = 0;
    for (const c of rejectedTs.values()) rejectedCount += c;
    if (rejectedCount) {
        log(`  ${rejectedCount} invalid timestamps rejected (< NMS release)`);
    }
    if (errors.length) {
        log(`  ${errors.length} files in error: ${errors.map((e) => e.file).join(', ')}`);
    }

    return { systems, playerStates, errors, rejectedTs, undated, rejectedCount };
}

// Loads the LZ4 deobfuscation mapping only if needed - shared by runPipeline
// and by callers (worker.js) doing scanSystems as their own first step.
export async function loadMappingIfNeeded(files, { log = () => {}, loadMappingJson }) {
    if (files.some((f) => hasLz4Magic(f.bytes))) {
        log('obfuscated save detected, loading deobfuscation mapping...');
        const mapping = buildMapping(await loadMappingJson());
        log(`  ${Object.keys(mapping).length} mapping keys loaded`);
        return mapping;
    }
    log('plaintext JSON format save, no mapping needed');
    return {};
}

// Stage 2: Payload A (geography), built ONLY once the depositor opts in -
// zero-cost to skip entirely (never called) when they don't. Every system
// here is a discovery record (see buildGeoPayload); there is no bare-address
// layer to merge in.
export async function buildGeoForOptIn({ systems }, { log = () => {} } = {}) {
    log('Payload A (geography)...');
    const geo = buildGeoPayload(systems);
    log(`  ${geo.systems.length} systems, ${geo.blackhole_routes.length} blackhole routes`);
    const post = await buildGeoPostBody(geo);
    const postJson = JSON.stringify(post);
    log(`  POST body: encoding ${post.encoding}, ${postJson.length} bytes ` +
        `(readable JSON: ${JSON.stringify(geo).length})`);

    return { geo, post, postJson };
}

// Stage 3: facts (report) + beats (story graph). Independent of the geo
// opt-in choice - runs regardless, right after scanSystems.
export function buildGraphFromSystems({ systems, playerStates }, { log = () => {} } = {}) {
    log('facts (report)...');
    const report = buildReport(systems, playerStates);
    log(`  ${report.totals.events} events, ${report.totals.regions} regions, ` +
        `${report.contributors.length} contributors`);
    log(report.birth.source === 'save_field'
        ? `  certified birth: ${report.birth.sysaddress} ` +
          `(galaxy ${report.birth.galaxy}, planet ${report.birth.planet_index})`
        : `  inferred birth (cradle): region ${report.birth.region} ` +
          `galaxy ${report.birth.galaxy}`);
    log(`  trajectory: ${report.trajectory.teleports.length} teleports, ` +
        `${report.trajectory.bases.length} bases`);

    log('beats (Payload B, pre-review)...');
    const graph = buildStoryGraph(report);
    log(`  ${graph.beats.length} beats detected`);

    return { report, graph };
}

// Stage 4: seed encoding, only once the (possibly user-edited/pruned) beats
// list is confirmed. v1.0 positional binary, crc8 watermark, deflate-raw when
// it helps, mosaic_public header bit when opted in (seed.js).
//
// The destroy key is minted here because this is the moment the seed's bytes
// are decided: its commitment is part of them, so the key cannot be added
// afterwards without producing a different story. The key itself goes to the
// caller and no further - it is never sent, never stored, and the only copy
// that outlives the tab is the one the depositor keeps from the printed sheet.
export async function finalizeSeed(beats, { mosaicPublic = false, log = () => {} } = {}) {
    const destroyKey = generateKey();
    const seed = await encodeSeed(beats, { mosaicPublic, commitment: await commitment(destroyKey) });
    log(`  ${beats.length} beats, seed ${seed.slice(0, 5)} ${seed.length} chars`);
    return { seed, destroyKey };
}

export async function runPipeline(files, { log = () => {}, loadMappingJson }) {
    const mapping = await loadMappingIfNeeded(files, { log, loadMappingJson });

    const { systems, playerStates, errors, undated, rejectedCount } =
        scanSystems(files, { log, mapping });

    const { geo, post, postJson } = await buildGeoForOptIn({ systems }, { log });

    const { report, graph } = buildGraphFromSystems({ systems, playerStates }, { log });

    const { seed, destroyKey } = await finalizeSeed(graph.beats, { log });

    return {
        systems, playerStates, geo, post, postJson, report, graph, seed, destroyKey,
        stats: { rejected: rejectedCount, undated, errors },
    };
}
