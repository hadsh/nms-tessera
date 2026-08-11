<!-- Author: had.sh -->

# The other half: what the server does

This package is the client half. It reads a save and produces a seed, and it
can do all of that with the network unplugged. The other half turns a seed back
into prose, and it runs on a server you do not control, which is exactly why it
deserves a description you can hold it to.

This document is that description. It is written to be sufficient, not
exhaustive: enough to know what is held, what is not, and what the server is
incapable of, without publishing a map of where things sit or what would make
them fall over.

## What is deliberately left vague

Three kinds of detail are omitted on purpose, and the omission is named here
rather than left for you to notice:

- **Where things live.** File paths, database names, directory layout.
- **How the defences work.** They are real and they are layered, and that is
  the whole of what is said about them: not their thresholds, not their
  arrangement, not how they answer when pushed.
- **How moderation decides.** That a check happens is stated. What it matches
  on is not, because a published filter is a published bypass.

None of the three changes what is stored or what leaves. If you find a claim
here that only holds because a detail is missing, that is a bug in the document
and worth reporting.

## 1. Rendering holds nothing

A story is opened by its link. The seed in that link is decoded, checked for
integrity, enriched with reference data about the places it names, and rendered
as prose. The server has no record of that story from before the request and
keeps none afterwards.

There is no lookup by identity anywhere in that path, because there is no
identity: no account, no session, no cookie required to read a story. The seed
is the whole of the input.

Two consequences worth stating plainly, and one deliberate exception.

A story nobody opens is a story the server has never heard of. And a story
cannot be found, only visited: no listing, no search, no way to ask which
stories exist, because nothing holds that answer.

### 1.1 The Mosaic, the one thing meant to be listed

The exception is the Mosaic, and it is the entire purpose of the second
checkbox. Ticking it means: put this story on a public wall, and that choice is
encoded in the Tessera itself rather than kept as a preference in a table
somewhere. So for those stories, and only those, the server does keep a row,
and that row exists in order to be listed. That is not a leak of the design, it
is the feature the box turns on, and it is the one place where "the server
holds nothing" stops being true.

What sits in that row is still a Tessera, and a Tessera is anonymous by
construction: no account, no platform identity, no other player's name, and a
protagonist who is only ever "you". The single exception is the one described
in [concepts.md](concepts.md) section 4: the names the player chose in game
travel with the story, and they travel because that player looked at them one
by one and decided to keep them. So the wall is a wall of anonymous stories.

What that means concretely:

- **The row holds the seed itself, not only its hash.** A wall has to re-render
  the stories on it, and a hash cannot be re-rendered. The hash is the dedupe
  key. Keeping the seed is not an extra exposure: it is exactly what the
  depositor agreed to make public by ticking the box.
- **The Mosaic is the only population that can be enumerated.** Opting in
  changes the story from "reachable by whoever holds the link" to "reachable by
  anyone browsing", which is the actual cost of that checkbox and the reason it
  is off by default and worded as an act.
- **A takedown deletes the row**, rather than hiding it. Removing a story
  removes it from the wall and from the table behind it.

Stories that did not opt in have none of this. No row, no hash, no trace, and
no way for the wall to know they ever existed.

## 2. What the server can hold

Exhaustively, at the level that matters. Four things, and no fifth.

### 2.1 The refusal list

When a story is taken down, its hash is recorded, with the date and whether the
decision came from the depositor or from us. Not the seed, not the story, not
who asked, not from where. A hash of a seed cannot be turned back into the
seed, so this list is a list of things to say no to and nothing more.

That hash is computed over the story's content, the beats, not over the
literal seed bytes the depositor happened to submit. The mosaic-bit byte rides
alongside the beats but is not part of what gets hashed for this list. The
reason is [privacy.md](privacy.md) section 5: the mosaic bit is unsigned, so
anyone holding a seed can flip it and resubmit. Keying the refusal list on
content rather than on the exact bytes means a forged copy of an already
withdrawn story is refused on arrival, whatever the mosaic bit says on that
particular copy. It does not prevent a first forged submission from reaching
the moderation queue before anyone has withdrawn anything; it prevents that
submission, or any other copy of the same story, from having a second life
once the depositor acts.

### 2.2 Mosaic entries, for opted-in stories only

The row holds the seed, its hash and a date, and it is the one thing here that
is meant to be listed. Detailed in section 1.1, including why it holds the seed
rather than only its hash.

### 2.3 Geography contributions, for those who ticked that box

Coordinates, systems, regions and black hole routes, staged for promotion into
the shared reference data. This is corpus, not story: it carries the in-game
discovery credit that came with the coordinates, and nothing that ties it to a
seed, a story or a person. Two players who visited the same system contribute
the same row.

### 2.4 Ordinary infrastructure records, which are not mine

Listed here for completeness, and to be clear about what it is: this is not a
choice made by this project, it is how the internet works. Every request you
make anywhere leaves records along the way, at your access provider, at the
networks in between, at the edge, at the host. That is true of this site
exactly as it is true of every other site you opened today, it happens at
layers below the application, and no design decision made here removes it.
Anyone claiming otherwise about their own site is describing something they do
not control.

What is a choice is what the application does with it, and the answer is
nothing. It does not read those records, does not join them to anything, and
writes no story, seed or hash into them. There is no table anywhere in which a
request and a story sit in the same row, which is why "who read this story" has
no answer here rather than a protected one.

## 3. What the server never holds

- **The save file.** It is never uploaded. Not a copy, not a fragment, not a
  hash of it. The pipeline in `lib/` is what reads it, and it runs on the
  player's machine.
