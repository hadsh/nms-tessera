<!-- Author: had.sh -->

# The seed format, byte by byte

Seed v1.0. This document describes exactly what a `tessera~` seed contains and
how to read one with nothing but a pen. Every listing below was produced by
`tessera dump` on a real seed, and the layout table it walks is cross-checked
against the shipped decoder by `tessera selftest`, so this page cannot drift
away from the code.

Seed v1.0 is what ships today, not the last word. See
[concepts.md](concepts.md) section 8 for what a future version can and cannot
change.

The per-beat type is carried as a 3-byte presence bitmask. Dates are stored as
one absolute month-index-since-epoch varint per beat. `main_story_arc` merges
two enums into a single byte. Every listing on this page reflects exactly
that layout.

## 1. The envelope

```
tessera~ <base64url payload> . <version>
                                 |
                                 1   raw bytes
                                 1z  deflate-raw compressed
```

Full example, the one dissected in section 3:

```
tessera~3RGQAAMUJTZHWGl6i5ytvs_g8fi82MTgiwTgDwCiocH0_wMDTmlkAQRFZGVuARc9QQQ.1
        \____________________________________________________________________/ \/
                          base64url of 49 bytes                                 tag
```

The base64url alphabet is `A-Z a-z 0-9 - _`, with no padding, so a seed is safe
in a URL, in a QR code and in a filename. Decoding it yields the frame:

```
+--------+--------+------------+----------------------------------+
| crc8   | header | commitment | beats: back to back, no separator |
| 1 byte | 3 bytes| 15 bytes   | 30 bytes in this example          |
+--------+--------+------------+----------------------------------+
```

The commitment is SHA-256 of the depositor's destroy key, truncated to 15
bytes, and it is on **every** seed. It is what lets someone take their own
story down later without an account, an email or any proof of who they are:
they type the key, the server hashes it and compares. See section 2 for why it
rides inside the payload rather than in a server row, and
[privacy.md](privacy.md) for what it does and does not reveal.

The header is a presence BITMASK, not a beat itself (see section 2): it says
which of the 17 known beat types are in this seed, and their bodies then
follow it in one fixed order, so no beat body needs a byte saying what
it is.

The first byte is CRC-8/SMBUS (polynomial `0x07`, init `0x00`, no reflection,
xorout `0x00`) computed over the ASCII bytes `had` followed by the payload. It
catches corruption and marks the origin of the seed. It is a checksum, not a
signature: anyone can recompute it.

The encoder builds both envelopes and keeps whichever is shorter once written
as text, then records the winner in the tag so the decoder never guesses. On a
22 save corpus the split is about half and half, within 8 characters either
way: the payload is already dense, so deflate often has nothing left to win.

## 2. Primitives

### varint (unsigned LEB128)

Seven payload bits per byte, low group first. Bit 7 is the continuation flag:
1 means another byte follows, 0 means this was the last.

```
byte  E0        0F
bits  1110 0000 0000 1111
      ^         ^
      |         +-- 0: last byte, payload 000 1111 = 15
      +-- 1: continue,   payload 110 0000 = 96

value = 96 + 15 x 128 = 2016
```

This is the only integer encoding in the format. **Nothing on the wire is
signed**, so there is no zigzag, no sign bit and no two's complement to read.
Every number in a seed counts upward from zero: a count, a length, a byte
index, or a month index counting forward from a fixed epoch.

### string

A varint byte length, then that many UTF-8 bytes. No terminator, no escaping.

```
03 4E 69 64
^^ ^^^^^^^^
|  "Nid"
+- 3 bytes follow
```

Every name field the format carries (`first_naming` twice, `favorite_base`,
`freighter_named`, `atlas_encounter`, `settlements`, `first_pet`,
`multitool_named`) goes through the same step before this encoding: a leading
or trailing bracket wrapper is stripped (`[TAG] Ragnar` becomes `Ragnar`),
spaces are removed by joining words in CamelCase, and the result is capped at
16 characters. A trailing bit records whether the original name had a space
at all, so the reader can split the CamelCase back apart without turning
`L'Atlas` into `L' Atlas`. `multitool_named` packs that bit into its own
`is_large`/`had_no_space` flag byte instead of a separate one, to save a byte;
every other name field carries it as its own trailing byte, right after the
string (`kind` `name` in the table below: a `str` plus that one byte).

### address

A system address is 11 hexadecimal characters. It is parsed as one number and
written as a single varint, which is why it takes 6 bytes rather than 11.
`first_system` uses 12 hex characters: the planet index rides in the leading
nibble, on top of the system address.

