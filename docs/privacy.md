<!-- Author: had.sh -->

# Privacy, in full

This document describes what the pipeline reads, what it keeps, what it drops,
what can leave your machine and under which conditions. It is written to be
checked, not believed: every claim about the client names the file that
implements it and, where possible, the command that verifies it. Claims about
the server are stated as behaviour rather than as file paths, for the reason
[the-other-half.md](the-other-half.md) gives at the top of that document.

Short version. Your save is read in your browser and never uploaded. Three
things can leave, all of them only if you ask: a geography contribution, sent
when you tick its box and press the primary button; your story, submitted to
the public mosaic at the end of the run if you ticked that box, where a human
reads it before it appears; and a seed, which you share yourself by handing out
its URL. The seed is anonymized by an explicit pass,
with one honest exception documented below: the names you chose in game travel
with it, and you decide their fate one by one before the seed is built.

Read section 3 before you tick the geography box, because the press that
continues is the press that sends: there is no confirmation step afterwards.
The button renames itself to say so, and that label is the last honest moment.

This describes the pipeline as it ships. See [concepts.md](concepts.md)
section 8 for what a future version of the format can and cannot change about
a seed already in someone's hands.

## 1. Where the computation happens

Everything runs locally. In the browser the pipeline runs inside a Web Worker
([lib/worker.js](../lib/worker.js)) so a 30 MB save does not freeze the page,
falling back to the main thread when Workers are unavailable. On the command
line the same modules run under Node.

The deobfuscation table needed to read modern saves is bundled as a JavaScript
module ([lib/mapping.json.js](../lib/mapping.json.js)), specifically so the page
never has to fetch anything to do its job.

There are exactly two network calls in the whole package, both in
[lib/app.js](../lib/app.js), one per checkbox: `fetch('/api/v1/geo')` inside
`sendGeoPayload`, called only from the branch that runs when the geography box
was ticked, and `fetch('/mosaic/publish')` inside `sendMosaicTile`, called only
from the branch that runs when the mosaic box was ticked. Nothing else in the
package opens a socket. `tessera selftest` fails if a third call appears, and
it also fails if either one moves out of its consent branch or gains a second
call site. That second half is the half that matters: the call count stayed at
one through the change that made this document wrong.

```bash
grep -rn "fetch(\|XMLHttpRequest\|sendBeacon\|WebSocket" lib/   # two hits
node bin/tessera.js selftest                                    # asserts where they are
```

## 2. What is read from the save

A save is a large JSON document with hundreds of obfuscated fields. The
pipeline can only name 88 of them: the deobfuscation table was trimmed to the
fields `extract.js` actually reads. Everything else in your save is, quite
literally, unnameable to this code.

```bash
node -e "import('./lib/mapping.json.js').then(m=>console.log(m.mapping.Mapping.length))"
# 88
```

Bounds are enforced while reading ([lib/limits.js](../lib/limits.js)): 64 MB of
input file, 96 MB of decompressed data, 512 chunks, 48 levels of JSON nesting,
8192 discovery records, 16384 systems, 8192 entries in any other save array
(bases, teleports, pets, settlements, missions, wonder records...), 32 hex
digits for a UA address before it is parsed as a number, 64 characters for a
name, 32 for a pseudonym. Each of these sits a few times over what the game
itself can produce (its own discovery buffer caps around 3200 records), not
over what a "big save" happens to look like - the margin is for save-format
drift, not for heroics. Strings are stripped of control characters. Nothing
from a save is ever evaluated as code: `JSON.parse` only, and text goes into
the DOM as `textContent`. `selftest`
asserts no module contains `eval` or `new Function`.

## 3. The three artifacts, and how they differ

The pipeline produces three things. They are not equivalent, and treating them
as such is the mistake this section exists to prevent.

### The report: local only

Built by [lib/report.js](../lib/report.js). It is the working view: totals,
contributors, trajectory, and the protagonist's own pseudonym, inferred as the
most prolific contributor in your save rather than hardcoded. It contains
identifiers. It is never sent anywhere, and no command uploads it. It is
printed by `tessera report` because you are entitled to see what was computed
about you.

### The geography, Payload A: opt-in

Built by [lib/geo.js](../lib/geo.js). This is the corpus contribution: system
addresses, the names you baptised (systems and planets), and black hole
routes with their candidate exits.

