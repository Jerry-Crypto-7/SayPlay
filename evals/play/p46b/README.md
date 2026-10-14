# P46B – úseky a boss pro běžce, řízení a skákačku

Měří, jestli hra těchto tří žánrů má rozjezd, dva úseky, které něco mění, a finále. Vedle čísel zábavy P45A (mrtvý čas, stoupání, finále, chování) přidává `segmentChanges` – kolik z úseků 2 a 3 přineslo proti předchozímu hratelnou změnu.

```
npx vitest run --config vitest.measure.mts evals/play/p46b/segments.measure.ts                  # → baseline.json
P46B_OUT=after npx vitest run --config vitest.measure.mts evals/play/p46b/segments.measure.ts   # → after.json
npx vitest run evals/play/p46b/__tests__/segments-gauge.test.ts                                 # test měřidla
```

**Věty:** z panelu P45 ty, které rychlý návrh postaví jako běžce (`runner`), řízení (`control:steer`) nebo skákačku (`platformer`) – 8 vět – a 12 nových v `sentences.json`, 4 na žánr (prvních šest jsou věty majitele z 12. 10.). Každá věta na semínku, které vybere publikace (`publishedWorld` v `p45/fun.ts`, táž cesta jako `/play`), běh robota `intermediate`. Souhrn buňky bere jen hratelné hry, které opravdu postavily žánr své buňky (`offGenre` = které ne).

## Měřidlo úseků (`segments.ts`)

Úseky jsou `PACING.segments` nad postupem hráče po trati (`z / length` v promile, nejvyšší dosažený): rozjezd 0–200, úsek 2 200–650, úsek 3 650–850, finále 850–1000. Úsek 2 se porovná s rozjezdem, úsek 3 s úsekem 2. Hratelná změna je jen:

| Změna | Kdy | Proč takhle |
|---|---|---|
| `foe:<role>:<pohyb>` | hrozba (`chaser`, `enemy`, `hazard`) s podpisem role + pohyb (`static`, `chase`, `roam`), který žádný dřívější úsek neměl | model ani barva v podpisu nejsou – nový vzhled téhož chování není změna (test) |
| `terrain:<role>:<static\|moving>` | nový druh těla trati (`obstacle`, `platform`), např. pohyblivá plošina | |
| `width:a->b` | medián volné šířky mezi dlouhými stěnami (≥ 10 m, mantinely řízení) se liší o ≥ 10 % | řady běžce nejsou stěny |
| `speed:a->b` | medián rychlosti hráče vpřed je o ≥ 10 % **vyšší** | medián: krátké turbo řízení úsek nezmění; jen růst: robot skákačky na těžší trati zpomalí, a to není nové tempo |
| `density:a->b` | překážek a hrozeb poprvé viděných na 100 m je ≥ 1,5× **víc** a aspoň o 2 víc | jen růst: řidší úsek nic nepřináší; dva soupeři řízení na startu jsou rozestavění, ne stupňování |

Zorné pole je 40 m před hráčem a 5 m za ním. Plošiny a dlouhé stěny do hustoty nejdou (tvar trati, ne co hráč míjí). Finále měří `finale` telemetrie P45A, ne `segmentChanges`.

## Baseline (`baseline.json`, `features/P45-demo-2026-10-12` `491079b7`)

| Buňka | Hratelné | Mrtvý čas (medián, s) | `rising` | `finale` | Chování (medián) | `segmentChanges` medián | `segmentChanges ≥ 2` |
|---|---|---|---|---|---|---|---|
| běžec | 6/6 | 9,36 | 1 | 0,67 | 1,5 | 2 | 1 |
| řízení | 7/7 | 9,92 | 0,86 | 0 | 1 | 1 | 0,29 |
| skákačka | 7/7 | 9 | 0 | 0 | 1 | 1 | 0 |

- **Běžec úseky už mění** (hrozby R2 od úseku 2, hejno od vrcholu, fáze rychlosti, hustší řady). Chybí mu boss (finále 0,67 je stupňování na konci, ne boss) a mrtvý čas.
- **Řízení** mění jen úsek 2 (zúžení trati z 10 m na 3,8 m a krok rampy +10 %), úsek 3 nic. Bez finále.
- **Skákačka** mění jen úsek 2 (pohyblivá plošina, hustší hroty), úsek 3 nic, intenzita nestoupá a finále nemá.
- Pět her má mrtvý čas přesně 10 s – první herní událost přijde až v 10. s (pravděpodobně první vlna šablony pravidel; ověří T2).