An address says nothing about which galaxy it is in, and the seed has no
default-galaxy field to lean on. Galaxy travels separately, as an ordinary
varint on the three beats that need one (`intergalactic_jump.to_galaxy`,
`atlas_encounter.galaxy`, `purple_systems.first_system.galaxy`), where `0`
means Euclid. Everywhere else, Euclid is what an address is read against.

The default-galaxy scheme, where a header names the most frequent galaxy and a
`0` elsewhere refers back to it, belongs to the geography payload and not to
this format: see [geo-format.md](geo-format.md). Payload A describes a whole
map at once, so a shared default pays for itself; a seed carries a handful of
addresses, and a header field would cost more than the repetition it saves.

```
bytes    F8 BC D8 C4 E0 8B 04
payloads 120 60 88 68 96 11 4    (each byte & 0x7F)

value = 120 x 128^0 + 60 x 128^1 + 88 x 128^2 + 68 x 128^3
      + 96 x 128^4 + 11 x 128^5 +  4 x 128^6
      = 17 996 057 026 168
      = 0x105E08961E78

planet index 1, system address 05E08961E78
```

### header bitmask

3 bytes (`ceil(17 beat types / 8)`), right after the crc8 byte, one bit per
beat type, bit 0 of the first byte first: bit `n` set means `BEAT_TYPES[n]`
is present. A beat type appears at most once by construction, so presence is
all the header needs to say - no per-beat marker, no order to carry. The
bodies that follow walk `BEAT_TYPES` in ascending index order; that is now
the *only* order a seed can express, and it does not need to be, because
`NarrationService::topoSort()` recomputes the narrative order server-side
from type, date and dependency rules, never from stream order.

Bit 17 is not a beat type. It is `mosaic_public`, the depositor's opt-in to the
public gallery, and it lives here because the header already transmits 24 bits
and only 17 were spoken for. It is read before any beat body
(`peekMosaicPublic`), and it is not authenticated by anything: see
[privacy.md](privacy.md) section 5, which spells out what follows from that and
why it ships anyway.

Bits 18 to 23 are **reserved**, and a decoder rejects a seed that sets any of
them (`seed: reserved header bit set`), a check the server-side decoder makes
too. This is not pedantry about unused space: leaving them unchecked would let
one story be spelled 64 different ways, each a different string with a
different SHA-256 - and the server keys both its moderation blocklist and its
gallery tile table on exactly that hash.
The same reasoning rejects trailing bytes after the last beat, and rejects
base64url text containing anything outside `A-Za-z0-9_-`. One story, one
encoding, one hash.

The day a new beat type claims bit 18, the reserved mask shrinks by one bit and
older seeds keep decoding unchanged, because they carry zeros there by
construction.

### commitment

15 raw bytes, straight after the header, on every seed: `SHA-256("tessera-destroy-v1:" + the
canonical destroy key)`, truncated. Never a varint, never length-prefixed, and
never optional.

The key itself is 120 bits from `crypto.getRandomValues`, shown once on the
printed receipt as 24 Crockford base32 symbols plus a check symbol, in five
groups of five: `4PTR3-KXD5V-SHECP-X51N8-3M9Y1`. 120 bits is 24 symbols and 15
bytes exactly, so the encoding lands on a byte boundary and there is no padding
convention for the two implementations to disagree about.

Why it is here, and not in a row on the server: an engagement is only worth
something if it was fixed before the challenge and cannot be swapped
afterwards. Inside the payload it is covered by the seed's own identity, so
changing it names a different story rather than stealing this one. Parked
beside the seed, it would be a detachable label: anyone holding a public link
could replace it with a commitment to a key of their own and take the story
down, without breaking a single hash. Nothing about that attack is
cryptographic, which is exactly why the field's position is the defence.

It reveals nothing. It is the hash of an unstructured random, so it refers to
no person, no save and no story. And it costs no header bit: being
unconditional, it needs no presence flag, so bits 18 to 23 stay reserved for
future beat types.

Being a hash, it is incompressible: deflate never wins anything on these 15
bytes, so budget the full amount against the QR ceiling in section "Budget QR".

### date

Month granularity, never finer. Each
dated beat stores ONE absolute unsigned varint: months since the game's
release month, 2016-08. No chaining, no delta from a previous beat - every
date is self-contained, which is what lets the header above walk beats in a
fixed order instead of the order they actually happened in. Decoded back to
an ISO date, the day is always synthesized as `-15` (mid-month): nothing
downstream (season, `date_human`, `relDuration`, the topological sort) reads
finer than month, so nothing claims a precision the wire does not carry.

