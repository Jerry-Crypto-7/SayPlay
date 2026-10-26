# P61 – kvalita rychlé hry a hry ze čtení

Plán: `plans/P61-kvalita-hry-2026-10-26.md` (gitignorovaný). Měřidlo: snímky her přes Playwright nad `next start`, slepý soudce nad listy s řádky označenými jen písmeny.

## Zapečetěná sada

`holdout.json` – 24 nových anglických vět (6 stříleček nebo bojovek s výrazným prostředím, 6 „sbírej N věcí“, 6 se 2–3 slovesy, 6 ostatních), napsaných 26. 10. 2026 před první změnou kódu P61. Žádná se neshoduje s `p30/*.json`, `p58b/holdout.json`, `p56c/*.json` ani další známou sadou (`__tests__/seal.test.ts`).

SHA-256 nad LF bajty: `e15ce81f8bb6b17c9411314419054ec8771ebbdb0fb8d30df96672b6ad3e4e0b` (`seal.ts`). Otevře se jednou v T8; nic se podle ní neladí. Snímky `main` na ní nafotí T1 do `D:/caches/p61/main-holdout/`, souzené nejsou – soudí se až v T8 na společných listech s větví.

## Měřidlo

- `shots.mjs serve` – spustí `next start` s placenou čtečkou (astra) jen pro AI verzi a režisérem bez dosažitelného modelu; klíč se čte z `.env.local` přes `node --env-file` a do logu ani repa nejde.
- `shots.mjs shoot` – věta → rychlá hra (upgrade cesta v prohlížeči zablokovaná, bez mezerníku) 3 snímky v 1, 3 a 5 s, pak hra ze čtení, pokud vznikne; desktop 1280 × 720 i Pixel 7 na výšku. `shots.json` s časy a id verzí leží vedle snímků v `D:/caches/p61/`.
- `shots.mjs spend` – útrata čtení z logu `usage-preload.mjs` (ceny 10 / 50 USD za Mtok).
- `judge.mjs` – na větu jeden list, řádky A/B/C…, pořadí `pure-rand` xoroshiro128plus + Fisher–Yates se seedem v JSON; soudce jen se `sheet.png` v prázdném `mkdtemp` (`ask()` z `scripts/p37d/judge-sheet.mjs`). „Po čtení“ = hra ze čtení, a když nevznikla, rychlá hra – to hráč hraje po příchodu čtení.

## Výchozí stav `main` na dev (T1, 26. 10.)

`main` = `5692b987`, dev věty `p30/dev.json` [0..11], desktop, soudce Claude Opus 5.5 (`claude -p --safe-mode`), seed 61026, dva běhy na týchž listech → `baseline-dev.json`.

| Strana | Věrnost | Hrál bych | Vět |
|---|---|---|---|
| rychlá hra | 0,375 (2. běh 0,35) | 0,325 | 12 |
| hra ze čtení (jen kde vznikla) | 0,55 (0,50) | 0,55 (0,50) | 3 |
| po čtení (hra ze čtení, jinak rychlá) | 0,45 | 0,35 | 12 |

Rozptyl soudce mezi dvěma běhy (15 dvojic věta × strana): medián rozdílu 0 / 0, největší 0,10 / 0,05.

Hra ze čtení vznikla jen u 3 z 12 vět (s002, s006, s022 – všechny tři řetězy); u 9 vět čtení proběhlo a zaplatilo se, ale hra nevznikla (stejný žánr). Největší ztráty podle důvodů soudce:
- **střílečka bez prostředí a nepřátel z věty**: s039 „zombie shooter in a mall“ 0,30 – terče v mlhavé aréně, `theme.look` žádný; s037 0,60 – brouci malí.
- **řetěz místo jedné hry**: s002 (rytíř a tři klíče) 0,15 – běžec s početními branami; s006 (corgi) 0,10 – přecházení silnic; s022 (robot na věži) 0,15 – chytání jablek.
- **prostředí nesedí**: s003 supermarket = zasněžené údolí, s008 chrám = farma, s021 láva = voda.
- **chybí cíl z věty**: s050 děti za sněhovou pevností, s088 věž z krabic, s069 match-3 mřížka.

Snímky `main` na zapečetěné sadě: 24/24 v `D:/caches/p61/main-holdout/`, nesouzené.

## T4 – řetěz a jedna hra

Zjištění: „knight … three keys … dodging ghosts“ nešel do řetězu přes `generic`, ale přes `multi_verb` – slovník čte collect (`move_free`) a dodging (`steer`), dvě ovládání; první buňka `arena.escape` 6 bodů s náskokem 5. Samotné zúžení `generic` by ho nechalo řetězem.

- `decide.ts`: `generic` jen pro neslyšenou větu (první buňka 0 bodů, nebo čtení bez hratelného slovesa); práh `GENERIC_MARGIN` zrušen. Slyšená obecná buňka s počítaným cílem hraje jednu hru i se dvěma slovesy – počet musí patřit sbírané věci věty (`readCountedNouns` ↔ `item`: „three keys“ ano, „two swords“ u sbírání klíčů ne).
- `build.ts`: kolo 1 = mikrohra hlavního slovesa (`classifyGenre` +4, u čtení modelem první sloveso čtení), zbytek losem jako T19. Corgi → běh, robot na věži → plošinovka, „dodge pies then throw pies“ → střelba na každém semínku.

Měřeno 26. 10. bez čtečky, 0 volání. Před = `30a0efc8` přeměřený týmž dnem (uložený `decide.md` z 22. 10. byl zastaralý).

