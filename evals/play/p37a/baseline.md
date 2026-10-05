# P37A T2 – baseline: návrh ze slov, sloveso soudené z klipu

Naměřeno 2026-10-03 na `ea31005f` (zdroják hry beze změny od `9691e4d4`). Data: `baseline.json`, zapisuje ho `baseline.measure.ts`.

## Jak se měřilo

- **Sady:** `dev-150.json` (150 vět porotce, P37A T1) a `../p30/dev.json` (60 vět P30). Zapečetěná `test-200` zůstala zavřená.
- **Jen návrh ze slov, bez režiséra.** Server `next start` na portu 3371 s vypnutým režisérem, panoramaty, hlasem i sdíleným úložištěm; měření nic neplatilo.
- **Offline na HEAD** (`measureSentence` z `../p36/depth.ts` a řetěz věrnosti `offlineChain`): žánr, robot vyhraje, nečinný prohraje, hrdina a položky modelem nebo kostkou.
- **Klip:** `play-fidelity.mjs run --clip --draft-only --gpu` – hru hraje robot, 3 snímky v tiku 90, 120 a 150 (odstup 0,5 s simulace, hodiny krokované ručně). Robot hrál ve všech 210 klipech.
- **Soudce:** `play-fidelity.mjs judge --clip` – astra přes `codex exec` se třemi obrázky, jen vývojové měření (předplatné). Odpovídá na celý checklist věty; tady se z něj bere hlavně sloveso. Verdikt jednoho snímku se nepočítá (`judgeFrames.draft = 3`).
- Položka, kterou řetěz kreslí a soudce ji v klipu nepoznal, je `not-recognized`.

## Čísla

| sada | vět | sloveso poznané v klipu | hrdina modelem | položky modelem | položky kostkou | robot vyhraje | nečinný prohraje |
|---|---|---|---|---|---|---|---|
| dev-150 celkem | 150 | **5/150 (3 %)** | 59/104 (57 %) | 13/199 (7 %) | 20/199 (10 %) | 150/150 | 150/150 |
| – unknown-verb | 60 | 0/60 (0 %) | 35/60 (58 %) | 2/71 (3 %) | 10/71 (14 %) | 60/60 | 60/60 |
| – non-game | 40 | 0/40 (0 %) | 1/3 | 3/63 (5 %) | 1/63 (2 %) | 40/40 | 40/40 |
| – fantasy | 30 | 4/30 (13 %) | 18/30 (60 %) | 6/38 (16 %) | 6/38 (16 %) | 30/30 | 30/30 |
| – mix | 20 | 1/20 (5 %) | 5/11 (45 %) | 2/27 (7 %) | 3/27 (11 %) | 20/20 | 20/20 |
| P30 dev | 60 | 11/60 (18 %) | 32/35 (91 %) | 40/75 (53 %) | 7/75 (9 %) | 60/60 | 60/60 |

„Hrdina modelem“ se počítá jen u vět, jejichž checklist hrdinu jmenuje. Zbytek položek do 100 % chybí ve specu úplně (`not-in-spec`) – hra ukáže věc z prostředí, ne věc z věty.

**Žánr na dev-150:** `arena.collect` 98, `quest.spatial` 13, `quest.station` 12, `voyage.race` 9, `arena.fight` 4, `arena.escape` 3, `throw` 3, `rhythm` 2, `runner` 2, `timing.stack` 2, `platformer` 1, `shooter` 1. Věta bez slyšeného slovesa dnes nepadá na běžce, ale na sběr v aréně (`src/play/genre/classify.ts:191`, `unheard`).

**Co z toho plyne pro Goal:**
- Sloveso 3 % proti cíli ≥ 60 %. Je to hlavní mezera P37A.
- Robot vyhraje a nečinný prohraje 100 % už dnes (cíl ≥ 92 % / ≥ 95 %). Rodiny sloves to nesmí rozbít.
- Hrdina modelem 57 % proti cíli ≥ 90 %; P30 dev má 91 %, takže díra je ve slovech, která P30 dev nemá (krtek, námořník, origamista).