Only systems with an actual in-game discovery record travel: there is no
"the save merely visited this address" entry. One pseudonym survives in
the format by design, the `credit` field naming the first in-game discoverer
of a system. It travels on the basis that it is public information: any
player who visits that system sees who found it first, in game, without
needing your save or your consent to learn it - the format merely repeats
what the game already discloses. That basis is also why the same field can,
on a save synchronized with other players, name someone who is not you: the
credit belongs to whoever discovered the system, and that is a fact about the
system, not about your save.

Named plainly rather than left implicit: the processing basis for that one
field is legitimate interest, not consent, and the balance is not close.
Crediting the first discoverer is not this project's invention, it is the
genre's own norm - the game itself shows it to every visitor of a system,
without asking the discoverer first, because withholding it is what players
would experience as the actual harm. The field repeats a fact the game already
publishes to anyone who visits, the processing adds nothing beyond
transcription, and no new fact is created that the discoverer did not already
put in front of every future visitor by discovering the system. That is the
argument in one paragraph so it exists somewhere other than as an assumption:
it is not a substitute for a lawyer's opinion if one is ever needed, but it is
the reasoning this design rests on, written down rather than left to be
inferred. Planet entries are explicitly stripped of their
`user` field and
their own discovery date; only the system-level `credit` and its date travel,
and the two are never sent one without the other (both come from the earliest
event that carried both a timestamp and a username). Every free-text field
(`name`, `credit`) is length-capped in bytes, at most 6 planets per system are
sent, and a system with no name, no credit and no planet at all is dropped
before anything is encoded - it would have carried nothing beyond its address.

It leaves your browser when you tick "Share the geography" and then press the
primary button of the scan panel. Untick the box and nothing is built and
nothing is sent. There is no timer, no retry, no background upload and no
second attempt anywhere in the code: one press, one POST, or no POST at all.

Be clear about the ordering : the readable payload is rendered in the same instant the
send fires, so it is shown to you for transparency, not for a second
confirmation. Your decision is the checkbox plus the press, taken before you
have seen the bytes. If you want to see them first, build them offline and read
them there, which takes one command and no network:

```bash
node bin/tessera.js geo save.hg --quiet > readable.json   # what the page shows
node bin/tessera.js geo save.hg --quiet --post > post.json # what would be sent
node bin/tessera.js dump-geo post.json --full | less       # the second, decoded
```

Because pressing is deciding, the button names what it is about to do. It reads
"Continue" with both boxes clear, and rewrites itself to name the geography
send, the mosaic opt-in, or both, from the state of the two checkboxes
([lib/app.js](../lib/app.js), `refreshContinueLabel`). The wording lives in the
page, not in the code.

### The seed, Payload B: the thing meant to travel

Built by [lib/beats.js](../lib/beats.js) and encoded by
[lib/seed.js](../lib/seed.js). A few hundred characters holding the shape of a
journey. See [seed-format.md](seed-format.md) for every byte of it.

An explicit pass, `anonymizeBeats()`, runs before the graph is assembled:

```js
if ('user' in facts) {
    if (protagonist !== null && facts.user === protagonist) {
        facts.user = 'you';          // you become "you"
    } else {
        delete facts.user;           // everyone else disappears
    }
}
delete facts.sample_users;           // no sampled third parties either
```

No field of the wire format carries a pseudonym at all: check the field table
in [seed-format.md](seed-format.md), or run `tessera spec`. Third parties are
reduced to a count, `distinct_users`, and nothing more.

Lifetime counters get bounded rather than dropped. Everything countable, from
creatures fed to sentinels killed, is clamped to 9999 (deaths to 999), and the
two distance figures become a class from 0 to 4 instead of a raw unit count. Past
four digits a number stops describing a journey and starts identifying a
player, and no sentence needs the difference. [seed-format.md](seed-format.md)
section 5 lists every counter, where it rides and where it is read from.

Mission progress gets the same treatment at encoding time. The raw list of
completed mission ids never enters the stream; it is reduced to about twenty
booleans, one per named arc. This is not reversible, and `selftest` proves it:
re-encoding a decoded seed yields all-false flags, because there is nothing
left to rebuild the ids from.

## 4. Player-authored text: the honest caveat

Names you chose in game do travel in the seed. Eight fields across seven beats
carry them, all treated the same way:

| beat | field | treatment |
|---|---|---|
| `freighter_named` | name | tag stripped, CamelCase packed, cut at 16 characters |
| `first_naming` | system_name, planet_name | tag stripped, CamelCase packed, cut at 16 characters |
| `favorite_base` | name | tag stripped, CamelCase packed, cut at 16 characters |
| `atlas_encounter` | system_name | tag stripped, CamelCase packed, cut at 16 characters |
| `settlements` | first settlement name | tag stripped, CamelCase packed, cut at 16 characters |
| `first_pet` | name | tag stripped, CamelCase packed, cut at 16 characters |
| `multitool_named` | name | tag stripped, CamelCase packed, cut at 16 characters |

