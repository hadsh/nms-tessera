<!-- Author: had.sh -->

# Concepts: the artefact carries everything

This document explains the decisions behind tessera, and what each one costs.
The other files in `docs/` say how the thing works. This one says why it works
that way, what was refused, and where the design is knowingly weak.

## In one paragraph

A player gives one save file to a web page. The page reads it on their own
machine, works out the shape of their journey, and hands back a few hundred
characters. Those characters are the story: not a pointer to a story held
somewhere, the story itself. Nothing is uploaded, no account is created, no row
is written. When the player opens the link, a server turns those characters
back into prose. It has never seen them before and will not remember them
after.

Everything below follows from that one sentence.

## 1. The artefact, a Tessera, carries everything

The central decision: the story lives in the seed, and the power to destroy it
lives in the seed too. The server holds only a list of hashes it refuses to
render.

It is an elegant arrangement, and elegance here is not decoration: it is the
whole of the security model, small enough to hold in your head. But what the
decision buys is absence. No account to create, so no
password to reset, no email to hold, no session to hijack. No user table, so
nothing to leak. No registry mapping stories to people, so no registry to be
subpoenaed, sold in a bankruptcy, or misconfigured on a Tuesday. The privacy
posture is not a policy document that has to be believed and audited: it is a
consequence of there being nothing to disclose.

It also makes hard questions answerable in a few lines. "Can I forge a destroy
key for someone else's story?" is not a matter of reviewing an access control
matrix. The seed carries a hash of a 120-bit random draw, which no foreseeable
hardware could brute-force within the lifetime of the universe and passing the check
means finding a preimage. The answer is short because the model is small.

What it costs is written into the design and cannot be softened: there is no
recovery of anything, ever. Lose the seed and the story is gone. Lose the
destroy key and the story is permanent. Both of those are the same property
seen from two sides, and neither has a support ticket.

What it forbids, in the future: any feature phrased as "let the user find their
old story again" reintroduces the account, the table, and everything the design
exists to avoid. That request will arrive. It should be answered with a copy of
this paragraph.

## 2. Consent is an act, not a setting

Two things can leave the machine, and only if asked for: a contribution of
coordinates to a shared map, and the story's appearance in a public gallery.
Both are off until turned on.

The part that matters is what happens next. There is no confirmation dialog
after the choice. The primary button renames itself to state exactly what
pressing it is about to do, and pressing it is the send. "Share coordinates,
add to the mosaic, then continue" is not decoration, it is the last honest
moment before geography leaves, and it exists because a confirmation step
teaches people to click through confirmations.

The same reasoning governs the wording everywhere else on the page. A button
that says "Continue" while a ticked box makes it upload something is a button
lying about itself, and no amount of small print underneath repairs that.

## 3. Destruction without identity

A story with no account behind it has nobody to prove they own it. The usual
answer is to keep a record of who deposited what, which reintroduces exactly
the registry the design refuses.

The answer here instead: when the seed is built, in the browser, a 120-bit key
is drawn and only its hash is written into the seed. The key is shown once and
kept nowhere. To take a story down, someone presents the story's link and types
the key. The server hashes what was typed, compares it against the hash the
seed itself carries, and if they match, adds the story's hash to the refusal
list.

Four properties of that exchange are deliberate:

- **The proof travels with the artefact.** The commitment is part of the seed's
  bytes, so it cannot be swapped for another story's. This is why a server that
  has never seen a story before can still verify a claim about it.
- **One answer for every failure.** A wrong key, an unknown link and a mangled
  paste all produce the same refusal. Distinguishing them would turn the form
  into an oracle for learning which links exist.
- **The comparison is constant time.** A comparison that returns early on the
  first wrong byte reports, through its own timing, how much of a guess was
  right, which turns an infeasible search into a feasible one.
- **Nothing about the request is recorded.** Not the key, not who asked, not
  from where. The list holds hashes of what to refuse, and the reason it was
  added, and that is all.

The cost, again stated rather than hidden: if the key is lost, nobody can help,
and that is deliberate rather than careless. Any way for us to remove a story
without the key would also be a way for someone else to remove yours.

