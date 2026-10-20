# P54B – scény a modely: měřidlo

Cíl: plná scéna, živé postavy a světlo z věty, a přitom hra hraje stejně (otisk beze změny).

## Sčítání scény

```
node --experimental-strip-types --import ./scripts/ts-paths.mjs scripts/play-scene-census.mjs --out evals/play/p54b/census-before.json
```

Dev sada `evals/play/p30/dev.json` (60 vět) přes `draftGameSpec` – rychlá verze bez režiséra. Věta `d01` (míč) mimo prohlížeč padá na `loadRapier()` a je v `skipped`.

- **Odlišné modely** = obsazení (hrdina, nepřítel, pronásledovatel, rekvizity rolí) + rekvizity sady (`landmarks`) + druhy vegetace. Orientační bod a život na pozadí se přičtou, až je sada bude mít (T8, T10).
- **Nepřítel s kostrou** se počítá přes všech 59 vět (`enemyModel`, i výchozí robot).
- **Světlo změněné** = `sceneLook` se od výchozí sady liší v obloze, polokouli, slunci, záři, mlze nebo expozici. **Věta jmenuje světlo** = slovo denní doby, počasí nebo nálady (`NAMES_LIGHT` ve skriptu).

**Před (`census-before.json`, 19. 10. 2026, `5d741740`):** hrdina s kostrou 18/59 (31 %), nepřítel s kostrou 1/59, odlišných modelů medián 12 (min 7, max 25), světlo změněné 4/59. Světlo jmenuje 7 vět, změní se jen u 4 – chybí `j10` („dark forest“ v hradu), `d03` („during a thunderstorm“), `d16` („snowy mountain village“). Čísla sedí přesně na výzkum.

**T7 (`census-t7.json`, výplň sad bez vegetace):** odlišných modelů medián 19 (min 13, max 25) – cíl ≥ 15 / ≥ 10 splněn. Výplň (`look/fill.ts`) má všech 12 sad bez vegetace, 7–11 druhů na sadu; řada kulis vedle ní zůstane hustá (`sparseLandmarks`). Hrdina s kostrou a světlo beze změny (18/59, 4/59).

**T11 (`census-t11.json`, nálada, počasí a denní doba z celé věty):** světlo jmenuje 7 vět, změní se u všech 7 (dřív 4) – přibyly `d03` (bouřka → déšť), `d16` („snowy“ → sněžení), `j10` (šero mimo místo věty → noc); světlo změněné celkem 7/59, žádná věta bez slov světla. Odlišných modelů beze změny (medián 19, min 13). 30 ručně označených vět (`p54b-sentence-mood.test.ts`): precision 1,0, recall 1,0 (36 štítků). Pozn.: měřeno nad commitem T3 (import riggovaných postav) – obsazení `d10` (pirát místo kostlivce) se od `census-t7.json` liší kvůli T3, ne kvůli T11.

**T4 (`census-t4.json`, riggované postavy pro výchozí a kategorijní hrdiny a nepřátele):** hrdina s kostrou 30/59 (51 %, dřív 18/59), nepřítel s kostrou 56/59 (95 %, dřív 1/59). Cíl hrdiny ≥ 60 % splněn není: zbylých 29 hrdinů jsou přesné identity se statickým modelem, pro které T3 postavu nemá (želva, astronaut, křeček, opice, zlatá rybka, medvěd, lenochod, sova, banán, předměty a jízdy) – nakreslit je liškou by porušilo pravidlo, že přesná identita vyhrává. Offline věrnost (`evals/play/fidelity`, korpus i judge-10) se nezměnila v žádné položce (korpus drawn 0,891, judge-10 0,73). Postava T3 stejného jména přebije statický model (liška, kuchař, doktor, babička, děda, zombie, drak, kráva, kůň…), kromě slov, kde je statický model přesnější (vědec, zdravotní sestra, lama, „dino“, zlobr).

**Kůže postav (oprava po T3, rozhodnuto bez majitele, vratné):** 46 lidí z Ultimate Animated Character má místo autorovy skoro černé kůže s bílýma očima (silueta, ve hře pro spotřebitele karikatura) přirozený odstín ze šesti (`SKIN_TONES` v `import-cc0.mjs`, od `#f2d0b1` po `#5a3622`, stálý podle id); zelená kůže skřetů a zombie zůstala a o vyřazení kvůli fialové dál rozhoduje paleta autora, takže sada 122 postav je stejná.