- **A destroy key.** Only the hash of one, and that hash travels inside the
  seed rather than in a table. The server cannot recover a key, cannot mail one
  out, and cannot tell you whether a given story still has an owner who holds
  it.
- **Seeds of stories that did not opt in.** They pass through a request and are
  gone.
- **Any link between a story and a person.** There is no such column anywhere,
  which is why the question "which stories did this person make" has no answer
  rather than a protected one.
- **Analytics, telemetry or third-party scripts.** The pages carry a content
  security policy that permits their own origin and nothing else, which is what
  makes this sentence enforceable rather than aspirational.

## 4. The same seed always renders the same story

Rendering is deterministic. The narration draws from a fixed dictionary and
selects with rules derived from the seed's own content, never from a random
draw, the time of day, the visitor, or anything the server knows and the seed
does not.

That is a privacy property, not a performance one. If the output varied per
visitor, the variation would be information, and it would come from somewhere.
Here it cannot: two people opening the same link a year apart read the same
sentences. It also makes the whole thing checkable, since a claim about what a
seed renders to is a claim you can test.

The reference data the renderer enriches with is read-only to the application.
It describes places, not people, and no request path writes to it.

## 5. What happens on a read, and in which order

The order matters more than the steps:

1. The seed is decoded and its integrity checked. A mangled seed is refused
   before anything else touches it.
2. The refusal list is consulted. A story its depositor asked us to remove
   stops rendering immediately, without a word of it being read.
3. The moderation gate runs. What the check
   looks for is not described here, for the reason given at the top.
4. Only then is the story enriched, rendered, and, if it opted in, added to the
   Mosaic.

A visitor holding a link to a story that is gone is told it is unavailable.
They are not told whether it was withdrawn by its author or stopped by
moderation, and never who decided.

## 6. Taking a story down

The exchange itself is described in [concepts.md](concepts.md) section 3, and
the reasoning behind the shape is there rather than repeated here. What belongs
in this document is what the server does with it:

- It verifies a typed key against the commitment carried by the seed presented
  with it. Nothing is looked up, because there is nothing to look up.
- It refuses every failure with one identical answer.
- It records the hash, the date, and that the decision came from the depositor.
- It deletes the Mosaic row if there was one.
- It records nothing about who asked, and the key itself is compared in memory
  and dropped.

### 6.1 What actually crosses the wire, and why it is the key itself

Two values are sent, once, in the body of a single request: the story's link
and the key as typed. The key travels in the clear inside that body, under TLS
like everything else, and not in the URL, because a query string ends up in
logs, proxies, browser history and referrer headers, which is precisely the
list of places a secret must not land.

The browser does not hash the key before sending it, and that is not an
oversight. Hashing it would produce the commitment, and the commitment is
public: it is written inside every seed, readable by anyone holding the link.
If the hash were what the server accepted, then the thing that authorises a
takedown would be printed on the artefact itself, and any reader could remove
any story. The server therefore has to receive the one value that is not
public, which is the key.

The alternative that avoids sending it is a challenge and response: the server
issues a random challenge, the browser answers with something derived from both
the challenge and the key. It works, and it was not chosen, because the server
would have to remember the challenge between two requests. That is state, per
attempt, tied to a story, and it is exactly the thing the whole design is built
to not have.

So the key crosses once, is hashed on arrival, compared in constant time
against what the seed carries, and dropped. It is never written to a database,
never echoed back in a response, and never logged.

### 6.2 The gap this leaves

A takedown stops that seed. Someone who made their own copy of the same
journey, with their own key, holds a different seed, and the original's
takedown does not reach it. Closing that would require knowing who deposited
what, which is the thing the design exists to avoid.

The reverse gap, a depositor's own takedown reaching every copy including ones
they no longer control, is deliberate rather than missing, and it is not
free: [archaeology.md](archaeology.md) section 4 names what that irrevocable
permanence costs a record meant to outlast the person who made it.

## 7. Abuse protection, at posture level

### 7.1 What is said about it

The public endpoints sit behind real defences, built deliberately and more than
one deep, from the edge down to the application itself. They are not an
afterthought bolted on before launch, and they are not a single switch that
either holds or does not. They work on the shape of traffic, and they hold no
story content: nothing in them ever sees what a story says.

How they are built, what they are tuned to, and how they behave under pressure
are not described here, and that is the only part of this document written to
be useless to someone probing them.

### 7.2 The key is not defended by a counter

The takedown form has one further property worth naming: the attack it would
have to defend against is not run against it. The commitment sits in a seed
that is public by construction, so anyone attacking a key would do it offline
and never touch the server at all. What protects a key is its 120 bits, not a
rate limit, and it is better to say so than to point at a counter.

## 8. What the server cannot do

The short list, because it is the useful one:

- It cannot list, search or enumerate stories.
- It cannot recover a lost seed or a lost destroy key.
- It cannot tell who made a story, or link two stories to the same person.
- It cannot read a save file, having never received one.
- It cannot make a taken-down story render again.

Those are not policies. They are consequences of there being no data to do them
with, which is the point of the whole arrangement and the subject of
[concepts.md](concepts.md).

## Why this half is not in the package

Shipping the server code here would break the one posture check this package
can make about itself: that nothing in `lib/` opens a socket except the two
opt-in sends, the geography and the mosaic tile, observable with a network tab
open. The client half can be
audited by running it. The server half cannot be, by anyone, which is why it
gets a document that names its limits instead of a promise that it behaves.
