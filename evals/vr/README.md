# Rozpočet snímku ve VR – Quest 2

`evals/vr/budget.mjs` projde všech 19 žánrů v emulátoru IWER (Quest 2, dvě oči) na produkčním buildu a zapíše `evals/vr/budget.json`. Každý žánr se publikuje z živé buňky, stránka s `?vr=1` vstoupí do VR a robot ověřovače hraje 600 tiků (10 s). Každých 30 tiků se zapíše jeden snímek:

- **draw cally a trojúhelníky** z `renderer.info`, obě oči dohromady (three kreslí každou síť jednou za oko);
- **paměť textur** na GPU: obal volání WebGL sčítá, co se opravdu alokovalo (textury i render buffery), `renderer.info` umí jen počet.

**Panely nad hrou (P67 T13):** po 10 s robot hru dohraje do konce a skript zapíše snímek s panelem výsledku, s kartou sdílení (až na ní stojí QR kód), s panelem „Comfort“, s lobby z „New game“ a s lobby a otevřenou 3D klávesnicí („Type“). Vzorky s panelem mají v souboru `panel`. Panely se ovládají jako v e2e: paprsek pravé ruky na střed tlačítka a spoušť.

**Obrazovky bez žánru:** `lobby` je „Enter VR“ na domově `/play` (karta lobby, pak s klávesnicí), `feed` je kolo karty feedu ve VR, výsledek s „Next“ a náhled další karty. Za oběma stojí tytéž tři hry z fixtur (běžec, flap, plošinovka) jako ve `vr-feed.spec.ts`, ať čísla nezávisí na obsahu úložiště. Náhled robota v nich běží na hodinách stránky, takže se mezi běhy smí lišit o pár volání.

FPS se tu neměří. GPU emulátoru je tohoto stroje, ne Questu; FPS z brýlí dává prohlídka `node scripts/quest-dev.mjs --port 3168 --cdp --tour 30` (`quest2-fps.json`, návod v `docs/vr/README.md`, bod 10).

```
npm run build
PLAY_STORE_DIR=D:/caches/p67/store node node_modules/next/dist/bin/next start -p 3168
node --experimental-strip-types --import ./scripts/ts-paths.mjs evals/vr/budget.mjs
```

`--genres runner.default,lobby` zúží běh na vyjmenované žánry a obrazovky (nezměřené zůstanou v `budget.json` z minulého měření), `--out` zapíše jinam, `--base` míří na jiný server (výchozí `http://127.0.0.1:3168`). `--table` jen vypíše řádky tabulek níž ze souboru, `--publish` jen publikuje hru každého žánru a vypíše jejich adresy (pro prohlídku v brýlích). Jeden prohlížeč naráz proti jednomu serveru. Prohlížeč běží bez OpenXR runtime počítače (`--disable-features=OpenXR`), brýle hraje IWER. Celý běh trvá asi 7 minut.

## Rozpočet

Rozpočet Questu 2 je **≤ 150 draw callů a ≤ 300 000 trojúhelníků za snímek** (`QUEST2_BUDGET` v `src/play/xr/quality.ts`). Je to inference z doporučení Mety pro Quest 2, upřesní ji ruční brána v brýlích (oddíl „Ruční brána“ níž).

`evals/vr/__tests__/budget.test.ts` spočte nejhorší snímek každého případu znovu ze vzorků v `budget.json` a selže, když je některý žánr, panel nad ním, lobby nebo feed nad rozpočtem, když soubor nemá všech 19 žánrů se všemi panely nebo když tabulky níž neodpovídají měření.

Měření 29. 10. 2026 (P67 T13), všech 19 žánrů v jejich režimech, Chromium s ANGLE D3D11 na GPU tohoto stroje. „Nejhorší“ je nejhorší snímek ze všech vzorků žánru (21 ze hry, 5 s panely). Další sloupce jsou volání / trojúhelníky nejhoršího snímku hry bez panelu a s jednotlivými panely. Hra s panelem je dohraná do konce, takže scéna pod ním bývá jiná (menší) než uprostřed hry:

| žánr | hraje se | nejhorší: volání | trojúhelníky | textury MB | hra | výsledek | sdílení s QR | Comfort | lobby s klávesnicí |
|---|---|---|---|---|---|---|---|---|---|
| `shooter.default` | native | 114 | 72946 | 53.7 | 114 / 72946 | 104 / 71038 | 104 / 71038 | 104 / 70886 | 104 / 70754 |
| `throw.default` | native | 108 | 41936 | 52.7 | 108 / 41936 | 32 / 37200 | 30 / 36008 | 30 / 36008 | 32 / 36012 |
| `whack.default` | native | 24 | 10360 | 51.7 | 24 / 8780 | 22 / 10360 | 18 / 8628 | 18 / 8628 | 20 / 8632 |
| `slice.default` | native | 58 | 12004 | 51.7 | 58 / 12004 | 36 / 10712 | 32 / 9080 | 32 / 9080 | 34 / 9084 |
| `arena.escape` | room | 40 | 98588 | 62.2 | 40 / 98588 | 32 / 67628 | 30 / 66928 | 30 / 66928 | 32 / 66932 |
| `catch.default` | room | 54 | 23716 | 51.7 | 54 / 23716 | 40 / 19532 | 36 / 18216 | 36 / 18216 | 38 / 18220 |
| `defense.default` | room | 88 | 51372 | 51.7 | 88 / 51372 | 86 / 44816 | 84 / 43728 | 84 / 43728 | 86 / 43732 |
| `runner.default` | surround | 48 | 114704 | 53.8 | 48 / 114704 | 26 / 80152 | 26 / 80152 | 26 / 80152 | 26 / 80152 |
| `platformer.default` | surround | 60 | 73294 | 52.8 | 60 / 73294 | 22 / 57176 | 20 / 57172 | 20 / 57172 | 22 / 57176 |
| `flap.default` | surround | 64 | 26056 | 52.7 | 64 / 26056 | 18 / 7592 | 16 / 7588 | 16 / 7588 | 18 / 7592 |
| `voyage.race` | surround | 54 | 286270 | 52.7 | 54 / 286270 | 24 / 239688 | 22 / 239684 | 22 / 239684 | 24 / 239688 |
| `hop.default` | surround | 46 | 175252 | 55.4 | 46 / 175252 | 34 / 118260 | 32 / 118256 | 32 / 118256 | 34 / 118260 |
| `crowd.default` | surround | 48 | 43512 | 53.9 | 48 / 43512 | 36 / 42360 | 34 / 42356 | 34 / 42356 | 36 / 42360 |
| `timing.stack` | diorama | 60 | 19452 | 52.8 | 40 / 18860 | 60 / 19452 | 60 / 19408 | 60 / 19140 | 60 / 19080 |
| `rhythm.default` | diorama | 48 | 22686 | 52.8 | 48 / 21974 | 46 / 22686 | 44 / 21894 | 44 / 21894 | 46 / 21898 |
| `duel.default` | diorama | 42 | 23036 | 52.8 | 42 / 22588 | 42 / 23036 | 40 / 21884 | 40 / 21884 | 42 / 21888 |
| `quest.spatial` | diorama | 76 | 104414 | 63.5 | 76 / 104414 | 70 / 97194 | 70 / 96990 | 68 / 96434 | 70 / 96438 |
| `merge.default` | diorama | 52 | 45552 | 52.8 | 52 / 45012 | 48 / 45552 | 46 / 45548 | 46 / 45548 | 48 / 45552 |
| `push.default` | diorama | 38 | 28240 | 52.8 | 38 / 26660 | 38 / 28240 | 30 / 17332 | 30 / 17332 | 32 / 17336 |

Obrazovky bez žánru (nejhorší snímek; lobby s kartou i s klávesnicí, feed s kolem, výsledkem a náhledem další karty):

| obrazovka | | volání | trojúhelníky | textury MB |
|---|---|---|---|---|
| `lobby` | screen | 56 | 82664 | 54.3 |
| `feed` | screen | 78 | 82660 | 40.7 |

Nejvíc draw callů má střílečka (114 ze 150), nejvíc trojúhelníků závod `voyage` (286 tisíc z 300, rezerva 4,6 %). Když brány v brýlích rozpočet zpřísní, začíná se u závodu. Panely nad hrou stojí od T13 jen 2–6 volání (oddíl „Co profil sráží“, bod 9); `timing.stack` má s panelem víc volání než ve hře, protože dohraná věž je vyšší než po 10 s.

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
9. **Tlačítka panelů v klidu jsou kresba na kartě (P67 T13).** Každé tlačítko panelu bylo vlastní síť s vlastní texturou, tedy 2 volání (obě oči) na tlačítko. Lobby z „New game“ s otevřenou klávesnicí (43 kláves) nad střílečkou mělo 194 volání, nad questem 158 – nad rozpočtem. Teď `XrPanel.tsx` nakreslí tlačítka v klidu do textury karty a síť tlačítka kreslí, jen když na něm je paprsek nebo je stisknuté. Paprsek síť najde i neviditelnou (`material.visible` řídí jen kresbu). Táž střílečka s klávesnicí má 104 volání, lobby na domově 142 → 56.