| Měřidlo | Brána | Před | Po |
|---|---|---|---|
| P56C dev: `multi_verb` → řetěz | ≥ 10/12 | 11/12 | 11/12 |
| P56C dev: `no_verb` + `world_only` → řetěz | ≥ 15/18 | 18/18 | 17/18 (d31 „ghost with a skateboard“ → běžec) |
| P56C dev: `single_verb` → jedna hra | ≥ 8/10 | 10/10 | 10/10 |
| P56C 150 vět se čtením: řetěz slovníkem | – | 40 | 37 (`multi_verb` 29 → 28, jen knight) |
| P56C 150 vět: řetěz se čtením | – | 35 | 26 (`generic` 20 → 9) |
| P58B rychlá hra: cíle se žánrem věty | ≥ 25/60 | 25/60 | 25/60 |
| P58B rychlá hra: pasti mimo návnadu | ≥ 15/20 | 15/20 | 15/20 |
| P58B: věty do řetězu | – | 40/80 | 36/80 |
| P58B: první hra, kterou hráč vidí (u řetězu žánr kola 1) – cíle / pasti | – | 20/60 · 14/20 | 24/60 · 16/20 |
| P58B: řetězy, které začínají běžcem | – | 14/40 | 11/36 |

- Cíl P56C (víc sloves vidět) neklesl: `multi_verb` na dev beze změny, ze 150 vět ho ztratil jen knight. Omezení na počítaná podstatná jména tedy jen pro výjimku `multi_verb`, ne pro `generic`.
- P58B rychlá hra (`fast` = návrh bez čtení) se změnou nehne z konstrukce – návrh řetěz nevolá. `holdout.measure.ts` offline cestu nemá (chce `OPENAI_API_KEY` a `openSealedOnce` zapisuje `holdout-opened.json`), proto neběžel. Čísla dal jednorázový skript nad otevřenou `p58b/holdout.json` (`rowOf` bez čtení + `chainReasons`/`buildChain` jako route), pečeť nedotčená.
- Pozor: zúžení počtu na sbíranou věc přišlo po pohledu na P58B s72, s74, s75 („eight swords“, „three forest lanes“, „four answers“ by jinak řetěz zrušily). Ta sada je otevřená od P58B T8; zapečetěná sada P61 neotevřená.

## Útrata čtení

Strop celého plánu 4 USD. Čtečka astra (`gpt-6-astra`), ceny 10 / 50 USD za Mtok, tokeny od poskytovatele z `usage-preload.mjs`.

| Krok | Volání | USD |
|---|---|---|
| T1 – `main` dev 12 vět + holdout 24 vět (jedna věta holdoutu dvakrát po pádu serveru) | 36 | 1,101 |
| **Celkem** | 36 | **1,101** |

## T6 – rámování na výšku

Měřidlo `e2e/p61-portrait.spec.ts` (projekty `pixel7-touch`, `iphone-touch`): 19 žánrů, týž telefon na výšku a na šířku (Pixel 7 412 × 839 / 863 × 360, iPhone 15 393 × 659 / 734 × 343), robot hraje 180 tiků ručními hodinami jako `p58a-framing`. Podíl hrdiny = medián plochy jeho obdélníku na plátně / plocha plátna – plocha, protože obrazovka je v obou polohách tatáž. Čísla `before` a `after` v `portrait.json`; 15 her z `p58a/framing-cells.json`, plavba, krájení, dav a slučování složené z věty bez modelu.

Nejmenší podíl hrdiny na výšku měly na obou telefonech **načasování** (jehla na liště) a **vytlačování z ringu**:

| Žánr | Telefon | Na výšku před | Na výšku po | Na šířku před / po | Výška / šířka před → po |
|---|---|---|---|---|---|
| načasování | Pixel 7 | 0,76 % | 1,66 % | 1,26 / 1,26 % | 0,60 → 1,32 |
| načasování | iPhone 15 | 1,11 % | 2,33 % | 1,42 / 1,42 % | 0,78 → 1,64 |
| vytlačování | Pixel 7 | 1,19 % | 1,46 % | 1,46 / 1,44 % | 0,82 → 1,01 |
| vytlačování | iPhone 15 | 1,50 % | 1,86 % | 1,64 / 1,61 % | 0,91 → 1,16 |

Cíl (zelený sloupec tolerance, soupeř) zůstal v obraze ve 100 % snímků před i po. Na šířku se kamera nezměnila (rozdíly do 2 % jsou šum běhu).

- **Načasování**: šířku záběru na výšku dával pevný kyv 10 m, jehla (0,2 m) ale kyvuje ±3,1 m – kamera teď rámuje kyv, jaký jezdec opravdu má (`timingDistance`), na Pixelu 7 13,7 m místo 17,7 m. Hrdina věty (tučňák) stál za krajem kyvu a z těsnější kamery by vypadl celý – na výšku stojí v popředí pod věží (`timingHeroAt`), dřív z něj byla vidět půlka. Blok věže (stavění) zůstal skoro, kde byl.
- **Vytlačování**: ring se na výšku vešel do 85 % šířky; do stran teď jen 0,6 m místo 1,3 m – střed soupeře na kraji ringu drží ve 0,9 šířky (bezpečná zóna `p58a-framing`).

Ostatní žánry: měřidlo je drží proti `before` (podíl na výšku ≥ 0,8× – šum plavby a chytání až 27 %, ostatních do 3 %; cíl v obraze nejvýš o 0,1 méně). Nejmenší poměr výška / šířka teď mají bouchání (0,41 / 0,61), přeskákání silnice (0,62 / 0,72) a rytmus (0,88 / 1,00) – nesahalo se na ně.

Kontrola: vrácená oprava (kyv zase 10 m, ring 1,3 m do stran) → měřidlo červené na obou opravených žánrech. `p58a-framing` a `play-phone` zelené na `pixel7-touch` i `iphone-touch` (oba specy tam od T6 běží; `p58a-framing` měří telefon projektu jako profil `touch`).
