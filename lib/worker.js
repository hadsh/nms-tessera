// Author: had.sh
// Web Worker for the pipeline: receives save file bytes, runs the pipeline
// stages off the main thread (UI stays responsive during JSON.parse of
// ~30 MB), returns log and results via messages. Stays alive across the 3
// phases below (does not terminate itself after any of them) so consent and
// beat-review choices can be relayed back in without re-parsing the save.
//
// Protocol (3 phases, worker stays alive between each):
//   main -> worker : { files: [{name, buffer: ArrayBuffer}], mapping }
//                                                                (phase 1 kickoff)
//   worker -> main : { type: 'log', msg }                        (any time)
//                  | { type: 'scanned', systemCount, undatedCount, rejectedCount, errors }
//                  | { type: 'error', msg }
//
//   main -> worker : { phase: 'geo', geoOptIn, mosaicOptIn }      (phase 2 kickoff)
//   worker -> main : { type: 'geo', geo, post, postJson }         (if geoOptIn)
//                  | { type: 'geo', skipped: true }               (if !geoOptIn)
//                  | { type: 'graph', report, graph, digests }    (always follows)
//                  | { type: 'error', msg }
//
//   main -> worker : { phase: 'confirm', beats }                  (phase 3 kickoff)
//   worker -> main : { type: 'result', seed }
//                  | { type: 'error', msg }
//
// No DOM here: logging passes via messages. The obfuscation mapping (3 KB)
// arrives inside the phase 1 message rather than being imported here. Firefox
// reported a default-src violation on mapping.json.js on this page (whose meta
// CSP sets default-src 'none'), and a worker-side import is the one plausible
// origin for a script fetch that lands on default-src instead of script-src.
// Unconfirmed: pipeline.js is imported here too and was never reported, so the
// explanation does not fully hold. Handing the mapping over costs nothing
// either way and removes one worker-side fetch from the equation.

import {
    scanSystems, loadMappingIfNeeded, buildGeoForOptIn, buildGraphFromSystems, finalizeSeed,
} from './pipeline.js';

const log = (msg) => self.postMessage({ type: 'log', msg });

// Carried between phases: set at the end of phase 1, read in phase 2/3.
let scanned = null;
let mosaicOptIn = false;

self.onmessage = async (e) => {
    try {
        if (!e.data.phase) {
            await handleFiles(e.data.files, e.data.mapping);
        } else if (e.data.phase === 'geo') {
            await handleGeo(e.data.geoOptIn, e.data.mosaicOptIn);
        } else if (e.data.phase === 'confirm') {
            await handleConfirm(e.data.beats);
        }
    } catch (err) {
        self.postMessage({ type: 'error', msg: String(err?.message ?? err) });
    }
};

async function handleFiles(rawFiles, obfuscationMapping) {
    const files = rawFiles.map((f) => ({
        name: f.name,
        bytes: new Uint8Array(f.buffer),
    }));
    // Fingerprint of the processed file, for the receipt (calculated BEFORE
    // the pipeline: it is the fingerprint of the input, no matter what).
    const digests = [];
    for (const f of files) {
        const h = await crypto.subtle.digest('SHA-256', f.bytes);
        digests.push({
            name: f.name,
            sha256: [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join(''),
        });
    }

    const mapping = await loadMappingIfNeeded(files, {
        log,
        loadMappingJson: async () => obfuscationMapping,
    });
    const { systems, playerStates, errors, undated, rejectedCount } =
        scanSystems(files, { log, mapping });

    scanned = { systems, playerStates, digests };
    self.postMessage({
        type: 'scanned',
        systemCount: systems.length,
        undatedCount: undated.length,
        rejectedCount,
        errors,
    });
}

async function handleGeo(geoOptIn, wantsMosaic) {
    mosaicOptIn = !!wantsMosaic;
    const { systems, playerStates, digests } = scanned;

    if (geoOptIn) {
        const { geo, post, postJson } = await buildGeoForOptIn({ systems }, { log });
        self.postMessage({ type: 'geo', geo, post, postJson });
    } else {
        self.postMessage({ type: 'geo', skipped: true });
    }

    const { report, graph } = buildGraphFromSystems({ systems, playerStates }, { log });
    self.postMessage({ type: 'graph', report, graph, digests });
}

async function handleConfirm(beats) {
    // destroyKey crosses back to the main thread and stops there: it goes on
    // the printed sheet and nowhere else. Never posted, never stored - the
    // worker is torn down right after this message.
    const { seed, destroyKey } = await finalizeSeed(beats, { mosaicPublic: mosaicOptIn, log });
    self.postMessage({ type: 'result', seed, destroyKey });
}
