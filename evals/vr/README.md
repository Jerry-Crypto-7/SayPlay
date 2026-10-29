# Rozpočet snímku ve VR – Quest 2

`evals/vr/budget.mjs` projde všech 19 žánrů v emulátoru IWER (Quest 2, dvě oči) na produkčním buildu a zapíše `evals/vr/budget.json`. Každý žánr se publikuje z živé buňky, stránka s `?vr=1` vstoupí do VR a robot ověřovače hraje 600 tiků (10 s). Každých 30 tiků se zapíše jeden snímek:

- **draw cally a trojúhelníky** z `renderer.info`, obě oči dohromady (three kreslí každou síť jednou za oko);
- **paměť textur** na GPU: obal volání WebGL sčítá, co se opravdu alokovalo (textury i render buffery), `renderer.info` umí jen počet.

FPS se tu neměří. GPU emulátoru je tohoto stroje, ne Questu; FPS z brýlí dává ruční brána T8 (`quest2-fps.json`, panel `?vrhud=1`).

```
npm run build
PLAY_STORE_DIR=D:/caches/p65/store node node_modules/next/dist/bin/next start -p 3165 -H 127.0.0.1
node --experimental-strip-types --import ./scripts/ts-paths.mjs evals/vr/budget.mjs
```

`--genres runner.default,shooter.default` zúží běh (nezměřené žánry zůstanou v `budget.json` z minulého měření), `--out` zapíše jinam, `--base` míří na jiný server. Jeden prohlížeč naráz proti jednomu serveru. Prohlížeč běží bez OpenXR runtime počítače (`--disable-features=OpenXR`), brýle hraje IWER. Skript na konci vypíše řádky tabulky níž.

## Rozpočet

Rozpočet Questu 2 je **≤ 150 draw callů a ≤ 300 000 trojúhelníků za snímek** (`QUEST2_BUDGET` v `src/play/xr/quality.ts`). Je to inference z doporučení Mety pro Quest 2, upřesní ji ruční brána T8 v brýlích.

`evals/vr/__tests__/budget.test.ts` spočte nejhorší snímek každého žánru znovu ze vzorků v `budget.json` a selže, když je některý žánr nad rozpočtem, když soubor nemá všech 19 žánrů nebo když tabulka níž neodpovídá měření.

Měření 27. 10. 2026, Chromium s ANGLE D3D11 na GPU tohoto stroje, nejhorší snímek z 21 vzorků. Aréna, chytání a obrana změřené znovu 29. 10. 2026 (P67 T6) ve svém novém režimu kolem hráče (`room`, hlava rovně). Šest tratí změřené znovu 29. 10. 2026 (P67 T7) na pódiu (`surround`, hlava se dívá na střed pódia):

| žánr | hraje se | draw cally | trojúhelníky | textury MB |
|---|---|---|---|---|
| `shooter.default` | native | 110 | 47806 | 58.4 |
| `throw.default` | native | 112 | 50304 | 54.6 |
| `whack.default` | native | 26 | 8784 | 57.4 |
| `slice.default` | native | 60 | 12012 | 57.4 |
| `arena.escape` | room | 44 | 103328 | 60.0 |
| `catch.default` | room | 56 | 23720 | 57.4 |
| `defense.default` | room | 90 | 51376 | 57.4 |
| `runner.default` | surround | 50 | 114708 | 56.7 |
| `platformer.default` | surround | 62 | 68562 | 55.7 |
| `flap.default` | surround | 66 | 26060 | 55.7 |
| `voyage.race` | surround | 54 | 281438 | 55.0 |
| `hop.default` | surround | 48 | 175256 | 56.4 |
| `crowd.default` | surround | 50 | 43516 | 56.2 |
| `timing.stack` | diorama | 46 | 23708 | 55.7 |
| `rhythm.default` | diorama | 52 | 22082 | 55.7 |
| `duel.default` | diorama | 44 | 22592 | 55.7 |
| `quest.spatial` | diorama | 74 | 74630 | 60.4 |
| `merge.default` | diorama | 54 | 45016 | 55.0 |
| `push.default` | diorama | 40 | 26660 | 55.0 |

Nejvíc draw callů má hod (112 z 150), nejvíc trojúhelníků závod `voyage` (281 tisíc z 300, rezerva 6 %). Když T8 rozpočet zpřísní, začíná se u něj.

