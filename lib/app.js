// Author: had.sh
// UI orchestration tessera, in 5 phases:
//   1. scan (extract, count systems) -> consent (share geography? add to
//      mosaic?) -> "Continue"
//   2. beats extracted (report/graph) -> review (keep/edit/remove player
//      names, include/exclude other beats) -> "Confirm and generate seed"
//   3. receipt
//   4. seal
//   5. seed/QR
//
// Computation runs in a Web Worker (worker.js) to never freeze the page
// during JSON.parse of ~30 MB; inline fallback (same pipeline.js stages,
// called directly) if Worker unavailable
//
// The ONLY network call is the geo payload send, and only when the geo
// consent checkbox was ticked at "Continue" (opt-in, player-triggered):
// nothing is ever sent automatically. Mosaic consent never triggers a
// network call from here at all, it only sets a bit inside the seed itself,
// read server-side when the story is first opened.

import {
    scanSystems, loadMappingIfNeeded, buildGeoForOptIn, buildGraphFromSystems, finalizeSeed,
} from './pipeline.js';
import { MAX_SAVE_BYTES } from './limits.js';
import { buildReceipt } from './receipt.js';
// QRCode loaded in index.html as classic script (sloppy mode for 'this' context)

// QRCode comes from lib/qrcode.vendor.js, loaded as classic <script> in
// index.html (the minified version requires sloppy-mode 'this', incompatible with ES modules).
const QRCode = globalThis.QRCode;
import { decodeSeed } from './seed.js';
import { mapping as OBFUSCATION_MAPPING } from './mapping.json.js';

// The 7 beat types that carry a player-chosen free-text name (beats.js), and
// which fact field(s) hold it. Everything else gets a plain include/exclude
// checkbox instead of the keep/edit/remove control.

const NAME_FIELDS_BY_TYPE = {
    favorite_base: ['name'],
    freighter_named: ['name'],
    first_pet: ['name'],
    multitool_named: ['name'],
    first_naming: ['system_name', 'planet_name'],
    settlements: ['names'],
    atlas_encounter: ['system_name'],
};

function beatPlayerNames(beat) {
    const fields = NAME_FIELDS_BY_TYPE[beat.type];
    if (!fields) return [];
    const names = [];
    for (const field of fields) {
        const value = beat.facts?.[field];
        if (Array.isArray(value)) {
            names.push(...value.filter(Boolean));
        } else if (value) {
            names.push(value);
        }
    }
    return names;
}

const fileInput = document.getElementById('file-input');
const extractBtn = document.getElementById('extract-btn');
const logEl = document.getElementById('log');
const scanPanel = document.getElementById('scan-panel');
const scanSummary = document.getElementById('scan-summary');
const consentGeo = document.getElementById('consent-geo');
const consentMosaic = document.getElementById('consent-mosaic');
const continueBtn = document.getElementById('continue-btn');
const panelA = document.getElementById('payload-a-panel');
const payloadAStatus = document.getElementById('payload-a-status');
const mosaicStatus = document.getElementById('mosaic-status');
const reviewPanel = document.getElementById('review-panel');
const reviewList = document.getElementById('review-list');
const confirmBtn = document.getElementById('confirm-btn');
const panelB = document.getElementById('payload-b-panel');
const outA = document.getElementById('payload-a');
const outB = document.getElementById('payload-b');
const readStoryLink = document.getElementById('read-story-link');

function log(msg) {
    logEl.textContent += msg + '\n';
    logEl.scrollTop = logEl.scrollHeight;
}

