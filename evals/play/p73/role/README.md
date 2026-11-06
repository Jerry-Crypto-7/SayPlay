# P73A T7 – oracle v prohlížeči

6. 11. 2026, `next start -p 3201` nad větví (T1–T6), `node --experimental-strip-types evals/play/p73/role/oracle.mjs`.
Pět vět soupeřů (p1–p5) a čtyři parafráze (`b`), desktop 1440×900 a telefon 390×844. Robot je `__playShell.playWitness()`.
Snímek `<id>-<desktop|phone>-mid.png` je uprostřed hry: stohování po 8 dílech robota, ostatní po 3 s živého běhu.
Surová data v `results.json`; **18/18 bez nálezu**, žádná chyba stránky.

| Věta | Hrdina (model) | Soupeř / díl (model) | Robot | Proužek náhrady |
|---|---|---|---|---|
| p1 A cat delivering pizzas across rooftops while avoiding seagulls | cat (pet-cat), rackové jako lovci | – | vyhrál 40,0 s | „The obstacles aren't here yet – here's a chase game. The rooftops aren't here yet – it's a city.“ |
| p1b a cat delivers pizzas across the rooftops and avoids the seagulls | cat (pet-cat) | – | vyhrál 40,0 s | totéž jako p1 |
| p2 A haunted library where books fly at you and you must find the exit | broom (gen3d-broom) | – | vyhrál 28,1 s | „Gliding isn't here yet – here's a swimming or flying game. The library isn't here yet – it's a spooky forest.“ |
| p2b escape a haunted library while books fly at you | broom (gen3d-broom) | – | vyhrál 15,2 s | totéž jako p2 |
| p3 An underwater race between a turtle and a shark | turtle (turtle) | shark (cc0-shark) | vyhrál 32,9 s | žádný – nic se nenahrazuje |
| p3b a turtle races a shark under the sea | turtle (turtle) | shark (cc0-shark) | vyhrál 33,5 s | žádný |
| p4 Balance a tower of pancakes on a windy day | knight (rigged knight) | pancake (cc0-pancake) | vyhrál 30,0 s | „Balancing isn't here yet – here's a timing game.“ |
| p4b stack pancakes as high as you can in the wind | explorer | pancake (cc0-pancake) | vyhrál 30,0 s | „Building, inning and the hazards aren't here yet – here's a timing game.“ (vada, R1) |
| p5 Escape a volcano before the lava reaches you | explorer (ne hranatý robot) | – | vyhrál 60,1 s | žádný – nic se nenahrazuje |

Desktop a telefon dávají stejné hry a stejné texty. Na snímcích je vidět: želva se žralokem na trati pod vodou (p3), věž
palačinek (p4, p4b), kočka s racky na náměstí (p1) a proužek nahoře u p1, p2 a p4. Na telefonu proužek končí výpustkou
(„Balancing isn't here yet – here's a timing g…“) – zobrazení dělá P73B.

**Co tu chybí:**
- Ve stohování hraje rytíř nebo průzkumník, ne postava z věty.
- p2 „Gliding isn't here yet“ a p4b „inning“ jsou vadné texty přiznání slovesa. Nejsou z T5, ta k přiznání jen přidává věty o náhradě. V plánu jsou zapsané jako R1.
