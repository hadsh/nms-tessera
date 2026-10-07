<!-- Author: had.sh -->

# Payload A: the geo-v1 format, byte by byte

This is the only artifact that ever leaves your machine, and only when you
press the button. It deserves the same treatment as the seed: a specification
you can check rather than a promise you have to take.

Everything below was produced by `tessera dump-geo` on a payload built from a
synthetic fixture, and the layout it walks is replayed against a freshly
encoded payload by `tessera selftest`, field by field.

Payload B, the seed, is a different format documented in
[seed-format.md](seed-format.md). The two share primitives and share nothing
else.

## 1. The POST body

The button sends one JSON object:

```json
{
  "_comment": "Public NMS geographical data, as visible to any player in-game. Pseudonymous, not anonymous: each system carries the first discoverer's in-game username (credit, which may not be the depositor's), public information anyone can read by visiting. No other personal data, and no address the save merely visited: only in-game discovery records. Discovery dates are cut to the month, every free text field is length-capped. Positional binary (geo-v1), deflate-raw + base64url in data.",
  "schema": "geo-v1",
  "encoding": "deflate-raw+base64url",
  "data": "e8zAxMTAWCE3jSOOgZG_buLJTZ8ZFgVM-CfPwMDsl5nC7VpRkJNflFrkn5fKxOKakprHwsA6..."
}
```

`_comment` is decorative and ignored by the server. It exists so that anyone
intercepting or logging the request can read what it is without tooling.

`encoding` has two possible values. `deflate-raw+base64url` is the normal case.
`b64url` is the fallback when the browser has no `CompressionStream`, and it
carries the same bytes uncompressed. Unlike the seed, there is no size race
here: compression always wins on a payload of this shape, which repeats
addresses, names and short varints by the thousand.

`data` decodes to:

```
+--------+---------------------------------------------------+
| crc8   | geo-v1 payload                                     |
| 1 byte | 227 bytes in the example below                     |
+--------+---------------------------------------------------+
```

Same watermark as the seed: CRC-8/SMBUS over the ASCII bytes `had` followed by
the payload.

## 2. Primitives

Three kinds, and one of them differs from the seed on purpose.

| kind | encoding |
|---|---|
| `n` number | unsigned LEB128 varint, as in the seed |
| `s` string | varint byte length, then that many UTF-8 bytes |
| `a` address | **6 fixed little-endian bytes**, never a varint |

The address choice is the interesting one. The seed packs an address as a
varint because it holds a handful of them and every byte shows in the URL. A
geo payload holds thousands, and a fixed width lets the decoder walk the
sections without parsing every field. 11 hex characters is 44 bits, so 6 bytes
fit with room to spare.

Addresses are little-endian here. `05E08961E78` is written `78 1E 96 08 5E 00`,
low byte first.

Dates are whole months since the game's release month, 2016-08, as a plain
varint with no delta chain. **The day of month, hours, minutes and seconds are
all dropped at encoding**: the readable JSON the page shows you displays
`2016-08-13 22:10:30`, and what actually goes on the wire is the number 0
(month 0 = August 2016). `selftest` asserts this.

A month is only ever written when a `credit` string is non-empty. The two
travel together on the wire because they come from the same fact: the earliest
event that carries BOTH a timestamp and a pseudonym (see `creditedDiscovery`
in `lib/geo.js`). A dated-but-anonymous event (a timestamp with nobody's name
attached) is not worth a byte of date at all.

## 3. Layout

```
header
  n  default_galaxy          0 if any entry is in Euclid, else the most
                              frequent galaxy in the payload
  n  n_systems
  n  n_blackhole_routes

systems section, repeated n_systems times
  a  sysaddress
  n  galaxy                  0 means default_galaxy
  s  name                    player's custom name, empty if none
  s  credit                  first in-game discoverer, empty if none
     n  credited month       \  only present if credit is non-empty
  n  n_planets
     s  planet name          x n_planets - name only, no date

routes section, repeated n_blackhole_routes times
  a  entry sysaddress
  n  galaxy                  0 means default_galaxy
  s  entry name
  s  entry credit
     n  entry credited month \  only present if entry credit is non-empty
  a  exit sysaddress         no galaxy field: a black hole never
                              changes galaxy, it is always this route's own
  s  exit name
  s  exit credit
     n  exit credited month  \  only present if exit credit is non-empty
```

There is no bare-address system in this format: every entry in the systems
section came from an in-game discovery record (`DiscoveryManagerData`), never
merely because the save mentions an address (visited, based on, teleported
through). 

There is also no `has_exit_candidate` flag: `buildBlackholeRoutes` never emits
a route without a paired exit (a route whose only content would repeat its
already-carried entry system is not written at all), so the exit fields always
follow the entry fields, unconditionally.

**The dominant galaxy is carried once.** Whichever galaxy appears most often
becomes `default_galaxy` in the header, and everywhere else a `0` in the
galaxy slot means "the default one". Most players never leave Euclid, so most
payloads pay nothing for galaxies at all.

One exception: Euclid's own index is `0`, so a `0` in the slot cannot mean
both "the default" and "Euclid". As soon as the payload holds any Euclid
entry (system or route), the encoder forces `default_galaxy` to `0`, which
makes the two meanings coincide. Without that, a Euclid system in a payload
dominated by another galaxy would be written `0` and read back into the
dominant galaxy. The decoder never needed to change for this.

## 4. A complete payload, dissected

Three systems and one black hole route. Reproduce it with:

```bash
node bin/tessera.js dump-geo fixtures/geo-sample.json --full
```