// Thousands separated by a space, never a comma: site-wide number convention,
// and the only place this page prints a count large enough to need it.
function formatCount(n) {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

// The technical log lives folded away, so the wait needs a plain sentence of
// its own. Like the consent button's labels, the wording stays in the view
// (data-phase-*) and this only picks which one is showing.
const phaseEl = document.getElementById('phase-status');

function setPhase(name) {
    if (!phaseEl) return;
    if (!name) {
        phaseEl.textContent = '';
        delete phaseEl.dataset.state;
        return;
    }
    const key = 'phase' + name.charAt(0).toUpperCase() + name.slice(1);
    phaseEl.textContent = phaseEl.dataset[key] ?? '';
    phaseEl.dataset.state = name;
}

// A refusal names the file or the count that caused it, so unlike the fixed
// phase sentences it cannot live in the view. It goes to the log too: the log
// stays the full record even when nobody unfolds it.
function refusePhase(msg) {
    log(msg);
    if (!phaseEl) return;
    phaseEl.textContent = msg;
    phaseEl.dataset.state = 'failed';
}

// The primary button names what pressing it will actually do, recomputed from
// the two consent checkboxes. Continue IS the send trigger (there is no second
// confirmation step), so a button reading "Continue" while a ticked box makes
// it upload a geography payload is the button lying about itself. The four
// labels live on the element as data-label-* so the wording stays in the view
// and no string is hardcoded here; missing attributes fall back to the
// button's own initial text rather than to an invented English phrase.
const continueLabels = continueBtn ? {
    none: continueBtn.dataset.labelNone || continueBtn.textContent,
    geo: continueBtn.dataset.labelGeo || continueBtn.textContent,
    mosaic: continueBtn.dataset.labelMosaic || continueBtn.textContent,
    both: continueBtn.dataset.labelBoth || continueBtn.textContent,
} : null;

function refreshContinueLabel() {
    if (!continueBtn || !continueLabels) return;
    const geo = !!consentGeo?.checked;
    const mosaic = !!consentMosaic?.checked;
    const key = geo && mosaic ? 'both' : geo ? 'geo' : mosaic ? 'mosaic' : 'none';
    continueBtn.textContent = continueLabels[key];
    // Styling hook for the view: the glass system keys off data attributes,
    // never off an inline style set from here (CSP hard, no inline anything).
    continueBtn.dataset.consent = key;
}

consentGeo?.addEventListener('change', refreshContinueLabel);
consentMosaic?.addEventListener('change', refreshContinueLabel);
refreshContinueLabel();

fileInput.addEventListener('change', () => {
    extractBtn.disabled = fileInput.files.length === 0;
});

function setupCopy(btnId, getText) {
    const btn = document.getElementById(btnId);
    // The view is edited far more often than this file: a copy button that
    // moved or went away must not take the whole module down with it, since
    // this script is what reads the save.
    if (!btn) return;
    btn.addEventListener('click', async () => {
        await navigator.clipboard.writeText(getText());
        const orig = btn.textContent;
        btn.textContent = 'Copied';
        setTimeout(() => { btn.textContent = orig; }, 1200);
    });
}

function setupDownload(linkId, text, mime) {
    const a = document.getElementById(linkId);
    if (a.href && a.href.startsWith('blob:')) {
        URL.revokeObjectURL(a.href);
    }
    a.href = URL.createObjectURL(new Blob([text], { type: mime }));
}

let latestPostJson = ''; // minified POST body (display is pretty-printed), '' if geo was never shared
// The seed is held here rather than read back off the page: the view may show
// it, fold it away, or not render it at all, and copying it must work either
// way. 
let latestSeed = '';
// Lives in this tab and nowhere else: minted client-side, never sent, and gone
// when the page closes. The printed sheet is the only copy that outlives it.
let latestDestroyKey = '';
// What "copy" hands over is the shareable link, not the bare seed: pasted into
// a message it has to be openable by whoever receives it. The seed alone is
// the fallback for the window before the link exists.
let latestShareUrl = '';
setupCopy('copy-a', () => latestPostJson || outA?.textContent || '');
setupCopy('copy-b', () => latestShareUrl || latestSeed);
setupCopy('copy-destroy-key', () => latestDestroyKey);

// The key is written into the DOM as soon as it exists, but blurred by CSS
// until this click: the panel sits near the QR people photograph, and
// a secret that cannot be reissued should not ride along in that photo.
const destroyKeyPanel = document.getElementById('destroy-key-panel');
const destroyKeyReveal = document.getElementById('destroy-key-reveal');
const destroyKeyValue = document.getElementById('destroy-key-value');
const destroyKeyHint = document.getElementById('destroy-key-hint');
destroyKeyReveal?.addEventListener('click', () => {
    destroyKeyReveal.setAttribute('aria-expanded', 'true');
    if (destroyKeyHint) destroyKeyHint.textContent = 'Keep it somewhere safe: a seal cannot be minted twice.';
});

// The QR is rendered by the vendor lib into a <canvas> (with an <img> fallback
// on browsers without canvas). cloneNode on a canvas copies the element and
// not its bitmap, so anything that needs the QR elsewhere - the print sheet,
// the download - goes through a real PNG taken from the live canvas.
// #seed-qr-raw holds the bare code the vendor drew; #seed-qr holds the card
// composed from it, which is what the page shows. The print sheet takes the
// bare one on purpose: the card's dark ground has no business on paper.
function qrCanvas() {
    return document.getElementById('seed-qr-raw')?.querySelector('canvas') ?? null;
}

function qrPngDataUrl() {
    const canvas = qrCanvas();
    if (canvas) return canvas.toDataURL('image/png');
    return document.getElementById('seed-qr-raw')?.querySelector('img')?.src ?? '';
}

// The QR is the form of the story that actually travels: pinned on a wall,
// sent in a message, posted to a thread. A bare code says nothing about what it
// opens, so the page shows, and hands over, a composed card instead: the site's
// own colors, the code, and who it comes from. The full link stays on the page
// under it, not on the card, where a wall of characters would only crowd the
// code. Drawn here on a canvas rather than fetched: nothing about this story is
// allowed to leave the tab, image included.
function cssColor(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    // color-mix() and friends are valid CSS but not valid canvas fillStyle, so
    // anything that is not a plain color falls back rather than silently
    // painting black.
    return /^#|^rgb|^hsl/.test(v) ? v : fallback;
}

// The page's own background image, taken from the --bg-image custom property
// the layout loads per page. Same-origin, so drawing it leaves the canvas untainted and toBlob
// still works - a cross-origin image would poison the download instead.
function pageBackgroundUrl() {
    const raw = getComputedStyle(document.body).getPropertyValue('--bg-image').trim();
    const m = raw.match(/url\(\s*["']?([^"')]+)["']?\s*\)/);
    if (!m) return '';
    const url = new URL(m[1], location.href);
    return url.origin === location.origin ? url.href : '';
}

// Twelve ways of naming the same thing. Which one a card wears is decided by
// the seed, so it is a property of the story rather than of the moment it was
// downloaded: the same save always gets the same title, and two travellers
// standing side by side rarely get the same one.
const CARD_TITLES = [
    'The route they took',
    'Where this one went',
    'A path worth reading',
    'One traveller’s log',
    'Follow the jumps',
    'Read the route',
    'See where they went',
    'The whole way out',
    'The way out, and back',
    'Charted in full',
    'A sky, remembered',
    'The distance, folded in',
];

// FNV-1a over the whole seed rather than a slice of it: the first characters
// are header and version bytes, identical for everyone, so reading the title
// off the front would hand the same one to every card.
function cardTitle(seed) {
    let h = 0x811c9dc5;
    for (let i = 0; i < seed.length; i++) {
        h ^= seed.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return CARD_TITLES[h % CARD_TITLES.length];
}

// Only the hex forms are handled, which is what the glass tokens are; anything
// else falls back to the void so the scrim is never skipped (and the wording
// never ends up unreadable on a bright photograph).
function hexToRgba(hex, alpha) {
    const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex);
    if (!m) return `rgba(14, 16, 22, ${alpha})`;
    const full = m[1].length === 3 ? m[1].replace(/./g, (c) => c + c) : m[1];
    const n = parseInt(full, 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

function loadImage(src) {
    return new Promise((resolve) => {
        if (!src) {
            resolve(null);
            return;
        }
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => resolve(null);
        img.src = src;
    });
}

// object-fit: cover, by hand: the background is a wide photograph and the card
// is portrait, so it is scaled to fill and centred rather than squashed.
function drawCover(ctx, img, w, h) {
    const scale = Math.max(w / img.width, h / img.height);
    const dw = img.width * scale;
    const dh = img.height * scale;
    ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
}

function roundRect(ctx, x, y, w, h, r) {
    if (typeof ctx.roundRect === 'function') {
        ctx.beginPath();
        ctx.roundRect(x, y, w, h, r);
        return;
    }
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
}

async function composeQrCard(qr, seed) {
    const W = 1080;
    const H = 1440;
    const card = document.createElement('canvas');
    card.width = W;
    card.height = H;
    const ctx = card.getContext('2d');
    if (!ctx || !qr) return null;

    const body = getComputedStyle(document.body).fontFamily || 'system-ui, sans-serif';
    const bg = cssColor('--void-deep', '#0E1016');
    const text = cssColor('--text', '#f6edfa');
    const dim = cssColor('--text-dim', '#c9c9c9');
    const accent = cssColor('--teal-data', '#b5bdd4');

    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    // The card wears the same sky as the page it was made on: the background
    // this visit resolved to, drawn under a scrim heavy enough to keep the
    // wording legible whatever image came up. Solid void if it fails to load,
    // so the card is never held up by an image.
    const bgImage = await loadImage(pageBackgroundUrl());
    if (bgImage) {
        drawCover(ctx, bgImage, W, H);
        // Heavier where the wording sits, nearly clear across the middle: the
        // white plate carries its own contrast there, so the photograph gets to
        // be seen rather than merely guessed at.
        const scrim = ctx.createLinearGradient(0, 0, 0, H);
        scrim.addColorStop(0, hexToRgba(bg, 0.66));
        scrim.addColorStop(0.22, hexToRgba(bg, 0.34));
        scrim.addColorStop(0.72, hexToRgba(bg, 0.24));
        scrim.addColorStop(1, hexToRgba(bg, 0.62));
        ctx.fillStyle = scrim;
        ctx.fillRect(0, 0, W, H);
    }

    // A soft halo behind the code: the page's own light, so the card reads as
    // coming from this site and not from a QR generator.
    const halo = ctx.createRadialGradient(W / 2, 820, 80, W / 2, 820, 820);
    halo.addColorStop(0, 'rgba(181, 189, 212, 0.16)');
    halo.addColorStop(1, 'rgba(181, 189, 212, 0)');
    ctx.fillStyle = halo;
    ctx.fillRect(0, 0, W, H);

    ctx.textAlign = 'center';

    // A drop shadow under every word, so the scrim can stay light: contrast is
    // bought here, locally, instead of by darkening the whole photograph.
    ctx.shadowColor = 'rgba(0, 0, 0, 0.75)';
    ctx.shadowBlur = 18;
    ctx.shadowOffsetY = 2;

    ctx.fillStyle = accent;
    ctx.font = `600 30px ${body}`;
    if ('letterSpacing' in ctx) ctx.letterSpacing = '8px';
    ctx.fillText('NO MAN’S GLYPHS', W / 2, 150);
    if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';

    ctx.fillStyle = text;
    ctx.font = `600 64px ${body}`;
    ctx.fillText(cardTitle(seed), W / 2, 240);

    ctx.fillStyle = dim;
    ctx.font = `30px ${body}`;
    ctx.fillText('Scan the code and read the traveller’s story', W / 2, 300);

    // The white plate is the quiet zone: readers need light around the code,
    // and this is also what keeps the card scannable when it is reposted small.
    // The code is drawn at exactly twice its rendered size, smoothing off: any
    // other factor blurs module edges, which is what makes a scaled QR fail.
    const qrSize = qr.width * 2;
    const pad = 40;
    const plate = qrSize + pad * 2;
    const px = (W - plate) / 2;
    const py = 340;
    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
    ctx.shadowBlur = 48;
    ctx.shadowOffsetY = 16;
    ctx.fillStyle = '#ffffff';
    roundRect(ctx, px, py, plate, plate, 28);
    ctx.fill();
    ctx.restore();

    // No shadow on the code itself: the text shadow set above would smear the
    // module edges, which is exactly what a reader needs sharp.
    ctx.save();
    ctx.shadowColor = 'transparent';
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(qr, px + pad, py + pad, qrSize, qrSize);
    ctx.restore();

    ctx.fillStyle = text;
    ctx.font = `600 28px ${body}`;
    ctx.fillText('glyphs.had.sh', W / 2, H - 60);

    return card;
}

// Takes the very canvas the page is showing: what gets downloaded is exactly
// what was seen, not a second rendering that could drift from it.
function setupQrDownload(linkId, source) {
    const a = document.getElementById(linkId);
    if (!a || !source) return;
    source.toBlob((blob) => {
        if (!blob) return;
        if (a.href && a.href.startsWith('blob:')) {
            URL.revokeObjectURL(a.href);
        }
        a.href = URL.createObjectURL(blob);
    }, 'image/png');
}

// Read from whichever element carries it rather than from <body>: this view is
// a fragment inside basic html now, and the layout's <body> is shared
// with every other page, which has no business carrying this page's token.
const csrfToken = document.querySelector('[data-csrf-token]')?.dataset.csrfToken ?? '';

// Sends the geo payload right when the depositor opts in at "Continue" - no
// separate "Send" button any more, the opt-in + button IS the send trigger.
async function sendGeoPayload(postJson) {
    payloadAStatus.textContent = 'Sending your travels...';
    try {
        const res = await fetch('/api/v1/geo', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Csrf-Token': csrfToken,
            },
            body: postJson,
        });
        const data = await res.json().catch(() => null);
        if (res.ok) {
            payloadAStatus.textContent =
                `${formatCount(data?.system_count ?? 0)} systems and ` +
                `${formatCount(data?.route_count ?? 0)} routes are now on the shared map.`;
        } else {
            payloadAStatus.textContent = `The shared map turned this down: ${data?.error ?? res.status}.`;
        }
    } catch (e) {
        payloadAStatus.textContent = `Nothing could be sent: ${e.message}`;
    }
}

// Submits the finished story to the public mosaic. Same shape as the geo send
// above - the tick at "Continue" IS the trigger, there is no second button -
// but it can only run here, at the very end: the mosaic_public bit goes INTO
// the seed, so the thing being submitted does not exist until the seed does.
//
// Called last, after the receipt and the seal are on screen, and that ordering
// is deliberate. The seal is revealed in the final panel; publishing before it
// is visible would create the case where someone closes the tab having put a
// story on a public wall and never seen the one key that takes it down. Since
// a takedown is not self-service, that would be irreversible for them.
//
// Failures are shown, never swallowed. A geo payload that does not arrive just
// means the map is missing a contribution; a tile that does not arrive means a
// person believes they are on the wall and is not.
async function sendMosaicTile(seed) {
    if (!mosaicStatus) {
        return;
    }
    mosaicStatus.textContent = 'Sending your story to the mosaic...';
    try {
        const res = await fetch('/mosaic/publish', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Csrf-Token': csrfToken,
            },
            body: JSON.stringify({ seed }),
        });
        const data = await res.json().catch(() => null);
        if (res.ok) {
            mosaicStatus.textContent =
                'Your story is with the mosaic. A human reads it before it joins the wall. '
                + 'Your link above works now, and does not wait for that.';
        } else {
            mosaicStatus.textContent =
                `The mosaic turned it down: ${data?.error ?? res.status}. Your link still works.`;
        }
    } catch (e) {
        mosaicStatus.textContent =
            `Your story could not be sent to the mosaic: ${e.message}. Your link still works.`;
    }
}

