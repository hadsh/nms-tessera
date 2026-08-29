<!-- Author: had.sh -->

# Build your own server

This package is the client half. It reads a save and produces a seed, and it
runs with the network unplugged. The other half turns a seed back into prose,
and it is not in this repository: [the-other-half.md](the-other-half.md)
describes what it holds and what it never will. This document describes the
other thing a spec is for, not what the server promises, but what it does, in
enough detail that someone could build one.

It is not a how-to.

What follows is the shape of the machine: the role it plays, the chain it runs on every request, the data it is allowed to keep, and the parts of the design that only
work because of what the server refuses to be. If you want to build a
compatible one, this is the map. The territory is yours to lay.

## 1. The server's role in the system

The client produces a seed. The server renders it. That sentence is the whole
division of labour, and everything else follows from taking it literally.

A seed is portable: a few hundred characters, self-describing, meaningful
without a database behind it, because a version tag on its tail says exactly
how to read it and the format has no free variable outside that tag. A
rendered story is not portable in the same way. It is prose, in a language,
built for the address book and reference data of a particular deployment,
resolving system and region names, distances, seasons, from whichever spatial
databases that deployment carries. The seed says which system. The server says
what that system is called and how far it sits from the centre, today, on this
host.

That split is why the seed carries facts and the server carries context. A
seed printed once has to mean the same thing forever, which is a promise about
bytes. A rendering has to read well, which is a promise about a place, a
language, a moment, and none of those are things a QR code on a sheet of paper
can hold.

Two servers reading the same seed do not have to produce identical prose.
They do have to agree on what happened: the same beats, the same facts, the
same counts. [concepts.md](concepts.md) section 6 calls this determinism a
privacy property first and a convenience second. It is also what makes a
second server possible at all: an implementation is free to write its own
sentences, as long as it is answering the same question the seed asks.

## 2. The chain of transformations

One request, five moves, always in this order:

```
seed  ->  decode  ->  beats  ->  enrich  ->  prose
```

**Decode.** Input: the base64url payload and its version tag, exactly as
described in [seed-format.md](seed-format.md). Output: a checksum verdict, a
presence bitmask, the destroy-key commitment, and the raw bytes of each beat
that is present, still unparsed against anything except the wire's own layout.
A decoder that only reads what [seed-format.md](seed-format.md) documents
needs no reference data at all, which is why `tessera decode` in this package
can already do half of this step offline. The site's own decoder,
`SeedDecoder`, is the mirror of that same read.

**Beats.** Input: the decoded bitmask and bodies. Output: a list of typed
facts, one per beat present, each carrying whatever
[seed-format.md](seed-format.md) section 4 says that beat type carries and
nothing it does not. This step is arithmetic, not interpretation: a varint
becomes a count, an address becomes a system reference, a month index becomes
a month. No lookup happens here, and no beat is invented that the seed did not
set a bit for. [beats.md](beats.md) is the catalogue of what can arrive at
this stage and why.

**Enrich.** Input: a beat's carried facts, plus whatever the deployment's own
reference data knows about the addresses and dates involved. Output: the
facts a sentence needs that the seed never carried, because they are
recomputable and recomputing them costs nothing next to shipping them:
which region and system a bare address names, how far that point sits from
the galactic centre, which season a month falls in, how long ago something
was relative to the story's other dates. This is the step that turns a
6-byte address into "Nid, in the outskirts of a region nobody has named yet",
and it is also the only step that needs a deployment's spatial database at
all. The site's own bridge for this, `StoryEnricher`, draws on read-only
reference data and falls back to a deterministic generator when an address
has no record.

An optional planning pass can sit between enrichment and prose: deciding an
order beats should read in, or a role a beat plays relative to its neighbours,
without touching a single carried fact and without writing anything back into
what the next step selects on. It changes how the story is told, never what
happened in it.

**Prose.** Input: the enriched, ordered beats. Output: text. This is the one
step that is allowed to vary between implementations, because it is the one
step that is about voice rather than fact. Given the same beats and the same
facts, this project's own renderer selects deterministically from a fixed
dictionary, keyed by a hash of the beat's own content, so the same seed always
reads the same way twice. A different server could write different sentences
for the same beats and still be a faithful renderer of the format, as long as
what it says is true to what the seed carries: it would simply be a different
voice telling the same story.

### Where the dictionary fits

The dictionary is not data about a player. It contains no field that came
from a save, a seed, or a request. It is the author's own text: hundreds of
curated sentence variants, organised by beat type, and the rules for which
variant a given beat's own facts (never anything external) select. It exists
so that the same journey, told twice, does not read like a mail-merge, and it
is a corpus you write once and keep improving, not a thing the server learns
from what passes through it.

A server implementing its own dictionary owns its own voice. Nothing about
the format requires borrowing anyone else's sentences, and nothing about a
seed leaks the dictionary that renders it: the seed is facts, the dictionary
is prose, and the mapping between them is a choice each deployment gets to
make for itself.

