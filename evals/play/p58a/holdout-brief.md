# Brief: write sentences for a small game generator

You are writing test input for an app where a player types ONE sentence and the app turns it into a short 3D mini-game that runs on a phone. You have never seen the app, and you must not look for it: do not open, list or search any file or folder other than this brief, and do not search the web. Write everything from your own imagination.

## What to write

Write exactly **120** sentences, the way a 13–18 year old player would type them into such an app: plain English, lowercase is fine, 8–30 words, no game-genre names (no "platformer", "match-3", "tower defense", "endless runner", "rhythm game"), no brand or franchise names, no real people.

Every sentence must name:

- **hero** – who or what the player is or controls (a creature, animal, person or vehicle). Required in every sentence.
- **foe** – who or what the hero fights, escapes from, dodges or races against, if the sentence has one.
- **item** – the thing the hero catches, collects, stacks, delivers, protects or uses, if the sentence has one.

Each sentence needs a hero **and** at least one of foe or item. Mix the kinds of play freely: catching, dodging, chasing, escaping, defending, racing, collecting, fighting one-on-one, stacking, jumping, flying, swimming, sneaking, delivering, timing.

**Two groups of 60:**

1. **sentences 1–60, `group: "common"`** – hero and foe/item are everyday things a casual phone game would very likely already show: common pets and farm animals, ordinary people and jobs, cars, balls, fruit, coins, robots, ghosts, zombies and the like.
2. **sentences 61–120, `group: "unusual"`** – the hero or the foe (at least one of them, ideally both) is an animal, creature or character a casual phone game would rarely have a 3D model for: rare or exotic animals, creatures from folklore and myth around the world, very specific jobs or character types, unusual machines. Every one of the 60 must use a different unusual hero or foe – do not repeat one.

Do not reuse the same hero more than twice across all 120.

## How to label

- `hero`, `foe`, `item`: the noun exactly as the sentence names the thing, singular, lowercase, one to three words ("fire ant", "snow plow"), without articles or adjectives that are not part of the name. `null` when the sentence has none (never for hero).
- `foe` and `item` may both be filled.
- `group`: `"common"` or `"unusual"` as above.

## Output

Reply only with the JSON the output schema asks for: `{ "sentences": [ { "text", "hero", "foe", "item", "group" }, … ] }`, 120 entries, in the order 1–120.