## T6 – skákačka: úseky a boss (12. 10.)

**Záložní plán z plánu se nepoužil**: robot skákačky plánuje skoky rychlostí úseku (`speed` v parametrech ovládání i robota, fáze ji škálují), takže skákačka má úseky i se změnou rychlosti a finále s bossem.

- **Jen nová hra.** Žánr Skákačka píše do `tuning` značku `segments`; jen s ní generátor staví úroveň po úsecích průběhu (`PLATFORM_SEGMENTS`) a `GENRE_PACING.platform_level` ji pace. Uložená hra bez značky, `genre.v1` i fixtura staví tentýž svět. Útěk s jedním životem (`jump.escape`) značku ani průběh nedostane: dotek bosse končí hru a začátečník vyhrál s finále 115 % 7/16, se 100 % 15/16 – útes, ne páka.
- **Úseky:** rozjezd o stupeň lehčí (90 %), úsek 2 od 450 ‰ past (hrot, který vyjíždí ze země a zajíždí) a pohyblivá plošina (100 %) – obojí až za 40 m zorného pole měřidla od konce rozjezdu –, úsek 3 rychlejší (115 %), finále aréna 20 m s checkpointem (100 %).
- **Boss `brute`** (nové chování na konci `BEHAVIOUR_IDS`): pevné tělo role `hazard`, 3 HP. Dotek z boku zraní jako hrot, doskok na hlavu mu ubere 1 HP a omráčí ho na 45 tiků; po varování 40 tiků (−4 za zásah) nabíhá na zamčené místo hráče. Výhru nedá, padne třetím doskokem.
- **Mrtvý čas:** mince u hrany, kde se čeká na pohyblivou plošinu, a mince, která jede s ní; mince rozložené po celé trati (dřív je rozpočet 60 vyčerpal úvod); rozjezd jen prostřední mince (hra k finále houstne).

| Měřeno | Před | Po |
|---|---|---|
| Měřidlo T1, skákačka (7 vět): mrtvý čas medián | 9 s | 2,77 s |
| `rising` / `finale` / `segmentChanges ≥ 2` | 0 / 0 / 0 | 1 / 0,86 / 0,86 |
| 4 buňky `platformer.default*`, semínka 1–20: novice / intermediate | 0,30 / 1,0 | 0,45 / 0,45 / 0,35 / 0,35 · 1,0 |
| Test T6 (semínka 1–8, intermediate): mrtvý čas | – | ≤ 3,62 s, boss padl v každé výhře |

Nalezeno, nevyřešeno: věty se sbíráním všeho (`collectAll`, např. „collecting bananas“) mají jen věci z věty a mrtvý čas 9,5–15,5 s (mince navíc by se staly povinnými). Věta „obby game with lava and spinning bars“ boss ani změnu úseku 3 v měřidle nemá (důvod neověřen; měřidlo výsledek běhu nezapisuje).

## Po T7 (`after.json`, 13. 10., `5462f04b`) – cíl T8 zatím nesplněn

| Buňka | Mrtvý čas (medián, s) | `rising` | `finale` | `segmentChanges ≥ 2` | Cíl T8 |
|---|---|---|---|---|---|
| běžec | 9,36 (beze změny) | 1 | 0,67 (beze změny) | 1 | mrtvý čas a finále ne |
| řízení | 3,23 | 1 | 1 | 1 | ano |
| skákačka | 2,77 | 1 | 0,86 | 0,86 | `segmentChanges` ne (6/7) |

Proč (změřeno sondou nad publikovaným světem, robot intermediate):

- **Hry s díly (P42, `assemblyParts`) průběh úseků ani bosse nedostanou** – výjimka v `GENRE_PACING` od P45C (běžec) a T5/T6 (řízení, skákačka): robot dílu rozhoduje o pruhu nad robotem průběhu. Z 6 vět běžce jsou takové 3 (b02 „Amanita … flee and shoot“ díl `fight`, b03 a s003 křeček s Roombou díl `escape`), mají finále `sprint`, prázdný rozvrh a mrtvý čas 8,7–10 s; b02 a b03 jsou věty majitele. Ze skákačky „obby“ (díl `hazard`), proto 6/7.
- **Běžec s úseky (b01, b04, m08) má mince po celé trati, ale robot běžce je nesbírá** – `runner-bot.ts` jen uhýbá, mince bere náhodou. Mince leží každá 2–4 % trati (~1,5–2 s), v rozjezdu od 65 ‰. Robot: tučňák první mince až po 20 s (mrtvý čas 10 s mezi vlnami šablony v 5. a 15. s), králík 5,08 s, veverka 6,52 s. Finále těchto tří je boss (`why: boss`).