const ticketPanel = document.getElementById('ticket-panel');
const ticketEl = document.getElementById('ticket');
const printBtn = document.getElementById('print-receipt');
const printFile = document.getElementById('print-file');
const printGenerated = document.getElementById('print-generated');
const printSha = document.getElementById('print-sha');
const printSummary = document.getElementById('print-summary');
const printSeed = document.getElementById('print-seed');
const printDestroyKey = document.getElementById('print-destroy-key');
const printQr = document.getElementById('print-qr');
const printGeo = document.getElementById('print-geo');

// Fills the print sheet from the receipt + the readable geo JSON (if
// shared), and clones the on-screen QR canvas/img into it (QRCode renders
// into #seed-qr, nothing here talks to the network to build a second one).
function fillPrintSheet(receipt, geo) {
    printFile.textContent = receipt.file.name;
    printGenerated.textContent = receipt.generated;
    printSha.textContent = receipt.file.sha256;
    printSummary.textContent = '';
    const fields = [
        ['Systems visited', formatCount(receipt.summary.systems ?? 0)],
        ['Moments recorded', formatCount(receipt.summary.events ?? 0)],
        ['Regions crossed', formatCount(receipt.summary.regions ?? 0)],
        ['Planets you named', formatCount(receipt.summary.named_planets ?? 0)],
        ['Galaxies reached', formatCount(receipt.summary.galaxies ?? 0)],
        ['Travelled from', `${receipt.summary.period?.[0] ?? '?'} to ${receipt.summary.period?.[1] ?? '?'}`],
        ['Teleports', formatCount(receipt.summary.teleports ?? 0)],
        ['Bases built', formatCount(receipt.summary.bases ?? 0)],
    ];
    for (const [k, v] of fields) {
        const li = document.createElement('li');
        li.textContent = `${k}: ${v}`;
        printSummary.appendChild(li);
    }
    printSeed.textContent = receipt.seed;
    // Deliberately on the sheet and not beside the QR: the QR is the story,
    // public and made to be scanned, while this is the secret that unmakes it.
    // The two must never end up in the same scannable object.
    if (printDestroyKey) {
        printDestroyKey.textContent = receipt.destroy_key ?? '';
    }
    printGeo.textContent = geo ? JSON.stringify(geo, null, 2) : 'Not shared.';
    printQr.textContent = '';
    const png = qrPngDataUrl();
    if (png) {
        const img = document.createElement('img');
        img.src = png;
        img.alt = 'QR code linking to your story';
        img.className = 'print-qr__img';
        printQr.appendChild(img);
    }
}