```
schema     geo-v1, encoding deflate-raw+base64url, 160 chars in data
payload    227 bytes: 3 systems, 1 routes
crc8       0x7B over "had" + payload, valid

off  bytes                    kind    section   field                          value
---  -----------------------  ------  --------  -----------------------------  -----

  0  00                       varint  header    default_galaxy                 0
  1  03                       varint  header    n_systems                      3
  2  01                       varint  header    n_blackhole_routes             1

  3  A2 50 90 FE 1F 00        addr6   systems   [0] sysaddress                 01FFE9050A2
  9  00                       varint  systems   [0] galaxy (0 = default)       0
 10  03 4E 69 64              str     systems   [0] name                       3 bytes: "Nid"
 14  0B 45 78 70 6C 6F 72...  str     systems   [0] credit                     11 bytes: "ExplorerOne"
 26  00                       varint  systems   [0] credited month             0 -> 2016-08
 27  02                       varint  systems   [0] n_planets                  2
 28  04 45 64 65 6E           str     systems   [0].planet[0] name             4 bytes: "Eden"
 33  00                       str     systems   [0].planet[1] name             empty
 34  7E 91 C9 B2 F3 00        addr6   systems   [1] sysaddress                 0F3B2C9917E
 40  0F                       varint  systems   [1] galaxy (0 = default)       15
 41  00                       str     systems   [1] name                       empty
 42  00                       str     systems   [1] credit                     empty
 43  01                       varint  systems   [1] n_planets                  1
 44  0A 53 6F 6C 6F 20 57...  str     systems   [1].planet[0] name             10 bytes: "Solo World"
 55  05 1C 4E 2D 7A 00        addr6   systems   [2] sysaddress                 07A2D4E1C05
 61  00                       varint  systems   [2] galaxy (0 = default)       0
 62  3F E2 98 83 E2 98 83...  str     systems   [2] name                       63 bytes: "☃☃☃☃☃☃☃☃☃☃☃☃☃☃☃☃☃☃☃☃☃"
126  30 C3 89 C3 89 C3 89...  str     systems   [2] credit                     48 bytes: "ÉÉÉÉÉÉÉÉÉÉÉÉÉÉÉÉÉÉÉÉÉÉÉÉ"
175  05                       varint  systems   [2] credited month             5 -> 2017-01
176  00                       varint  systems   [2] n_planets                  0

177  10 3E B3 A1 C7 00        addr6   routes    [0] entry sysaddress           0C7A1B33E10
183  00                       varint  routes    [0] galaxy (0 = default)       0
184  00                       str     routes    [0] entry name                 empty
185  0B 45 78 70 6C 6F 72...  str     routes    [0] entry credit               11 bytes: "ExplorerOne"
197  13                       varint  routes    [0] entry credited month       19 -> 2018-03
198  21 5A 3D 8F 9C 00        addr6   routes    [0] exit sysaddress            09C8F3D5A21
204  09 46 61 72 20 53 68...  str     routes    [0] exit name                  9 bytes: "Far Shore"
214  0B 6F 74 68 65 72 70...  str     routes    [0] exit credit                11 bytes: "otherplayer"
226  13                       varint  routes    [0] exit credited month        19 -> 2018-03
```

Read the three systems out of that:

- `01FFE9050A2` named `Nid`, first discovered in game by `ExplorerOne` in
  2016-08, two planets, one of them named `Eden`, the other unnamed.
- `0F3B2C9917E` in galaxy 15, dated (one planet, `Solo World`) but the
  discovering event carried no username, so `credit` and the month are both
  empty - a name with nobody credited for it.
- `07A2D4E1C05`, both `name` and `credit` truncated at the wire cap (64 and
  48 bytes): the name is 21 snowman characters (63 bytes, one short of the
  cap, because the cut backs off rather than split the 22nd code point),
  the credit is 24 `É` (48 bytes exactly).

And the route: the player entered a black hole at `0C7A1B33E10`, credited to
`ExplorerOne` in 2018-03, and the first new, sufficiently distant, non-079
system dated within the search window was `09C8F3D5A21`, named `Far Shore`
and credited to `otherplayer` (a third party: nothing says the person who
took the exit is the one who is credited for finding it first). The exit is
called a candidate because a window match is evidence, not proof - the server
decides on geometry (progress toward the galactic centre).

## 5. What is in it, and what is not

In, per system: the address, the galaxy, the name you gave it, the in-game
discovery credit and its month (only together, never one without the other),
the planets you discovered with their names only (no date, no count beyond
the wire cap). Per route: the same, on both the entry and the exit candidate.

Not in it: your own pseudonym anywhere in the structure unless you happen to
be the credited discoverer, the `user` field of planet entries which is
stripped before encoding, the day/hour/minute/second of any event, how long a
black hole jump took, anything about your inventory, your ships, your bases
beyond the address of the system they sit in, and any address the save merely
mentions without an attached discovery record.

The one pseudonym the format carries is `credit`, and it is the name of
whoever first discovered a system in game, which every player who visits that
system already sees. It is often you; on a community-synchronized save, it is
often someone else entirely.

[privacy.md](privacy.md) covers what this means and what you get in exchange
for sending it.

## 6. Checking a payload of your own

```bash
node bin/tessera.js geo save.hg --quiet > my-geo.json          # readable form
node bin/tessera.js geo save.hg --quiet --post > my-post.json  # what would be sent
node bin/tessera.js dump-geo my-post.json --full               # every byte of it
```

The listing is truncated to 60 rows unless you pass `--full`, because a real
payload runs to thousands of systems. Piping it into a pager or grepping it for
a name is the fastest way to answer "is that in there".