## Důkaz, že vzhled není v hashi

`src/play/arcade/__tests__/p54b-look-not-hashed.test.ts`: šest vět ze šesti žánrů, týž spec s jinou sadou, náladou, počasím a denní dobou postaví svět se stejným `canonicalHash`, stejným počátečním stavem a robot ho za 600 tiků dohraje se stejným hashem. Zelené na `5d741740`; mutace (`theme.look` přimíchaný do semínka v `arcadeWorldOf`) test zčervená. `theme` do hashe nevstupuje – architektura P54B platí.

## Snímky

```
node scripts/play-look-shots.mjs shots --base http://127.0.0.1:3351 --set genres --out evals/play/p54b/before
node scripts/play-look-shots.mjs shots --base http://127.0.0.1:3351 --set genres --profile pixel7 --out evals/play/p54b/before-phone
```

18 vět na žánr (`evals/play/p46g/genres.json`), tik 150, SwiftShader. `before/` 1280×800, `before-phone/` emulace Pixel 7 (scéna startuje na úrovni `low`). Build `5d741740` + T1 (jen komentáře), 19. 10. 2026.

**T8 (`landmark-t8.json`, orientační bod a rámující kusy):** `FALLBACK_SMOKE_URL=… LANDMARK_REPORT=evals/play/p54b/landmark-t8.json npx playwright test e2e/p54b-landmark.spec.ts` (1280×800, GPU, tik 150) – bod v záběru (≥ 50 % kvádru v obraze) u 16 z 18 snímků; mimo jsou aréna a agar (aréna 40 × 40 m pod kamerou 12 m a 40°: zem 25–60 m od kamery je vidět jen u stěny, ke které hrdina má blízko – robot do tiku 150 od ní odejde). Hrdina vidět ze 100 % u všech 18 (paprsky kamery na hrdinu, které bod ani kus nezakryje), kreslicích volání navíc 1–3 (kusy nevrhají stín). Rozhodnuto bez majitele: kamera, která jede (trať, aréna, bludiště), bod veze s sebou a rámující kusy nemá – 1–2 kusy jsou jen u pevné kamery a stojí u míče (2), hodu (1) a věže (2); střelnice, rytmus a ring žádné místo nemají (u kraje obrazu blíž než hrdina je jen mýtina, pruhy nebo ring); kandidáti jdou v pořadí ze semínka a strmá kamera vezme první, který se do záběru vejde.

## Balík modelů pro P54C (T12)

`model-requests.json` je pevný seznam žádostí P54C (12 položek), `model-pack.json` odpověď: 3–7 modelů na položku, slučované předměty 6 velikostí; id je stálé id scény, které `sceneModelOf(label, character)` vrátí, třída z `catalog-motion.json` (postavy s kostrou z manifestu), výška = doporučená výška těla ve scéně. Pinuje `src/play/assets/__tests__/p54b-model-pack.test.ts` (id, soubor v `public/`, třída, cesta z popisku). Všechno pokryl katalog, takže nic nového v `public/` ani v `disclosure.json`; dav jsou riggované postavy T3 s klipy idle a win. Rozhodnuto bez majitele: krtka katalog ani cache CC0 nemá a gen3d ho ve třech kolech nevyrobil (P45E a P45F soudce viděl prase nebo rejska, P45I neprošla brána), čtvrté kolo se nespouštělo – položku `mole` zastupují křeček, surikata a ježek (zvířata, která vylézají z nory); slovo „mole“ dál vede na nic a P54C má brát id z balíku.

## Výkon

**Základ zatím nezměřen.** 19. 10. 2026 běžel stroj na 100 % CPU (81 procesů Node, souběžné autopiloty): emulace Pixel 7 dala 18–20 FPS a pak 0,1 FPS (zamrzlý prohlížeč), takže běh byl zastaven a čísla se nezapsala. Výkonová brána se měří A/B hned po sobě proti buildu `features/P54B` na commitu T2 (vzhled beze změny), až bude stroj v klidu; `perf-before.json` vznikne tím prvním během.