**Pódium tratí (T7) proti stolu:** trojúhelníky skoro stejné (závod 281 438 proti 281 754 na stole 1:27, běžec 114 708 proti 119 112), draw callů o 2–22 víc. Pódium vidí víc trati, a přesto trojúhelníků nepřibylo – nejspíš je nese terén a trať, které okno protínají v obou případech (zvlášť neměřeno). Jistě přibyla podlaha okolí (2 volání, obě oči) a vinětace (2 volání, jen když svět jede). Nejvíc přidaly flap (50 → 66) a plošinovka (40 → 62); odhad: na pódiu 1:8 je vidět víc trubek a plošin než na stole 1:12–1:14. Srážet nebylo třeba.

## Před profilem a po něm

Týž skript na kódu před T6 (`e21ae519`) a po něm. Draw cally / trojúhelníky nejhoršího snímku:

| žánr | před T6 | bez skládače a stínů | profil T6 celý |
|---|---|---|---|
| shooter | 1182 / 4,10 mil. | 270 / 1,08 mil. | 110 / 48 tis. |
| throw | 360 / 2,16 mil. | 140 / 802 tis. | 112 / 50 tis. |
| runner | 982 / 29,4 mil. | 106 / 1,50 mil. | 46 / 119 tis. |
| platformer | 734 / 4,89 mil. | 132 / 906 tis. | 40 / 67 tis. |
| flap | 1164 / 395 tis. | 124 / 53 tis. | 50 / 21 tis. |
| arena | 270 / 3,32 mil. | 104 / 1,56 mil. | 48 / 72 tis. |
| voyage | 560 / 1,11 mil. | 234 / 485 tis. | 52 / 282 tis. |
| quest | 314 / 3,50 mil. | 128 / 1,55 mil. | 74 / 75 tis. |

Ostatních 11 žánrů bylo pod rozpočtem už po vypnutí skládače a stínů. Paměť textur klesla ze 104–109 MB na 55–60 MB: skládač v relaci nemění velikost svých cílů na rozlišení brýlí.

## Co profil sráží

Profil platí jen v relaci VR (`src/play/xr/quality.ts`, `XrRoot.tsx`, `XrCull` v `XrRig.tsx`); 2D se nemění.

1. **Skládač postprocessingu nekreslí.** Ve VR kreslil celou scénu podruhé a k tomu AO, bloom a SMAA v rozlišení brýlí, a výsledek stejně přemazala přímá kresba (stereo by rozbil). To byla většina volání.
2. **Žádné stíny.** Světla ve VR stín nevrhají, stínový průchod nekreslí kulisy ještě jednou.
3. **Bez vegetace.** Rostliny si vybírají podle kamery hry ve 2D; ve VR bez stínového průchodu kreslily všechny rostliny svého okna, 0,74–1,37 milionu trojúhelníků za snímek. Oprava patří do `look/Vegetation.tsx` (P62), pak se vegetace může vrátit.
4. **Kulisy mimo desku (diorama i pódium tratí).** Síť, která leží celá mimo prostor nad deskou, by roviny řezu stejně ořízly. Závod tak kreslil 162 ze 184 volání kulis zbytečně.
5. **Prstenec rostlin za stěnami arény.** Na desce leží celý za rovinami řezu, stál 175–213 tisíc trojúhelníků. V aréně kolem hráče (P67 T6) vidět je, ale s ním měla aréna 316 656 trojúhelníků, nad rozpočtem; bez něj 103 328. Za stěnami místo něj leží podlaha okolí v barvě země sady.
6. **Obrysy nepřátel.** Každý díl postavy kreslily podruhé. Obrys hrdiny zůstává.
7. **Sloučení stejných sítí.** Aspoň 4 sítě se stejnou geometrií a materiálem kreslí jedna instancovaná síť. Šest dílů každého nepřítele střílečky tak stojí 6 volání na oko, ne 6 × počet nepřátel.
8. **Strop částic** 500 jako telefon na `low`, pevná foveace 1, frekvence nejblíž 72 Hz.

## Co emulátor neměří

- **FPS.** Rozhodují brýle (T8).
- **`framebufferScaleFactor` a foveace.** IWER kreslí do plátna stránky a obojí přejde. Profil začíná na 1,0 (výchozí rozlišení prohlížeče Questu). T8 porovná na brýlích s `?vrscale=0.8` (rozsah 0,8–1,0). Lepší FPS při 0,8 a čitelné panely = profil se přepne na 0,8.
- **Plnění pixelů** (průhledné částice, mlha, velké plochy). Draw cally a trojúhelníky jsou práce CPU a vrcholů, ne pixelů.

## Ruční brána T8

Zapíše majitel po kole v brýlích (návod `docs/vr/README.md`): `Ruční brána T8: OK <datum>`, nebo seznam žánrů s vadou.