printBtn.addEventListener('click', () => window.print());

// --- Pipeline runners: Worker-backed and inline-fallback, same async API ---
// (scan/geo/confirm), so the orchestration below never has to branch on
// which one is in use.

function makeWorkerRunner() {
    const w = new Worker(new URL('worker.js', import.meta.url), { type: 'module' });
    const handlers = {};
    w.onmessage = (e) => {
        if (e.data.type === 'log') {
            log(e.data.msg);
            return;
        }
        const handler = handlers[e.data.type];
        if (handler) handler(e.data);
    };
    w.onerror = (e) => {
        const handler = handlers.error;
        // Some embedded browsers (observed: Steam client's overlay browser on
        // Windows) expose a working `Worker` global but fail to load a module
        // worker whose script uses `import` - the resulting ErrorEvent carries
        // no message, so the file/line is included as a fallback detail to
        // make future reports diagnosable.
        const detail = e.message || `${e.filename ?? 'worker.js'}:${e.lineno ?? '?'}`;
        if (handler) handler({ msg: `worker error (${detail})` });
    };

    return {
        scan(files) {
            return new Promise((resolve, reject) => {
                handlers.scanned = resolve;
                handlers.error = (d) => reject(new Error(d.msg));
                const buffers = files.map((f) => f.bytes.buffer);
                w.postMessage({
                    files: files.map((f) => ({ name: f.name, buffer: f.bytes.buffer })),
                    mapping: OBFUSCATION_MAPPING,
                }, buffers);
            });
        },
        geo(geoOptIn, mosaicOptIn) {
            return new Promise((resolve, reject) => {
                let geoMsg = null;
                handlers.geo = (d) => { geoMsg = d.skipped ? null : d; };
                handlers.graph = (d) => resolve({ geoResult: geoMsg, report: d.report, graph: d.graph, digests: d.digests });
                handlers.error = (d) => reject(new Error(d.msg));
                w.postMessage({ phase: 'geo', geoOptIn, mosaicOptIn });
            });
        },
        confirm(beats) {
            return new Promise((resolve, reject) => {
                handlers.result = (d) => resolve({ seed: d.seed, destroyKey: d.destroyKey });
                handlers.error = (d) => reject(new Error(d.msg));
                w.postMessage({ phase: 'confirm', beats });
            });
        },
        terminate() { w.terminate(); },
        usesWorker: true,
    };
}

