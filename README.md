<!-- Author: had.sh -->

# tessera

The recipe that turns a No Man's Sky save into a story seed, packaged so it can
be read, run and checked by anyone, with no server involved.

Seed v1.0 is what ships. [docs/concepts.md](docs/concepts.md) section 8
explains what a future format version can and cannot change about a seed
already printed or scanned.

A `tessera` is the small token you hand over as proof of your journey: a seed
of a few hundred characters, carried in a URL as `tessera~{seed}`, that holds
the shape of a save without holding the save. This directory is the client half
of that: the JavaScript pipeline as it runs in the browser on
[glyphs.had.sh](https://glyphs.had.sh/), plus the tooling to run it offline and
audit it.

If you are here to understand rather than to run something, start with
[docs/concepts.md](docs/concepts.md). It is the reasoning behind the whole
thing: why the story lives in the artefact instead of in a database, what that
buys, what it costs, what it forbids, and where the design is knowingly weak.
Everything in this README is an implementation of the decisions that document
explains.

A tessera (plural: tesserae) is a small object whose meaning depends on its
historical context. The Latin word simply means "small cube" or "tile", but it
came to refer to several different things in the ancient world:

- **An ancient token**: a small piece of bone, ivory, clay, or metal used as a
  pass, voucher, identification token, or proof of entitlement. Tesserae could
  grant access to public distributions, banquets, military passwords, or
  official events.
- **A theater ticket**: in Ancient Rome, a tessera theatralis was a token
  engraved with information such as the section, row, or seat, allowing
  spectators to enter and find their assigned place.
- **A mosaic tile**: the tiny cubes of stone, glass, or ceramic used to create
  mosaics are also called tesserae. Each individual piece contributes to a
  larger image, much as pixels form a digital picture.

Although these meanings seem unrelated, they all share the same underlying
idea: a small piece that forms part of a larger system, whether granting
access, identifying a person, or building an image. This common symbolism is
why tessera is often used today as a metaphor for a fragment that gains its
full meaning only within a greater whole.

The mosaic sense turned out to run deeper than a metaphor. A mosaic's
tesserae are also, literally, among the pieces that most often survive a
building's collapse intact, being small, durable, and never one fragile whole
to begin with, which is a large part of how archaeology knows as much as it
does about floors nobody living has stood on. What this package calls the
Mosaic, the site's public wall of stories, is built the same way: individual
pieces, each complete on its own, that only add up to a picture once enough of
them are set down together. [docs/archaeology.md](docs/archaeology.md) makes
that reading in full, including where it stops being a nice metaphor and
starts being an actual argument about what this format is for.

This one was built for a specific date: No Man's Sky turns ten on 2026-08-09,
#NMS10, and the package is timed to that anniversary rather than to any
release schedule. It is not trying to be infrastructure or a platform. It is a
small, friendly, deliberately poetic tool with one job: take a save file that
represents years of someone's actual time in the game, and hand back a story
worth keeping.

```
save.hg  ->  extract  ->  geography (Payload A)  ->  facts  ->  beats  ->  seed (Payload B)
                                                                            |
                                                    tessera~q2D4sefGkQfdLA_42fl...1z
```

## What is in here, and what is not

`lib/` is a byte-for-byte copy of the site's `public/assets/js/story/`. Not a
rewrite, not a demo port: the same files. Verify that claim yourself by diffing
them against what the site serves, see [docs/audit.md](docs/audit.md) section 3.
Everything that computes a seed lives there.

What is deliberately absent: the server half. Rendering a seed back into prose
uses PHP services (`SeedDecoder`, `StoryEnricher`, `NarrationService`), a
narrative dictionary and read-only spatial databases.
None of that is needed to produce, inspect or decode a seed,
which is what this package is for. What that half does with a seed, what it can
hold and what it is incapable of, is described in
[docs/the-other-half.md](docs/the-other-half.md): it cannot be audited by
running it, so it gets a document that names its limits instead.

Also absent, and for a sharper reason: the site's takedown form and its report
form. They post to the server on their own account, outside any of the two
consent ticks the pipeline knows about, so shipping them in `lib/` would break
the one posture check this package can make about itself, that nothing here
opens a socket except the two opt-in sends. Minting a destroy key and
committing to it is in scope and lives in `crockford.js`; spending one is a
server conversation and is not.

```
lib/                the pipeline, unmodified
  limits.js         hard bounds (file size, decompression, depth, string lengths)
  lz4-block.js      LZ4 block decompression for obfuscated saves
  mapping.json.js   bundled field-name deobfuscation table (no fetch)
  extract.js        save -> systems (discovery records only), player states
  geo.js            Payload A: geography + POST body
  report.js         aggregated facts of the journey
  beats.js          facts -> narrative beats, anonymized
  seed.js           Payload B: positional binary seed, encode and decode
  crockford.js      the destroy key: 120-bit draw, Crockford base32, commitment
  compress.js       base64url, deflate-raw, crc8 watermark
  pipeline.js       the orchestration, host agnostic
  worker.js         Web Worker wrapper
  app.js            browser UI wiring
  receipt.js        in-memory receipt (JSON download + print sheet, no storage)
  qrcode.vendor.js  QR rendering (third party, MIT, see Provenance)
bin/tessera.js      CLI: run, decode, dump, dump-geo, spec, selftest, serve
tools/annotate.js   the seed layout, executable: walks a payload byte by byte
tools/annotate-geo.js  same, for geo-v1 (Payload A)
tools/geo-fixture.js   synthetic geo payload used by the docs and the checks
test/selftest.js    format and posture checks, no save file needed
docs/concepts.md    the decisions behind all of this, and what each one costs
docs/the-other-half.md  what the server does with a seed, and what it holds
docs/audit.md       how to verify all of this without trusting the package
docs/audit-agent.md doing that audit with an AI agent, prompts included
docs/seed-format.md the seed format, bit by bit, with a worked example
docs/geo-format.md  the geo-v1 format, the payload the opt-in posts
docs/beats.md       the 17 beats: what fires them, what they carry
docs/privacy.md     what is read, what travels, what does not, and how to check
docs/troubleshooting.md  real error messages and what causes them
docs/archaeology.md what makes this a record and not just a tool, and what
                     that asks of a format built for a URL bar
CHANGELOG.md        package and pipeline history, breaking changes flagged
fixtures/           synthetic worst-case seed and its decoded beats
offline/            local page: the site's element ids and lib/ scripts
MANIFEST.sha256     sha256 of every lib/ file
LICENSE             provisional, restrictive: read and run, do not redistribute
```

## Quick start

Node 18 or later, no install, no dependency, no network.

```bash
node bin/tessera.js selftest              # checks the format, needs nothing else
node bin/tessera.js spec                  # the frozen seed tables
node bin/tessera.js run /path/to/save3.hg # full pipeline on your own save
```

Typical `run` output:

```
systems         53 dated, 64 in geography
regions         9
galaxies        1 (0)
events          167
period          2016-08-13 12:46:13 -> 2018-07-29 16:31:32
blackhole       0 routes
beats           7 (first_system, freighter_named, main_story_arc, ...)
payload A       1411 bytes posted, encoding deflate-raw+base64url
payload B       127 chars

seed            tessera~q2D4sefGkQfdLA_42flzEhXcclKTM1IVnHJSS1MZGBn4HRgYGFg4wGq4...1z

destroy key     4PTR3-KXD5V-SHECP-X51N8-3M9Y1
                keep this. it is the only thing that can remove the story,
                and it cannot be recovered by anyone, including us.
```

The destroy key is printed once, here, and never again. It was drawn in that
process and stored nowhere: the seed carries only its hash. Keep it if you
intend to publish the story and might want it gone later.

Where the saves live: `%APPDATA%\HelloGames\NMS\<id>\` on Windows,
`~/.local/share/HelloGames/NMS/<id>/` on Linux (Steam),
`~/Library/Application Support/HelloGames/NMS/` on Mac. Take one `saveN.hg`
file, the slot of the character you want. `accountdata.hg` and the `mf_*`
manifests are not saves and are rejected with a clear message.

## Commands

| Command | What it gives you |
|---|---|
| `run <save.hg>` | the whole pipeline, human summary, the seed and the destroy key |
| `seed <save.hg>` | the seed alone, ready to pipe |
| `beats <save.hg>` | the detected beats as JSON, with facts and salience |
| `report <save.hg>` | the aggregated facts the beats are built from |
| `geo <save.hg> [--post]` | Payload A, readable, or the compressed POST body |
| `decode <seed\|file>` | a seed back into beats, the round trip in one call |
| `spec [--json]` | beat indices, dated flag, payload sizes, read from the code |
| `dump <seed\|file>` | byte by byte listing of a seed, with the bits |
| `dump-geo <file\|data> [--full]` | same, for a geo-v1 POST body |
| `selftest [--update-fixtures]` | format and offline-posture checks |
| `serve [--port 8787]` | the local page on `127.0.0.1` |

Common flags: `--out <file>` to write the result to disk, `--quiet` to drop the
progress journal on stderr, `--pretty` to indent JSON.

Why your story mentions one thing and not another is answered beat by beat in
[docs/beats.md](docs/beats.md). When something is refused or looks wrong,
[docs/troubleshooting.md](docs/troubleshooting.md) lists the real messages and
their causes.

`decode` accepts a bare seed, a file containing one, or anything with the
`tessera~` marker in it, so a pasted URL or a QR scan works as is:

```bash
node bin/tessera.js seed save3.hg --quiet > my.seed
node bin/tessera.js decode my.seed
node bin/tessera.js decode 'https://g.had.sh/s/tessera~q2D4sef...1z'
```

## Running it in a browser, offline

```bash
node bin/tessera.js serve
# then open http://127.0.0.1:8787/
```

This serves `offline/index.html` with `lib/` and nothing else, on the loopback
interface only. A small server is needed rather than opening the file directly
because browsers refuse ES modules and Web Workers over `file://`.

The page carries every element id `lib/app.js` reads, loads the same scripts
from `lib/`, and declares the same Content-Security-Policy (`default-src
'none'`, no inline script, no inline style, no external origin). `selftest`
checks that id parity on every run, so a page that drifts from the site's
markup fails loudly instead of throwing silently on the first click.

Two differences from the site page, both deliberate. The site hides the file
input behind a styled button wired by a page script that lives outside `lib/`;
here the native input is shown as is. And there is no ingestion endpoint on
loopback, so if you tick "Share the geography" and continue, the upload is
attempted and answered with an explicit 501 rather than quietly doing nothing.

Keep the network tab open while you run a save through it. Leave both boxes
unticked and there is nothing to see, which is the point. Tick the geography
box and you will see exactly one POST, at the moment you press the button:
that is the whole of the network behaviour, observed rather than read.

## The seed format, in short

```
tessera~ base64url( crc8("had" + payload) | payload ) . 1   raw
tessera~ base64url( crc8("had" + payload) | payload ) . 1z  deflate-raw

payload = header (3 B) | commitment (15 B) | beats
```

The payload opens with a three byte presence bitmask, one bit per beat type,
then fifteen bytes of destroy-key commitment, and the beat bodies follow in
beat-table order with no per-beat marker. Each dated beat carries one absolute
month index since the game's release month (2016-08), self-contained, not a
delta from anything. Then the beat's fields in a frozen order. No keys, no
separators, no JSON. Integers are unsigned LEB128 varints, system addresses are
11 hex characters packed as one varint. The encoder emits both envelopes and
keeps whichever is shorter as text.

The commitment is `SHA-256` of the destroy key your browser drew when it built
the seed, truncated to fifteen bytes. It is on every seed, and it is what lets
you take your own story down later: you type the key, the server hashes it and
compares. Nothing is registered when the story is made, so the server does not
learn a story exists unless you come back to remove it. It sits inside the
payload rather than beside it for a specific reason: there, it is covered by
the seed's own identity, so nobody can swap it for a commitment to a key of
their own and take down a story that is not theirs.

Six bits of the header are reserved for future beat types. A decoder rejects a
seed that sets them, and rejects trailing bytes after the last beat, so one
story has exactly one encoding.

The leading byte is CRC-8/SMBUS over the payload prefixed with the ASCII bytes
`had`. It catches corruption and marks the origin of the seed. It is eight
bits, so it catches 255 corruptions out of 256. It is not a signature, it was
never meant to be one, and nothing about a seed is authenticated: see
[docs/privacy.md](docs/privacy.md) section 4 for what follows from that,
because one real consequence does.

`tessera spec` prints the frozen tables (beat index, dated or not, field
order, worst-case size) by encoding one beat of each type and measuring the
result, so the table can never drift away from the code that produced it.

[docs/seed-format.md](docs/seed-format.md) is the full specification: every
primitive spelled out bit by bit, a complete 49 byte seed dissected field by
field, the frozen beat table and the arc flag bit order. `tessera dump <seed>`
produces the same listing on any seed of your own.

## Privacy, concretely

Three artifacts come out of the pipeline, and they are not equivalent:

- **The seed (Payload B)** is the one meant to travel. The protagonist is
  always `you`, third-party pseudonyms are dropped, mission progress is reduced
  to a handful of booleans at encoding time, and raw mission ids never enter
  the stream. `selftest` asserts that last point: re-encoding a decoded seed
  produces all-false flags, because the ids are not recoverable from it.
- **The geography (Payload A)** is the corpus contribution: systems, planets,
  black hole routes. It carries the in-game discovery credit, which is the one
  pseudonym in it. It leaves the browser only if the player ticks "Share the
  geography" and then presses the primary button, which renames itself to say
  so. There is no second confirmation after that press: the button is the
  decision, which is why it names what it is about to do.
- **The report** is a local working view and does contain identifiers found in
  the save. It is printed by `tessera report`
  for inspection, and nothing in the pipeline sends it anywhere.

- There is a fourth thing, and it travels in the opposite direction: the
**destroy key**. `tessera run` prints it once, under the seed, and it is the
only output that must not be shared. It is 120 bits drawn locally, it is never
sent, and only its hash goes into the seed. Typing it on the site's takedown
page removes the story. Losing it means the story stays up: there is no
recovery, on purpose, because any way for the server to remove a story without
the key would also be a way for a stranger to remove yours. The reasoning, and
the two rejected alternatives, are in [docs/privacy.md](docs/privacy.md)
section 6b.

[docs/privacy.md](docs/privacy.md) covers this in full: the 88 save fields the
code can even name, the anonymization pass, the player-authored names that do
travel, what the server stores, and what the design does not protect against.

The save itself is never uploaded, never parsed as code, never executed.
`limits.js` fixes hard bounds (64 MB file, 96 MB decompressed, 512 chunks, 48
levels of JSON nesting, 4 MB for what a compressed seed may inflate to,
bounded string lengths) so a hostile file is rejected rather than heroically
processed.

## Auditing it yourself

The short version is below. [docs/audit.md](docs/audit.md) is the full
walkthrough, including the one check that does not rely on anything shipped
here: diffing `lib/` against the files the live site serves.

Each claim above has a way to check it that does not require trusting this
README.

```bash
sha256sum -c MANIFEST.sha256    # lib/ has not drifted since it was vendored
node bin/tessera.js selftest    # format round-trips, no eval, no stray network call
sha256sum -c MANIFEST.sha256    # same thing with your own tool
grep -rn "fetch(\|XMLHttpRequest\|sendBeacon" lib/   # 3 matching lines: 2 in app.js (one call per line), 1 in app.min.js (both calls squished onto its one line)
```

If you would rather have a machine read the fourteen modules for you,
[docs/audit-agent.md](docs/audit-agent.md) carries the prompts. It is built
around the one thing that makes an agent audit worthless: pointed at this
directory, an agent reads the documentation, runs the commands the
documentation suggests, and reports that the package agrees with itself.

There are exactly two network calls in the whole package, both in `lib/app.js`,
one per checkbox:

| call | function | runs when |
|---|---|---|
| `fetch('/api/v1/geo')` | `sendGeoPayload` | the geography box was ticked before the primary button was pressed |
| `fetch('/mosaic/publish')` | `sendMosaicTile` | the mosaic box was ticked, and only once the seed and the destroy key are on screen |

`selftest` holds both to the same rule: it fails if a third call appears, if
either one moves out of its consent branch, if either gains a second call site,
or if any module gains an `eval` or a `new Function`. Adding a third send is a
decision someone has to write down in that list, not a refactor that slips
through.

That trigger check exists because counting calls is not enough: a send can
move from a click handler into the main flow without the count itself
changing, leaving the check green while the claims made about it go stale.
Counting is not a posture.

To see what a seed actually holds, decode one:

```bash
node bin/tessera.js decode fixtures/max-synthetic.seed
```

`fixtures/max-synthetic.seed` is a hand-built worst case: every beat type at
once, every optional name filled, every progress flag set, dates spanning the
whole possible range. No real player looks like this, which is exactly why it
is the fixture. Regenerate it with `node bin/tessera.js selftest
--update-fixtures` when the format legitimately changes; a change that was not
intended shows up as a failed check first.

## Keeping the copy honest

`lib/` is never edited here. Fixes belong upstream in the site assets, and the
copy is refreshed with plain tools:

```bash
cp /path/to/public/assets/js/story/*.js lib/     # never the .min.js
sha256sum lib/*.js > MANIFEST.sha256
node bin/tessera.js selftest
```

`MANIFEST.sha256` detects drift, and nothing more. It ships inside the copy it
describes, so it cannot detect tampering: altering `lib/` and regenerating the
manifest produces a package that agrees with itself perfectly. There is
deliberately no command here that pretends otherwise. The check that means
something is the diff against the live site in
[docs/audit.md](docs/audit.md) section 3.

## Provenance and license

Everything under `lib/` except `qrcode.vendor.js` comes from
[glyphs.had.sh](https://glyphs.had.sh/) and is authored by had.sh.

`lib/qrcode.vendor.js` is davidshimjs/qrcodejs 1.0.0 (MIT), encoder by Kazuhiko
Arase, vendored locally so no CDN is ever contacted. Its own license applies to
it.

No license has been chosen yet for the had.sh part of this package. Until I
choose, it is my code: [LICENSE](LICENSE) holds the provisional terms. Read it,
run it on your own saves, keep what it produces from your own data. Do not
redistribute it, do not build on it, do not ship it in anything. That is a
placeholder for a decision, not the decision.

## The ideas are open, the code is a conversation

The ideas are a separate matter, and they are not fenced off. The shape this
package is built in is described in [docs/concepts.md](docs/concepts.md)
precisely so it can be taken, argued with and improved on: an artefact that
carries its own story and its own destruction, a server that holds nothing, a
consent that is an act rather than a setting. Build that. It is worth building.

For the code itself, or any part of it, ask. That is not a polite way of saying
no, it is a preference for knowing who is building what, and the answer is
likely to be yes.

I am reachable at [had.sh](https://had.sh/)