```
byte  17
bits  0001 0111      payload 001 0111 = 23 (no continuation bit set)

months since 2016-08 = 23  ->  2016-08 + 23 = 2018-07  ->  "2018-07-15"
```

### flags

One bit per named arc, bit 0 of the first byte first. Seven arcs fit in one
byte for the main story, eleven take two bytes for the expedition lore.
Leftover high bits are always zero.

### single bytes

Four fields are one raw byte, with no varint and no length. Their meaning is
entirely in the table they index, so here are those tables.

**`creature_id`** on `first_pet` is an index into the frozen `CREATURE_IDS`
list, 85 species long, from `FISH` at 0 to `QUAD_PET` at 84. Byte `0x16` is 22,
which is `CAT`. A species the table does not know falls back to 0, so an
unknown creature reads as `FISH` rather than failing. Print the list with
`node -e "import('./lib/seed.js').then(m=>console.log(m.CREATURE_IDS))"`.

**The `multitool_named` flag byte** packs two booleans and wastes the rest:

```
bit 0  is_large        the tool is a large multitool
bit 1  had_no_space    the original name contained no space
bits 2..7  unused, always 0
```

`had_no_space` exists so the reader never re-splits a name that was already
one word. Without it, `StarLight` compressed and expanded would come back as
`Star Light`.

**`dist_fly_class` and `dist_walked_class`** on `journey_ends` are classes from
0 to 4, never distances. See section 5.

Galaxy fields are varints, not bytes, and `0` means Euclid, the galaxy every
character starts in.

## 3. A complete seed, dissected

Four beats: one undated, one dated with two strings, one dated counter, one
flag beat. Reproduce this listing at any time with:

```bash
node bin/tessera.js dump 'tessera~3RGQAAMUJTZHWGl6i5ytvs_g8fi82MTgiwTgDwCiocH0_wMDTmlkAQRFZGVuARc9QQQ.1'
```

```
envelope   raw (.1), 69 chars on the wire, 49 payload bytes
crc8       0xDD (11011101) over "had" + payload, valid

off  bytes                    kind           field                        value
---  -----------------------  -------------  ---------------------------  -----

  0  11 90 00                 header         presence bitmask             4 beats: first_system, first_naming, final_session, main_story_arc
     00010001 10010000 00000000
  3  03 14 25 36 47 58 69...  commit         destroy-key commitment       031425364758697a8b9cadbecfe0f1

 18                           type           beat present (header bit)    first_system
 18  F8 BC D8 C4 E0 8B 04     addr12         sysaddress + planet_index    105E08961E78
 25  E0 0F                    varint         start_year                   2016
     11100000 00001111

 27                           type           beat present (header bit)    first_naming
 27  00                       varint         month index                  month 0 -> 2016-08-15
     00000000
 28  A2 A1 C1 F4 FF 03        addr11         sysaddress                   01FFE9050A2
 34  03 4E 69 64 01           name           system_name                  3 bytes, had_no_space=1: "Nid"
 39  04 45 64 65 6E 01        name           planet_name                  4 bytes, had_no_space=1: "Eden"

 45                           type           beat present (header bit)    final_session
 45  17                       varint         month index                  month 23 -> 2018-07-15
     00010111
 46  3D                       varint         events_that_day              61
     00111101

 47                           type           beat present (header bit)    main_story_arc
 47  41                       flags1         arc flags                    2 flags set, bit 0 first
     01000001
 48  04                       enum2          epilogue_reached | artemis_choice  4: epilogue_reached=stay, artemis_choice=dead
```

The commitment at offset 3 is the fixed byte pattern the test fixtures use, not
a real key's hash: a real one would be different on every run and this listing
could not be reproduced. Nothing in the format cares which it is.

Reading the header bitmask at offset 0 bit by bit: byte 0 is `0x11` =
`0001 0001`, bits 0 and 4 set -> `BEAT_TYPES[0]` (`first_system`) and
`BEAT_TYPES[4]` (`first_naming`); byte 1 is `0x90` = `1001 0000`, bits 4 and
7 set (bit index `8+4=12`, `8+7=15`) -> `BEAT_TYPES[12]` (`final_session`)
and `BEAT_TYPES[15]` (`main_story_arc`); byte 2 is `0x00`, nothing in bits
16-16 (only index 16, `expedition_lore`, lives there). Four bits set, four
beats, and the bodies below walk them in that same ascending order -
`first_system` before `first_naming` before `final_session` before
`main_story_arc` - regardless of which order they actually happened in.

