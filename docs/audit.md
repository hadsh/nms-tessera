<!-- Author: had.sh -->

# How to audit this, without trusting it

Everything else in this package is written by the author of the code. So is
this page. That is a problem, and this page is organised around it: each claim
below comes with a way to check it that does not depend on anyone's good faith,
and the section that matters most is the one where you stop using this
package's own tools entirely.

If you only do one thing, do section 3.

If you would rather delegate the reading to an AI agent,
[audit-agent.md](audit-agent.md) has the prompts, and starts by explaining why
an agent pointed at this page produces a worthless report.

## 1. Five minutes, from cold

```bash
node --version                    # 18 or later, nothing else to install
node bin/tessera.js selftest      # 40+ checks, no save file needed
sha256sum -c MANIFEST.sha256      # drift check, proves nothing on its own
node bin/tessera.js decode fixtures/max-synthetic.seed
```

The last command turns a seed back into its contents. That is the whole
premise of the format made visible in one call: a few hundred characters in, a
readable list of beats out, no server involved.

Then, on your own save:

```bash
node bin/tessera.js report save.hg     # everything computed about you
node bin/tessera.js geo save.hg        # exactly what ticking the box would send
node bin/tessera.js seed save.hg | tee my.seed
node bin/tessera.js decode my.seed     # exactly what your seed reveals
node bin/tessera.js dump my.seed       # the same, byte by byte
```

Nothing in that sequence touches the network. Run it with the machine offline
if you want the point made physically.

## 2. What each claim rests on

| claim | checked by | does not cover |
|---|---|---|
| the format is what the spec says | `selftest`, `dump`, `dump-geo` | nothing: the annotators walk real bytes |
| every field is documented | `selftest` coverage checks | that the explanation is *good*, only that it exists |
| no pseudonym in the seed | the field table, `spec`, `decode` | the names you chose yourself, see [privacy.md](privacy.md) section 4 |
| mission ids are not recoverable | `selftest` one-way check | nothing |
| the destroy key is drawn locally and never sent | `grep` for `crockford`, `selftest`, network tab | that the server honours it, see section 6 |
| the commitment reveals nothing | read `lib/crockford.js`: it hashes a `getRandomValues` draw | nothing, there is no input to leak |
| nothing is sent but the two opt-in sends | `grep`, `selftest`, browser network tab | the server, see section 6 |
| `lib/` is the site's code | **nothing shipped here**, see section 3 | . |

That last row has no entry in the middle column on purpose, and this package
ships no command that would fill it. `MANIFEST.sha256` compares the copy
against a list that travels inside the copy: alter `lib/`, regenerate the
manifest, and everything agrees. It catches accidental drift, never tampering.
A self-check shipped alongside the thing it checks is not evidence, so the only
answer to that row is section 3.

## 3. The trust root: check `lib/` against the live site yourself

`MANIFEST.sha256` proves the copy is internally consistent. It proves nothing
about whether it matches what the site actually serves, because the manifest
ships with the copy. If both were altered together, every check in this package
would still pass.

The way out is to fetch the site's own files and compare. The page at
`/mosaic/create` loads `/assets/js/story/app.min.js` as a module, and that
module imports the rest of the pipeline by relative path, so every `.min.js`
file in `lib/` is served from the same directory. Read the page source,
follow the imports, and take the files from there rather than from anyone's
word - the `.min.js` build, not the readable source, is what the browser
actually runs:

```bash
BASE=https://glyphs.had.sh/assets/js/story
mkdir -p /tmp/from-site && cd /tmp/from-site
for f in limits.min.js compress.min.js lz4-block.min.js mapping.json.min.js \
         extract.min.js geo.min.js report.min.js beats.min.js seed.min.js \
         pipeline.min.js worker.min.js receipt.min.js app.min.js \
         qrcode.vendor.min.js; do
    curl -fsS "$BASE/$f" -o "$f" || echo "MISSING $f"
done
sha256sum *.js | sort > /tmp/site.sha
( cd /path/to/tessera/lib && sha256sum *.min.js | sort ) > /tmp/pkg.sha
diff /tmp/site.sha /tmp/pkg.sha && echo "identical"
```

The readable sources (`app.js` and the rest, no `.min`) ship in `lib/` too,
and are still worth reading - they are what `.min.js` is built from, byte
for byte, `--minify-whitespace` only, no renamed identifiers - but they are
not the file the diff above needs, since they are not what the site serves.

A `diff` with no output means the code you just audited is the code running on
the site. That statement rests on curl, sha256sum and your own eyes, and on
nothing that came with this package.

