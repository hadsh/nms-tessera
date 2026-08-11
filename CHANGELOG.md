<!-- Author: had.sh -->

# Changelog

What changed in this package, and what changed upstream in the pipeline it
vendors. Newest first.

Two things move independently and are logged separately: the **package** (the
CLI, the docs, the offline page, the checks) and the **pipeline** in `lib/`,
which is a copy of the site's `public/assets/js/story/`. This file tells you
what happened between two copies.

Format changes are called out as **BREAKING** when they invalidate seeds
produced before them.

## 1.0.0, 2026-08-08 (first public release, experimental)

First public release. Nothing before this is tracked here: the package starts
at version 1, published while the pipeline it vendors is still in active
development.

Timed to No Man's Sky's tenth anniversary, 2026-08-09, #NMS10.

No seed is in circulation yet, and that is the practical meaning of
"experimental": the format, the pipeline and this package can all still change
for the cost of changing it. See [docs/concepts.md](docs/concepts.md) section
8 for what changes the day that stops being true, and
[docs/seed-format.md](docs/seed-format.md) for what the format looks like
today.

What ships:

- `lib/`, a byte-for-byte copy of the pipeline modules, with
  `MANIFEST.sha256` as a drift check, never a tamper check (see
  [docs/audit.md](docs/audit.md) section 3)
- `bin/tessera.js`: `run`, `seed`, `beats`, `report`, `geo`, `decode`, `spec`,
  `dump`, `dump-geo`, `selftest`, `serve`, `version`
- `test/selftest.js`: primitives, seed round-trips, the geo-v1 layout, and the
  offline posture (the two declared network calls, both consent-gated, no
  `eval`)
- `tools/annotate.js` and `tools/annotate-geo.js`: executable specifications,
  cross-checked against the shipped encoders by `selftest`
- `offline/`: the site's page, served on loopback by `tessera serve`
- docs: [concepts](docs/concepts.md), [the other half](docs/the-other-half.md),
  [seed format](docs/seed-format.md), [geo format](docs/geo-format.md),
  [beats](docs/beats.md), [privacy](docs/privacy.md),
  [troubleshooting](docs/troubleshooting.md), [audit](docs/audit.md) and
  [auditing with an agent](docs/audit-agent.md)
- `LICENSE`: provisional and restrictive, pending a decision

## How to read this against your copy

```bash
sha256sum -c MANIFEST.sha256    # has my lib/ drifted since it was vendored?
node bin/tessera.js version     # package version and seed format version
node bin/tessera.js selftest    # does the format still behave as published?
```

A seed that stops decoding after an update is almost always a **BREAKING**
line above. The error tells you which kind: `unknown beat type index N` means
the catalogue moved under it.