Reading the arc-flags byte at offset 32 bit by bit:

```
0x41 = 0 1 0 0 0 0 0 1
       ^ ^ ^ ^ ^ ^ ^ ^
       | | | | | | | +-- bit 0  a3_choice_reached     true
       | | | | | | +---- bit 1  act1_complete         false
       | | | | | +------ bit 2  act2_complete         false
       | | | | +-------- bit 3  act3_complete         false
       | | | +---------- bit 4  nexus_complete        false
       | | +------------ bit 5  remembrance_reached   false
       | +-------------- bit 6  story_init_reached    true
       +---------------- bit 7  unused, always 0
```

Note what happened at encoding time: this player had `STORY_INIT`,
`A3_CHOICE`, `EPILOGUE_STAY` and `NEXUS6A_DEAD` done. The next byte, `0x04`,
is `epilogue_reached * 3 + artemis_choice` = `1 * 3 + 1` = `4`: `stay` and
`dead`. Neither enum spends its own byte any more (see section 4).

The whole journey above, four beats including two names and two dates, costs
49 bytes, or 69 characters once in a URL - of which 15 bytes are the
commitment, the fixed price of being able to take the story down again. Each name costs one more byte than
its string length: the trailing `had_no_space` bit, present on every name
field (see section 2).

## 4. The beat table

Type indices are append-only by discipline: reordering the table invalidates
every seed ever emitted. A field that does not earn its place is cut before it
ships, never after: once a seed carrying it exists, removing it means carrying
it forever behind a version bump instead.

| beat | index | dated | payload fields, in order |
|---|---|---|---|
| `first_system` | 0 | no | addr12 sysaddress + planet_index, varint start_year |
| `community_phase` | 1 | no | varint distinct_users |
| `center_journey` | 2 | yes | addr11 closest_system, varint blackhole_warps |
| `intergalactic_jump` | 3 | yes | varint to_galaxy |
| `first_naming` | 4 | yes | addr11 sysaddress, name system_name, name planet_name |
| `journey_ends` | 5 | yes | varint total_systems, total_regions, total_galaxies, total_events, active_days, total_deaths, systems_discovered, planets_discovered, byte dist_fly_class, byte dist_walked_class, varint sentinel_kills |
| `favorite_base` | 6 | yes | addr11 sysaddress, name name, varint bases_built |
| `freighter_named` | 7 | no | name name, varint frigates, varint ships_owned, varint ships_bought |
| `atlas_encounter` | 8 | yes | addr11 sysaddress, varint galaxy, name system_name |
| `purple_systems` | 9 | yes | addr11 first_system.sysaddress, varint first_system.galaxy |
| `total_playtime` | 10 | no | varint seconds |
| `settlements` | 11 | yes | varint total_population, name names[0], addr11 sysaddress |
| `final_session` | 12 | yes | varint events_that_day |
| `first_pet` | 13 | yes | addr11 sysaddress, byte creature_id, name name, varint pets_owned, varint creatures_fed, varint creatures_discovered |
| `multitool_named` | 14 | no | str name, byte `is_large \| had_no_space` |
| `main_story_arc` | 15 | no | flags1 arc flags, enum2 `epilogue_reached \| artemis_choice` |
| `expedition_lore` | 16 | no | flags2 lore flags, varint pirates_killed, varint flora_discovered |

Worst-case payload sizes, measured on the synthetic fixture where every field
is filled, are printed by `tessera spec`. The heaviest beats are the ones
carrying names: `first_naming` 30 bytes, `first_pet` 30, `settlements` 26.

### The quest beats, bit by bit

The two quest beats are the densest part of the format: seven bytes carry
everything the story knows about what you did in the game. They are also the
only place where a bit or a packed enum means something a
reader could never guess, so here they are in full, taken from the worst case
fixture where every quest is done.

`main_story_arc`, two bytes, no type byte of its own (see the header
bitmask in section 2):

```
 X    7F   arc flags                      01111111
X+1   04   epilogue_reached | artemis_choice   00000100
```

**Byte 1, the arc flags.** Seven bits, one per arc, bit 0 first. Bit 7 has no
arc and is always 0, which is why a fully completed main story reads `0x7F` and
never `0xFF`.