## 3. The data held

What crosses a render is not what stays after it. Four things earn a place
in permanent storage, and each earns it by being the price of a specific
promise rather than a convenience.

**Stored:**

- The commitment inside the seed (a hash, not a key), because it travels with
  every seed by construction and is never written anywhere on its own. See
  section 4.
- A refusal list, keyed on a hash of a story's content rather than of its raw
  bytes. This is the entire memory a takedown leaves: enough to say no to
  a story again, never enough to reconstruct it from the list alone.
- Whatever a story's own author explicitly opted to publish: the seed of a
  story added to a public gallery, kept because a gallery has to be able to
  re-render what it lists, and a hash cannot be re-rendered.
- Geography contributed under its own, separate opt-in: coordinates, names,
  in-game discovery credit, staged toward a shared reference dataset. This is
  corpus, not story. Nothing in it points back to a seed, and two players who
  discovered the same system contribute the same row.

**Not stored:**

- The destroy key. Only its hash survives, and that hash lives inside the
  seed, never in a table next to it. See section 4 for why the difference is
  the whole of the security model.
- The save file, in any form, at any size. Nothing about this chain of
  transformations needs it after a seed exists, and nothing here ever
  receives one.
- Any request for a seed that was not explicitly published. A story reached
  by its link is decoded, enriched, rendered, and forgotten in the same
  breath the response is sent.
- Any link between a story and the person who made it. Not a session, not an
  account id, not an IP address kept beside a seed. If a deployment's own
  request logs exist below the application, at whatever layer serves HTTP at
  all, that is infrastructure, not this design, and this design does not
  read them, join them, or write a story into them.

### Why the commitment, not the key

A key that could be recovered is a key that could be phished, or
leaked in a breach, and any of those would let someone other than a story's
author take it down. A hash cannot be reversed into the key that produced it,
so storing the commitment (or in this design, not even storing it separately,
just letting it ride inside the seed) means the server can *verify* a
takedown claim without ever being in a position to *forge* one. It answers
yes-or-no to "does this key match", and it can give that answer honestly
without ever having held the thing being checked.

## 4. The destroy key flow

The key is drawn once, client-side, at the moment a seed is built. Only its
hash is written into the seed, in a fixed position, before the first beat.
[seed-format.md](seed-format.md) section 2 has the byte layout; the two facts
that matter here are that the commitment is unconditional (every seed carries
one, so no header bit is spent announcing it) and that its position is the
defence: sitting inside the payload means it is covered by the same identity
as the story it protects, so swapping it swaps the story, not just the lock.

Taking a story down is one request, holding two values: the story's link and
the key as typed. The server:

1. Decodes the seed from the link and reads its commitment.
2. Hashes the key it was just given.
3. Compares the two hashes, in constant time, so a near-miss and a wrong
   guess look identical from outside.
4. On a match, records the refusal (a content hash, a date, and that the
   decision came from the depositor) and drops the key from memory. It is
   never written down, never echoed back, never logged.

There is no lookup in that sequence, because there is nothing to look up
against. The seed is self-certifying: it carries the only thing that could
verify a claim about it, and the server's job is comparison, not custody.

This is also why the flow needs no session and no challenge-response. A
challenge would have to be remembered between two requests, and remembering
one thing per attempt, per story, is exactly the state this design is built
to avoid holding.

### What this buys, and what it does not

A verified takedown reaches exactly the seed it names. Someone holding a
different seed of the same journey, minted with a key of their own, is
untouched by it, because there is no registry connecting the two seeds to
the same person or the same save. That is not a bug to fix later. Closing it
would require knowing who deposited what, which is the registry the whole
design exists to not build. [concepts.md](concepts.md) section 8 names this
gap plainly, alongside the ones it does not try to hide.

Right to be forgotten, in this shape, does not mean "we can find and delete
whatever you made". It means the opposite: you were never on file to begin
with, and the one thing that can stop a specific seed from rendering again
is a key nobody but you ever held.

## 5. The mosaic

Rendering is stateless by default. A story that opted into a public gallery
is the one deliberate exception, and the exception exists to serve exactly
one purpose: a wall has to be able to list what is on it, and to re-render
each piece when someone looks. Everything about how that wall is built
follows from that one requirement.

**A tile is written once, on an explicit act**, not discovered lazily the
first time someone happens to open the story's link. The two have very
different trust profiles: a route that only writes when a specific, aware
consent is present versus one that would let anyone who guesses or is handed
a link add an entry to a public gallery just by requesting it. Guarding the
write, not merely the read, is what keeps opting in meaningful.

**A tile starts unlisted.** Landing in a public gallery is not the same
event as being added to storage; a queue sits between the two so a human
looks at each piece before strangers do. What a queue checks for, and on what
signal, is exactly the kind of detail this document does not spell out, for
the same reason [the-other-half.md](the-other-half.md) gives: a published
filter is a published bypass.