Do this from a machine that is not ours, on a network that is not ours. It is
the only check in this document that is worth anything if you assume the author
is lying.


## 4. Watch the page do nothing

```bash
node bin/tessera.js serve
```

Open `http://127.0.0.1:8787/`, open the browser's network tab, push a save
through the page, and leave both consent boxes clear. After the initial load of
the page and its modules, the panel stays empty. That is the "nothing is sent"
claim, observed rather than read.

Then run it again with "Share the geography" ticked, because the second half of
the claim is the one worth checking. Exactly one POST leaves, at the instant you
press the primary button, and the button has renamed itself to say it will. The
panel stays empty until that press and shows nothing after it. Compare its body
against `tessera geo save.hg --post`: same bytes, no extras.

Then a third run, with "Add to the public mosaic" ticked instead, which sends a
second POST. One POST again, to `/mosaic/publish`, and this
one leaves at the other end of the run: not at the press, but after the seed
and the destroy key are on screen. That ordering is deliberate, and watching it
is the point - a story reaches the wall only once its owner has the key that
takes it down. Offline both sends are answered with an explicit 501, so what
you are watching is the call, not an upload.

The page is served with `default-src 'none'` and no inline script, so a
listener injected into it would show up both in the source and in the console
as a CSP violation.

For the same claim on the real site, do it there: the page is the same page,
which is what section 3 establishes.

## 5. Read what your own seed says about you

```bash
node bin/tessera.js decode my.seed | grep -i name
node bin/tessera.js decode my.seed | less
```

Names you chose in game travel in the seed: eight fields across seven beats,
tag-stripped and capped at sixteen characters, but otherwise as you typed them.
Nothing else in it identifies you. Do not take that from the table in
[privacy.md](privacy.md); read your own decoded seed and see for yourself what
is in there before you share it. Note also what a seed does not protect: the
public-gallery consent bit inside it is forgeable by anyone who has the seed,
which [privacy.md](privacy.md) section 5 states and accepts.

The fifteen bytes after the header are the destroy-key commitment, and
`tessera dump` labels them:

```bash
node bin/tessera.js dump my.seed | grep commit
```

They are the hash of a random your browser drew, so they say nothing about you.
What is worth checking is the other direction: that the key itself never
appears in anything the pipeline emits except the receipt and the `run`
summary.

```bash
node bin/tessera.js seed save.hg --quiet    # the seed alone: no key in it
node bin/tessera.js geo save.hg --quiet     # the contribution: no key in it
grep -rln "getRandomValues" lib/ | grep -v min   # where a key can be drawn at all
```

The last one should name `lib/crockford.js` and nothing else: that module is
the only place in the pipeline that can produce a key.

Grepping for `subtle.digest` instead also matches `lib/worker.js`, and that one
is not a key: it is the SHA-256 fingerprint of the save file you fed in, which
goes on the receipt so you can tell later which file a story came from.

The same for the contribution:

```bash
node bin/tessera.js geo save.hg --quiet > readable.json
node bin/tessera.js geo save.hg --quiet --post > post.json
node bin/tessera.js dump-geo post.json --full | less
```

`readable.json` is what the page shows you. `post.json` is what would actually
go over the wire. `dump-geo` decodes the second one, so you can confirm they
agree and that nothing extra rides along inside the compressed blob.

## 6. What none of this can prove

Stated plainly, because an audit guide that oversells itself is worse than
none.

- **Server behaviour.** Everything above runs on your machine. What a running
  instance of the site does with a payload it receives is outside the reach of
  any client-side check. The server code is not published either, so you cannot
  even read it here, and reading code would not be the same as observing a
  deployment anyway. The only artifact you can hold the site to is the payload
  you chose to send, which is why section 5 shows how to read it before you
  press the button.
- **That a takedown is honoured.** You can verify here that the destroy key is
  drawn locally, that only its hash enters the seed, and that nothing is sent
  when the story is made. Whether the server actually stops serving a story
  once you spend that key is a server behaviour like any other: observable
  from outside (open the link afterwards) but not provable from this package.
  What the design does guarantee, and this is checkable, is that nobody can
  spend a key they do not hold, because the commitment lives inside the seed's
  own bytes and cannot be swapped without naming a different story.
- **Future versions.** These commands answer questions in the present tense.
  Rerun them after every update; that is why they are commands and not
  paragraphs.
- **Intent.** Nothing here proves the pipeline was designed in good faith. It
  proves what the code does, which is a different and more useful thing.