function makeInlineRunner() {
    let scanned = null;
    let mosaicOptIn = false;
    return {
        async scan(files) {
            log('(Worker unavailable, computing on main thread)');
            const mapping = await loadMappingIfNeeded(files, {
                log,
                loadMappingJson: async () => OBFUSCATION_MAPPING,
            });
            const { systems, playerStates, errors, undated, rejectedCount } =
                scanSystems(files, { log, mapping });
            scanned = { systems, playerStates };
            return { systemCount: systems.length, undatedCount: undated.length, rejectedCount, errors };
        },
        async geo(geoOptIn, wantsMosaic) {
            mosaicOptIn = wantsMosaic;
            let geoResult = null;
            if (geoOptIn) {
                const { geo, post, postJson } =
                    await buildGeoForOptIn({ systems: scanned.systems }, { log });
                geoResult = { geo, post, postJson };
            }
            const { report, graph } =
                buildGraphFromSystems({ systems: scanned.systems, playerStates: scanned.playerStates }, { log });
            return { geoResult, report, graph, digests: null };
        },
        async confirm(beats) {
            return finalizeSeed(beats, { mosaicPublic: mosaicOptIn, log });
        },
        terminate() {},
    };
}

// --- Review panel rendering: keep/edit/remove for player names, plain
// checkboxes for everything else. Returns a function that reads the current
// UI state back into a filtered/edited beats array. ---

