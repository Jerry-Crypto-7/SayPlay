# P37A T3 – rodiny sloves

Rodina = slovesa se stejnou hratelnou podstatou. Každá hraje **existující žánr** s parametry a nese `heroAction` (co hrdina viditelně dělá; vykreslení dělá P37B). Nové žánry ne. Kód: `src/play/genre/families.ts`, sloveso z věty `src/play/genre/classify.ts` (`VERBS`).

## Odkud jsou rodiny

Neznámá slovesa z `dev-150.json` (150 vět porotce), `../demand/corpus.json` (poptávka) a `../fidelity/corpus.json` (korpus P26), shluknutá ručně podle toho, **co by hráč dělal rukama**. Počty vět jsou regex nad textem věty (`D:/caches/p37a/fam-count.cjs`), ručně očištěné o falešné shody (`crush` je boj, `grind` je skejt).

## Tabulka

| # | rodina | slovesa | žánr a režim | parametry | `heroAction` | věty dev-150 / demand / korpus | stav |
|---|---|---|---|---|---|---|---|
| 1 | úklid | scrub, polish, mop, vacuum, wash, tidy, rake, sweep, wipe, shovel, clean up/out | `arena.collect` | předmět slovesa = sbíraná věc („crumbs“, „leaves“, „dishes“), pod časem | `sweep` | 15 / 1 / 0 | **zapojeno T3** |
| 2 | vaření | cook, bake, grill, brew, flip pancakes, stir, whisk, knead, frost, simmer, fry, roast, pour, meal prep | `quest.station` | předmět = cíl stanice („soup“, „cake“, „potion“) | `stir` | 10 / 4 / 0 | **zapojeno T3** |
| 3 | sekání | chop, carve, sculpt, whittle, shear, gnaw, mine | `quest.spatial` | předmět = cíle v prostoru, ke každému dojít („logs“, „pumpkins“, „sheep“) | `chop` | 8 / 4 / 2 | **zapojeno T3** |
| 4 | řemeslo | knit, sew, stitch, crochet, weave, iron, fold, wrap | `rhythm` | ťuk v rytmu = steh | `knit` | 9 / 1 / 0 | **zapojeno T4** |
| 5 | zahrada | water; plant, dig, burrow, bury | `quest.spatial` | záhony jako cíle | `water`; `dig` (sázet, kopat) | 5 / 5 / 0 | **zapojeno T4** |
| 6 | opravy | repair/fix/mend (dřív samostatné sloveso), hammer, weld, patch, change a tire | `quest.station` | rozbitá věc jako stanice | `fix` | 3 / 5 / 2 | **zapojeno T4** |
| 7 | malování | paint, spray-paint, graffiti | `quest.spatial` | plochy jako cíle | `paint` | 4 / 4 / 0 | **zapojeno T4** (decorate zůstává obecnou stanicí `make`) |
| 8 | péče | groom, bandage, bathe, nurse | `quest.station` | donést věc k tvorovi | `carry` | 4 / 2 / 0 | **zapojeno T4** (feed, heal zůstávají v `make`) |
| 9 | stříkání | spray, squirt, hose at | `shooter` | cíle = vosy, skvrny; krátký dosah parametr nemá (render je P37B) | `spray` | 3 / 0 / 0 | **zapojeno T4** (hašení ohně dál `extinguish` → `quest.spatial`) |
| 10 | pastevectví | herd, lasso, lure, round up, wrangle | `arena.collect` | zvířata jako sbírané věci | `throw` | 3 / 0 / 0 | **zapojeno T4** |
| 11 | vystoupení | juggle, whistle, conduct, drum, present | `rhythm` | ťuk v rytmu | `throw` (juggle), jinak `none` | 4 / 1 / 1 | **zapojeno T4** |
| 12 | papíry | file, sign, renew, pay, write, do homework/taxes, answer emails, help with homework | `timing.stack` | list po listu na stoh | `stack` | 7 / – / – (mimo hry) | **zapojeno T4** |
| – | pohyb | skate, grind rails → `runner`; paddle, row, canoe → `sail`; gallop, trot → `ride`; rise → `flap` | známý žánr | – | – | 11 / 4 / 1 | **zapojeno T4** jako slovesa známých žánrů |
| – | další slovesa známých žánrů | save, unpack, wake, freeze, raise/summon (`quest.spatial`); crush, stomp, guard (`arena.fight`); play chess, argue, negotiate, convince, say no, break up (`duel`); park (`voyage.land`); hide, sneak, ignore, refuse, wait, fall asleep (`arena.escape`); hoard, pick herbs, drag (sběr); make coffee/potions, transform (vaření) | známý žánr | – | – | – | **zapojeno T4** |
| – | mimo hry bez herního slovesa | talk, call, explain, apologize, remember, grieve, choose, věty jen z podstatných jmen | podle nálady věty | podstatná jména věty → hrdina, položky, soupeři | – | 19 vět dev-150 | T5 (absurdní přenos) |

Pořadí T3 = tři rodiny s nejvíc větami v dev-150, kde sloveso dnes padalo na sběr v aréně bez věci z věty.

## Měření T3 (4. 10. 2026)

