# P45 – měřidlo zábavy

Měření hloubky a zábavy her: telemetrie robota, slepý párový soud a formulář majitele. Plán: P45A (interní), spec `docs/specs/2026-10-08-p45-hloubka-a-zabava.md` (interní).

## `panel.json` – vývojový panel, 40 vět

Vybraný jednou 8. 10. 2026 nad `main` `0714a352` dřív, než se P45 dotkl kódu (`panel.select.ts`, holý Node se zavaděčem `scripts/ts-paths.mjs`). 25 vět z `p37a/dev-150.json`, 15 z `p30/dev.json`; ladí se jen na něm.

- **Žánr** = žánr rychlého návrhu (semínko 1, bez modelu) jako `p36/depth.ts`; věty, které spadnou do mřížky, vypadly – nemají arkádový běh, který by robot změřil.
- **Pořadí výběru:** skupiny sady se střídají (`group` v `dev-150`, `source` v `p30/dev`), uvnitř skupiny podle id; věta se vezme, dokud její žánr nemá svůj podíl (strop kvóta / počet žánrů), zbytek kvóty doplní další věty v tomtéž pořadí. Čisté pořadí podle id by z `dev-150` vzalo jen `f*` a `m*` a panel by neměl jedinou větu s neznámým slovesem.
- **Nepřítel** = tělo role `chaser` nebo `enemy` ve světě na semínku 1 (živé i předloha vln).
- Pokrytí: 18 žánrů, 18 vět s nepřítelem. `genre` a `enemy` jsou zapsané u každé věty v době výběru – pozdější změna hry je nepřepisuje.
- Žádná věta se po normalizaci neshoduje s `p30/test-200.json` ani se zapečetěnými sadami P43, P44C a P44E. Výběr drží `__tests__/panel.test.ts` (změna = červený).

## `sealed-100.json` – zapečetěná sada zábavy, 100 vět

Napsaná 8. 10. 2026 nezávislým autorem (subagent bez přístupu ke kódu, plánům, specům i ke všem ostatním sadám v `evals/play/**`; dostal jen pravidla seznamu z `fidelity/corpus.json`, tvar jednoho záznamu a rozložení skupin) s pokynem psát věty jako porotce, který chce hru, u které se pobaví. Skupiny: `threat` 40 (nepřítel, souboj, útěk), `everyday` 25 (neznámé sloveso), `fantasy` 20, `non-game` 15; pár vět nese štítek `typo`, `short` nebo `two-verbs`. Na sadě se neladí a její věty nikdo z P45A nečetl – test ji ověřuje jen přes otisky.

SHA-256 (konce řádků LF): `1b6d2eb9c11f58cbef5a9f9bff7a1b69aa380c69d804c44225dd5cc0f9fa7a2c`, hlídá ho `__tests__/sealed.test.ts`.

- Žádná věta se po normalizaci (`normalizeSentence`) neshoduje s `p30/test-200.json`, `p30/dev.json`, `p37a/dev-150.json`, `fidelity/corpus.json`, `fidelity/judge-10.json`, `demand/corpus.json`, `p41/sentences.json`, `p43/panel.json`, `p43/sealed-100.json`, `p44c/sealed-110.json`, `p44e/sealed-200.json` ani s panelem P45.
- Pečeť rozhoduje obsah (`source: "sealed-p45"`), ne cesta: `loadSet` bez `--open-sealed-once` odmítne, s ním zapíše `sealed-opened.json` (čas, běh, commit, SHA-256 nad LF bajty) dřív, než odejde první věta, a každé další otevření odmítne.
- **Pečeť je zlomená:** otevřelo ji konečné měření P46 (`abe38f04`, běh `p46-final`, 15. 10. 2026). Ten commit zapsal `sealed-opened.json`, a tím shodil očekávání „v repu ještě neotevřená“; `88e0596d` ho oprávněně nahradil přísnějším – záznam existuje, běh je `p46-final` a otisk sedí na tyto bajty. Sada je od té doby otevřená a na další měření se nehodí; nové plány si píšou vlastní holdout (P51: `evals/play/p51/holdout.json`).

### Panel – ids