function renderReviewList(beats) {
    reviewList.textContent = '';
    const controls = []; // { beat, kind: 'name'|'plain', ...refs }

    for (const beat of beats) {
        const names = beatPlayerNames(beat);
        const li = document.createElement('li');

        if (names.length > 0) {
            const label = document.createElement('span');
            label.className = 'beat-type';
            // The theme is the human name of the beat ('home', 'first
            // companion'); beat.type is the format's internal key and only
            // shows if a beat ever ships without a theme.
            label.textContent = `${beat.theme ?? beat.type}: `;
            const nameEl = document.createElement('span');
            nameEl.className = 'review-name';
            nameEl.textContent = `"${names.join('", "')}"`;
            label.appendChild(nameEl);
            const actions = document.createElement('span');
            actions.className = 'review-actions';

            const keepBtn = document.createElement('button');
            keepBtn.type = 'button';
            keepBtn.className = 'review-action review-action--keep';
            keepBtn.textContent = 'Keep';
            const editBtn = document.createElement('button');
            editBtn.type = 'button';
            editBtn.className = 'review-action review-action--edit';
            editBtn.textContent = 'Change';
            const removeBtn = document.createElement('button');
            removeBtn.type = 'button';
            removeBtn.className = 'review-action review-action--remove';
            removeBtn.textContent = 'Drop';

            const editInput = document.createElement('input');
            editInput.type = 'text';
            editInput.className = 'review-edit-input hidden';
            editInput.value = names[0] ?? '';

            const state = { beat, kind: 'name', decision: 'keep', editedValue: null, li };
            const setDecision = (decision) => {
                state.decision = decision;
                li.dataset.decision = decision;
                editInput.classList.toggle('hidden', decision !== 'edit');
                if (decision === 'edit') editInput.focus();
            };
            keepBtn.addEventListener('click', () => setDecision('keep'));
            editBtn.addEventListener('click', () => setDecision('edit'));
            removeBtn.addEventListener('click', () => setDecision('remove'));
            editInput.addEventListener('input', () => { state.editedValue = editInput.value; });

            actions.append(keepBtn, editBtn, removeBtn);
            li.append(label, actions, editInput);
            setDecision('keep');
            controls.push(state);
        } else {
            const label = document.createElement('label');
            label.className = 'checkbox-label';
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.checked = true;
            const span = document.createElement('span');
            span.textContent = `${beat.theme ?? beat.type}`;
            label.append(checkbox, span);
            li.append(label);
            controls.push({ beat, kind: 'plain', checkbox, li });
        }

        reviewList.appendChild(li);
    }

    // Reads current control state into the beats array to encode: excluded
    // beats dropped, edited names substituted into their beat's facts (rest
    // of the beat untouched), everything else passed through as-is.
    return function collectConfirmedBeats() {
        const kept = [];
        for (const c of controls) {
            if (c.kind === 'plain') {
                if (c.checkbox.checked) kept.push(c.beat);
                continue;
            }
            if (c.decision === 'remove') continue;
            if (c.decision === 'edit' && c.editedValue) {
                const fields = NAME_FIELDS_BY_TYPE[c.beat.type];
                const facts = { ...c.beat.facts };
                for (const field of fields) {
                    if (Array.isArray(facts[field])) {
                        facts[field] = [c.editedValue];
                    } else if (facts[field]) {
                        facts[field] = c.editedValue;
                    }
                }
                kept.push({ ...c.beat, facts });
            } else {
                kept.push(c.beat);
            }
        }
        return kept;
    };
}

