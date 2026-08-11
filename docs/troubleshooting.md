<!-- Author: had.sh -->

# Troubleshooting

Real messages, real causes. If yours is not here, the pipeline journal on
stderr usually names the file and the step that gave up.

## Finding your save

| platform | path |
|---|---|
| Windows | `%APPDATA%\HelloGames\NMS\<id>\` |
| Linux, Steam | `~/.local/share/HelloGames/NMS/<id>/` |
| Mac | `~/Library/Application Support/HelloGames/NMS/` |

Take one `saveN.hg`. One slot is one character, and the pipeline is built
around a single save: mixing two characters would produce one incoherent
journey out of two real ones.

## The file is refused

**`unrecognized format: not a character save`**

You passed `accountdata.hg`, or an `mf_*` file. Neither is a save.
`accountdata.hg` holds account-level data with no `PlayerStateData` in it, and
`mf_*` files are manifests: small companions to a save, not the save itself.
Take `save.hg`, `save2.hg`, `save3.hg` and so on.

**`unrecognized format: neither NMS LZ4 (magic E5A1EDFE) nor plaintext JSON`**

The file is not an NMS save at all, or it is a console save in a container
format. This package reads two shapes: plaintext JSON, which very old saves
use, and the LZ4 obfuscated blob every modern save uses. Xbox saves live in a
folder with a `containers.index` that has to be walked first, and that walking
is not implemented in JavaScript. Raw PS4 and PS5 blobs are out of reach
entirely.

**`unrecognized format: empty or truncated file`**

Zero bytes, or the copy was interrupted. Copy it again from the game folder.

**`file too large for an NMS save`**

Over 64 MB, the cap in [lib/limits.js](../lib/limits.js). A real save is around
15 MB. Something else is in that file.

**`LZ4: incoherent chunk header or aberrant volume, not an NMS save`**

The magic bytes matched but the stream inside does not hold together. Usually a
partial copy, sometimes a file mangled by a sync tool or an editor that
rewrote it as text.

## The pipeline runs but produces nothing

**`no systems extracted`**

The file parsed, and nothing datable came out of it. Two usual causes: a brand
new character who has not discovered anything yet, or a save where every
timestamp predates the game's release, which the pipeline rejects as
impossible. The journal counts those rejections just above the error.

**Fewer beats than you expected.** Absence is silence, by design: a beat that
cannot be established does not fire. [beats.md](beats.md) lists the exact
condition for each of the seventeen. `node bin/tessera.js report save.hg` shows
the facts they are built from, which usually explains the gap in one line.

## Seeds

**`seed: missing version suffix`**

Something ate the tail of the string. A seed always ends in `.1` or `.1z`. Copy
it again in full, and beware of chat clients that truncate long strings or turn
them into links.

**`seed: crc8 mismatch (corruption or missing watermark)`**

The string arrived damaged. One character is enough. Also expected if the seed
was hand-edited: the watermark is there precisely to catch that.

**`seed: unsupported version (expected 1 or 1z)`**

Either the string is not a seed, or it comes from a future format version. See
[concepts.md](concepts.md) section 8 on what happens when the format moves.

**`seed: unknown beat type index N`**

A seed produced by a different version of the catalogue than the one you are
running. This is exactly what happens to a seed published in an old document
after a beat is removed: the indices shift and old strings stop decoding.

**`seed: compressed seed, but DecompressionStream unavailable`**

Your runtime has no `DecompressionStream`. Node 18 or later has it; a very old
browser does not. Raw `.1` seeds still decode.

**`seed: commitment must be 15 bytes`**

You called `encodeSeed` without a destroy-key commitment, or with one of the
wrong length. It is a required field on every seed: mint one with
`generateKey()` and `commitment()` from [lib/crockford.js](../lib/crockford.js).
It is required rather than optional on purpose, so that no story can exist that
its own author is unable to take down.

**`seed: commitment overruns payload`**

The seed ends inside the fixed 15-byte field that follows the header. Same
cause as `truncated payload` below: the string was cut short somewhere between
where it was written and where you pasted it.

**`crockford: no CSPRNG available, refusing to generate a key`**

The runtime has no `crypto.getRandomValues`. The library refuses rather than
falling back to `Math.random`, whose internal state is recoverable from a few
outputs, which would hand out predictable destroy keys while looking like a
working feature. Run it in a modern browser or in Node 18 or later.

**`crockford: crypto.subtle unavailable (needs a secure context)`**

`crypto.subtle` only exists in a secure context: HTTPS, or `localhost`. Under a
`file://` URL it is `undefined`, so no commitment can be computed and no seed
can be built. This is not a new restriction on the offline page, which already
could not run from disk (browsers refuse ES modules and Web Workers there); it
is one more reason the documented path is `tessera serve`, which binds
`127.0.0.1` and therefore counts as secure.