`f01` `f02` `f03` `f05` `f10` `f12` `f17` `f18` `m01` `m02` `m03` `m04` `m06` `m07` `m08` `m09` `m11` `m16` `n01` `n02` `n04` `u01` `u02` `u03` `u06` (dev-150) · `d01` `d03` `d04` `d09` `h02` `h03` `h05` `j01` `j04` `j05` `j08` `s002` `s003` `s021` `s035` (p30 dev).

## Metriky robota – `fun.ts`, `src/play/arcade/telemetry.ts`

Každá věta projde cestou hry z `/play`: rychlý návrh (semínko 1, bez modelu), semínka publikace a táž výhybka jako `p36/depth.ts` (první semínko, kde robot publikace vyhraje a nečinný hráč ne). Hru pak odehraje robot `intermediate` (`runBot`, profil z `verify.ts`) a telemetrie přehraje jeho záznam a stav jen čte (hash běhu je s ní i bez ní stejný). **Hratelná** = výhybka našla semínko; souhrn bere jen hratelné hry, nehratelná se změří, ale do mediánů a podílů nevstupuje.

- **Událost** = sebrání (`pickup`), zabití nepřítele, hrozby nebo terče (`kill`), zásah, který ubral HP (`hit`), ztráta života nebo HP hráče (`damage`), nové tělo (`spawn`), změna stavu cíle (`stateChange`), samotné zvýšení skóre (`score`; skóre v tiku jiné události je její následek, ne druhá událost). Výhra a prohra jsou hrana posledního úseku, ne událost.
- **`eventsPerS`** – událostí za sekundu běhu (60 tiků = 1 s).
- **`longestGapS` (mrtvý čas)** – nejdelší úsek bez události v sekundách, počítaje začátek a konec běhu; `medianGapS` je medián úseků.
- **`rising`** – poslední třetina běhu má víc událostí než první (třetiny délky tohoto běhu, ne 90s horizontu); `intensityRatio` = poslední / první, `null` při prázdné první třetině.
- **`nearMisses` (blízká minutí)** – hrozba (honič, nepřítel, nebezpečí, projektil) vejde do 1,5 m od hráče (střed–střed, vzorek každých 0,1 s) a vyjde ven, aniž hráč mezitím přišel o život. Tělo zrozené uvnitř (vlastní střela) ani tělo, které zmizelo uvnitř, se nepočítá; slot znovu použitý spawnem je nové tělo.
- **`livesLost`**, **`playerDied`**, **`kills`** – počet `damage`, prohraný běh, počet `kill`.
- **`behaviours` (rozmanitost)** – různé podpisy `<role>:<pohyb>` hrozeb: `static` (ujede za běh < 0,5 m), `chase` (průměrný kosinus posunu mezi vzorky k hráči > 0,5), `roam` (hýbe se, nehoní), `shot` (projektil); `+spawned` = tělo vzniklo po startu. Dva honiči téže role jsou jedno chování. Hráčova vlastní střela (poprvé viděná < 3 m od hráče a letí od něj) nevstupuje. `behaviourCount` = počet podpisů.
- **`finale`** – `boss`: hrozba (honič, nepřítel, nebezpečí), která dostala ≥ 3 zásahy a do konce zmizela (`kill`, chybí v posledním vzorku, nebo tam má HP 0 – poražený v `arena.fight` zůstává ve hře s HP 0); jinak `climax`: vyhraný běh delší než 10 s, jehož posledních 10 s je aspoň 1,5× hustší než celý běh.

Změřit sadu: `P45_SET=panel P45_OUT=<soubor> npx vitest run --config vitest.measure.mts evals/play/p45/fun.measure.ts` (výstup bez času, opakovaný běh nechá git čistý). Zapečetěnou sadu `fun.ts` přečte jen s `P45_OPEN_SEALED_ONCE=1` a zlomenou pečetí.

## Baseline `main` `0714a352` – `baseline.json`

Panel, 8. 10. 2026; P45A kód hry nemění, telemetrie běží nad HEAD P45A se stejnými hrami jako `main`.

| Metrika | `main` | Cíl spec | Splněno |
| --- | --- | --- | --- |
| Hratelné hry | 40/40 | – | – |
| Mrtvý čas – medián `longestGapS` | 6,37 s | ≤ 3 s | ne |
| Podíl `rising` | 0,40 | ≥ 0,70 | ne |
| Chování – medián `behaviourCount` | 1 | ≥ 2 | ne |
| Podíl s finále | 0,15 | ≥ 0,50 | ne |
| Medián `eventsPerS` | 0,94 | – | – |
| Medián `nearMisses` | 0 | – | – |
| Medián `livesLost` | 0 | – | – |

