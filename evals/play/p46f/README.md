# P46F – modely pro hratelnost přes noc

Plán: P46F (interní). Větev převzala fast-forwardem lokální integrační větev `features/P46-hratelnost-2026-10-12` (`491079b7`, obsahuje P45G a P45I). Do P46 se slučuje jako poslední, nebo kdykoli mezi A → B → D → C → E – sahá jen na katalog a assety.

## Cíl

Aspoň **80 nových modelů** v knihovně, z toho aspoň **15 bossů** a **20 věcí pro akce hrdiny**. Pořadí podle dopadu na hru z P46:

1. **Bossové** pro finále (P46B, P46E) – pronásledovatel běžce, který útočí; vrtulník a jiný stroj nad tratí pro řízení; šéf na konci skákačky; velké a hrozivé verze tvorů a strojů, které věty jmenují jako nepřítele.
2. **Věci pro akce P46A** – zbraně, střely, štíty, power-upy (magnet, štít, 2×), kořist ke krádeži.
3. **Nepřátelé, překážky a sběratelné věci**, které věty chtějí a knihovna nemá (`evals/play/p45d/missing.json`, panely P45/P46).
4. **Chybějící hrdinové.**

Mimo: `src/play/**` a `src/components/**` (tam běží P46A/B/D), placená API, zapečetěné sady (`evals/play/p30/`), rigování.

## Pravidla běhu

- Karta RTX 3090, každý běh přes `node D:/claude/_shared/gpu-lock.mjs -- <příkaz>`. Mezipaměť `D:/claude/_gen3d-cache-p46f` (mezipaměti P45G a P45I se smí číst), záznam dávek `D:/caches/p46f/round<n>/`.
- **Soudce i předkontrola obrázku = Opus 5.5** přes `claude -p --model claude-opus-5-5` na předplatné. Slepý soud v prázdném `mkdtemp`, jediný soubor `sheet.png`, povolený nástroj jen `Read` – soudce nevidí jméno předmětu ani cestu, která by ho prozradila.
- Strop celého P46F **1200 volání** soudce. Vyčerpaný limit předplatného = zbytek „čeká na soud“, smyčka počká na obnovení (čas z hlášky) a pokračuje.
- Povýšení nesmí změnit výsledek testů v `src/play`; když zčervenají, jméno jde ven přes `promote-batch.mjs --drop` a zapíše se jako zjištění.
- license-gate: nové GLB v `public/` a jejich záznamy v `disclosure.json` v tomtéž commitu, jeden commit na dávku.
- Souběžné autopiloty P46B a P46D GPU nepotřebují; sady po dávce počkají, když jejich worktree pouští vitest nebo build (časové testy pod zátěží padají).
- **Okno:** po **13. 10. 2026 06:10** se nová dávka nespouští; rozběhnutá se dokončí, hotové se povýší, zbytek se zapíše. Souhrn hotový nejpozději v 06:40.

## Souhrn kola (12.–13. 10. 2026, 21:55–06:21)

| | Jmen | Model (předkontrola a brána) | Slepý soud Opus 5.5 | Povýšeno |
|---|---|---|---|---|
| P46F, 20 kol (první pokus) | 200 | 170 | **136 (68 %)** | **130 (65 %)** |
| P46F, 5 kol opakování (6, 7, 12, 16, 21) | 50 | 39 | 25 (50 %) | 18 (36 %) |
| P45I, kola 1–26 (první pokus) | 251 | 207 | 147 (59 %) | 141 (56 %) |
| P45I, kola 27–35 (opakování) | 78 | 52 | 14 | 9 (12 %) |

Procenta jsou z počtu jmen. Čísla po kolech: `gen-round.md`, listy soudce `D:/caches/p46f/round<n>/judge/`, souhrn skriptem `D:/caches/p46f/summary.mjs`.

- **Cíl splněn: 152 nových modelů v katalogu** (1201 → 1353, cíl 80), každý s licencí a původem v `disclosure.json`. Z toho **59 bossů** (cíl 15) a **76 věcí pro akce** (cíl 20).
- **Po skupinách:**

  | Skupina | Zkoušeno jmen | Povýšeno |
  |---|---|---|
  | bossové (pronásledovatel běžce, stroj nad tratí, šéf skákačky, stroje) | 80 | 59 |
  | akce (zbraně a střely, štíty, power-upy, kořist) | 86 | 76 |
  | nepřátelé | 17 | 8 |
  | překážky | 17 | 9 |
  | tvorové, hrdinové | 0 | 0 |

  Hrdinové odloženi už v T3: každé jméno hrdiny změní seznam postav v `src/play` a jeho pin, takže by šlo ven přes `--drop`. Tvorové stáli ve frontě poslední. Nezkoušených zůstalo 32 jmen fronty (8 nepřátel, 11 překážek, 13 tvorů) a 20 neprošlých čeká na opakování – `D:/caches/p46f/state.json`, na ně může navázat další noc.
