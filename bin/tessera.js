#!/usr/bin/env node
// Author: had.sh
// tessera CLI: runs the exact browser pipeline (lib/, byte-identical copy of
// the site assets) on a local machine, with no network and no dependency.
//
// Why it exists: the recipe is meant to be auditable. Anyone can take this
// directory, run the pipeline on their own save, read every intermediate
// payload, decode the seed back, and check that nothing else is computed or
// emitted. The only command that opens a socket is `serve`, and it binds
// 127.0.0.1 to serve the local page.
//
// Deliberately absent: any command claiming to verify that lib/ is the site's
// code. A checker shipping alongside the thing it checks proves nothing, so
// that verification is a diff against what the site actually serves, done with
// your own tools (docs/audit.md section 3).
//
// Usage: node bin/tessera.js help

import fs from 'fs';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';

import { runPipeline } from '../lib/pipeline.js';
import { mapping as OBFUSCATION_MAPPING } from '../lib/mapping.json.js';
import { decodeSeed, encodeSeed } from '../lib/seed.js';
import { base64urlDecode, inflateRaw } from '../lib/compress.js';
import { MAX_SAVE_BYTES } from '../lib/limits.js';
import { runSelftest, maxSyntheticBeats, TEST_COMMITMENT } from '../test/selftest.js';
import { annotateSeed, formatAnnotation, BEAT_TYPES, HEADER_BYTES, COMMITMENT_BYTES } from '../tools/annotate.js';
import { annotateGeo, formatGeoAnnotation } from '../tools/annotate-geo.js';

const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIB_DIR = path.join(PKG_DIR, 'lib');

const USAGE = `tessera: offline NMS save -> story seed pipeline

  tessera run <save.hg>          full pipeline, human-readable summary
  tessera seed <save.hg>         the seed (Payload B) alone
  tessera beats <save.hg>        detected beats, as JSON
  tessera geo <save.hg> [--post] geography (Payload A), readable or POST body
  tessera report <save.hg>       aggregated facts, as JSON
  tessera decode <seed|file>     seed -> beats, JSON (round-trip audit)
  tessera spec [--json]          the frozen seed tables, read back from the code
  tessera dump <seed|file>       byte by byte listing of a seed, with the bits
  tessera dump-geo <file|data>   same, for a geo-v1 POST body (Payload A)
  tessera selftest               format checks, no save file needed
  tessera serve [--port 8787]    local page (127.0.0.1), offline browser run
  tessera help | version

Options
  --out <file>   write the command output to a file instead of stdout
  --quiet        drop the pipeline journal (stderr) and keep only the result
  --pretty       indent JSON output (default for decode/beats/report)

Nothing leaves this machine: no telemetry, no fetch, no auto-upload.
`;

// --- small helpers -------------------------------------------------------

function parseArgs(argv) {
    const opts = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--out') opts.out = argv[++i];
        else if (a === '--port') opts.port = parseInt(argv[++i], 10);
        else if (a.startsWith('--')) opts[a.slice(2)] = true;
        else opts._.push(a);
    }
    return opts;
}

function die(msg) {
    process.stderr.write(`tessera: ${msg}\n`);
    process.exit(1);
}

function emit(text, opts) {
    if (opts.out) {
        fs.writeFileSync(opts.out, text.endsWith('\n') ? text : text + '\n');
        process.stderr.write(`wrote ${opts.out}\n`);
        return;
    }
    process.stdout.write(text.endsWith('\n') ? text : text + '\n');
}

function json(value, opts, prettyByDefault = true) {
    const pretty = opts.pretty ?? prettyByDefault;
    return JSON.stringify(value, null, pretty ? 2 : 0);
}

