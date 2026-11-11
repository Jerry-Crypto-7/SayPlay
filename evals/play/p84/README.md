# P84 – three sentence shapes the fast version misread

Narrow fixes to how the keyword reader reads a sentence and which existing game type it routes to. No new game type, no new mechanic, no scene change. Each fix is built on the shape of the sentence and pinned by one test in `__tests__/` that is red without it, over the sentence and three variants (another animal, another thing, another number).

## T1 – "a place where tapping a thing makes it do something" (`tap-place.test.ts`)

- **Shape:** `<place> where tapping/clicking a <thing> makes it <verb>` – e.g. an aquarium where tapping a fish makes it swim.
- **Before:** the hero was the clause fragment `aquarium where`, the game was a swim race against a shark the sentence never names; `a pond where tapping a frog makes it jump` was a platformer.
- **Now:** the tap-to-explore scene (`orrery`) with the sentence's things as the tap targets and the place from the sentence; no opponent. What the scene cannot do (swimming, jumping) is admitted on the strip ("… isn't here yet").
- **Where:** the subject reader (`sentenceNouns` in `src/play/draft/draft.ts`) no longer takes "garden where" as a two-word subject; one more shape of the explore sign in `src/play/genre/classify.ts`; `fish`, `sheep`, `deer` keep their plural in game text.

## T2 – "X blocks / stops / catches Y thrown by Z" (`defender-roles.test.ts`)

- **Shape:** `<X> blocks|stops|catches|saves|deflects <things> thrown|shot|fired|kicked by <Z>`.
- **Before:** the penguin goalkeeper threw snowballs at "every goalkeeper"; the other variants were a collecting or throwing game with no opponent.
- **Now:** the player is X, the opponent is Z, and the game is **Catch** (`catch`): the thing Z throws comes at the player, who moves under it and catches it; Z drops in as the thing to dodge.
- **Why Catch:** of the existing types it is the only one where things fly at the player and the player stops them. Throwing makes the player the thrower (the misread itself); the arena chase and the runner are about avoiding, not stopping; tower defense needs a wave marching on a place. Catch has exactly two roles – what is caught and what is dodged – and the sentence gives both.
- **Where:** the shape lives once in `src/play/draft/lexicon.ts` (`THROWN_BY`, `DEFENDS`) and is read by the classifier, the Catch module (which thing is caught, who throws) and the intent reader: a throw after "by" is the thrower's action, not one the player misses, and "goalkeeper" in "a goalkeeper penguin" is the player's role, not a rival.
- `A knight dodges arrows fired by archers` stays the runner it was.

## 200-sentence set (`../p30/test-200.json`)

Hero, place and game type of every sentence, keyword reader, before and after each fix.

| Fix | Readings changed |
|---|---|
| T1 | 0 |
| T2 | 0 |