```
0x7F = 0 1 1 1 1 1 1 1
       ^ ^ ^ ^ ^ ^ ^ ^
       | | | | | | | +-- bit 0  a3_choice_reached
       | | | | | | +---- bit 1  act1_complete
       | | | | | +------ bit 2  act2_complete
       | | | | +-------- bit 3  act3_complete
       | | | +---------- bit 4  nexus_complete
       | | +------------ bit 5  remembrance_reached
       | +-------------- bit 6  story_init_reached
       +---------------- bit 7  unused, always 0
```

**Byte 2, `epilogue_reached | artemis_choice`.** Two independent exclusive
enums packed into one byte instead of two: `value = epilogue_reached * 3 +
artemis_choice`, each sub-value 0-2. Reading back: `epilogue_reached =
floor(value / 3)`, `artemis_choice = value % 3`. `epilogue_reached`: `0`
absent, `1` you stayed, `2` you left for a new galaxy (if both mission ids
somehow appear, staying wins, an arbitrary but documented tie-break).
`artemis_choice`: `0` absent, `1` dead, `2` simulation. `0x04` above is
`1 * 3 + 1` = stay, dead.

`expedition_lore`, four bytes, also with no type byte of its own:

```
 X    FF 07   lore flags         11111111 00000111
X+2   89 06   pirates_killed     10001001 00000110   = 777
X+4   80 10   flora_discovered   10000000 00010000   = 2048
```

**Bytes 1 and 2, the lore flags.** Eleven bits across two bytes, bit 0 of the
first byte first, so a full completion reads `FF 07` and the five high bits of
the second byte are always 0.

```
byte 1: 0xFF = bits 0..7   atlas_lore_complete, bio_frig_complete,
                           bio_ship_complete, farmer_complete,
                           overseer_complete, pirates_complete,
                           scientist_complete, sentinels_complete
byte 2: 0x07 = bits 8..10  settlement_arc_complete, waterstory_complete,
                           weapguy_complete
               bits 11..15 unused, always 0
```

**Then two counters**, `pirates_killed` and `flora_discovered`, ordinary
varints capped at 9999 like every other counter in section 5.

An arc is complete only when every mission id in its group is done, with two
exclusive branches counted as alternatives: `NEXUS6A_DEAD` or `NEXUS6A_SIM`,
and `NEXUS7_DEAD` or `NEXUS7_ALIVE`. Finishing twelve of the thirteen `ACT1`
steps leaves bit 1 at zero. The bit says complete, never in progress, and there
is nothing in the seed to say how far along you were.

### What each quest bit requires

The bit order above, with the mission ids each flag is computed from.

`main_story_arc`:

| bit | flag | complete when |
|---|---|---|
| 0 | `a3_choice_reached` | `A3_CHOICE` |
| 1 | `act1_complete` | the 13 `ACT1_STEP*` |
| 2 | `act2_complete` | `ACT2_BEACON` and the 13 `ACT2_STEP*` |
| 3 | `act3_complete` | `ACT3_BEACON` and the 4 `ACT3_STEP*` |
| 4 | `nexus_complete` | the 18 `NEXUS*`, counting `NEXUS6A_DEAD` or `NEXUS6A_SIM`, and `NEXUS7_DEAD` or `NEXUS7_ALIVE` |
| 5 | `remembrance_reached` | `REMEMBRANCE` |
| 6 | `story_init_reached` | `STORY_INIT` |

`expedition_lore`, in bit order:

| bit | flag | complete when |
|---|---|---|
| 0 | `atlas_lore_complete` | the 10 `ATLAS*` |
| 1 | `bio_frig_complete` | `BIO_FRIG`, `BIO_FRIG_DONE` |
| 2 | `bio_ship_complete` | the 5 `BIO_SHIP*` |
| 3 | `farmer_complete` | the 10 `FARMER*` |
| 4 | `overseer_complete` | the 10 `OVERSEER*` |
| 5 | `pirates_complete` | the 11 `PIRATE*` |
| 6 | `scientist_complete` | the 9 `SCIENTIST*` |
| 7 | `sentinels_complete` | the 5 `SENTINELS_*` |
| 8 | `settlement_arc_complete` | `SETTLE_INTRO`, `SETTLE_CLAIM`, `SETTLE_MISS`, `SETTLE_SURVIVE` |
| 9 | `waterstory_complete` | the 5 `WATERSTORY*` |
| 10 | `weapguy_complete` | the 7 `WEAPGUY*` and `WEAPGUY_REWARDS` |