Finále mají dnes jen dva souboje v aréně (boss) a čtyři vyhrané běhy se zhoustlým koncem (climax). 19 her nemá žádnou hrozbu, takže jejich `behaviourCount` je 0.

## Kalibrace soudce – `calibration.json`

Párový soud (`play-fidelity.mjs pairwise`): list se dvěma sloupci (A vlevo, B vpravo), řádky = snímky klipu průběhu (`run --pace-clip`: po 1,5 s, pak každých 6 s hry, nejvýš 8; šedá buňka = hra skončila), strana vlevo losovaná `pure-rand` ze seedu, soudce Codex na předplatné v prázdném adresáři jen se `sheet.png` a schématem. `bShare` = (výhry B + remízy / 2) / n.

- **Nulový test** (`main` `0714a352` na 3218 proti HEAD na 3217, týž kód, 40 párů): `bShare` 0,5, `leftWinShare` 0,5 – v pásmu 0,35–0,65. **Zjištění:** 38/40 remíz. Hry i robot jsou deterministické, takže obě strany vyrobí stejný klip a soudce správně řekne „tie“; poziční zkreslení tenhle test neměří (rozhodnuté jsou jen 2 páry).
- **Test citlivosti** (12 vět s nepřítelem: hraná hra proti téže hře bez robota, `run --pace-clip --idle`): hraná vyhrála **10/12** (práh 9/12), `leftWinShare` 0,5 nad 12 rozhodnutými páry – poziční zkreslení se neukázalo. Prohry hrané hry: střílečky `f03` a `d04`, kde se k nečinnému hráči sešli nepřátelé.
- Volání soudce: 40 + 12 + 1 zkušební = 53. Otázka se neupravovala.

**Odvozeno (ne změřeno):** věta, které plán nezměnil hru, dá stejné klipy a remízu za půl bodu. `bShare` celé sady proto táhne k 0,5 podíl nezměněných vět – plán, který změní jen část žánrů, potřebuje na změněných větách vyšší výhru, než říká cíl.

## Konečné měření P45B/C/D

Jeden příkaz, dva buildy. **A** = `main` `0714a352` z vlastního worktree, **B** = HEAD plánu:

1. A: `git worktree add --detach .claude/worktrees/p45a-main-0714a352 0714a352` (už existuje z P45A), `node_modules` jako junction na hlavní checkout, `npm run build`, `PLAY_STORE_DIR=<prázdný adresář> node node_modules/next/dist/bin/next start -p 3218`.
2. B: ve worktree plánu `npm run build` a totéž na portu 3217.
3. Obě strany bez `.env.local` (bez modelu), servery přes `run_in_background`.

```
node --experimental-strip-types scripts/play-fidelity.mjs fun --set p45-sealed --open-sealed-once --base-a http://127.0.0.1:3218 --base-b http://127.0.0.1:3217 --run <plan>-final --gpu   # --ignore-budget
```

Příkaz načte sadu **jednou** pro obě strany, natočí klipy průběhu z A (`<run>-a`) i B (`<run>-b`), pustí párový soud (100 volání) a telemetrii nad HEAD a zapíše `evals/play/p45/result-<run>.json`: `pairwise` (souhrn soudu), `fun` (souhrn telemetrie), `targets` a `met`. Cíl párového soudu je ≥ 0,55 pro jeden plán; pro P45C + D přidej `--target-b 0.65`.

**Pečeť se láme jednou pro celou P45:** první plán, který ji otevře, měří i za ostatní – proto ji otevře až konečné měření nad sloučeným `main` (A → B → C → D). Jednotlivé plány měří na panelu: `fun --set p45-panel` se stejnými `--base-a`/`--base-b` (40 volání). Na panelu je šum podílu ~0,08 (40 párů), takže tam rozhoduje jen hrubý směr; cíl 65 % platí na 100 zapečetěných větách (šum ~0,05).

Lidská přejímka: `acceptance.md` (10 vlastních vět majitele, desktop a telefon, cíl „hrál bych ≥ 7/10“).