- **T7:** perf A/B T7 odložen do klidného stroje (CPU 81 %). Výplň je proto střídmá: město hustota 0,22 bez linie v dálce (louka 0,45 se třemi vrstvami), interiéry 0,25 bez linie v dálce; každý druh je jedno kreslicí volání (nejvýš 11 na sadu, město 9).
- **T8:** perf A/B T8 odložen (CPU 82 %). Navíc 1–3 kreslicí volání na scénu (model gen3d = jedna síť, jeden materiál, bez stínu), místo bodu se hledá jednou při stavbě scény.
- **T9:** perf A/B T9 odložen (CPU 41–67 %, souběžná T10 ve stejném worktree – rozpracované typy by build neprošly a druhý prohlížeč by čísla zkreslil). Prstenec a rohové shluky arény se stěnami (g-arena, g-fight, g-quest; agar stěnu nemá a je beze změny) přidají nejvýš 6 kreslicích volání: 6 druhů z vegetace sady, každý jedna instancovaná síť bez stínu (`p54b-arena-ring.test.ts`). 45–83 kusů na arénu 40 × 40 m, 2–4 shluky; odlišných modelů výzdoby 8–9 (6 modelů prstence + 2–3 tvary výzdoby podlahy) přes 18 sad × 50 semínek.
- **T10:** perf A/B T10 odložen (CPU 30–100 %, kolísá se souběžnými autopiloty; základ `perf-before.json` zatím není). Život v pozadí přidá 1–2 kreslicí volání na scénu (druh = jedna `InstancedMesh` z jednoduchých tvarů bez stínu; louka 2, město, poušť a sníh 0); pohyb počítá jen vertex shader, CPU za snímek posune jednu skupinu za orientačním bodem. Kusů na `high`/`medium` 4–40 (ptáci 10, motýli 8, ryby 12, skákající ryby 4, netopýři 10, jiskry 24, prach 40, hvězdy 4), `low` polovinu. Umístění pinuje `p54b-ambient.test.ts` (10 kamer žánrů × 2 poměry × 15 sad: v záběru, za hrdinou, před koncem mlhy, celým rozkmitem v patě orientačního bodu – mimo plochu i kruh hrdiny); shader všech 8 druhů přeložen a vykreslen v headless Chromiu (SwiftShader), živá hra zatím nezkontrolována.
- **T15:** `perf-after.json` nevznikl – stroj 19. 10. ve 22–23 h na 58–100 % CPU (souběžné autopiloty P54A, P54C a dvou cizích projektů). Náhradní údaj, ne FPS: kreslicí volání ze snímků T15 proti T2 v emulaci telefonu +0 až +22 na scénu (medián +2; nejvíc úkol v hradu +22 a aréna +8, agar +9, kluzák +12), na desktopu medián +2. Brána ≥ 40 FPS a A/B ≥ −10 % zůstává neověřená a je podmínkou sloučení.

## Závěr MVP (T15, 19. 10. 2026, `8cf50b98`)

Snímky `after/` a `after-phone/` stejnými příkazy jako T2 (sada `genres`, tik 150, SwiftShader, `--out evals/play/p54b/after[-phone]`, telefon s `--profile pixel7`). Slepý soud:

```
node scripts/play-p46g-blind.mjs judge --dir evals/play/p54b --pass-at 15 --work D:/tmp/p54b-blind
node scripts/play-p46g-blind.mjs sheet --dir evals/play/p54b
```

Dvojice telefonu drží poměr stran (výška 1200 px); dřívější ořez na 960×600 by soudci nechal jen pruh ze středu. Tři odpovědi telefonu napoprvé chyběly (`claude.exe` ENOENT během aktualizace CLI ve 22:20) a byly položeny znovu; ostatních 33 je z prvního kola.

| Cíl | Naměřeno | |
|---|---|---|
| soud desktop ≥ 15/18 | **15/18** | splněno |
| soud telefon ≥ 15/18 | **10/18** | nesplněno |
| hrdina s kostrou ≥ 60 % | 30/59 = 51 % | nesplněno (beze změny od T4) |
| nepřítel s kostrou ≥ 40 % | 56/59 = 95 % | splněno |
| odlišné modely medián ≥ 15, min ≥ 10 | 19 / 13 | splněno |
| světlo u vět, které ho jmenují | 7/7 | splněno |
| FPS Pixel 7 ≥ 40, A/B ≥ −10 % | nezměřeno | stroj přetížený |
| sada, build, e2e, replay brána | zelené po opravě (níž) | splněno |

