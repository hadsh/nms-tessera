// Author: had.sh
// Synthetic geo-v1 payload used by the docs and by selftest. Hand-built, no
// real save and no real player: the point is to exercise every branch of the
// format at once (default galaxy and another one, a system with planets and a
// credit, a system dated with no attached pseudonym at all, an over-cap name
// and pseudonym, and a black hole route with a credited exit candidate).
//
// Every entry has the shape extract.js actually produces: `sources` and
// `planets` are always arrays (possibly empty), never absent - geo-v1 carries
// no bare-address system since 2026-08-02, so there is no shape without them.

import { buildGeoPayload, buildGeoPostBody } from '../lib/geo.js';

export function syntheticGeoInput() {
    return [
        // Discovery record: dated, named, planets, first-discoverer credit.
        {
            galaxy: 0, sysaddress: '01FFE9050A2', name: 'Nid',
            sources: [{ timestamp: 1471125030, user: 'ExplorerOne', date: '2016-08-13 22:10:30' }],
            planets: [
                { name: 'Eden', timestamp: 1471125030, date: '2016-08-13 22:10:30', vp1_raw: null },
                { name: null, timestamp: 1471211531, date: '2016-08-14 09:02:11', vp1_raw: null },
            ],
        },
        // Dated but anonymous: a timestamp with no attached username. credit
        // and date are null together (creditedDiscovery needs BOTH on the
        // same event), only the planet name survives.
        {
            galaxy: 15, sysaddress: '0F3B2C9917E', name: null,
            sources: [{ timestamp: 1472688000, user: null, date: '2016-09-01 00:00:00' }],
            planets: [{ name: 'Solo World', timestamp: 1472688000, date: '2016-09-01 00:00:00', vp1_raw: null }],
        },
        // Deliberately over the wire caps, with a 3-byte character straddling
        // the cut: proves every run that free text is bounded and that the
        // truncation never splits a code point.
        {
            galaxy: 0, sysaddress: '07A2D4E1C05', name: '☃'.repeat(30),
            sources: [{ timestamp: 1483614000, user: 'É'.repeat(40), date: '2017-01-05 11:00:00' }],
            planets: [],
        },
    ];
}

// One route, added after the fact: the route builder needs a timing pattern
// that a fixture this small cannot express, and the wire shape is what this
// fixture is for. Same name/credit/date rule as a system, on both ends.
export function syntheticRoutes() {
    return [
        {
            sysaddress: '0C7A1B33E10', galaxy: 0, name: null,
            credit: 'ExplorerOne', date: '2018-03-21 04:15:00',
            exit_candidate: {
                sysaddress: '09C8F3D5A21', name: 'Far Shore',
                credit: 'otherplayer', date: '2018-03-21 05:00:00',
            },
        },
    ];
}

export function syntheticGeo() {
    const geo = buildGeoPayload(syntheticGeoInput());
    geo.blackhole_routes = syntheticRoutes();
    return geo;
}

export async function syntheticGeoPost() {
    return buildGeoPostBody(syntheticGeo());
}