- **Úspěšnost proti P45I:** první pokus 68 % soud / 65 % povýšení proti 59 % / 56 %, opakování 36 % proti 12 %. *Odhad, neměřeno:* rozdíl dělá spíš výběr jmen (bossové a zbraně jsou výrazné tvary, P45I mělo víc drobných věcí z vět) než přísnost soudce – v kalibraci byl Opus u sporných listů spíš přísnější než Codex.
- **Opakování:** 7 jmen dostalo nový popis do `ops/gen3d/features.toml` podle toho, co soudce místo nich viděl (vrtulník místo gyrokoptéry, drak místo hydry, orel místo roka, dělo místo kulometu gatling…); ostatní jen nová semínka.
- **Vyřazeno manifestem `src/play`: 0.** Seznam z T3 nemá žádné slovo třídy postav, takže žádné povýšení nezměnilo testy `src/play`.
- **Soudce Opus 5.5:** 597 volání (předkontroly obrázků i soudy listů) ze stropu 1200, limit předplatného ani jednou nedošel. Shoda s Codexem v kalibraci 15 z 20 (75 %, `calibration.md`).
- **Velikost nových GLB:** lod0 13,8 MB (průměr 91 kB na model), lod1 6,6 MB (průměr 43 kB).
- **Sady v klidu** (stejné jako po každém kole, GPU stojí): 26 souborů, 1610 testů zelených.
- **Pokrytí katalogu** (`npx vitest run --config vitest.measure.mts evals/play/catalog-coverage.measure.ts`): modelů 1353, pokrytí podstatných jmen z vět beze změny (102 ze 114) – měřená sada vět bossy ani zbraně nejmenuje.
- **Chyba v záznamu smyčky:** 4 jména v množném čísle (speed boots, winged shoes, spring shoes, angel wings) se povýšila už v prvním pokusu, ale katalog je má v jednotném čísle, takže je záznam vedl jako nepovýšená a dostala zbytečné opakování. V číslech výše jsou započtená jako povýšená v katalogu, v tabulce kol ne.
- **Provoz:** proces smyčky zemřel s koncem sezení /go dvakrát; generování, které běželo odpojeně, přežilo a smyčka po restartu pokračovala od rozdělaného kola. Jedno jméno (honey pot) třikrát dalo rozpadlou síť a zdrželo kolo 20 o 22 minut.

## Dojde boss do hry? (zjištění pro P46B a P46E)

Sonda `boss-reach.measure.ts` (`npx vitest run --config vitest.measure.mts evals/play/p46f/boss-reach.measure.ts`): 7 povýšených bossů × 7 tvarů věty → `draftGameSpec` → `arcadeWorldOf`. Boss je ve hře, když svět nese pravidlo zásahu bosse; kreslí se modelem pronásledovatele (`chaserModel`) – tělo bosse, věže i strážce kreslí scéna jako `cast.chaser` (`src/components/play/arcade/World.tsx:103`, `arena/ArenaScene.tsx:346`).

| Tvar věty | Žánr | Finále s bossem | Model nového jména |
|---|---|---|---|
| „Shoot the lava golem before it reaches you“ | střelnice | **ano** (věž) | **ano**, 6 ze 7 |
| „… while a lava golem chases you“ / „Run from the lava golem …“ | běžec | ne | ano, jako pronásledovatel |
| „avoid the lava golem“ / „the lava golem hunts you“ v aréně | aréna – útěk | ne | ano, jako pronásledovatel |
| „Fight the lava golem in the arena“ | souboj | ne (kola) | ne, robot |
| „Explore the dungeon … defeat the lava golem“ | aréna – sběr | ne | ne, jméno se ztratí |

- **Ve střelnici nový model bosse ve hře je** (lava golem, hydra, t rex, frost giant, kaiju, manticore); necromancer dostane hotovou postavu skeleton-mage, protože hrdinské postavy mají přednost.
- **V běžci a v aréně model do hry dojde jen jako pronásledovatel** – tyto věty finále s bossem nedostanou (`GENRE_PACING` v `src/play/arcade/pieces/pacing-parts.ts`: boss jen u arény se sběrem věcí ve vlnách, souboje, výpravy a střelnice).
- **Pro P46B/P46E:** finále arény a výpravy kreslí bosse modelem pronásledovatele. Věta, která bosse jmenuje bez pronásledování („defeat the X“, „fight the X“), žádnou roli pronásledovatele nemá, takže boss zůstane robot. Bosse z věty by šlo brát z role s jeho jménem (nepřítel, nástraha) i tam, kde chybí pronásledovatel.
- Ověřeno v kódu a přes překladač hry, **ne na obrazovce** – vykreslenou hru s novým bossem nikdo neviděl.