// Reads the save files named on the command line, in the shape the browser
// hands to the pipeline: { name, bytes }. The size cap is the same as the
// page (limits.js), so the CLI cannot be a softer door than the web input.
function readSaves(paths) {
    if (!paths.length) die('missing save file (try: tessera help)');
    return paths.map((p) => {
        if (!fs.existsSync(p)) die(`no such file: ${p}`);
        const st = fs.statSync(p);
        if (st.isDirectory()) die(`${p} is a directory (pass the save.hg file itself)`);
        if (st.size > MAX_SAVE_BYTES) {
            die(`${p}: ${st.size} bytes exceeds MAX_SAVE_BYTES (${MAX_SAVE_BYTES})`);
        }
        return { name: path.basename(p), bytes: fs.readFileSync(p) };
    });
}

async function pipelineFor(paths, opts) {
    const files = readSaves(paths);
    const log = opts.quiet ? () => {} : (m) => process.stderr.write(m + '\n');
    return runPipeline(files, {
        log,
        loadMappingJson: async () => OBFUSCATION_MAPPING,
    });
}

// Accepts a bare seed, a seed file, or anything carrying the tessera~ prefix
// (a pasted URL, a QR scan result). Keeps only what the decoder needs.
function readSeedArg(arg) {
    if (!arg) die('missing seed (a string, a file, or a tessera~ URL)');
    let raw = arg;
    if (fs.existsSync(arg) && fs.statSync(arg).isFile()) {
        raw = fs.readFileSync(arg, 'utf8');
    }
    raw = raw.trim();
    const marker = raw.lastIndexOf('tessera~');
    if (marker !== -1) raw = raw.slice(marker + 'tessera~'.length);
    return raw.split(/\s+/)[0];
}

// --- commands ------------------------------------------------------------

async function cmdRun(opts) {
    const r = await pipelineFor(opts._, opts);
    const lines = [
        '',
        `systems         ${r.report.totals.systems} dated, ${r.geo.systems.length} in geography`,
        `regions         ${r.report.totals.regions}`,
        // totals.galaxies is the list of galaxy ids, not a count.
        `galaxies        ${r.report.totals.galaxies.length} (${r.report.totals.galaxies.join(', ')})`,
        `events          ${r.report.totals.events}`,
        `period          ${r.report.period.first} -> ${r.report.period.last}`,
        `blackhole       ${r.geo.blackhole_routes.length} routes`,
        `beats           ${r.graph.beats.length} (${r.graph.beats.map((b) => b.type).join(', ')})`,
        `payload A       ${r.postJson.length} bytes posted, encoding ${r.post.encoding}`,
        `payload B       ${r.seed.length} chars`,
        '',
        `seed            tessera~${r.seed}`,
        '',
        // Printed once, here and nowhere else: it was drawn in this process and
        // is not stored anywhere, not even in the seed - the seed carries only
        // its hash. Losing it means the story can never be taken down.
        `destroy key     ${r.destroyKey}`,
        `                keep this. it is the only thing that can remove the story,`,
        `                and it cannot be recovered by anyone, including us.`,
        '',
    ];
    emit(lines.join('\n'), opts);
}

async function cmdSeed(opts) {
    const r = await pipelineFor(opts._, opts);
    emit(r.seed, opts);
}

async function cmdBeats(opts) {
    const r = await pipelineFor(opts._, opts);
    emit(json(r.graph.beats, opts), opts);
}

async function cmdReport(opts) {
    const r = await pipelineFor(opts._, opts);
    emit(json(r.report, opts), opts);
}

async function cmdGeo(opts) {
    const r = await pipelineFor(opts._, opts);
    // --post shows the wire body (compressed, base64url); default shows the
    // readable geography it was built from, which is the auditable form.
    emit(opts.post ? json(r.post, opts) : json(r.geo, opts), opts);
}

async function cmdDecode(opts) {
    const seed = readSeedArg(opts._[0]);
    let beats;
    try {
        beats = await decodeSeed(seed);
    } catch (e) {
        die(`decode failed: ${e.message}`);
    }
    emit(json(beats, opts), opts);
}