## 10 největších skupin ztrát

Seřazeno podle počtu postižených vět (dev-150 + P30 dev). Skupina = `why × role × žánr`.

| # | why | role | žánr | vět | příklady | příčina v kódu | úloha |
|---|---|---|---|---|---|---|---|
| 1 | not-in-spec | item | arena.collect | 99 | u01:scarf, u02:buttons, u03:soup pot, u05:chickens, u09:leaves | `src/play/draft/draft.ts:1162` – položka je `collectible` ze slovníku, jinak `defaultCollectible(setting)`; `src/play/draft/lexicon.ts:488` bere věc jen za collect/gather/hoard/find/pick up/grab/steal. „Knits a scarf“ tak sbírá věc z prostředí. | **T3/T4** – rodina určí, které podstatné jméno je položka; věty mimo hry **T5** |
| 2 | not-in-spec | verb | arena.collect | 83 | u01:knit, u02:sew, u03:stir, u05:lasso, u15:wash | `src/play/genre/classify.ts:191` – žádný režim sloveso neslyšel, věta dostane sběr v aréně a sloveso nemá ovládání ani mechaniku. | **T3/T4** |
| 3 | not-recognized | setting | arena.collect | 40 | u08:farm, u13:apartment, u15:river, u26:haunted mansion, u28:bedroom | Aréna ukáže prostředí jen sadou kulis (`src/play/fidelity/chain.ts:235`); soudce v klipu farmu, byt ani řeku nepoznal. | – vykreslení prostředí je mimo A (P37B, kulisy P37D) |
| 4 | not-recognized | verb | arena.collect | 27 | u08:dig, u09:rake, u12:mop, u13:vacuum, u14:scrub | Sloveso je ve specu jen jako sběr; v klipu je chůze a sbírání, ne činnost. Soudce: „Movement shows no clear excavation, digging motion, or new holes.“ | **T3/T4** (`heroAction` + mechanika rodiny), animace P37B |
| 5 | not-recognized | hero | arena.collect | 24 | u01:grandma cat, u03:penguin, u05:cowboy, u36:hamster, f04:troll | Hrdina má model, ale v záběru arény je malý a tmavý. Soudce: „Small dark figure lacks clearly recognizable penguin features.“ | – záběr a vykreslení hrdiny je mimo A (P37B) |
| 6 | not-in-spec | setting | arena.collect | 20 | u01:fireplace, u12:ice rink, u14:pirate ship, n03:meeting room, n27:funeral | Slovník rolí místo nenašel a `src/play/draft/draft.ts:1150` dosadí prostředí slovesa nebo žánru. | – mimo P37A; kandidát na navazující úlohu |
| 7 | no-model | hero | arena.collect | 14 | u08:mole, u14:sailor, u17:origami master, u21:lumberjack, u43:baker | Popisek hrdiny nemá model v katalogu (`src/play/arcade/models.ts:188`), hra ukáže tvar. | **T6** – nejbližší model; chybějící modely P37D |
| 8 | not-read-by-control | setting | arena.collect | 14 | u03:iceberg, u05:ranch, u17:temple, u36:museum hall, n02:bed | Místo ve specu je, ale pro něj neexistuje sada kulis (`lookFor` = null, `src/play/fidelity/chain.ts:235`); aréna ho tedy neukáže. | – mimo A (sady kulis P37D) |
| 9 | not-recognized | setting | quest.station | 12 | u04:bakery, u24:junkyard garage, u27:post office, u40:snowy village, s069:cave | Jako #3, u stanice. | – mimo A |
| 10 | not-recognized | verb | quest.spatial / quest.station | 12 + 12 | u06:water, u07:plant, u10:mow, u18:paint; u04:bake, u24:repair, u29:feed, u52:brew | Úkol v prostoru a stanice sloveso hrají (jdi k místu, nes na stanici), ale v klipu je jen chůze. Soudce: „Movement shows no pouring, spraying, or watering plants.“ | **T3/T4** – rodiny pro zalévání, sázení, vaření; `heroAction`, animace P37B |