There is exactly one other party who can stop a story from rendering, and it is
worth naming rather than discovering: had.sh moderation. A tessera can be
refused because what it carries is not acceptable on the site that renders it,
which is a decision made by the person running that site and by nobody else.
The refusal list records which of the two it was, the depositor or us, because
a takedown with no author is a takedown nobody can be held to. Everything else
follows the rule above: no third party, no reporting form that removes a story
on someone's say-so, no automated complaint pipeline, and no key held in
reserve. Two hands can take a story down, the one that made it and the one that
hosts it, and the second one has to sign its name.

## 4. Anonymity by construction

Other players who appear in a save become nobody. The depositor becomes "you".
No in-game identity, no platform id, no friend list survives into the seed.
This is done by an explicit pass rather than by hoping the fields were never
copied, and the pass is a table of beat types and the fields that carry text.

The exception, by design, is stated plainly because pretending otherwise would be the more
dishonest choice: the names the player chose in game are theirs, they are often
the best part of the story, and they travel with it. So they are listed one by
one before the seed is built, and each can be kept, edited or dropped. Consent
here is per name, not a single checkbox for the concept of naming.

## 5. The format is a budget

A seed has to fit in a URL, print on a sheet of paper, and scan off a screen as
a QR code. That is a hard ceiling of a few hundred characters, and it is the
single constraint that shaped the encoding: positional binary rather than
JSON, varints rather than fixed integers, dates to the month rather than the
second, and append-only table of beat types.

## 6. Verifiable instead of promised

Every claim above is the kind that a project makes about itself and nobody can
check. So the claims are made checkable instead at :

https://github.com/hadsh/nms-tessera

`lib/` is a byte-for-byte copy of the files the site serves, not a rewrite for
publication. That is a claim you can test with `diff`, and the package tells
you how. `MANIFEST.sha256` covers every file in it. `tessera selftest` fails if
a network call appears anywhere in the pipeline beyond the two declared ones,
and it also fails if either legitimate call moves out of its consent branch or
gains a second call site: it is the moving of those calls, not their existence,
that would matter. The
CLI runs the whole thing on a real save with no network at all, so the strong
version of "your file is not uploaded" is a thing you can observe rather than
accept.

## 7. What was deliberately not built

The absences are the design, so they are listed rather than left to be noticed:

- **No accounts, no login, no recovery.** Section 1.
- **No server-side storage of stories.** Rendering is stateless. The gallery
  holds seeds that were explicitly opted in, and a takedown deletes that row
  rather than hiding it.
- **No analytics, no telemetry, no third-party script.** The page runs under a
  content security policy that permits nothing but its own origin, which is
  what makes the previous sentence enforceable rather than aspirational.
- **No moderation queue with a human backlog.** The depositor holds the key,
  and that is the primary remedy.

## 8. Where this is weak

An honest document names the parts that are not solved.

**A copy cannot be recalled.** Destroying a story stops that seed from
rendering. If someone else republished the same journey under a seed of their
own, with their own key, the original's takedown does not touch it. This is
duplication rather than key forgery, and it is unsolved by design: solving it
would require knowing who deposited what.

**Versioning is what lets the format move, and it is also the debt.** Every
seed ends in a version tag, `.1` or `.1z` today, and the decoder refuses a tag
it does not know rather than guessing at the bytes. So the format is not frozen
at launch: a version 2 can change anything, including the things called
permanent above, because a version 2 seed announces itself as one.

What freezes is the meaning of version 1. The moment the first seed is printed
or scanned, that spelling has to keep rendering, because a token someone keeps
for years is expected to still work in years, and a QR code on paper cannot be
reissued. Every future version therefore adds a reader that can never be
deleted, and the cost of a format change is not the change, it is carrying its
predecessor forever.

**Truncation to 120 bits is a choice, not an accident.** The commitment is 15
bytes, matching the key's entropy. Against a large population of published
stories, a generic preimage search costs roughly 2^120 divided by the number of
targets. At a million stories that is 2^100, which is not a threat, but it is
the honest bound and there is no per-story salt to improve it.
No foreseeable hardware could brute-force within the lifetime of the universe.

## 9. Why this shape is worth copying

