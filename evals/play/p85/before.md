# P85A – 20 jury sentences before the fixes (11. 11. 2026)

Reading: `read.ts` – the same path as `/api/play/games` without the model reader (chain or single game, `draftGameSpecWithMeta`, the strip from `honestyForSpec`). Expected readings: `prompts.json`, written before the run.

## Reading

| # | Hero | Against | Game type | HUD goal | Strip | Verdict |
|---|---|---|---|---|---|---|
| s01 | cat | traffic barrier | platformer | Collect 5 fish and reach the flag. | The rooftops aren't here yet – it's a city. | fits – a cat jumping for fish; the barrier is the platformer's own obstacle |
| s02 | mouse | wall | collect_exit (maze) | Collect the cheese and reach the exit. | Running isn't here yet – here's a maze game. | partly – right game, but the strip reads "timer runs out" as running |
| s03 | spaceship | alien ship | shooter | Stop 6 waves of 3 alien ships. Each wave is faster. | The obstacles aren't here yet – here's a shooting game. | partly – "three alien ships" became 6 waves of 3; the place is "spaceship" (the hero) |
| s04 | farmer | bee | quest | Use all 5 stars, 3 rounds. | Planting isn't here yet – here's a quest. | no – the seeds became stars and "plant" became "use"; bee and place "farmer" are not in the sentence |
| s05 | turtle | log, rabbit | hazard_crossing (race) | Beat the rabbit to the finish. | – | fits |
| s06 | wizard | skeleton | defense | Hold the tower! Stop every skeleton. | – | fits |
| s07 | chef | bomb | catch | Catch 30 ingredients. Dodge the bombs! | – | partly – catching ingredients fits; the bombs and the place "pot" are not the sentence's |
| s08 | robot | – | arena collect | Collect 8 gears per wave, 3 waves. | Pushing isn't here yet – here's a collecting game. | no – no boxes and no "four"; pushing onto tiles is a mechanic the game does not have |
| s09 | bee | – | arena collect | Collect 10 flowers! | Visiting isn't here yet – here's a collecting game. | fits – ten flowers; returning to the hive is admitted |
| s10 | pirate | rock, crab | runner | Reach the treasure chest. Jump, slide and switch lanes. | Digging isn't here yet – here's an endless runner. | partly – crabs and a chest, but one chest instead of three and a runner instead of digging around an island |
| s11 | farmer | – | throw | Hit every block in 87 seconds. | – | partly – a throwing game in a haunted house, but blocks instead of pins and a farmer nobody asked for |
| s12 | kid | missed beat | rhythm | Tap each lane as its note hits the line. The song gets busier. | – | fits – a piano is a rhythm game; keys lighting up is how the lanes look |
| s13 | dog | – | arena collect | Collect 8 sheep per wave, 3 waves. | Herding isn't here yet – here's a collecting game. | partly – sheep, but 8 × 3 instead of six; the pen is the place |
| s14 | submarine | shark | hazard_crossing (glide) | Pass every ring and reach the finish. | Free movement and photographing aren't here yet – here's a swimming or flying game. | no – no sea creatures and no "five"; a shark the sentence does not have |
| s15 | kid | – | ball | Score in every hoop. | – | fits – basketball with hoops against a clock |
| s16 | kid | – | quest | Make all 2 shows hows, 10 rounds. | – | no – broken text: "shows how" read as the thing and "make" as the verb |
| s17 | ninja | wall, guard | collect_exit (maze) | Collect the scroll and reach the exit. | – | fits |
| s18 | train | rock | hazard_crossing (race) | Reach the finish line. | – | partly – a train on a track, but no passengers and no "four stations" |
| s19 | knight | win | quest | Use all 3 coins. | – | no – "wins" became the opponent, coins nobody said; a joust is no quest |
| s20 | fox | bee | arena escape | Survive 40 seconds. | Ignoring isn't here yet – here's a chase game. | no – no duck; the strip quotes the instruction back ("Ignoring") |

Fits 7, partly 7, no 6. No sentence was a chain of microgames; nothing printed instructions or a prompt.

## Browser – the clumsy player (`clumsy.ts`)

One sentence per game type, 3 runs each against `next start` on :3218. The clumsy player plays what the verifier's robot would press, 400 ms later than the robot, and spoils every fifth new input (keeps the old direction, drops the press); the runs differ in which input is spoiled first. Won = the run ended in a win within 45 s and the result card says `won`. Robot = `playWitness()` on the same game.

| # | Type | Clumsy, 3 runs | Robot | Console errors |
|---|---|---|---|---|
| s01 | platformer | 0/3 – still running at 45 s, 0 fish | won, 52.2 s | 0 |
| s03 | shooter | 0/3 – still running at 45 s | won, 56.2 s | 0 |
| s05 | hazard_crossing (race) | 0/3 – lost at 12–13 s | won, 32.8 s | 0 |
| s06 | defense | 0/3 – lost at 38.4 s, 16 stopped | won, 47.9 s | 0 |
| s07 | catch | 0/3 – lost at 20 s, 8–9 caught | won, 38.2 s | 0 |
| s09 | arena collect | 3/3 – won at 40–41.5 s | won, 41.7 s | 1 – a 429 on a resource after three quick reloads (rate limit of the local server, not the game) |
| s10 | runner | 0/3 – lost at 31 s | won, 56.9 s | 0 |
| s17 | collect_exit (maze) | 0/3 – still running at 45 s, 21 m of 52 m | won, 34.9 s | 0 |

Not run in the browser (the cap is 8): quest, throw, rhythm, ball. The shooter probe plays without aiming (the probe sends only the axis and the buttons), so its 0/3 says little about a human with a mouse.

Four types do not end within 45 s even for the robot (platformer, shooter, defense, runner): their first round is longer than a juror's first attempt.

## Classes (same cause = one class)

| Class | Sentences | Cause |
|---|---|---|
| A. A place where tapping a thing does something, without "makes it" | s16 (broken text), s12 | The tap-to-explore shape (P84 T1) needs "… makes it <verb>"; "clicking a building shows …" and "pressing a key plays …" fall through to other types – s16 to a quest built from the words "shows how" |
| B. An instruction to the AI before the game | s20 | The instruction's verb ("ignore") becomes the game's verb and the strip quotes it; "a game about a duck" has no subject, so the hero falls back to the fox |
| C. A quest whose verb the classifier does not carry | s04, s19 | The quest is chosen but the classifier's verb is empty, so the target falls back to "use / star" (s04) or to a coin and a rival "win" (s19) |
| D. A count on a plural without -s | s13 | `readCountedNouns` only reads plurals ending in -s: "six sheep" is lost, the arena's 8 per wave stays |
| E. The hero taken as the place | s03, s04 | The place reader takes the subject ("spaceship", "farmer") when the sentence names no place |
| F. Counted things the game type cannot count | s08, s10, s14, s18 | Pushing boxes onto tiles, digging three chests, photographing five creatures, four stations – each would need a mechanic or a type the reading does not have |
| G. "time runs out" read as running | s02 | The strip's verb reader takes "runs out" as running |
| H. Opponent or hero from the type's defaults | s07 (bomb), s11 (farmer), s14 (shark) | The type fills a role the sentence leaves empty |
| I. First round longer than 45 s for a clumsy player | s01, s03, s05, s06, s07, s10, s17 | See the browser table |
