// Author: had.sh
// Receipt: local receipt of each extraction, for the player.
// Contains the SHA-256 fingerprint of the processed file, a data summary, the
// seed (Payload B), and two facts ABOUT the geography payload - its encoding
// and its size in bytes - but not the payload itself. The readable geo JSON
// goes onto the printable sheet instead (app.js, fillPrintSheet).
// Nothing here persists: the receipt exists only for the duration of the
// page, handed to the player as JSON and as a printable sheet (window.print,
// "save as PDF"). Nothing is written to storage of any kind.

// The destroy key rides on the receipt because the receipt is the thing people
// keep. It is not a secret the receipt learns from anywhere: it was drawn in
// this tab, it was never sent, and once this page closes the only copy left is
// whichever one the player saved. That is the whole recovery story - there is
// no server-side reset, by design (see vendor/tessera/docs/privacy.md).
export function buildReceipt({ fileName, sha256, report, graph, seed, post, destroyKey }) {
    return {
        schema: 'ticket-v1',
        generated: new Date().toISOString().slice(0, 19).replace('T', ' ') + ' UTC',
        file: { name: fileName, sha256 },
        summary: {
            systems: report.totals.systems,
            events: report.totals.events,
            regions: report.totals.regions,
            named_planets: report.totals.named_planets,
            galaxies: report.totals.galaxies,
            period: report.period,
            birth: report.birth,
            teleports: report.trajectory.teleports.length,
            bases: report.trajectory.bases.length,
            beats: graph.beats.map((b) => b.type),
        },
        seed,
        destroy_key: destroyKey ?? null,
        post_encoding: post ? post.encoding : null,
        post_bytes: post ? JSON.stringify(post).length : 0,
    };
}