**Placement is deterministic, never a live draw.** Given the same set of
approved tiles in the same order, a wall rebuilt from scratch lands every
piece in the same place, because the assignment is computed from the record
itself rather than rolled fresh each time the page loads. A wall that can be
rebuilt identically is a wall that can be audited; one that reshuffles itself
cannot.

**A takedown deletes the row, not just its visibility.** Removing a story
from the wall means the wall no longer has it, full stop, which is the same
posture the refusal list keeps: a decision recorded as an absence, not a flag
on a row that is still sitting there.

### What the wall is not

It is not a directory of everyone who has ever made a story. Stories that
never opted in leave no trace for it to enumerate, and the wall has no way
to ask "does a story exist for address X" for anything that is not already
on it. It is a gallery of what was explicitly handed over for display, and
nothing else is reachable through it.

### Geography is not the story

A story and its geography opt in separately, through separate buttons, and
they are stored separately for the same reason they are asked for
separately: geography is corpus (coordinates, names, discovery credit,
useful to a reference dataset regardless of whose journey it came from) and a
story is narrative (an interpretation of one save's shape, meaningful mainly
to the person who lived it and whoever they hand the link to). Merging the
two tables would tie a piece of shared, reusable map data to one specific
narrative artefact for no reason the map needs. [geo-format.md](geo-format.md)
documents the shape of what geography carries; nothing in it points back at
a seed.

## 6. How to build your own

Not a checklist. A description of what the shape above turns into if you
built it.

**You need somewhere to hold the four things section 3 lists as stored, and
nowhere that holds the things it lists as not stored.** That is a schema
decision before it is anything else: a refusal table keyed on content hash,
a gallery table keyed on the same, a geography store keyed on address, and
no table anywhere with a column that joins a story to a person. The absence
is the design; if your schema has a place to put an IP next to a seed, the
schema is already wrong regardless of whether anything is ever written there.

**You need a decoder**, either an implementation of
[seed-format.md](seed-format.md) in whatever language your server runs, or a
call out to this package's own `lib/seed.js`, which is exactly what it looks
like: a byte-for-byte copy of what a browser already runs, callable
server-side. Writing your own is the more interesting path if you intend to
diverge from this project's format later; calling this one is the faster
path to a working renderer today. Either way, `tessera selftest` in this
package is the reference you check a from-scratch decoder against: it walks
a worst-case fixture and demands the same numbers back.

**You need the enrichment step**, which means you need reference data about
the places a seed can name: enough to turn an address into a system and
region name, a distance, a season. This is the one piece with no shortcut
through this package, because it depends on whatever spatial dataset your
deployment has (or does not have) access to. Without one, you can still
decode and list facts; you cannot write "Nid" instead of an address.

**You need a dictionary**, meaning a set of sentence templates and the rules
for choosing among them per beat type, written by whoever is standing up the
voice of your server. This is not portable from this project's own
deployment, on purpose: the sentences are the author's own text, not part of
the format, and every server that renders seeds is expected to write its
own.

**You need to serve the rendered page**, over a route that decodes on every
request rather than looking anything up, checks a request's seed against
your refusal list before rendering a word of it, and writes nothing durable
unless the request is itself an explicit act of publication (a mosaic
submission, a geography contribution, a takedown). That last clause is the
one that is easy to get backwards: the render path being read-only is not
an optimisation, it is the property that makes "a story nobody opens is a
story the server has never heard of" true.

None of that is small, and none of it is described here at the level of a
tutorial. It is a description of the shape, offered so that someone building
their own can check their design against it rather than reinvent the shape
from nothing.

## 7. Limitations

**This is a specification, not an implementation.** The server behind
[glyphs.had.sh](https://glyphs.had.sh/) is not published here or anywhere
else, for the reason [the-other-half.md](the-other-half.md) closes on: the
client half can be audited by running it, and the server half cannot be, by
anyone, because there is no build of it to run. This document is what
replaces that audit for the parts that can be described in words: not a
promise that a particular codebase behaves, but an account of what any
codebase implementing this shape would have to do, and what it would have
to refuse to do, to earn the same claims.

**Running a server means holding other people's stories, even briefly, even
statelessly.** A render is a moment where a stranger's years of play pass
through code you wrote. Getting the shape in section 3 right, what is kept
and what is not, is necessary and not sufficient: it does not moderate
content on its own, it does not decide what is acceptable to host, and it
does not replace a person willing to look at a report and make a call. That
judgment is not something a specification can hand you.

**No guide substitutes for the trust a mosaic asks for.** A public gallery is
a promise to the people who opted into it that their story will be looked
after, shown in a queue before strangers see it, and taken down cleanly if
they ask. Nothing here can make that promise on a new deployment's behalf.
Building the mechanism is the smaller half of running one.