**Fakta ze soudu.** Desktop prohrál bludiště (jasně oranžová nízkopolygonová liška je vidět líp než riggovaná), flappy (chýše za trubkami „zakrývá ptáka“) a rytmus („tyrkysový předmět nad drahou“ – jeřáb města). Telefon prohrál osm: flappy („průsvitný strom v mezeře“), věž („monolit na věži“), rytmus („tmavá stavba“), přistání na Marsu („silo v záběru“), souboj rytířů („pochodeň zakrývá rytíře“), aréna (hrdina a liška si jsou podobní), plošinovka (bez konkrétní vady) a kluzák (oba snímky stejné, volba náhodná). Kde „po“ vyhrálo, důvodem je skoro vždy riggovaná postava („fox-shaped“, „wolves clearly shaped like wolves“), orientační bod nebo ptáci.

**Závěr (odvozeno).** Pět z osmi proher telefonu má jednu příčinu: orientační bod se hledá „nejblíž středu obrazu“ a z hry se vyhýbá jen kruhu hrdiny, ne obdélníku hracích předmětů na obrazovce. Na úzkém obrazu telefonu tak u pevné boční kamery stojí přímo za trubkami, věží nebo drahou; rámující kus u souboje se vyhýbá jen hrdinovi, ne soupeři. Test T8 (`p54b-landmark.spec.ts`) to nezachytí, protože měří jen desktop 1280×800 a zakrytí hrdiny. Oprava je v logice umístění, ne v datech – jde do plánu jako nález (`T15a`), stejně jako holá scéna kluzáku (`T15b`, „korálový útes“ bez útesu na obou snímcích, vada už před P54B). Čitelnost riggovaných postav na telefonu (aréna, bludiště) řeší T14.

**Hrdina s kostrou 51 %.** Data opravit nejde bez porušení „přesná identita vyhrává“: zbylých 29 hrdinů jsou přesné identity bez riggované postavy (křeček, želva, astronaut, sova, lenochod…) nebo volby návrhu mimo soubory tohoto plánu (želva u „obby“, závodní auto u „rytíř jede na jednorožci“, hrad z písku u „venčím psa“) – přesné párování model–věta je mimo rozsah P54B.

**Sada.** `vitest` celá (JSON, 15 159 testů): 15 150 zelených, 3 červené + 1 soubor. Skutečná regrese jedna – brand guard našel 8 řádků surového hexu v `look/Ambient.tsx` (T10); barvy přesunuty do palety `look/index.ts` (`8cf50b98`), guard i `p54b-ambient` zelené. Zbytek prostředí: `submission-check` (ENOENT `plans/P8-…` ve worktree), `swarm` časová mez 0,056 > 0,05 ms a `rules/coverage` – samy zelené; `golden` v replay bráně pod zátěží na 180 s, sám zelený. `npm run build` exit 0. E2E proti `next start` (`FALLBACK_SMOKE_URL`): `p32-look`, `interface-language`, `p54b-landmark`, `p54b-walk-clip` 11/11.

`sheet-all.png`: každá věta ve čtyřech snímcích – before, after, before-phone, after-phone.

## Závěr MVP po T15a (20. 10. 2026, `e5bbf7de`)

Oprava T15a ve dvou kolech. První (`43115a49`, `5d81db13`): bod i rámující kusy se v obraze vyhnou každé postavě a hracímu pásu žánru, ne jen hrdinovi. Soud po něm: desktop 14/18, telefon 13/18 – tři prohry způsobil bod sám: bludiště shora (stojící kámen „jako zbloudilý šedý sloup“), souboj (bod se vyhnul soupeři jen tam, kde začal; rytíři chodí po celém ringu) a přistání na telefonu (silo přes popředí). Druhé kolo (`3e121ad9`, `e5bbf7de`): kamera strmější než 62° bod nedostane, souboj hlídá celý ring do výšky rytířů, bod z obrazu většinou venku se nepostaví vůbec a cílová výška je třetina **kratší** strany obrazu (na telefonu na výšku dřív dvě třetiny šířky).

Snímky a soud stejnými příkazy jako T15, čistý `--work` (`D:/tmp/p54b-blind-t15a-2`):