## The offline page

**Nothing happens when opening `offline/index.html` directly.**

Expected. Browsers refuse ES modules and Web Workers over `file://`. Run
`node bin/tessera.js serve` and open `http://127.0.0.1:8787/`.

**The QR code will not scan.**

Two causes, in order of likelihood. The quiet zone: a QR needs four modules of
blank margin, provided here by the padding on `.qr-container`. A custom
stylesheet that drops it makes the code unreadable, especially against a dark
background. Then density: the log line `QR URL: N chars` tells you how big the
payload is. Past roughly 370 characters the code reaches version 13, its
modules fall to about six pixels on screen, and phone cameras struggle. Zoom
the page, or hold the phone further away rather than closer.

**Ticking "Share the geography" offline answers `offline package: no ingestion
endpoint here`.**

Working as intended. The offline server has nothing to ingest into and says so
rather than failing silently.

**A seed is refused with `seed: truncated payload`, `seed: string overruns
payload` or `seed: arc flags overrun payload`.**

The seed is cut short. Copy it again, whole: a wrapped line in an email or a
chat client eating the tail are the usual causes.

**`seed: reserved header bit set` or `seed: trailing bytes after the last
beat`.**

The seed is structurally valid but not in the one encoding the format allows.
Either something appended bytes to it, or it was produced by a tool that fills
the header's spare bits. Both are refused so that one story has exactly one
seed string, see [seed-format.md](seed-format.md) "header bitmask". Re-generate
the seed from the save rather than trying to repair the string.

**`base64url: invalid character` or `seed: invalid base64url`.**

Something outside `A-Za-z0-9_-` is in the seed: a smart quote substituted by a
messaging app, a stray space, a `+` or `/` from a base64 converter, an OCR
mistake on a printed receipt. Copy the seed from the source rather than from a
rendering of it.

**`compress: decompressed payload too large` on a `.1z` seed.**

The seed inflates past 4 MB, and a real one is a few hundred bytes. Nothing
you can fix by retrying: that string is not a seed this pipeline produced.

**Printing the receipt shows the whole page, not just the sheet.**

The print stylesheet lives in `offline/tessera.css` under `@media print`; a
custom stylesheet that drops that rule (or a browser print preview that
ignores print media, some do by default) will show everything. Nothing about
the receipt itself changes: it is still built fresh in memory and still
printed by `window.print()`, only the layout is affected.

## The CLI

**`sha256sum -c MANIFEST.sha256` reports a failure.**

A file in `lib/` changed since the copy was vendored. Either someone edited it
in place, which nothing here should ever do, or the copy was refreshed without
regenerating the manifest. Note that this check only ever proves the copy
agrees with itself: to establish that `lib/` is really the site's code, diff it
against what the site serves ([audit.md](audit.md) section 3).

**`tessera dump-geo` output stops with `(N more rows, use --full)`.**

Deliberate. A real payload runs to thousands of systems. Pass `--full`, and
pipe it somewhere.

**`selftest` fails on `published seed still reproduces byte for byte`.**

The seed format changed. If that was intentional, regenerate the fixture with
`node bin/tessera.js selftest --update-fixtures` and commit the new one. If it
was not, something upstream moved without anyone noticing, which is what the
check exists for.