Every technique here is known. Capability-bearing tokens, hash commitments,
domain separation, offline-first computation, stateless rendering: none of it
is invented, and the document would be worse if it pretended otherwise. What is
unusual is where they have been put.

These patterns normally live in infrastructure, one or two layers below
anything a person touches: inside a signing service, a session library, a
storage layer. Here they are the product surface itself. The object the player
holds, prints, and pins to a wall is the datastore. There is no row behind it.

That is rare in commercial software for reasons that have nothing to do with
difficulty. Accounts are the business model. Retention needs a table. Growth
teams need an event stream, and a support desk needs to be able to say yes to
"can you get my thing back". Every one of those pressures points at exactly the
registry this design refuses, and most products give in to all four before
their first launch. Building the other way is not harder to implement, it is
harder to defend, which is why the defence is written down in section 1 rather
than left to memory.

In fan projects specifically, I have not seen it done at all. The normal shape
is a Discord login, a hosted database, a spreadsheet of player data that
someone maintains alone, and a privacy policy copied from a template. That path
is not chosen out of carelessness: it is the path with tutorials. Its cost is
invisible right up until the day the project is abandoned, the host is
breached, or the maintainer is asked to hand over what they hold. A design that
holds nothing cannot be asked for anything.

The minimalism is measurable rather than a matter of taste. The total server
state for a story that has been taken down is one hash. For a story that has
not, it is nothing at all. The pipeline that turns a 30 MB save into a few
hundred characters has no dependencies, no build step, and no network access,
and the whole of it is published so that this paragraph can be checked instead
of believed.

None of this makes the project important. It is a tool for turning a video game
save into something to read. But the thing it does, it does in a shape that is
worth copying. 

On copying it: the code is published to be read, run on your own machine and
checked, and nothing more than that has been granted yet. The terms are not
chosen, which is why [LICENSE](../LICENSE) is narrow and says so plainly rather
than inventing something permanent in a hurry. The ideas in this document are
another matter, and they are why it exists: build the same shape, argue with
it, improve on it. If you want the code itself, or a part of it, ask. That is
not a formality standing in for a licence I intend to refuse, it is a
preference for knowing who is building what, and the answer is likely to be
yes.

## 10. The name got there first

None of the reasoning above chose the name. Tessera and Mosaic were named for
the metaphor the README documents: a small piece that only means something
inside a larger whole, borrowed from an ancient token and a theatre ticket
before it was ever a floor. The name came first, the design came from the
problem, and the two were not aimed at each other on purpose.

But a tessera is also, literally, the unit an excavation lifts out of the
ground when what survives of a picture is the durable small pieces of it
rather than the fragile whole, and a wall of them is a mosaic in the oldest
sense of that word, not only the site's name for a gallery page. That the
vocabulary this project already had turns out to fit, almost exactly, a
reading of the whole shape as an archival practice rather than only a privacy
one, is a coincidence worth naming rather than a plan worth taking credit for.
[archaeology.md](archaeology.md) follows it all the way through: what makes a
seed trustworthy as a record and not just a story, what of that record can be
reused and by whom, and a tension the rest of this document does not resolve
because resolving it would mean pretending the destroy key and the archive
want the same thing.

## One more thing

And since you have read this far, one last thing, only half in jest. All of the
above was designed and built by one person, alone, on shared hosting with no
cache server and no budget, for the tenth anniversary of a video game:
No Man's Sky turns ten on 2026-08-09, #NMS10. That is the whole occasion. This
is not infrastructure and it does not want to be. It is a small, friendly,
deliberately poetic tool that exists to help one long journey through a game
become a story worth handing to someone else.

If your organisation is looking for someone who does privacy by architecture
rather than by policy, who reaches for the design that holds nothing before the
design that holds everything, and who writes down why afterwards, I am
reachable at [had.sh](https://had.sh/). My rates are negotiable. So is my
opinion on user tables, but that one is the expensive line item :)

## Reading order

If you have five minutes and want to check rather than believe:
[audit.md](audit.md). If you want to know what is read and what travels:
[privacy.md](privacy.md). If you want the bytes: [seed-format.md](seed-format.md).
If you want to know why a format built for a URL bar is held to an
archival standard: [archaeology.md](archaeology.md).