// The frozen tables of the seed format, read back from the shipped code
// instead of a doc that could drift: each beat type is encoded alone, and its
// wire index and payload size are measured on the result.
async function cmdSpec(opts) {
    const rows = [];
    for (const beat of maxSyntheticBeats()) {
        const seed = await encodeSeed([beat], { commitment: TEST_COMMITMENT });
        const dot = seed.lastIndexOf('.');
        let framed = base64urlDecode(seed.slice(0, dot));
        if (seed.slice(dot + 1) === '1z') framed = await inflateRaw(framed);
        const [decoded] = await decodeSeed(seed);
        // Header is a 3-byte presence bitmask (BREAKING pass 2026-07-30), not
        // a type byte: a single-beat seed has exactly one bit set, and its
        // position IS the type index (framed[0] is the crc8 watermark).
        const mask = framed.slice(1, 1 + HEADER_BYTES);
        let index = -1;
        for (let idx = 0; idx < BEAT_TYPES.length; idx++) {
            if (mask[idx >> 3] & (1 << (idx % 8))) { index = idx; break; }
        }
        rows.push({
            type: beat.type,
            index,
            dated: decoded.ts !== null,
            bytes: framed.length - 1 - HEADER_BYTES - COMMITMENT_BYTES, // minus crc, header, commitment
            facts: Object.keys(decoded.seed_facts),
        });
    }
    rows.sort((a, b) => a.index - b.index);

    if (opts.json) {
        emit(json({ format: 'seed v1.0', envelope: 'base64url(crc8had|header|commitment|payload).1[z]', beats: rows },
            opts), opts);
        return;
    }
    const lines = [
        '',
        'seed v1.0',
        '  envelope     base64url( crc8("had"+payload) | header | commitment | payload ) + ".1" raw or ".1z" deflate-raw',
        '  header       3-byte presence bitmask (bit n = BEAT_TYPES[n] present), bodies follow in that order',
        '  commitment   15 bytes, sha256 of the destroy key, on every seed (see docs/privacy.md)',
        '  integers     unsigned LEB128 varint',
        '  dates        month granularity, absolute months since 2016-08 (NMS release), one per dated beat',
        '  addresses    11 hex chars, 12 for first_system (planet index in the leading nibble)',
        '',
        'idx  beat type            dated  bytes  facts',
    ];
    for (const r of rows) {
        lines.push(`${String(r.index).padStart(3)}  ${r.type.padEnd(20)} ` +
            `${(r.dated ? 'yes' : 'no').padEnd(6)} ${String(r.bytes).padStart(5)}  ` +
            r.facts.join(', '));
    }
    lines.push('', 'Sizes come from the synthetic worst case (every field filled).', '');
    emit(lines.join('\n'), opts);
}

// Byte-level listing of a seed: what every byte is doing, bits spelled out.
// The layout table it walks is cross-checked against the real decoder by
// selftest, so this listing cannot quietly go stale.
async function cmdDump(opts) {
    const seed = readSeedArg(opts._[0]);
    let walk;
    try {
        walk = await annotateSeed(seed);
    } catch (e) {
        die(`dump failed: ${e.message}`);
    }
    emit('\n' + formatAnnotation(walk, { showBits: !opts['no-bits'] }) + '\n', opts);
}

// Byte-level listing of a geo-v1 payload: the POST body as JSON, the bare
// base64url data string, or a file holding either. Long payloads are truncated
// unless --full is passed, since a real one carries thousands of systems.
async function cmdDumpGeo(opts) {
    const arg = opts._[0];
    if (!arg) die('missing payload (a JSON body, a data string, or a file)');
    let input = arg;
    if (fs.existsSync(arg) && fs.statSync(arg).isFile()) {
        input = fs.readFileSync(arg, 'utf8');
    }
    let walk;
    try {
        walk = await annotateGeo(input.trim());
    } catch (e) {
        die(`dump-geo failed: ${e.message}`);
    }
    emit('\n' + formatGeoAnnotation(walk, { maxRows: opts.full ? 0 : 60 }) + '\n', opts);
}