function disableReviewControls() {
    reviewList.querySelectorAll('button, input').forEach((el) => { el.disabled = true; });
}

// --- Main flow ---

extractBtn.addEventListener('click', async () => {
    extractBtn.disabled = true;
    try {
        logEl.textContent = '';
        setPhase('reading');
        scanPanel.classList.add('hidden');
        panelA.classList.add('hidden');
        reviewPanel.classList.add('hidden');
        panelB.classList.add('hidden');
        destroyKeyPanel?.classList.add('hidden');
        ticketPanel.classList.add('hidden');

        // Mono-save: one slot / one character
        if (fileInput.files.length > 1) {
            refusePhase('One save at a time, please: that is one character\'s story.');
            return;
        }
        const files = [];
        const f = fileInput.files[0];
        if (f) {
            if (f.name.startsWith('mf_') || !f.name.endsWith('.hg')) {
                refusePhase(`${f.name} is not a save file. Look for one named like save2.hg.`);
            } else if (f.size > MAX_SAVE_BYTES) {
                // Size guard BEFORE reading: never load into memory
                // a file that cannot be a valid save.
                refusePhase(`${f.name} is too heavy to be a save (${Math.round(f.size / 1048576)} MB, ` +
                    `a save stays under ${MAX_SAVE_BYTES / 1048576} MB).`);
            } else {
                if (f.size > 20 * 1048576) {
                    log(`${f.name}: large file (${Math.round(f.size / 1048576)} MB), ` +
                        'processing may take a while...');
                }
                files.push({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) });
            }
        }
        if (!files.length) {
            if (!f) refusePhase('No file chosen yet.');
            return;
        }

        let runner;
        try {
            runner = typeof Worker !== 'undefined' ? makeWorkerRunner() : makeInlineRunner();
        } catch (err) {
            log(`Worker unavailable (${err.message}), using main thread.`);
            runner = makeInlineRunner();
        }

        // Phase 1: scan -> show counts + consent, wait for "Continue". A
        // Worker that exists but cannot actually load its module script
        // (observed on the Steam client's embedded browser) fails right
        // here with nothing salvaged yet, so this is the one safe point to
        // swap to the inline runner and retry rather than surface a dead end.
        let scanResult;
        try {
            scanResult = await runner.scan(files);
        } catch (err) {
            if (runner.usesWorker) {
                log(`Worker failed (${err.message}), retrying on main thread.`);
                runner.terminate();
                runner = makeInlineRunner();
                scanResult = await runner.scan(files);
            } else {
                throw err;
            }
        }
        // Systems left out are said out loud rather than silently dropped, but
        // in terms of what it means for the story (they carry no date, so they
        // cannot be placed in time) instead of in pipeline vocabulary. The
        // panel shows no prose: the only count the player is
        // given is the one on the consent label below, so this goes to the log.
        const skipped = (scanResult.undatedCount ?? 0) + (scanResult.rejectedCount ?? 0);
        log(`${formatCount(scanResult.systemCount)} systems visited.` +
            (skipped ? ` ${formatCount(skipped)} could not be placed in time and stay out of the story.` : ''));
        if (scanSummary) scanSummary.textContent = '';
        // The geo consent label states the size of what it is about to share,
        // so the count is on the box being ticked and not only in the summary
        // above it. Template with {count} lives in the view; before the scan
        // the label reads without a number, since there is none yet.
        const geoLabel = document.getElementById('consent-geo-label');
        if (geoLabel?.dataset.label) {
            geoLabel.textContent =
                geoLabel.dataset.label.replace('{count}', formatCount(scanResult.systemCount));
        }

        setPhase(null);
        scanPanel.classList.remove('hidden');

        const { geoOptIn, mosaicOptIn } = await new Promise((resolve) => {
            continueBtn.addEventListener('click', () => {
                resolve({ geoOptIn: consentGeo.checked, mosaicOptIn: consentMosaic.checked });
            }, { once: true });
        });
        consentGeo.disabled = true;
        consentMosaic.disabled = true;
        continueBtn.disabled = true;

        // Phase 2: geo (if opted in) + graph -> review, wait for "Confirm".
        setPhase('building');
        const { geoResult, report, graph, digests } = await runner.geo(geoOptIn, mosaicOptIn);

        if (geoResult) {
            latestPostJson = geoResult.postJson;
            if (outA) outA.textContent = JSON.stringify(geoResult.post, null, 1);
            setupDownload('download-a', geoResult.postJson, 'application/json');
            setupDownload('download-a-readable', JSON.stringify(geoResult.geo, null, 2), 'application/json');
            panelA.classList.remove('hidden');
            await sendGeoPayload(geoResult.postJson);
        } else {
            latestPostJson = '';
        }

        const collectConfirmedBeats = renderReviewList(graph.beats);
        setPhase(null);
        reviewPanel.classList.remove('hidden');

        await new Promise((resolve) => {
            confirmBtn.addEventListener('click', () => resolve(), { once: true });
        });
        const confirmedBeats = collectConfirmedBeats();
        disableReviewControls();
        confirmBtn.disabled = true;

        // Phase 3: seed/QR/read-story link/receipt.
        setPhase('packing');
        const { seed, destroyKey } = await runner.confirm(confirmedBeats);
        runner.terminate();

        latestSeed = seed;
        latestDestroyKey = destroyKey;
        if (outB) outB.textContent = seed;

        // Decompresses and displays the seed
        const seedLen = seed.length;
        (async () => {
            try {
                const decoded = await decodeSeed(seed);
                const json = JSON.stringify(decoded, null, 2);

                const outBeta = document.getElementById('seed-decompressed');
                if (outBeta) {
                    outBeta.textContent = json;
                }

                log(`Seed (binary): ${seedLen} chars`);
            } catch (e) {
                log(`Seed decode: ${e.message}`);
            }
        })();

        // Generates QR code: shareable short URL. Standard colors
        // (dark on light: many readers reject inverted QR codes),
        // level L (sufficient for a screen, much less dense), quiet zone
        // provided by the white plate the card draws around it.
        const seedQrRawEl = document.getElementById('seed-qr-raw');
        const seedQrEl = document.getElementById('seed-qr');
        seedQrRawEl.textContent = '';
        seedQrEl.textContent = '';
        let shareUrl = '';
        try {
            shareUrl = `https://g.had.sh/s/tessera~${seed}`;
            latestShareUrl = shareUrl;
            // 440px: a v13 QR (69x69 modules, our seed ceiling ~300 bytes)
            // renders modules >= 6px here, comfortably scannable on screen.
            new QRCode(seedQrRawEl, {
                text: shareUrl,
                width: 440,
                height: 440,
                colorDark: '#101418',
                colorLight: '#ffffff',
                correctLevel: QRCode.CorrectLevel.L
            });

            // The card is what the page shows and what the download hands over:
            // one canvas, drawn once. If the browser gave us no canvas to
            // compose from, the bare code is shown instead rather than nothing.
            const card = await composeQrCard(qrCanvas(), seed);
            if (card) {
                card.className = 'story-upload__card';
                card.setAttribute('role', 'img');
                card.setAttribute('aria-label', 'Card holding the QR code and the link to your story');
                seedQrEl.appendChild(card);
                setupQrDownload('download-b', card);
            } else {
                seedQrRawEl.classList.remove('hidden');
            }

            // Clickable text under the card, in its own inset: same URL, for
            // anyone who'd rather click than scan.
            const qrLink = document.getElementById('seed-url');
            if (qrLink) {
                qrLink.href = shareUrl;
                qrLink.textContent = shareUrl;
            }

            log(`QR URL: ${shareUrl.length} chars`);
        } catch (e) {
            log(`QR error: ${e.message}`);
        }

        // Same-origin link straight to the rendered story
        if (readStoryLink) {
            readStoryLink.href = `/mosaic/tessera~${seed}`;
        }

        if (destroyKeyValue) destroyKeyValue.textContent = destroyKey;

        // Receipt: produced fresh for this extraction, nothing persists after
        // the tab closes. Downloadable as JSON, or as a printable sheet
        // (window.print, "save as PDF") holding the same facts plus the QR:
        // whichever copy the player keeps is the one they chose to keep.
        const receipt = buildReceipt({
            fileName: digests?.[0]?.name ?? files[0].name,
            sha256: digests?.[0]?.sha256 ?? 'unavailable (inline computation)',
            report,
            graph: { beats: confirmedBeats },
            seed,
            post: geoResult?.post ?? null,
            destroyKey,
        });
        ticketEl.textContent = JSON.stringify(receipt, null, 2);
        setupDownload('download-ticket', JSON.stringify(receipt, null, 2), 'application/json');
        fillPrintSheet(receipt, geoResult?.geo ?? null);
        // Revealed in reading order, which is also DOM order: the copy to keep,
        // then the seal, then the story itself as the last thing before the
        // log. Showing them earlier (as the QR gets built) made the panels pop
        // in above one another and shift the page under the reader.
        ticketPanel.classList.remove('hidden');
        destroyKeyPanel?.classList.remove('hidden');
        panelB.classList.remove('hidden');

        // Last act, and only if the box was ticked at "Continue". Everything
        // the depositor needs to keep is on screen by now, the seal included:
        // see sendMosaicTile for why publishing must not happen before that.
        if (mosaicOptIn) {
            await sendMosaicTile(seed);
        }

        setPhase('done');
        log('done.');
    } catch (e) {
        setPhase('failed');
        log(`ERROR: ${e.message ?? e}`);
        console.error(e);
    } finally {
        extractBtn.disabled = false;
    }
});
