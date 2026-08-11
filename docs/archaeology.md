<!-- Author: had.sh -->

# Archaeology: what a seed keeps, and what a place keeps

This document is not about privacy or security. The other files in `docs/`
cover those. This one is about a different question: what does it mean for
this package to be a record, not just a tool, and what does that ask of a
format that was built for entirely practical reasons - a URL that fits a QR
code, a story that renders without a server remembering it.

## 1. A shared instinct, found twice

The site this package renders through already treats some places as worth
keeping past the point where the universe stopped agreeing on them. No Man's
Sky's procedural generation was unified across platforms after launch, and a
galactic address that once resolved to one system on one platform can resolve
to a different system on PC today. The site does not quietly drop the older
reading and show only the current one. Where both are known, the earlier
system is kept, marked as a historical record, and described as conserved
digital archaeology rather than as an error to correct.

That is the same instinct this package is built on, applied at a different
scale. A place is fixed at the address the game's algorithm assigns it, until
the algorithm itself changes underneath the address. A player's journey is
fixed at the seed a save produces, until nothing about the save is ever
touched again. Neither artefact survives by being protected from
regeneration. Both survive by being copied out of it, before the
regeneration happens, into something that no longer depends on the
generator agreeing with itself.

Once the parallel is visible, it explains a few choices documented elsewhere
for entirely practical reasons. Positional binary instead of JSON, a frozen
v1 semantics that no version 2 is allowed to reinterpret, byte-for-byte
provenance instead of a rewrite for publication: [concepts.md](concepts.md)
section 5 and section 8 give the engineering reasons for each. The
archaeological reading does not replace those reasons. It says why a project
with no obligation to anyone would still hold itself to that standard rather
than to a looser one.

There is academic precedent for taking a video game's built environment
seriously enough to excavate it, and it does not rest on one researcher's
idiosyncrasy. Reinhard led an archaeological survey of No Man's Sky, applying
survey and recording methods from field archaeology to abandoned player
settlements inside the game (Reinhard 2018, 2021). Separately, and from a
games-research rather than an archaeology department, Smith Nicholls and Cook
built a game around the claim that procedurally generated content already
invites archaeological reading, and studied how players interpret it as such
(Smith Nicholls and Cook 2023). Two different fields arrived at the same
claim by different roads: that a procedurally generated place is worth
treating as a site, not merely as content. Full references are at the end of
this document.

## 2. What makes tessera trustworthy as a source, and not just a story

An archive is only as good as the chain from the thing it holds back to the
moment it was made, and that chain is exactly what long-term digital
preservation has struggled with: a file survives its own format only for as
long as something can still run it. Rothenberg's foundational analysis of the
problem (Rothenberg 1999) argued that betting on any particular piece of
software or infrastructure surviving is the wrong bet, and that the safer one
is a representation simple and self-describing enough to be read by something
that has not been written yet. Three properties of this package exist for
practical reasons and happen to be exactly what that argument asks for.

**The artefact does not depend on this project continuing to exist.** A seed
decodes with nothing but the algorithm in `lib/`, which is published, and the
spatial reference data it looks up, which does not have to come from this
site. `tessera dump` and `tessera decode` run with no network at all. If this
project disappeared tomorrow, every seed already printed, scanned or pasted
somewhere would still be readable by anyone who kept a copy of `lib/`.

**The published copy is provably the copy that ran.** `MANIFEST.sha256`
covers every file, and `docs/audit.md` section 3 gives the command to fetch
the site's own served files and diff them against this package byte for
byte. A record whose provenance rests on trusting the person who kept it is a
weaker record than one whose provenance can be checked by a stranger with
`curl` and `sha256sum`.

**What version 1 means is not allowed to drift.** [concepts.md](concepts.md)
section 8 states the rule plainly: a future format version can change
anything, but it must keep reading version 1 exactly as version 1 was
specified, because a seed printed on paper or pinned to a wall cannot be
reissued when the reader changes underneath it. An archive that quietly
reinterprets its own past entries is not an archive, it is a moving target
with a memory problem. This format is built to refuse that failure mode
before a single seed exists for it to fail on.

None of this makes the record complete. A seed is deliberately thin: it
carries addresses, counts and month-level dates, not a copy of the save.
[privacy.md](privacy.md) section 5 describes what the seed leaves out and
what the server's reference data fills in when the story is rendered. What
tessera preserves is the shape of a journey, not the journey's raw material.
That is a narrower claim than "everything survives", and it is the honest
one.

## 3. Reusability is the point, not a side effect

Two different things can be reused here, and they are governed differently
on purpose.

