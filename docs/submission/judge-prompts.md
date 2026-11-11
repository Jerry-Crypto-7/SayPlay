# Sentences to try – what Sayplay makes and what to expect

- **What a sentence becomes:** a short 3D game with a hero, a place, an opponent, a thing to catch or collect and how many, played as one of 30 game types from a closed registry (runner, catch, duel, a tap-to-explore scene, a shop counter, mini golf…).
- **What it does not make:** long stories, a chain of causes played out step by step (a marble knocks a domino that pulls a string that rings a bell), or the exact physics of a machine (an engine, a gearbox).
- **When the sentence asks for something it cannot do,** it still makes the nearest game and the start card says what was swapped, for example "Packing isn't here yet – here's a collecting game."
- **First the quick version,** built from the words without a model: a median 1.8 s from a new sentence to a playable game on the deployed demo ([ai.json](../../evals/play/p74/ai.json)). The AI version comes later as a new game linked to it, when the AI director answers.
- **Every game below passed the publish check** (a robot wins it, an idle player does not, two replays end in the same state) in a Node run of the sentence reader on 11 November 2026, without a browser, a model or keys ([prompts-check.json](../../evals/play/p85b/prompts-check.json)).

## Twelve sentences inside the scope

"Start card" is the line on the card before the game starts, exactly as the reader produced it. "Left for the AI version" is what the sentence asks for and the quick version does not show.

| # | Sentence | Start card | How to tell it fits | Left for the AI version |
|---|---|---|---|---|
| 1 | `A goalkeeper penguin blocks snowballs thrown by a polar bear until the whistle blows` | You: goalkeeper penguin · Against: polar bear · Place: polar · Played as: lanes | You are the penguin; snowballs fall in five lanes and you move under them to catch them; goal "Catch 30 snowballs. Dodge the polar bears!" | The whistle that ends the game; the card says "Blowing isn't here yet – here's a lane game." |
| 2 | `An aquarium where tapping a fish makes it swim to the surface and blow a bubble` | You: tourist · Place: aquarium · Played as: orrery | A tap-to-explore aquarium with the fish as the things you tap; goal "Tap the fish!" | The fish swimming up and the bubble; the card says "Gliding isn't here yet – here's a tap-to-explore scene." |
| 3 | `A bakery where I pack twelve cupcakes into boxes of four and it shows how many boxes are full` | You: baker · Place: bakery · Played as: arena | Cupcakes in the bakery and a count to 12; goal "Collect 12 cupcakes." | Boxes of four and the count of full boxes; the card says "Packing isn't here yet – here's a collecting game." |
| 4 | `A knight collects three keys in a castle` | You: knight · Place: castle · Played as: arena | Keys in a castle and a count to 3; goal "Collect 3 keys." | Nothing the card leaves out |
| 5 | `a solar system where clicking a planet shows its name and makes it orbit faster` | You: astronaut · Place: planet · Played as: orrery | Tap a planet to see its name; goal "Tap the sun, mercury and venus!" | Orbiting faster: a second tap makes a planet glow, spin or grow instead |
| 6 | `A small shop where I pick up three items and put them on the counter to see the total price` | You: customer · Place: small shop · Played as: shop | A shop counter with a running total and 3 items; goal "Put 3 teddy bears on the counter!" | Which items: the sentence does not say, so the quick version picks teddy bears; the card still says "Collecting isn't here yet – here's a shop counter with a running total." |
| 7 | `A fox gathers glowing berries in a snowy forest while owls swoop down` | You: fox · Place: snowy forest · Played as: arena | Glowing berries in a snowy forest, in 3 waves; goal "Collect 8 glowing berries per wave, 3 waves." | The owls as the opponent; the card does not list them |
| 8 | `Mini golf on a pirate ship deck` | You: ship · Place: pirate ship deck · Played as: minigolf | A mini golf hole on a pirate deck; goal "Sink the ball in as few strokes as you can!" | A golfer as the hero; the quick version names the ship |
| 9 | `an elf archer defends the forest gate from orcs` | You: elf archer · Against: orc · Place: forest · Played as: lanes | Orcs march down five lanes towards your wall and you tap a lane to shoot; goal "Hold the forest gate! Stop every orc." | Nothing the card leaves out |
| 10 | `a turtle dodges falling coconuts on a tropical beach` | You: turtle · Against: rock, coconut · Place: tropical beach · Played as: runner | A runner on a beach with coconuts in the way; goal "Dodge the coconut. Reach the finish line. Jump, slide and switch lanes." | The rocks are the game's own obstacle; the sentence names only coconuts |
| 11 | `a boxer fights a robot in an underground ring` | You: boxer · Against: robot · Place: underground · Played as: duel | A duel against the robot; goal "Dodge the wind-up, strike in the opening. Beat 9 robots." | The ring itself; the quick version reads only "underground" |
| 12 | `a paper airplane glides through an office without hitting the ceiling fans` | You: paper airplane · Against: ceiling fan · Place: office · Played as: glide | Gliding through rings in an office past the fans; goal "Pass every ring and reach the finish." | Nothing the card leaves out |

Sentences 1–3 are the three sentence shapes the reader fixed on 11 November ([what changed](../../evals/play/p84/README.md)); 4–8 cover counted collecting, the tap scene, the shop counter and mini golf; 9–12 come from the held-out set of 200 sentences (`evals/play/p30/test-200.json`, ids t102, t144, t145, t140).

## Three sentences outside the scope

| Sentence | What happens |
|---|---|
| `Write a long story about a dragon who learns to forgive his brother over many years` | No story. It becomes a stacking timing game, "You: brother · Played as: timing", goal "Stack the long stories!", and the card says "Writing isn't here yet – here's a timing game." |
| `A marble rolls down a ramp, knocks over ten dominoes, the last domino pulls a string and the string rings a bell` | No chain of causes. It becomes a ball game with the marble as the hero on a ramp, goal "Rescue the string. Score in every goal.", and the card says "The pulling domino and ringing aren't here yet – here's a ball game." |
| `Simulate a car engine with pistons, a crankshaft and a gearbox that shifts at the right revs` | No engine physics. It becomes a race with the car as the hero, goal "Reach the finish line.", and the card says "Simulating isn't here yet – here's a driving game." The place is read wrongly as "right revs". |

## Asking the same sentence twice

The same sentence gives the same game: the seeds come from the sentence, and a game's id is a hash of its spec and world ([contracts.ts](../../src/play/contracts.ts)), so the second request opens the same game. In the Node run above every one of the 15 sentences gave the same spec and world twice (`"sameTwice": true`). An AI version, once accepted, is cached by sentence for seven days ([answer-cache.ts](../../src/server/answer-cache.ts)): the same sentence gets the same AI version without a new model call. If the AI version does not come at all, the page says "The quick version is the one to play." and the quick game stays playable. The AI version was last verified end to end on 24 October (12/12 published, [director.json](../../evals/play/p58b/director.json)).

Check the readings yourself, without keys: `node --experimental-strip-types --no-warnings --import ./scripts/ts-paths.mjs evals/play/p85b/prompts-check.ts --check` reads all 15 sentences again and reports any that differ from the saved file.
