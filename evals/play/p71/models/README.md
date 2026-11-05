# P71E – modely na telefonu (oracle T4, 5. 11. 2026)

Build po T1–T3 (HEAD 814a1de7), `next start -p 3014`, telefon 390×844, snímek ve 3. s hry, `shots.mjs --fps`.
Snímky: `oracle/`, před opravami `before/`, po T2/T3 `after/`.

| Věta (id) | Žánr / ovládání | Model | Poznatelný na snímku | Chyby sítě | FPS* |
|---|---|---|---|---|---|
| a tiny bird flaps through pipes (flap) | flap | `gen3d-small-songbird` | ano – žlutý ptáček | 0 | 22 |
| a pirate ship sails across the stormy sea (voyage) | steer | `gen3d-pirate-ship` | **ne** – zezadu černá skvrna; trup je tmavě hnědý už v náhledu modelu, bouřková sada ho ztmaví | 0 | 0 (měření selhalo) |
| a dragon defends its castle from knights (defense) | defense / lanes | `gen3d-wyvern` | drak ano – zelená wyverna; **rytíři ne** – černé siluety | 0 | 27 |
| a chicken crosses the busy road (hop) | hop | `cc0-chicken` | ano – bílé kuře s červeným hřebínkem | 0 | 33 |
| a wizard explores a dungeon to find the lost crown (quest) | arena / move_free | `mage` | **ne** – čaroděj stojí mimo záběr u levé hrany (kamera, P71C); kvádr skrz něj zmizel (T3) | 0 | 0 (měření selhalo) |
| a shark hunts fish in the ocean (shark) | move_free | `cc0-shark` | **ne** – u levé hrany a tmavě šedá kulatá příšerka | 0 | 40 |
| golf ball score (golf-ball) | minigolf | míček + jamka | ano – míček, jamka, dráha | 0 | 39 |
| a cat runs through the city (cat) | runner | kočka | ano – šedá kočka zezadu | 0 | 19 |
| a dog jumps over fences in the park (dog) | platformer | pes | spíš ano – oranžový pes zezadu, hranatý | 0 | 29 |
| a frog hops across the pond (frog) | platformer | žába | ano – zelená žába | 0 | 30 |
| a penguin slides across the ice (penguin) | runner | tučňák | ano – černobílý, oranžové nohy | 0 | 23 |
| a horse races across the farm (horse) | steer | kůň | ano – hnědý kůň, malý | 0 | 28 |

\* **FPS tu neplatí.** Měřeno při souběhu dalších tří autopilotů (CPU 63 %, ~90 procesů node, ~50 chrome); 0 = měření
nedoběhlo. Brána FPS ≥ 55 se musí změřit prokládaně A/B proti buildu `origin/main` (scénu po scéně, mediány), ne absolutně.

## Co zbývá (fakta ze snímků)

- Loď, žralok a rytíři zůstávají nepoznatelní → plán T2a (žralok), T2b (rytíři), T2c (loď).
- Čaroděj a žralok mimo záběr u levé hrany: kamera a scéna, patří P71C – tady se neopravuje.
- Výběr žánru „golf ball score“ je minigolf s míčkem a jamkou – pro P71D nic.