Další v pořadí: `no-model|item|quest.station` 11 (u04:bread, u29:hippos, u60:ball of yarn → **T6**), `not-in-spec|item|quest.spatial` 11 a `not-in-spec|item|voyage.race` 11 (podstatná jména věty nedostanou roli → **T3/T4**).

**Shrnutí příčin:** #1, #2, #4 a #10 jsou jedna věc – neznámé sloveso nemá rodinu, takže hra je obecný sběr a podstatná jména věty se do ní nedostanou. To je 83–99 vět z 210 a řeší je T3/T4. Prostředí (#3, #6, #8, #9) a velikost hrdiny (#5) jsou mimo stopu A.

## Věty mimo hry – rozhodnutí

**Naměřeno (40 vět `non-game`):** 37 hraje sběr v aréně, 2 závod, 1 útěk. Sloveso poznané 0/40. Ze 63 položek z věty jsou ve hře modelem 3; 59 ve specu vůbec není. **U 36 ze 40 vět není ve hře žádný hrdina ani věc z věty** – hráč dostane obecný sběr v aréně, který s „file my expense report“ nemá nic společného. Hratelné jsou všechny (robot vyhraje 40/40, nečinný prohraje 40/40).

**Rozhodnutí: „absurdní přenos“ (T5).** Věta mimo hry dostane hratelný žánr podle nálady a podstatná jména věty se stanou hrdinou, položkami a soupeři: „file my expense report with a pile of crumpled receipts“ → sbírej účtenky, vyhýbej se termínům. Cíl řekne HUD větou z věty („Collect the receipts!“, „Dodge the deadlines!“) z uzavřeného anglického vzoru.

**Pořadí:** napřed rodina slovesa (T3/T4) – „fold a mountain of clean towels“ má sloveso, které rodinu dostane. Absurdní přenos jen u vět, kde po T4 sloveso rodinu nemá.

**Proč ne jinak:**
- **Odmítnout větu nebo chtít jinou** – porota zkouší vlastní věty (RULES.md §3.3), prázdná odpověď je prohra.
- **Nechat obecný sběr z prostředí** – to je dnešní stav: 36/40 vět bez jediné věci z věty.

**Měřítko T5:** hrdina nebo položka z věty ve hře ≥ 80 % (dnes 4/40 = 10 %), žádná chyba ani prázdná scéna 40/40.

## Znovu spustit

Server: `npm run build`, pak `node node_modules/next/dist/bin/next start -p 3371 -H 127.0.0.1` s prázdnými `KV_REST_API_URL`, `KV_REST_API_TOKEN`, `WORLDSMITH_SPEND_STORE_URL`, `WORLDSMITH_SPEND_STORE_TOKEN`, `WORLDSMITH_MODEL_ENDPOINT`, `WORLDSMITH_FALLBACK_ENDPOINT`, `PLAY_ENV_ENDPOINT`, `PLAY_ENV_KEY`, `PLAY_VOICE_ENDPOINT`, s `WORLDSMITH_BRANCH=offline` a `PLAY_PUBLISH_DAILY_CAP=5000` (Next proměnnou, která v prostředí už je, nepřepíše ani prázdnou).

```
node --experimental-strip-types scripts/play-fidelity.mjs run --set ../p37a/dev-150.json --run p37a-t2-dev150 --clip --draft-only --gpu --base http://127.0.0.1:3371
node --experimental-strip-types scripts/play-fidelity.mjs run --set dev --run p37a-t2-p30dev --clip --draft-only --gpu --base http://127.0.0.1:3371
node --experimental-strip-types scripts/play-fidelity.mjs judge --run <run> --clip [--only id,id]   # 3–5 procesů paralelně, doběh přeskočí hotové
npx vitest run --config vitest.measure.mts evals/play/p37a/baseline.measure.ts
```

Složky běhů (`../fidelity/runs/`) jsou gitignorované; verdikty soudce nese `baseline.json`.