| Cíl | T15 | po T15a |
|---|---|---|
| soud desktop ≥ 15/18 | 15/18 | **17/18** splněno |
| soud telefon ≥ 15/18 | 10/18 | **15/18** splněno |
| bod v záběru, desktop (`landmark-t15a.json`) | 16/18 (T8) | 13/18 – bez bodu záměrně aréna, agar, poletování, bludiště, souboj |
| bod v záběru, telefon (`landmark-t15a-phone.json`) | – | 9/18; pět dalších stálo dřív v obraze na 0 % a už se nestaví |
| hrdina nezakrytý | 100 % | 100 % na obou |

**Fakta ze soudu.** Desktop prohrál jen rytmus („LEFT has no unclear extra creature“ – tyrkysový tvor vlevo nahoře). Telefon prohrál arénu a bludiště (nízkopolygonová liška je čitelnější než riggovaná – T14) a souboj (snímky stejné, volba náhodná). Silo na Marsu soudce teď bere jako „Mars base structure adds a believable sense of place“.

**Výkon (20. 10. 2026, 1:52–2:45, CPU v klidu 11–17 % před během).** `perf` A/B hned po sobě, Pixel 7 CPU 4×, d3d11, 3 opakování po 10 s, sada `sentences` (12) i `genres` (18): build T2 `8c2f3a11` (`perf-before-*.json`) proti `e5bbf7de` (`perf-after-*.json`). Všech 30 scén ≥ 45 FPS (před 41,7–59) – brána ≥ 40 **splněna**. Medián rozdílu −0,5 %, kreslicích volání medián +3 (nejvýš +33). Horší než −10 % jsou dva řádky: `city-race` 53,6 → 45,3 (−15,5 %) a `g-shooter` 57,6 → 50,4 (−12,5 %) – brána A/B **nesplněna**; rozptyl opakování v jednom běhu je až ±10 %, takže potvrzení chce nové měření (nález `T15c`).

**Odvozeno.** Telefon prošel přesně na hraně a tři výhry jsou remízy téměř stejných snímků („picked only to break the tie“ – souboj na desktopu, poletování, rytmus na telefonu): opakovaný soud může dát 13–16. Skutečné zlepšení telefonu proti T15 nese hlavně bod, který už nestojí na hře (věž, poletování, přistání), a kluzák s útesem (T15b). Zbývající slabina je čitelnost riggovaných postav na telefonu – T14 (po MVP).

## Výkon po T15c (20. 10. 2026, 2:50–3:55, `ff19fb69`)

Obě scény znovu `perf --repeats 7`, A/B hned po sobě proti buildu T2 (`perf-t15c.json`):

| Scéna | potvrzení (`e5bbf7de`) | po opravě (`ff19fb69`) |
|---|---|---|
| `g-shooter` | 57,7 → 51,2 (−11,3 %) | 57,0 → 55,5 (**−2,6 %**) |
| `city-race` | 55,5 → 50,3 (−9,4 %) | 55,0 → 50,9 (**−7,5 %**) |

Brána A/B (žádný řádek horší než −10 %) je u obou scén **splněna**; ostatních 28 se po opravě neměřilo – oprava jen ubírá práci za snímek.

**Fakta.** Střelnice se potvrdila, město ne: v jeho profilu procesoru (CDP, 8 s hry) je nový build stejný jako T2 (34,2 proti 34,5 FPS), jedno opakování A/B dalo i +12 %. Střelnice v T15a kreslila **méně** volání (64 → 40), přesto potřebovala na snímek o 6–11 ms procesoru víc (profil 18–22 ms proti 25–33 ms). Příčinou je pět riggovaných zombií z T4 (dřív statický `cc0-zombie`): míchač animací +1,3 ms, přepočet matic kostí +2 ms, obrys, který každý snímek prochází podstrom každého těla, +0,8 ms, a dotaz `matchMedia` a čtení `?toy=` za každé tělo každý snímek ~1 ms.

**Rozhodnutí (bez majitele).** AC chtělo ztenčit příčinu jen na `low`; všechny tři opravy jsou bezeztrátové, platí proto na každé úrovni a nic ze scény neodešlo: klipy při načtení ztratí stopy, které kost celý klip drží v klidu (65–80 % stop Quaternius a KayKit; póza i prolnutí beze změny, test `p54b-rest-tracks` + mutace červená), dotaz na omezený pohyb a `?toy=` se čtou jednou, obrys dorovná obaly každý třetí snímek. Snímek střelnice proti T15a: 0,04 % pixelů jinak. E2E `p32-look` a `p54b-walk-clip` 7/7.