If you named a base after yourself, after someone else, or after anything you
would not want in a URL, that string (or its first 16 characters) is in the
seed, and anyone holding the seed can read it back with `tessera decode`. The
cap bounds length, not content: it is not a filter for personally-identifying
names.

This is a deliberate trade: those names are what makes a generated story feel
like yours rather than like a report. But it is your text, so you get the last
word on it.

### The choice happens before the seed exists

The page shows you every name it found and asks, for each one, before anything
is encoded:

- **keep it** as you typed it in game
- **drop it**, and the beat is written without a name
- **rename it**, and the replacement you type is what gets encoded

The ordering is the whole point, and it is not a detail of presentation. A name
you refuse is never encoded, so it is not in the payload, not in the CRC, not
in the URL, not in the QR code, and not in any copy of the seed that may
already have been pasted somewhere. There is no version of the seed that ever
held it. This is the opposite of redaction, which hides something that was
produced first and can resurface from any copy made before the hiding.

Renaming affects the seed alone. Your save file is a copy in your browser,
opened read only and can't ever written to, so nothing you decide here changes anything in game.

Reading your own seed is still worth doing before you share it, and it is the
only way to be certain rather than trusting this page:

```bash
node bin/tessera.js decode <your seed> | grep -i name
```

## 5. What the server does

Three endpoints matter, and they behave very differently.

**`GET /mosaic/tessera~{seed}`** renders a seed into prose. It is declared
`GET|HEAD` only and sets no-cache headers. The
rendering is deterministic: the same seed and the same dictionary always give
the same text. `/s/tessera~{seed}` is a short alias that redirects here, and it
is the form the QR code carries.

Reading writes nothing. A GET carries no token and no Origin check, so nothing
that changes state is allowed to hang off it: opening a story's link can never
by itself add that story to the gallery.

**`POST /mosaic/publish`** is the submission, and the only way into the
wall. It is what `sendMosaicTile` calls, once, at the end of a run where the
mosaic box was ticked. It requires the site's CSRF token and a matching
Origin, it refuses a seed whose `mosaic_public` bit is clear, and the row it
inserts lands `PENDING`: a human reads the story before it appears. The row
holds the seed string itself and the time. The seed string is not a hash:
anything in it, including the names from section 4, is stored with it and can
be read back with `tessera decode`.

So the two cases split cleanly. A story you never submitted leaves nothing
behind here at all. A story you submitted leaves the whole of itself, names
included. Which is precisely why there has to be a way back out, and there is:
spending your destroy key deletes that row, rather than merely hiding it. See
section 6b.

Which brings up the thing you should know before ticking that box.

**The mosaic bit is not authenticated, and cannot be.** It rides in the same
unsigned envelope as the story, guarded by a CRC-8 that exists to catch
corruption. Anyone can recompute that CRC, because there is no secret in it.
So anyone who obtains your seed - from a chat message, a QR code, the printed
receipt, a screenshot - can flip the bit and submit the result, and cause your
story to be queued for the wall even though you never asked for it. Doing so
costs sending a request with a token anyone can fetch, which is not
impossible, and the moderation queue, not the envelope, is what stands
between that and the wall. The content tiled is the content you already put in
a shareable seed; the choice that gets overridden is the one about making it
public.

This is a known and accepted property of the current design, not an oversight
under repair: the choice is to ship it and say so rather than to add a
signature or a server-side confirmation. Reproduce it in four lines if you
want to see it rather than take my word:

```bash
node bin/tessera.js dump <your seed> | head    # byte 2 of the header holds it
```

What follows practically: a seed is safe to hand to someone you would be
comfortable seeing publish it, and no safer. If that is not true of a
particular story, do not share its seed at all, with the box ticked or not.

Three properties do hold, and they are worth separating from the one that does
not. A seed cannot be altered into a *different* story without the change being
visible on decode, a seed has exactly one valid encoding:
reserved header bits and trailing bytes are rejected, so the same story cannot
be re-spelled into a different string with a different hash. That closes the
route by which a moderation decision could be evaded by re-encoding, and the
one by which the same story could be inserted hundreds of times as hundreds of
distinct tiles.