## Co emulátor neměří

- **FPS.** Rozhodují brýle (ruční brána).
- **`framebufferScaleFactor` a foveace.** IWER kreslí do plátna stránky a obojí přejde. Profil začíná na 1,0 (výchozí rozlišení prohlížeče Questu). Ruční brána porovná na brýlích s `?vrscale=0.8` (rozsah 0,8–1,0). Lepší FPS při 0,8 a čitelné panely = profil se přepne na 0,8.
- **Plnění pixelů** (průhledné částice, mlha, velké plochy). Draw cally a trojúhelníky jsou práce CPU a vrcholů, ne pixelů.

## FPS v brýlích (P67 T13)

`node scripts/quest-dev.mjs --port 3168 --cdp --tour 30` projde všech 19 žánrů v Questu 2 a zapíše `quest2-fps.json`. `budget.test.ts` z něj, když říká `connected: true`, přepočítá medián a 5. percentil každého žánru ze vzorků po sekundách a hlídá medián ≥ 72 a 5. percentil ≥ 65.

29. 10. 2026: neměřeno – brýle nepřipojené/nenasazené, měří se v T15. Brýle byly na USB s povoleným laděním, ale spaly (`mWakefulness=Asleep`), nikdo je neměl na hlavě. Skript je nebudil (po probuzení bez člověka drží popředí systémový dialog), nic nepřesměroval a zapsal důvod do souboru.

## Celá smyčka v jedné relaci (P67 T14 a T14a, 29. 10. 2026, emulátor)

`e2e/vr-loop.spec.ts` projde v IWER (Quest 2) celé kolo v jedné XR relaci v pořadí z cíle plánu (od T14a): `/play` → „Enter VR“ → lobby → karta → „Make it!“ → hra → robot vyhraje → „Again“ → „Next“ → feed (robot první karty v brýlích hned) → spoušť → „Next“ → páčka zpět → „New game“ → klávesnice „zombies attack my house“ → „Make it!“ → hra → „AI version ready“ → „Play it“ → AI verze z fixtur → výhra → „Share“ → QR kód s výzvou. Okno 800 × 900, kde feed leží pod formulářem. Po každém kroku test ověří, že stránka si o relaci řekla jednou, žádná neskončila a renderer dál bere snímky od téhož objektu `XRSession`.

Tři běhy samostatně (T14a), všechny zelené. Čas od začátku testu (ms, kumulativně):

| krok | běh 1 | běh 2 | běh 3 |
|---|---|---|---|
| ve VR (lobby) | 2 394 | 2 435 | 2 382 |
| hra z karty lobby | 4 020 | 4 329 | 4 343 |
| „Again“ | 6 139 | 6 254 | 6 332 |
| „Next“ do feedu | 9 131 | 8 802 | 9 238 |
| „Next“ a zpět | 11 549 | 11 015 | 11 667 |
| hra z klávesnice | 17 553 | 17 275 | 17 627 |
| AI verze | 20 229 | 19 775 | 20 522 |
| QR kód sdílení | 27 461 | 30 014 | 27 780 |

Do T14a kolo začínalo ve feedu („Enter VR“ na kartě), protože ze hry z věty do feedu cesta nevedla; tři běhy T14 měly 30,0–30,4 s.

- **Klávesnice:** 23 stisků (věta „zombies attack my house“) ~6 s, tedy ~0,25 s na klávesu včetně míření. Člověk v brýlích bude pomalejší; to emulátor neměří.
- **QR kód** se ukazuje 7–10 s po výhře: výsledek 2D výzvu po výhře uložil a strop 1 výzva / 10 s VR chvíli odmítá (`docs/vr/README.md`, „Sdílení z VR“).
- **Útrata 0:** feed a AI verze jsou hry z fixtur, každý dotaz na AI verzi (`GET …/upgrade`) odpověděl test. Kromě čtení stránka poslala jen dvě rychlé hry z vět, uložení výzvy a události.

## Ruční brána

Zapíše majitel po kole v brýlích (návod `docs/vr/README.md`, „Kolo majitele v brýlích“): `Ruční brána P67: OK <datum>`, nebo seznam vad (co, ve které hře, jak se to projevilo).