Zábava panelu P45 (40 her) proti `fun-baseline.json` P46A (týž základ `491079b7`): mrtvý čas medián 5,36 → 4,00 s, `rising` 0,55 → 0,63, finále 0,23 → 0,35, události/s 1,09 → 1,16. Žádná věta horší (hratelnost, nejdelší mezera +0,5 s, ztracené stoupání, finále, počet chování).

## Po R1 a R2 (`after.json`, 13. 10.) – číselný cíl T8 splněn

R1 (`0e091749`): robot běžce si zajede pro minci, když se stihne vrátit před řadu. R2: hry s díly běžce a skákačky dostanou hrozby, úseky a bosse jako hry bez dílů.

| Buňka | Mrtvý čas (medián, s) | `rising` | `finale` | `segmentChanges ≥ 2` |
|---|---|---|---|---|
| běžec | 9,36 → 3,8 | 1 | 0,67 → 1 | 1 |
| řízení | 3,23 | 1 | 1 | 1 |
| skákačka | 2,77 → 3,58 | 1 | 0,86 → 1 | 0,86 → 1 |

Skákačka má medián vyšší, protože do souhrnu nově vstupuje „obby“ (3,58 s). Věty se sbíráním všeho zůstávají na 9,5–15,5 s (viz T6).

Zábava panelu P45 (40 her, `f0267b47`) proti `fun-baseline.json` P46A: mrtvý čas medián 5,36 → 3,78 s, `rising` 0,55 → 0,63, finále 0,23 → 0,38, události/s 1,09 → 1,18. Žádná věta horší (hratelnost, nejdelší mezera +0,5 s, ztracené stoupání, finále, počet chování, žánr).

### R2 – hry s díly: změřeno sondou, 20 semínek, robot intermediate / začátečník

Sonda stavěla věty b02, b03, s003, s021 a recepty `assembled` se všemi 9 druhy dílů pro běžce i skákačku. Výsledky před → po:

- **Přetahování robotů se nepotvrdilo.** Robot dílu přebije pruh jen u svého cíle a jen bez překážky před sebou. Intermediate vyhrál stejně jako bez průběhu: běžec 0,85–1,0 (`catch` 0,85 před i po), skákačka 1,0. Boss padl v každé výhře. Úprava robota (vzor `dodgeLane`) nebyla potřeba.
- **Běžec s díly:** finále `sprint` → boss, `rising` 0,2–0,8 → 0,95–1. Nejdelší mezera přes 20 semínek klesla z 10,85 s na 5,7 s. U `deliver`/`interact` klesla z 52 s na 5,7 s. Úseky 2 a 3 se mění na 20/20 semínek už dřív (rychlost a hustota fází).
- **Skákačka s díly:** dřív bez průběhu, teď s pastí, pohyblivou plošinou, rychlejším úsekem 3 a bossem. `segmentChanges ≥ 2` 0,35–0,55 → 0,8–0,85. Semínka 2, 11 a 15 nemají změnu úseku 3 ani u `platformer.default` bez dílů: rychlost 115 % robot v mediánu nevyjede. Je to vlastnost generátoru z T6, ne dílů. Začátečník 0,5–0,8 → 0,3–0,45 (bez dílů 0,45).
- **Skákačka s dílem `chaser` průběh nedostane.** Pronásledovatel dílu vyběhne hráči naproti a v první sekundě mu vezme život. Past a boss se pak hrají na dva životy a začátečník spadl z 0,5 na 0,25 (pod pásmem 0,3–0,7).

**Nalezeno, nevyřešeno – začátečník běžce z vět vyhrává 5–10 %.** Platí s díly i bez nich (b01, b04, m08 0,1), před R2 i na základu P45 `491079b7`. Takže to nezpůsobil P46B. Buňky P41 dávají začátečníkovi 0,45–0,6, protože nesou ladění obtížnosti `legacy-difficulty.ts` (`fullRowPct` 50, tedy polovina řad s volným pruhem). Věta z návrhu ani recept `assembled` ho nemají. Změřeno: začátečník přijde o životy nárazy (`hit`) v poslední pětině trati. Odvozeno, neověřeno: jde o plné řady, protože spec věty se od buňky liší jen chybějícím `fullRowPct`. Oprava patří k obtížnosti návrhu, ne k úsekům.