The second: the refusal list keys on the story's content, not on the literal
seed string. What gets hashed for that list is the beats, not the mosaic-bit
byte that rides alongside them, specifically so that flipping that one bit
does not produce a different key. Practically, once a depositor spends their
destroy key, every copy carrying that same story is refused from then on,
including a copy someone else forged by flipping the bit on a version they
were never given permission to publish. A forged submission does not get a
second life once its original is taken down; it inherits the same refusal
without needing to be found and reported individually. It does not need a
matching mosaic bit to be caught: content is what is compared, not bytes.

What that closes, and what it does not, both matter. It closes persistence:
there is no way for a forged public copy of a withdrawn story to keep
surfacing under a different encoding once the depositor has acted. It does not
close the window before that: a forged submission still reaches the moderation
queue and is read by a human moderator before anyone withdraws anything, which
is itself an unconsented read of content its author never chose to make
public, even when it is never actually published to the wall. The queue is the
backstop against forged content going live, not against forged content being
seen once by the one person whose job is to look at it.

**`POST /api/v1/geo`** ingests a geography contribution. It requires a CSRF
token and a valid Origin, and the global anti-abuse layer runs before it. What
it stores, in a staging database:
the decoded systems and routes, the raw payload as received, and a digest (hash) of
the source IP address, kept for abuse triage on a public write endpoint.

Treat that digest as personal data, because it is. It is also the one part of
the design that lives entirely on the server side, so it is a matter of
server-side discipline rather than something this package can demonstrate to
you. Section 7 says the same thing in general terms: a client-side audit
establishes client-side behaviour and nothing beyond it.

If that trade is not one you want to make, leave the box unticked. Nothing else
in the pipeline depends on it, and the seed is produced either way.

**`POST /mosaic/report`** is the way to tell us a story is a problem. It is
reachable from the bottom of every story with the seed
prefilled, and from the report page with a link pasted by hand. It stores the
reported seed, its hashes and the reason given. Nothing about the reporter is
read or kept: no account, no digest of the address, nothing. A false report
costs a row in a queue and never a sanction, so there is nothing to gain by
knowing who sent it. This is not part of the pipeline and its form does not
ship in `lib/`, for the reason given in the README: it posts on its own
account, outside the two consent ticks.

### What you get back for contributing

The choice is worth understanding rather than just declining, because the
geography is also what makes your own story richer when it is rendered.

The seed is deliberately thin. It carries addresses and month-level dates, and
the renderer fills the blanks by resolving each address against public spatial
data, falling back to the game's procedural name generator when it knows
nothing else. Read from a bare seed, your story speaks of systems by the names
the universe gives them.

The geography payload carries more, and it carries it for every discovery
record rather than for the handful the seed mentions: the name you gave each
system, the names you gave its planets, and the month the credited discovery
happened, plus what the server derives from the address alone.
Once staged, all of it becomes available to the renderer, whose lookup order
is official data first, then your contribution, then the procedural fallback.

Discovery dates are cut to the MONTH, the granularity of both
payloads. The readable JSON the page shows
you still displays the full timestamp it started from ("2016-08-13 22:10:30"),
but `buildGeoPayload` drops the day, hours and minutes before anything is
encoded. A month is only sent at all when a `credit` is: a timestamp with
nobody's name attached is not worth a byte of date. See
[geo-format.md](geo-format.md) and [seed-format.md](seed-format.md), which
specify each wire format byte by byte, and `selftest`, which asserts all of
this.

So the same seed, rendered after you contributed, tells the story with the
names you actually chose, across your whole map instead of a few landmarks.
That is the upside, and it is a real one.

It is also, stated plainly, the path by which those names and timestamps reach
a server. Both halves of that sentence are true, and which one weighs more is
yours to decide, once, at the checkbox, before the press that acts on it.

## 6. Your local record

Every extraction builds a receipt ([lib/receipt.js](../lib/receipt.js)): the
SHA-256 fingerprint of the file you processed, a summary of what was computed,
the seed, and the encoding and byte count of the geography payload, and your 
destroy key. The
readable geography itself is on the printable sheet rather than in the receipt
JSON. It exists only for
as long as the tab stays open, in memory, to answer the question of what this
tool actually computed on which file. Nothing about it is written to storage
of any kind: no IndexedDB, no localStorage, no cookie.

"how do we protect data we don't need to keep" only has one clean answer:
stop keeping it. The receipt is now handed to you two ways instead, both
one-shot: a JSON download (`download-ticket`), and a printable sheet - the
same facts plus the QR - that `window.print()` turns into a PDF through the
browser's own "save as PDF", no library, no upload. Close the tab without
using either and nothing of it remains anywhere.

