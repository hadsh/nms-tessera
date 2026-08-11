<!-- Author: had.sh -->

# The beat catalogue

A beat is one moment of a journey that earns a paragraph. The pipeline detects
them in [lib/beats.js](../lib/beats.js), the seed carries them, and the renderer
turns each into prose. This page answers the question the other documents do
not: why does my story mention this and not that.

Seventeen types exist. A given save produces between five and seventeen of
them. Most saves land around ten.

The rule behind the whole catalogue: **absence is silence**. A beat that cannot
be established from the save does not fire, and nothing is invented to fill the
gap. A story that does not mention your settlement is a story where the save
carried no settlement.

## What fires, and when

| beat | fires when | dated |
|---|---|---|
| `first_system` | always | no |
| `journey_ends` | always | yes |
| `center_journey` | always | yes |
| `community_phase` | at least 3 pseudonyms other than yours appear around your cradle | no |
| `first_naming` | you named something, and a record credits it to you | yes |
| `intergalactic_jump` | your own track shows a galaxy change | yes |
| `favorite_base` | a base stands out in your trajectory | yes |
| `final_session` | your densest session is also your last day | yes |
| `freighter_named` | you named a freighter, or own any ship or frigate | no |
| `atlas_encounter` | you discovered an Atlas station yourself | yes |
| `purple_systems` | the save records exotic colour systems as discovered | yes |
| `settlements` | you own at least one settlement | yes |
| `first_pet` | you tamed at least one creature with a birth time | yes |
| `multitool_named` | you named your active multitool | no |
| `main_story_arc` | any main story mission id is done | no |
| `expedition_lore` | any lore or expedition mission id is done | no |
| `total_playtime` | the save records play time | no |

Undated beats are not undated by accident. A freighter name has no timestamp
anywhere in the save; a mission flag says done, never when. Those beats sort to
the front of the story and are told without a date, which is honest rather than
convenient.

## Notes on the ones that surprise people

**`first_system` is your cradle, not your first discovery.** It comes from the
save's own start address when the save carries one, and only falls back to your
earliest record when it does not. The planet index rides along, so the story
can say which world you woke up on.

**`community_phase` is about the crowd, never about individuals.** It fires on
the count of other pseudonyms near your beginning, and it carries that count
and nothing else. No name of any other player survives the anonymisation pass.
Three is the threshold: below that it is a coincidence, above it you started in
a place other people had already walked through.

**`center_journey` measures ground gained, not distance travelled.** It compares
the distance from your starting point to the galactic centre against the closest
you ever got. Someone who spent six years going nowhere near the centre still
gets the beat, with a number that says so.

**`intergalactic_jump` follows your own track.** It walks your chronological
records looking for a galaxy change, rather than trusting the galaxy list in
the save, which includes galaxies you never chose to reach.

**`atlas_encounter` is derived from the address, not from the flag.** A system
whose address carries the marker `07A` is an Atlas station, by generation rule.
The save's own `CompletedAtlasAddresses` and `FirstAtlasStationDiscovered`
fields are unreliable: often blank, often dated late, sometimes false for a
player who clearly visited one. The earliest `07A` you discovered yourself is
the truth, and its date is a real first encounter.

**`final_session` only fires if your biggest day is also your last.** That is
the shape of a journey that stopped rather than tapered: an intense session,
then nothing. A save whose last day was quiet does not get the beat, because
there is no ending to describe.

**`freighter_named` also carries the fleet.** It fires on a name or on any
ship, frigate or purchase count, so the fleet counters are never lost on a
player who never renamed anything.

**`first_pet` fires even for an unnamed creature.** The species and the system
are enough to tell the story. `multitool_named` is the opposite: with no name
there is nothing to say, so it does not fire at all.

**`main_story_arc` and `expedition_lore` carry booleans, never ids.** The
detection compares your mission progress against two frozen id tables, and the
encoder reduces the result to about twenty per-arc flags. The id list itself
never reaches the seed. See [privacy.md](privacy.md) section 3.

## What a beat carries, and what it does not

Each beat holds two different sets of facts, and the distinction is the reason
seeds are small.

**Carried in the seed**: identifiers and numbers that cannot be recomputed.
Addresses, counts, the names you chose, the month. The exact field list per beat
is in [seed-format.md](seed-format.md) section 4.

**Derived at render time**: everything the server can rebuild from an address
and a date. System and region names, the distance to the galactic centre, the
season, relative phrasings like "three years later", the ordering of paragraphs.

So `center_journey` carries an address and a warp count, and the sentence about
seven hundred thousand light years is computed when the page is built. Nothing
about that number travels.

Lifetime counters ride along on beats that have nothing to do with them: your
fleet counts on `freighter_named`, your sentinel kills on `journey_ends`, how
many creatures you fed on `first_pet`, your pirate kills on `expedition_lore`.
Each rides inside a beat that already exists rather than paying for a beat
header of its own. Every one of them is capped at 9999, and the two
distance figures are reduced to a class from 0 to 4. The full table is in
[seed-format.md](seed-format.md) section 5.

Beats also carry two hints the renderer uses and the seed drops entirely:
`theme`, a label like "birth" or "purple stars", and `salience`, a number
between 0 and 1 saying how much weight the moment deserves. Both are recomputed
from the beat type, which is why they cost no bytes.

One field in the seed belongs to no beat at all: the fifteen-byte destroy-key
commitment, which sits between the header and the first beat. It is not part of
your story, it says nothing about your journey, and no beat can add to it or
read it. It is there so the story can be taken down later by whoever made it.
See [seed-format.md](seed-format.md) section 2 and
[privacy.md](privacy.md) section 6b.

## What earns a beat its bytes

The test a beat has to pass is simple: it has to change a sentence in the
output. A beat that only changes a number nobody reads does not make the cut,
and its bytes stay out of the URL. `main_story_arc`'s booleans are the
clearest case: the game sets endings together rather than one at a time, so a
field tracking which ending was reached would discriminate nothing and earns
no byte. See [seed-format.md](seed-format.md) section 4.

## Seeing your own

```bash
node bin/tessera.js beats save.hg     # every beat detected, with its facts
node bin/tessera.js run save.hg       # the list, in one line
node bin/tessera.js decode <seed>     # what survived into the seed
```

The difference between the second and the third is worth looking at once: the
beats carry more than the seed keeps, and the gap is exactly what gets
recomputed rather than transported.