async function cmdSelftest(opts) {
    const ok = await runSelftest({
        log: (m) => process.stderr.write(m + '\n'),
        updateFixtures: !!opts['update-fixtures'],
    });
    if (!ok) process.exit(1);
    emit('selftest: OK', opts);
}

// Local static server for offline/. Exists because ES modules and Web Workers
// are blocked under file:// by browser CORS rules: a save opened straight from
// disk would never load lib/. Binds loopback only.
function cmdServe(opts) {
    const port = opts.port || 8787;
    const roots = { '/': path.join(PKG_DIR, 'offline'), '/lib/': LIB_DIR };
    const TYPES = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'text/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
    };

    const server = http.createServer((req, res) => {
        const url = new URL(req.url, `http://127.0.0.1:${port}`);
        let pathname = decodeURIComponent(url.pathname);

        // The page keeps the site's opt-in send buttons. Offline there is
        // nothing to send to, and the answer says so instead of hanging.
        // Both endpoints, or the mosaic tick would meet a 404 page and the
        // status line would blame a missing file for a deliberate absence.
        if (pathname === '/api/v1/geo' || pathname === '/mosaic/publish') {
            res.writeHead(501, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'offline package: no ingestion endpoint here' }));
            return;
        }

        if (pathname === '/') pathname = '/index.html';
        const base = pathname.startsWith('/lib/') ? roots['/lib/'] : roots['/'];
        const rel = pathname.startsWith('/lib/') ? pathname.slice(5) : pathname.slice(1);
        const file = path.join(base, rel);
        // Path traversal guard: resolved file must stay under its root.
        if (!path.resolve(file).startsWith(path.resolve(base) + path.sep)) {
            res.writeHead(403).end('forbidden');
            return;
        }
        if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
            res.writeHead(404).end('not found');
            return;
        }
        res.writeHead(200, {
            'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
            'Cache-Control': 'no-store',
            // Same posture as the site: no inline script, no external origin.
            // frame-ancestors is its own directive (default-src does not
            // cover navigation/framing) and a <meta> CSP can never carry it,
            // so it has to live in this header, not just offline/index.html.
            'Content-Security-Policy': "default-src 'none'; script-src 'self'; " +
                "style-src 'self'; connect-src 'self'; worker-src 'self'; " +
                "img-src 'self' data:; base-uri 'none'; form-action 'none'; " +
                "frame-ancestors 'none'",
            'X-Frame-Options': 'DENY',
            'X-Content-Type-Options': 'nosniff',
        });
        fs.createReadStream(file).pipe(res);
    });

    server.listen(port, '127.0.0.1', () => {
        process.stderr.write(
            `tessera: http://127.0.0.1:${port}/  (loopback only, Ctrl+C to stop)\n`);
    });
}

// --- dispatch ------------------------------------------------------------

const [, , cmd, ...rest] = process.argv;
const opts = parseArgs(rest);

const COMMANDS = {
    run: cmdRun,
    seed: cmdSeed,
    beats: cmdBeats,
    report: cmdReport,
    geo: cmdGeo,
    decode: cmdDecode,
    spec: cmdSpec,
    dump: cmdDump,
    'dump-geo': cmdDumpGeo,
    selftest: cmdSelftest,
    serve: cmdServe,
};

if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    process.stdout.write(USAGE);
    process.exit(0);
}
if (cmd === 'version' || cmd === '--version') {
    const pkg = JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'package.json'), 'utf8'));
    process.stdout.write(`tessera ${pkg.version} (seed format v1.0, node ${process.version})\n`);
    process.exit(0);
}
if (!COMMANDS[cmd]) {
    process.stderr.write(`tessera: unknown command "${cmd}"\n\n${USAGE}`);
    process.exit(1);
}

try {
    await COMMANDS[cmd](opts);
} catch (e) {
    die(e.message);
}