29 vět tří rodin z dev-150 (úklid 13, vaření 8, sekání 8). Návrh ze slov bez režiséra, server `next start` na 3371 bez placených služeb, klip 3 snímky po 30 tikách hraný robotem (`play-fidelity.mjs run --clip --draft-only --gpu`, běh `p37a-t3-families`, gitignorovaný), soudce astra nad klipem (`judge --clip`). **Soudce je od `b4475a4f` slepý:** běží v prázdném dočasném adresáři se snímky `frame-N.png`, spec hry ani jméno věty nevidí (nález P37D).

| | úklid | vaření | sekání | celkem | cíl |
|---|---|---|---|---|---|
| žánr a režim podle rodiny (živě) | 13/13 | 8/8 | 8/8 | **29/29** | ≥ 90 % |
| `heroAction` vyplněný | 13/13 `sweep` | 8/8 `stir` | 8/8 `chop` | **29/29** | všechny |
| robot hrál a vyhrál / nečinný prohraje (offline, `families.test.ts`) | ano | ano | ano | **ano** | ano |
| sloveso poznané v klipu | 0/13 | 1/8 | 0/8 | **1/29 (3 %)** | ≥ 50 % – **NESPLNĚNO** |
| baseline T2 na týchž větách | 0/13 | 0/8 | 0/8 | 0/29 | – |

Uložené hry dávají týž hash (fixtury `src/play/__fixtures__`, `src/play/arcade/__fixtures__`); mutant „rodina vypnutá“ test `families.test.ts` shodí.

### Proč sloveso není vidět (příčina, ne odhad – ze zdůvodnění soudce)

- **Všech 28 ztrát má stejné zdůvodnění:** „character moves / changes position, no chopping (scrubbing, raking…) motion or tool visible“. Hra se hraje správně, ale z pohybu hry je vidět jen *dojdi k věci a věc zmizí*.
- **Věc slovesa je kostka.** U21 („a lumberjack chops logs“): klády jsou modré kostky se žlutým kroužkem, medvěd je model. Bez modelu klády, dřezu, listí nebo hrnce se činnost nemá na čem ukázat → **T6** (nejbližší model z katalogu místo kostky).
- **Hrdina nic nedrží a nic nedělá.** `heroAction` je ve specu u všech 29 her, ale vykreslení činnosti (koště, sekera, míchání) je **P37B** – render (`src/components/play/arcade/**`) stopa A nemění.
- **Jediný zásah (f14, „an ogre chef cooks soup“)** viděl, jak jídlo v pánvích hnědne – stanice vaření ukazuje změnu stavu sama. Ostatní věty vaření soudce četl jako „frying“, ne pečení, míchání ani nalévání: stanice kreslí pánve pro polévku, dort i lektvar.

**Závěr:** zapojení rodin (žánr, parametry, `heroAction`, robot, hash) je hotové a změřené; poznatelnost slovesa z klipu se z návrhu hry sama nezvedne. Přeměřit tutéž sadu (`--run p37a-t3-families`, 29 vět) po T6 (modely věcí) a po sloučení P37B (animace činnosti), v T10 na celé dev-150.

## Měření T4 (4. 10. 2026)

Offline na celé dev-150, návrh ze slov bez čtení modelem. Hlídají ho `src/play/genre/__tests__/verb-coverage.test.ts` a `families.test.ts`.

| | před T3 (baseline) | po T4 | cíl |
|---|---|---|---|
| hlavní sloveso patří rodině nebo známému žánru | 60/150 (40 %) | **131/150 (87 %)** | ≥ 85 % |
| věta padne na náhradu (sběr v Aréně bez slovesa) | 90 | **19**, všechny bez herního slovesa | jen věty bez slovesa |
| `arena.collect` celkem | 98 | 43 | – |
| robot vyhraje (`evals/play/p36` metoda hloubky) | 150/150 | **150/150** | ≥ 92 % |
| nečinný hráč prohraje | 150/150 | **150/150** | ≥ 95 % |

- **Žánry po T4:** `arena.collect` 43, `quest.spatial` 26, `quest.station` 24, `rhythm` 12, `voyage.race` 8, `timing.stack` 7, `arena.escape` 7, `duel` 6, `arena.fight` 5, `runner` 3, `throw` 3, `shooter` 2, `platformer` 2, `voyage.land` 1, `flap` 1.
- **Žádná dřív slyšená věta nezměnila sloveso.** Uložené hry dávají týž hash (fixtury `src/play/**/__fixtures__`), zlatá sada 40 vět i pokrytí poptávky (`evals/play/rules/coverage.json`) beze změny verdiktu.
- **Rozhodnutí – „věta bez slovesa“ čtu jako „bez herního slovesa“.** Rozhovor bez protivníka („explain quantum physics to my grandma“, „call grandma“, „apologize to my neighbor“) zůstává na náhradě: souboj s babičkou by hráč nepoznal a tutéž větu jako vzor věty mimo hry pinují `draft-unsupported.test.ts` a `draft-nearest.test.ts`. Spor s protějškem (argue, negotiate, convince, say no, break up) hraje `duel`. Obojí doladí T5 podle nálady věty.
- **Vzory jen pro tvar slovesa.** Podstatná jména chycená prvním návrhem a teď vyloučená testem: „its burrow“, „sea spray“, „oil drums“, „a fishing lure“, „a washing machine“ (to chytal už `wash` z T3 a měnil jednu větu poptávky z plošinovky na sběr).