## T8 – párový soud proti P45 (14. 10., `1ea5bfac`) – cíl nesplněn

Slepý soud P45A jen nad 8 větami panelu tří žánrů (běžec m08, s003; řízení m03, m06, h02; skákačka m09, m16, s021), ne nad celým panelem: jiné žánry P46B nemění a remízy by podíl jen táhly k 0,5. **A** = `features/P45-demo-2026-10-12` `491079b7` (dočasný worktree `p46b-base-491079b7`, port 3218), **B** = tato větev (3217), obě strany bez `.env.local` a s prázdným `PLAY_STORE_DIR`:

```
node --experimental-strip-types scripts/play-fidelity.mjs run --set p45-panel --only m03,m06,m08,m09,m16,h02,s003,s021 --base http://127.0.0.1:<port> --run p46b-t8-<a|b> --pace-clip --draft-only --gpu
node --experimental-strip-types scripts/play-fidelity.mjs pairwise --a p46b-t8-a --b p46b-t8-b --out evals/play/fidelity/runs/p46b-t8-pairwise.json --concurrency 1   # --ignore-budget
```

`pairwise-t8.json` = výstup soudu doslova (páry se zdůvodněním). 8 volání soudce; první běh se dvěma vlákny dostal od Codexu 429 po čtyřech párech, zbytek prošel po jednom.

| Žánr | Pro B | Pro A | Remíza |
|---|---|---|---|
| řízení | 3 | 0 | 0 |
| běžec | 1 (s003) | 1 (m08) | 0 |
| skákačka | 0 | 3 | 0 |
| **celkem** | **4** | **4** | **0** – `bShare` 0,5, cíl ≥ 0,6 |

Šum na 8 párech je ~0,18, rozhoduje směr: řízení lepší, skákačka horší ve všech třech.

**Proč skákačka prohrává (snímky `m16`, `s021`, zdůvodnění soudce):** úroveň P46B končí dlouhou plochou arénou bosse a boss `brute` je na snímku malá postavička velikosti hráče. Soudce bosse nevidí a arénu čte jako „broad flat stretch, ends sooner“ (m16), „more time on broad, safe platforms, the ending looks less demanding“ (s021). Tvar plošin před arénou je na obou stranách stejný. Odvozeno, neověřeno: robot P46B (skáče podle rychlosti úseku) je na snímcích častěji na zemi než robot P45, který je ve vzduchu skoro na každém snímku. Běžec m08 prohrál, protože u P46B je trať do půlky řidší („stays relatively sparse longer“).

**Zkušební sloučení do `features/P46-hratelnost-2026-10-12` `e290df5c`** (dočasný worktree, nic necommitnuto):

- Konflikt jen v `phase-pieces.ts`: P46A i P46B tam nezávisle udělaly stejnou optimalizaci (parametry fáze jednou za svět). Bere se strana integrační větve.
- `npx vitest run src/play/arcade/__tests__/runner-boss.test.ts src/play/arcade/abilities`: 144/145. Padá pásmo obtížnosti `runner.default+shoot_at`: začátečník vyhraje 10/10 (pásmo 0,3–0,7). Střílející běžec má po P46A akci střelby a začátečník s ní bosse i hrozby sestřelí. Běžec bez střelby v pásmu.
- Přečteno z kódu, během zatím neověřeno: úder P46A bosse běžce nezasáhne. `ability_strike` bere jen role `enemy` a `chaser` (`abilities/strike.ts`, `isStruck`), boss běžce má roli `hazard` (`behaviours/boss.ts` `bossBody(flanker.body)`), stejně shazovač řízení a `brute` skákačky (1,6 × 1,3 × 2 m). Test `boss-abilities.test.ts` z AC tedy po sloučení bez úpravy úderu neprojde. Návrh testu (gitignorovaný `plans/P46B-T8-boss-abilities.draft.ts`) na úder zatím nedošel: robot akcí plánuje s úderem, takže jeho pohyb bez jeho stisků prohraje, a pohyb robota bez akcí na světě s akcí taky prohraje (svět s akcí je jiný).

## R5 – finále skákačky jako souboj s bossem (14. 10.) – cíl splněn