The two id tables these are computed against are frozen and exported from
`lib/seed.js` as `MAIN_STORY_MISSION_IDS` and `EXPEDITION_LORE_MISSION_IDS`.
Print them with:

```bash
node -e "import('./lib/seed.js').then(m=>console.log(m.MAIN_STORY_ARC_GROUPS))"
```

## 5. The counters

Sixteen fields in the table above are lifetime counters, most of them read from
`Stats.^GLOBAL_STATS` in the save. Each rides inside whichever beat its subject
belongs to rather than a beat of its own, which is why they sit where you
would not expect: how many creatures you fed rides inside `first_pet`, how
many sentinels you killed rides inside `journey_ends`.

| counter | rides on | read from |
|---|---|---|
| `blackhole_warps` | `center_journey` | global stats |
| `total_deaths` | `journey_ends` | save milestones |
| `systems_discovered` | `journey_ends` | global stats |
| `planets_discovered` | `journey_ends` | global stats |
| `sentinel_kills` | `journey_ends` | global stats |
| `dist_fly_class` | `journey_ends` | global stats, bucketed |
| `dist_walked_class` | `journey_ends` | global stats, bucketed |
| `frigates` | `freighter_named` | global stats |
| `ships_bought` | `freighter_named` | global stats |
| `ships_owned` | `freighter_named` | the save's ship list |
| `pets_owned` | `first_pet` | global stats |
| `creatures_fed` | `first_pet` | global stats |
| `creatures_discovered` | `first_pet` | global stats |
| `pirates_killed` | `expedition_lore` | global stats |
| `flora_discovered` | `expedition_lore` | global stats |
| `bases_built` | `favorite_base` | count of bases in your trajectory |

Three counters are not from the global stats and behave differently.
`total_population` on `settlements` is the sum over the settlements you own.
`distinct_users` on `community_phase` counts other players around your cradle.
`seconds` on `total_playtime` is the save's own play time field.

### Every counter is capped

`capCount()` clamps each one to the range 0 to 9999, rounded:

```js
function capCount(n) {
    return Math.min(9999, Math.max(0, Math.round(n ?? 0)));
}
```

`total_deaths` is capped harder, at 999. So a player with 25 000 fed creatures
and 1 200 deaths emits `9999` and `999`. The exact figures stay in your save
and in the local report; the seed carries "more than the format can say".

The cap is a design decision, not an accident of the varint. Beyond four
digits the number stops being a story and starts being a fingerprint, and no
sentence the renderer can write needs the difference between 9 999 and 25 000.

### Distances are buckets, not measurements

`dist_fly_class` and `dist_walked_class` are single bytes holding a class from
0 to 4, never a distance:

| class | flown | walked |
|---|---|---|
| 0 | none | none |
| 1 | under 1 000 000 | under 50 000 |
| 2 | under 10 000 000 | under 300 000 |
| 3 | under 30 000 000 | under 1 000 000 |
| 4 | beyond | beyond |

The thresholds are in game units, the raw values of `^DIST_FLY` and
`^DIST_WALKED` in the save's global stats. No conversion is applied and none is
claimed: the numbers above are compared exactly as the save records them.

The raw counts never enter the seed. The renderer only ever needed to say
whether you flew a little or a great deal, so that is all it gets.

## 6. What the seed does not contain

The format carries the minimum needed to retell a journey. Everything below is
either dropped at encoding time or recomputed at rendering time from public
spatial data, and none of it travels:

- the save file, or any part of it beyond the fields listed above
- the player's name, and any third party name: the protagonist is `you`
- raw mission ids: reduced to the arc bits above, and not recoverable from them
- region names, system names as generated by the game, distances to the galactic
  centre, seasons, relative wording like "three years later": all derived server
  side from the address and the date
- timestamps finer than the month
- coordinates: an address is not a position until it is resolved against the
  spatial databases

## 7. Reproducing this document

```bash
node bin/tessera.js dump <seed>       # the listing of section 3, on any seed
node bin/tessera.js spec              # indices, dated flag, worst-case sizes
node bin/tessera.js selftest          # checks this layout against the decoder
node bin/tessera.js decode <seed>     # the beats a seed yields
```

`tools/annotate.js` holds the only copy of the layout outside `lib/seed.js`.
That duplication is deliberate, and it is kept honest by `selftest`, which
walks the worst-case fixture with the table in this document and compares every
beat index, every dated flag and every scalar against what the shipped decoder
returns. A field added upstream without updating the table fails a check before
it can produce a wrong listing.
