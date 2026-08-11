<!-- Author: had.sh -->

# Auditing this with an AI agent

An agent reads fourteen modules faster than you do and never gets bored halfway
through. That makes it a good instrument for one specific job: checking whether
the documentation in this package describes the code that is actually in it.

It is a bad instrument for the job it will happily pretend to do. Point an
agent at this directory and ask it to audit the package, and it will read
[audit.md](audit.md), run the commands that page suggests, watch them pass, and
report that everything checks out. That is the author grading his own homework
with one extra step. Every command in this package was written by the person
whose claims are under test.

This page is how to avoid that. It is written for the reader, not for me: the
prompts below are meant to be copied, run against whatever model you like, and
disagreed with.

## 1. What an agent can and cannot settle

| question | agent | why |
|---|---|---|
| does the code do what the docs say | yes, this is the job | mechanical, high volume, no judgement needed |
| what leaves the machine | yes, with a caveat | it must build its own list of egress forms, not reuse mine |
| is a claimed one-way property actually one-way | partly | it can find a counterexample, it cannot prove absence |
| is `lib/` the code the site serves | no | see [audit.md](audit.md) section 3, that check is curl and your eyes |
| is `MANIFEST.sha256` evidence | no, and it will say yes | agents accept self-consistent checks, this one is not evidence |
| was this designed in good faith | no | nothing settles that, see [audit.md](audit.md) section 6 |

The failure mode to watch for is agreement. Ask an agent to confirm something
and it tends to confirm it. Every prompt below is phrased to make disagreement
the useful answer.

## 2. A cold session

The agent should meet this package with no priors: no project instructions, no
stored memory, no settings of yours, and no other repository on disk. Clone
from the published remote rather than copying a working tree, so that what gets
audited is what the public actually receives.

```bash
git clone https://github.com/hadsh/nms-tessera.git /tmp/tessera-audit
cd /tmp/tessera-audit
git log -1 --format=%H          # record this, a report without it is undated
```

With Claude Code, a fresh configuration directory is what makes the session
cold, because project instructions and stored memory both live under it:

```bash
mkdir -p /tmp/tessera-agent-home
CLAUDE_CONFIG_DIR=/tmp/tessera-agent-home claude
```

Any other agent works. What matters is that it starts from this directory and
nothing else, and that you can read its tool calls afterwards. An agent that reports a command's output without a visible
record of having run it has not run it.

## 3. Pass A: describe the code without the documentation

The point of this pass is to obtain a description of the pipeline that owes
nothing to my description of it. So the prose goes away first, and so does
everything that narrates the format rather than implementing it: `tools/` walks
a payload and tells you what each byte means, `test/` asserts what I expected,
`bin/` labels its own output. All three are claims.

```bash
cd /tmp/tessera-audit
mkdir ../tessera-claims
mv README.md CHANGELOG.md docs bin tools test ../tessera-claims/
```

`package.json` stays, because `"type": "module"` is what lets the agent import
`lib/` directly. Its `description` field is a claim too; the prompt says so.

```
This directory contains a JavaScript library, with its documentation removed.
It is said to turn a No Man's Sky save file into a short shareable code. I have
no other information about it and I do not trust its author.

Read every file in lib/ and produce a description of what it does, derived only
from the code. Cite file and line for every statement. Where you cannot
determine something from the code alone, write UNVERIFIED and say what is
missing. Do not treat comments, identifier names, or the description field in
package.json as evidence: they are the author's claims, and part of what I want
checked is whether they are true.

Answer these, in this order:

1. Every path by which any byte can leave the machine this runs on. Build the
   list of possible forms yourself before you search: network APIs are only one
   of them. For each hit, give the file, the line, what triggers it, and what
   data reaches it.
2. What the save file is read for. Which fields, and what happens to each.
3. The short code that is the pipeline's output: enumerate everything it can
   contain, field by field, including anything conditional. Flag anything that
   could identify a person.
4. The intermediate structures that are not the output. For each, whether it
   can reach the output or a network path, and by which route.
5. Anything the code does that a reader of point 1 to 4 would not expect.

Write it as a report I can hand to someone else. No reassurance, no summary of
how careful the code looks.
```

Keep that report. It is the only artifact of this exercise that is not derived
from something I wrote.

## 4. Pass B: the documentation as a claim under test

New session, cold again, full clone this time, with the pass A report saved
next to it as `derived.md`.

```
This repository documents itself extensively. Treat every document in it,
including docs/audit.md, as a claim under test and not as a source of truth.
derived.md is an independent description of the same code, produced by reading
lib/ with the documentation removed. It may also be wrong.

Find the contradictions. For each one: the document and line making the claim,
the code and line contradicting it, and which of the two is right.

Rank what you find by whether it changes a decision someone would make about
their own data. A wrong byte count in a table matters less than a field
described as absent that is present.

Run the package's own commands if you want, but say clearly which of your
findings depend on them. Those findings are worth less: those commands are
written by the same author as the documents under test.
```

That last paragraph is the one that matters. It is the difference between an
agent auditing the package and an agent operating it.

## 5. Pass C: the attacker pass

New session. Framing changes the work more than the question does: "verify this
is safe" and "find the leak" produce different searches over the same code.