The **format** is documented to the bit in [seed-format.md](seed-format.md),
cross-checked against the shipped decoder by `tessera selftest` so the
document cannot silently drift from the code it describes. Anyone building an
independent reader, an archive, or a browser extension that opens these links
without this project's help has everything they need to do it, and nothing
here asks them to ask first.

The **ideas** are explicitly open to being copied, argued with, and improved
on: [concepts.md](concepts.md) section 9 says so directly. Capability-bearing
tokens, a client that proves what it does not send, a server described by its
limits rather than by a promise: none of these techniques are new, and the
document that names them says as much. What is offered for reuse is the
decision to put them where a player holds them, rather than a layer down
inside infrastructure nobody sees.

The **code** is a separate matter, and stays one. `LICENSE` grants reading,
running and checking, not redistribution, and [concepts.md](concepts.md)
section 9 explains why that line was drawn where it was rather than left
unresolved. A format that anyone can implement from the specification and a
codebase that stays this project's own are not in tension. The specification
is the part meant to outlive the code that first implemented it.

## 4. The tension this project has not resolved

Every other document that discusses the destroy key treats it as an
individual's right, and stops there. That framing is correct as far as it
goes: [concepts.md](concepts.md) section 3 is built entirely around the
premise that a story's only owner is the person who made it, and that no
third party gets to override a voluntary, irrevocable act of removal.
Nothing here argues against that.

But an archive and a takedown want opposite things, and this project has
built a strong version of only one of them. The destroy key is not a
soft delete or a hide from search: spending it is designed to be permanent
and to leave nothing behind for anyone, including the person who spent it,
to recover. Weighed against a preservation instinct real enough to already
be running elsewhere on the same site, for the same underlying reason, that
is a genuine cost, not a hypothetical one. A journey through a universe that
no longer generates the way it did when that journey happened is exactly the
kind of record the site's own historical-record entries argue is worth
keeping. This package makes sure such a record exists and is easy to
produce. Its own key then
makes sure that record can be permanently and unilaterally erased, by design,
with no review and no appeal.

Nothing here proposes to weaken the key. An archive that could override a
depositor's own erasure would have solved the memory problem by recreating
the registry the whole design exists to avoid: something has to know who
holds a copy, or on whose authority a copy survives its owner's decision to
destroy it, and that something is precisely the record this project refuses
to keep. The tension is named here because naming it honestly is better than
letting the individual framing quietly stand in for an answer to a question
it was never built to answer.

This is not a new argument invented for a game preservation side project. The
archival profession has been having it directly, in those terms, since the
right to erasure became enforceable law rather than a design preference:
Székely's account of the collision between an individual's right to be
forgotten and archives' obligation to remember (Székely 2014) is one entry in
that literature, not the only one, and it reaches no tidier a conclusion than
this document does. What memory a community keeps of its own history, when
every entry in it can be unilaterally and permanently withdrawn by whoever
wrote it, is a question this document raises and does not close, in company
with a field that has not closed it either.

## References

- Reinhard, Andrew. *Archaeogaming: An Introduction to Archaeology in and of
  Video Games.* New York: Berghahn Books, 2018.
- Reinhard, Andrew. "Archeology of Abandoned Human Settlements in No Man's
  Sky: A New Approach to Recording and Preserving User-Generated Content in
  Digital Games." *Games and Culture* 16, no. 7 (2021): 855-884.
  https://doi.org/10.1177/15554120211005236
- Smith Nicholls, Florence, and Michael Cook. "'That Darned Sandstorm': A
  Study of Procedural Generation through Archaeological Storytelling." In
  *Proceedings of the 18th International Conference on the Foundations of
  Digital Games* (FDG 2023). New York: ACM, 2023.
  https://doi.org/10.1145/3582437.3587207
- Rothenberg, Jeff. *Avoiding Technological Quicksand: Finding a Viable
  Technical Foundation for Digital Preservation.* Washington, DC: Council on
  Library and Information Resources, 1999.
- Székely, Iván. "The Right to Be Forgotten and the New Archival Paradigm."
  In *The Ethics of Memory in a Digital Age: Interrogating the Right to Be
  Forgotten*, edited by Alessia Ghezzi, Ângela Guimarães Pereira, and Lucia
  Vesnić-Alujević, 28-49. London: Palgrave Macmillan, 2014.

## Reading order

If you want the engineering reasons behind the choices this document reads
archaeologically: [concepts.md](concepts.md). If you want to know exactly
what a seed does and does not carry: [privacy.md](privacy.md) and
[seed-format.md](seed-format.md). If you want to check any claim made here
against the code rather than take it on trust: [audit.md](audit.md).