## 6b. The destroy key: leaving, without ever having arrived

Every seed carries a 15-byte commitment: `SHA-256` of a 120-bit key your
browser draws when it builds the seed, and prints once on your receipt. Typing
that key on the takedown page stops the story rendering and deletes its gallery
entry, immediately, with no account and no proof of who you are.

**Nothing is registered when the story is made.** No request leaves the page,
so the server does not learn that your story exists. It learns only if you come
back to remove it, and what it then keeps is a hash of the seed and a
timestamp: not the seed, not your key, not your address, not who asked.

**The commitment reveals nothing.** It is the hash of an unstructured random.
It refers to no person, no save and no story, and it is published in the URL
precisely because there is nothing in it to protect. Recovering the key from it
would mean a preimage search over 120 bits, on the order of 2¹²⁰ operations. 
Even at a trillion attempts per second, that would take roughly 10¹⁶ years,
several million times the current age of the universe.

**Why it lives inside the seed.** An engagement only means something if it was
fixed before the challenge and cannot be swapped afterwards. Inside the payload
it is covered by the seed's identity: change it and you have named a different
story. Beside the seed it would be a detachable label, and anyone holding a
public link could replace it with a commitment to a key of their own and take
your story down.

**There is no recovery, and that is the point.** If you lose the receipt, the
story stays up forever. We cannot restore the key, because we never had it. Two
alternatives were considered and rejected:

- *Prove you still hold the save.* It does not work. The seed is public and the
  extractor is published, so anyone with the link can decode the beats and
  hand-build a save file that produces exactly them. Demanding more matching
  fields changes nothing: 100% is reachable by construction, because the
  answers are printed on the link.
- *Commit to something stable in the save instead.* Worse than no recovery. The
  stable, unique values in a save are account identifiers: structured and low
  entropy, on the order of 2^32. Publishing their hash in a URL would hand
  anyone an offline search that ends at the player.

So the honest version is the one we ship: the key is on the receipt, the
receipt is the backup, and nobody, us included, can give it back to you.

## 7. What this design does not protect against

Stated plainly, because a privacy document that only lists strengths is
marketing.

- **A shared seed is public.** It is not encrypted and not signed. Anyone with
  the string can decode it, including the names discussed in section 4. The
  CRC-8 is a checksum and a watermark, nothing more.
- **Taking a story down does not un-share it.** The link stops rendering here
  and the gallery row is deleted, but anyone who already copied the seed string
  still holds a decodable copy, and the destroy key does not reach into their
  files. Removal is removal from this site, not from the world.
- **Lose the destroy key and the story is permanent.** There is no reset, by
  design: see section 6b for why every alternative is worse.
- **Geography can be correlated.** A set of system addresses and dates is
  distinctive. Contributing it, then publishing a seed covering the same
  journey, links the two. Both are opt-in, and they are opt-in separately.
- **Dates are dates.** Both payloads round timestamps to the month, which is
  coarse but still a timeline of when you played.
- **Addresses are game coordinates, and they are public.** They describe places
  in a procedurally generated universe that anyone can visit; they say nothing
  about where you live. They do say where your bases are, in game.
- **This package proves client behavior, not server behavior.** Sections 1 to 4
  are verifiable on your own machine with the commands given. Section 5 names
  the server files by path, but that code is not published and this package
  does not carry it, so nothing there is checkable from here. Take it as a
  description, not as evidence.

## 8. Verifying the claims

[audit.md](audit.md) is the step by step version of this section, written for
someone who assumes the author is lying.

```bash
node bin/tessera.js selftest     # anonymization, no eval, the two declared calls
sha256sum -c MANIFEST.sha256     # drift check; real proof is audit.md section 3
node bin/tessera.js report save.hg   # everything computed about you, locally
node bin/tessera.js geo save.hg      # exactly what ticking the box would send
node bin/tessera.js decode <seed>    # exactly what your seed reveals
node bin/tessera.js serve            # run it in a browser, network tab open
```

The last one is the honest test. Open the network tab, push a save through the
page with both boxes clear, and watch nothing happen. Then do it again with the
geography box ticked, and watch exactly one POST leave at the moment you press
the button, carrying exactly the bytes `tessera geo --post` printed for you.
Tick the mosaic box instead and you get the other one, and only at the end,
once the seed and the destroy key are on screen. Offline both are answered with
a 501, which is itself worth seeing: the call is real, the destination is not.
Both halves are the test: the first shows the default, the second shows that
the only departures are the ones you asked for, at the moment you asked :)
