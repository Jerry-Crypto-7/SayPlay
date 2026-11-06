# P71E – modely na telefonu (oracle T4, 5. 11. 2026)

Build po T1–T3 a T2a–T2c (HEAD c45b9ebb), `next start -p 3014`, telefon 390×844, snímek ve 3. s hry (`shots.mjs`).
Snímky: `oracle/`, před opravami `before/`, po T2/T3 `after/`, po jednotlivých opravách `t2a/`, `t2b/`, `t2c/`.

| Věta (id) | Žánr / ovládání | Model | Poznatelný na snímku | Chyby sítě | FPS A / B |
|---|---|---|---|---|---|
| a tiny bird flaps through pipes (flap) | flap | `gen3d-small-songbird` | ano – ptáček se zobákem a křídlem, olivový | 0 | 38 / 37 |
| a pirate ship sails across the stormy sea (voyage) | steer | `cc0-ship-large` | ano – loď zezadu, bílé plachty, hnědý trup; malá (kamera) | 0 | 27 / 25 |
| a dragon defends its castle from knights (defense) | defense / lanes | `gen3d-wyvern` | ano – zelená wyverna; rytíř světle šedý u světlé kamenné zdi (T2b) | 0 | 47 / 38 |
| a chicken crosses the busy road (hop) | hop | `cc0-chicken` | spíš ano – bílé kuře s červeným hřebínkem shora, napůl za autem | 0 | 59 / 57 |
| a wizard explores a dungeon to find the lost crown (quest) | arena / move_free | `mage` | **ne** – čaroděj mimo záběr u levé hrany (kamera, P71C); kvádr skrz něj zmizel (T3) | 0 | 46 / 47 |
| a shark hunts fish in the ocean (shark) | move_free | `cc0-shark` v2 | ve 3. s jen čumák u levé hrany (kamera, P71C); ve 12. s celý modrý žralok s ploutví a ocasem (`t2a/shark-12s.png`) | 0 | 55 / 54 |
| golf ball score (golf-ball) | minigolf | míček + jamka | ano – míček, jamka, dráha | 0 | 56 / 57 |
| a cat runs through the city (cat) | runner | kočka | ano – šedá kočka zezadu | 0 | 43 / 40 |
| a dog jumps over fences in the park (dog) | platformer | pes | spíš ano – oranžový pes zezadu, hranatý | 0 | 35 / 33 |
| a frog hops across the pond (frog) | platformer | žába | ano – zelená žába | 0 | 41 / 41 |
| a penguin slides across the ice (penguin) | runner | tučňák | ano – černý, oranžové nohy | 0 | 36 / 37 |
| a horse races across the farm (horse) | steer | kůň | ano – hnědý kůň, malý | 0 | 37 / 37 |

**FPS** (`oracle/fps-ab.json`): A = tato větev (3014), B = build `origin/main` c7037ab8 (`D:/claude/Hackaton-demo`, 3016),
Pixel 7, CPU 4×, 10 s ukázky, 3 opakování prokládaně A B / B A scénu po scéně, mediány. Poměr A/B 0,97–1,24, žádná scéna
pod šumem (±10 %) – modely P71E FPS nesnížily. Absolutně brána ≥ 55 drží jen hop, golf a žralok; stroj měl při měření
CPU ~78 % (souběžné autopiloty), takže absolutní čísla nic neříkají a stejně nízko je i `origin/main`.

## Co zbývá (fakta ze snímků)

- Čaroděj a žralok ve 3. s mimo záběr u levé hrany: kamera a scéna, patří P71C – tady se neopravuje.
- Ve voyage žraloka (nepřítele) ve 3., 6. ani 12. s nerozeznám, i když scéna jeho GLB stáhne.
- Výběr žánru „golf ball score“ je minigolf s míčkem a jamkou – pro P71D nic.