```
You are trying to get data out of this pipeline without the user's consent, or
to recover something from its output that its author says cannot be recovered.
The user runs it in a browser, drops in a save file, and leaves both consent
checkboxes clear before pressing the button that continues.

Find a route. Consider at least: indirect network forms, code that runs on
attacker-influenced strings, values that survive from one stage into another,
persistence that outlives the page, anything reachable from a third-party file,
and any bound that is documented but only enforced at one of several entry
points.

For each route: the exact steps, the files and lines, and what an attacker who
already controls the server would additionally need to control. If you find no
route, say so and list precisely what you checked, so the next reader does not
repeat it.
```

## 6. Targets worth naming explicitly

Agents are good at questions with a yes or no answer and mediocre at open
mandates. These have answers, and each one has a claim behind it that is mine:

- `lib/qrcode.vendor.js` is said to be davidshimjs/qrcodejs 1.0.0, MIT. That
  claim has a truth outside this package. Hashing it against upstream is the
  one supply chain check that can be completed today without trusting me.
- Mission identifiers are said to be unrecoverable from the seed. Re-encoding a
  decoded seed is the test. Look for any other route back.
- The report contains the player's name. Prove or disprove that no value from
  it reaches the seed or the geography payload, including through a shared
  object rather than a direct assignment.
- The bounds in `lib/limits.js` are claimed as hard. Check every entry point,
  not the documented one. A bound applied in one caller and skipped in another
  is the usual shape of this bug.
- The CRC-8 is documented as a corruption check and explicitly not a signature.
  Verify nothing anywhere treats a valid CRC as authentication. One thing does,
  knowingly: the `mosaic_public` consent bit rides in that envelope and is
  forgeable by anyone holding a seed. It is documented in
  [privacy.md](privacy.md) section 5 and accepted rather than fixed. Look for a
  second case, which would not be.
- The decoder is claimed to reject every non-canonical encoding: reserved
  header bits, trailing bytes, out-of-alphabet base64url. Find a fourth way to
  spell one story as two strings. If you find one, `hash(seed)` stops being an
  identity and two server tables stop working.
- The decoder is claimed to terminate on any input. Look for an unbounded loop
  or unbounded allocation reachable from a pasted string, a truncated varint
  is the obvious shape to try first.
- The receipt is built in memory and never written to storage. Confirm
  `lib/receipt.js` has no `indexedDB`/`localStorage` call, and that the only
  ways to keep it are the JSON download and the print sheet, both player-
  triggered. The receipt also carries the destroy key, which
  raises the stakes on that check: a receipt persisted anywhere is a key
  persisted anywhere.
- The destroy key is claimed to be drawn locally, never transmitted, and stored
  nowhere but the receipt. Three things to separate. First, that
  `lib/crockford.js` is the only module able to draw one, and that it refuses
  rather than falling back when `getRandomValues` is missing. Second, that the
  key reaches no payload: neither the seed, which carries only its hash, nor
  the geography. Third, and the interesting one, that the value crossing back
  from `lib/worker.js` to `lib/app.js` is not incidentally kept somewhere it
  outlives the tab.
- The commitment is claimed to leak nothing about the person. The argument is
  that it hashes an unstructured random and nothing else. Verify there is no
  path where anything save-derived is mixed into that input. If one existed, a
  low-entropy value would become brute-forceable from a public URL, which is
  the failure this design exists to avoid.
- The commitment is claimed to be unswappable because it lives inside the
  seed's bytes. Try to build a seed that renders one story while carrying a
  commitment to a key you chose. If you succeed, anyone can take down anyone
  else's story, and the whole scheme is dead.
- The offline page ships a Content-Security-Policy of `default-src 'none'`.
  Check the page against it rather than reading the header: a policy that the
  page violates in one place is a policy that was relaxed somewhere.
- `lib/mapping.json.js` is a bundled table so that nothing is fetched at
  runtime. Confirm no code path falls back to fetching it.

## 7. If you publish a result

A report whose prompt is not published is an appeal to authority wearing a lab
coat. Anything worth reading carries, at minimum:

- the commit hash of the clone that was audited,
- the model and its version,
- the prompts, verbatim, including whatever you changed from this page,
- the transcript with the tool calls visible, not just the conclusions.

With those four, a reader reruns it and gets their own answer. Without them,
they are trusting your agent instead of trusting me, which is not an
improvement.

Run it twice with models from two different vendors if you can. Blind spots
correlate inside a vendor, and a finding that only one of them sees is worth
more attention than a finding both agree on.

## 8. What this does not replace

Section 3 of [audit.md](audit.md), the diff between `lib/` and what the live
site serves, is untouched by everything on this page. An agent auditing this
package audits this package. Whether this package is what runs on the site is a
separate question, and the answer is still curl, sha256sum and your own eyes,
from a machine that is not mine.

The rest of the caveats in [audit.md](audit.md) section 6 apply unchanged.
Server behaviour is out of reach here too, an agent reading client code learns
nothing about a deployment, and none of this speaks to intent.

And the agent is not independent of me either, in one respect worth stating: I
wrote the prompts on this page. They direct attention, and attention directed
is attention withheld somewhere else. Change them.