- **Boss a aréna.** `brute` je vysoký 3,2 m (dvakrát hrdina, `2 * PLATFORM.playerH`), dřív 1,3 m. Aréna už není rovná deska: schod (+0,9 m nad dnem), mezera 1,5 m, římsa (+1,8 m, checkpoint), za ní jáma 12 m s bossem a cílem na dně. Na hlavu bosse dosáhne jen skok z římsy, ze dna ani ze schodu ne. Aréna je dlouhá jako dřív rovná deska, takže délka úrovně a hranice úseků v ‰ zůstaly.
- **Schod ve výšce rovné desky.** Schod stojí ve výšce, kterou generátor losuje pro poslední desku (`nextTop`). První verze ho dávala do výšky předchozí desky: ze skoku do arény zmizel seskok (u semínka 1 o 0,64 m), začátečník na něm padal 8× místo 5×, na bosse mu nezbyl čas a `chase_me` spadl na 2/8 (pásmo od 0,3).
- **Robot.** V jámě se odráží z římsy (místo odrazu podle doletu skoku, na hraně římsy brzdí). Dopad na hlavu, který robot kvůli zpoždění ještě nevidí, ho hnal větví „nedopadni bossovi k boku“ dopředu, takže z hlavy sešel za bosse a vyhrál po 2 zásazích (semínko 1). Nad hlavou teď míří dál na její střed.
- **Měřeno:** pin `platform-pacing.test.ts` 8/8 (tvar jámy, každý zásah skokem z římsy, boss padne třetím zásahem před cílem). `p41/difficulty.json` skákačky: intermediate 20/20 ve všech 4 buňkách, začátečník 0,5 / 0,5 / 0,4 / 0,4 (před R5 0,45 / 0,45 / 0,35 / 0,35). `after.json` beze změny: skákačka mrtvý čas 3,58 s, `rising`, finále a `segmentChanges ≥ 2` 1. Sada arcade + compose + golden + p46b 2655/2657, výkon `swarm` a časový limit golden padly jen pod zátěží, samotné zelené.
- **Delší varianta zamítnuta:** mezera 1,5 m napevno místo losované prodloužila úroveň o ~1,5 m. Soud dopadl stejně, ale hranice úseků se posunuly a u m16 zmizela změna rychlosti v úseku 3 (`segmentChanges2Share` skákačky 0,86).

**Párový soud jen nad 3 větami skákačky.** Klipy B natočené znovu na této variantě (stejný příkaz jako v T8, `--only m09,m16,s021`), jejich `*.answer.json` smazané, strana A beze změny. Výstup doslova: `pairwise-r5.json`.

| Věta | Vítěz | Soudce o P46B |
|---|---|---|
| m09 | B | „more frequent airborne action across varied gaps and platforms, with red spikes and glowing danger rings close to the robot in the later scenes“ |
| m16 | B | „introducing a large orange robot late in the run, giving it more variety and buildup“ |
| s021 | A | „more often on broad, flat platforms, giving it a steadier pace and less visible buildup“ |

Skákačka 2 ze 3 pro P46B (v T8 0 ze 3), celkem 6 z 8, `bShare` 0,75 (cíl ≥ 0,6). Odvozeno, neověřeno: s021 dál prohrává na plošinách před arénou, které R5 neměnila.

**Po R5 (`42076825`), T8 před sloučením:**

- Zábava panelu P45 (40 her) proti `fun-baseline.json` P46A: mrtvý čas medián 5,36 → 3,78 s, `rising` 0,55 → 0,63, finále 0,23 → 0,38, události/s 1,09 → 1,18. Žádná věta horší (hratelnost, nejdelší mezera +0,5 s, stoupání, finále, počet chování, žánr).
- Celá sada samotná: 13 090 / 13 128. R5 shodila dva testy a oba jsou opravené: statistika mezer sekce 3 v `sections.test.ts` (římsa a jáma se do ní nepočítají, `c19c6817`) a zmrazené otisky skákačky P41 (`42076825`, jen řádky skákačky). Zbytek červených padá bez vztahu k P46B: časové limity pod zátěží sady (`upgrade`, `compile-report`, `golden`, `swarm`, chyby `STACK_TRACE_ERROR` na limitu), `upgrade-action-lost` stejně na základu `491079b7` a chybějící gitignorovaný `plans/P8-odevzdani.md` ve worktree.
