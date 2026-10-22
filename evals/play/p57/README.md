# P57 – modely a světy v top kvalitě

Měření a soudy P57: které modely porotce vidí nejčastěji, jak je soudci hodnotí, co se přegenerovalo a jak vypadají scény 12 vět auditu před a po.

## Výchozí snímky (T1)

- **Věty:** `audit-12.json` – 12 vět auditu dema z 21. 10. 2026 (žába, zombie, ninja, žralok, pizza, kočka, brankář, drahokamy, astronaut, kuchař, bubeník, strašidelný dům).
- **Skript:** `node scripts/p57/snap-audit.mjs --base <url> --out <dir>` nad `npm run build` + `node node_modules/next/dist/bin/next start`.
- **Co fotí:** každou větu na desktopu 1280×800 a na telefonu 390×844 (dotykový Pixel 7 se zmenšenou plochou), ve 2 s a v 15 s ukázky robota – 48 PNG a `index.json`.
- **Čas je tik simulace, ne čas zdi:** 2 s = tik 120, 15 s = tik 900 (60 Hz, ruční hodiny `__playShell.byHand`). Snímek před a po výměně modelů tak ukazuje stejný herní stav a liší se jen vzhledem. Hra, která skončí dřív, se fotí v posledním tiku.
- **Jen plátno:** text stránky je skrytý, soudí se scéna a modely, ne rozhraní.
- **Kde leží:** `D:/caches/p57/baseline/` (commit `72665fdc`), po P57 `D:/caches/p57/after/`. Do repa nejdou, jsou velké.

## Použití modelů (T2)

`usage.json` z `node scripts/p57/usage-tally.mjs`: 227 scén (p30 dev, p54c dev, p55 holdout otevřený, 12 vět auditu; 5 vět mimo prohlížeč přeskočeno), 402 použitých modelů katalogu z 1 766. Top 300 podle počtu scén, vzorek 100 z ostatních (`pure-rand`, semínko 57). Riggované postavy (`rigged:*`) a primitiva jsou v `unknown` – P57 je neumí soudit ani vyměnit.

## Soud knihovny (T4)

`node scripts/p57/judge-library.mjs` → `judge.json` (21. 10. 2026, commit `d25870f8`).

- **Listy:** 45 mřížek 3×3 v pořadí použití, buňka = ¾ pohled, číslo a rozměry, žádné jméno. Modely, které hry ukazují hlavně jako vegetaci, mají šedé listí přebarvené na listí louky `#4f9a3a` jako ve hře (`plantPaint`); bez toho dostala šedá tráva a bříza 4 body za barvu, kterou hráč nevidí.
- **Soudci:** liché listy Codex, sudé Opus 5.5, každý desátý oba. Codex 28 volání (strop 30/den, počítadlo `codex-calls.json`, včetně 2 zkušebních listů). Každý soudce viděl jen `sheet.png` v prázdném adresáři.
- **Přečteno:** 400/400 modelů, žádná buňka `null`.
- **Shoda soudců:** 36 buněk překryvu, 36 s rozdílem ≤ 2 body (100 %), průměrný rozdíl 0,86 bodu. Brána 80 % prošla, kalibrace nebyla potřeba.
- **Rozdělení:** top 300 medián 6, průměr 5,97, pod 6: 124, aspoň 8: 73. Vzorek 100 medián 6, průměr 5,68, pod 6: 48, aspoň 8: 16.
- **Vstupy přegenerování:** `below6` 172 modelů (T6 bez top 50), `top50Below8` 41 z top 50 (T8).

**Inference:** nejpoužívanější modely jsou jen o málo lepší než ocas (5,97 proti 5,68), takže levný vzhled scén nejde na vrub pár výjimek, ale celé knihovny.

## Přegenerování pod 6 bodů (T6)

`node scripts/p57/regen.mjs --batch N` → `regen.json` (8 dávek, 21.–22. 10. 2026, commity `a5fb68dc` … `14a94908`).

- **Rozsah:** 151 modelů (`below6` bez top 50), 2 pokusy (zadání b se semínkem 1, pak zadání a se semínkem 2), zadání doplněné o opravu z důvodu soudce (`[judge_fix]` v `ops/gen3d/features.toml`). Kandidát se přeškáluje do starého boxu (rovnoměrně, nebo po osách, dokud poměr os nepřesáhne 1,5×) a zjednoduší tak, aby LOD1 nebyl těžší než starý.
- **Soud:** Opus 5.5 na mřížkách 3×3, stejná otázka jako v T4. Staré modely, které v T4 soudil jen Codex, Opus přesoudil na stejných listech, aby staré a nové skóre dal týž soudce.
- **Výsledek:** `replaced` 26 (17 v 1. pokusu, 9 ve 2.), `kept-old` 101, `rejected-bounds` 24 (16 %). Vyměněné modely v průměru z 4,46 na 6,81 bodu.
- **Po T6 pod 6 bodů:** 109 ze 151. 16 ponechaných starých modelů dostalo od Opuse při přesouzení 6 a víc (Codex jim v T4 dal o bod méně).
- **Odmítnuté na rozměry:** 16 %, pod hranicí 30 % z plánu, takže škálování v `finish_mesh.py` není potřeba – přeškálování do boxu už dělá `regen.mjs`; odmítnutí jsou tvary s poměrem os přes 1,5×. Na úrovni pokusů se do boxu nevešlo 84 z 216 kandidátů (39 %); model je odmítnutý, až když neprojde ani jeden z jeho pokusů.

**Inference:** TRELLIS.2 s opravou zadání zvedne jen asi šestinu slabých modelů; zbytek drží strop výchozího profilu (5 000 trojúhelníků, paleta) a starý box. Další zlepšení slabých modelů nepřijde z dalších semínek, ale z profilu hero (T8) nebo z jiného zdroje.

### Kdy GPU generovalo (pro FPS jiných plánů)

FPS naměřené v těchto oknech neplatí (pravidlo běhu). Časy UTC z `regen.json` `batches[*]`:

| Dávka | Začátek | Konec |
|---|---|---|
| 1 | 21. 10. 19:54 | 21. 10. 21:25 |
| 2 | 21. 10. 21:47 | 21. 10. 23:17 |
| 3 | 21. 10. 23:23 | 22. 10. 00:16 |
| 4 | 22. 10. 00:18 | 22. 10. 01:42 |
| 5 | 22. 10. 01:43 | 22. 10. 04:35 |
| 6 | 22. 10. 04:36 | 22. 10. 05:23 |
| 7 | 22. 10. 05:24 | 22. 10. 06:04 |
| 8 | 22. 10. 06:08 | 22. 10. 06:33 |

Souhrnně 21. 10. 19:54 až 22. 10. 06:33 UTC s pauzami nejvýš 22 minut. Před dávkou 2 proběhl a byl zahozen pokus s padlým ComfyUI (tentýž večer, mezi dávkami 1 a 2).

## Top 50 na 8+ (T8) – průběžně

Dávky 1–3 starým pravidlem (výměna jen se skóre ≥ 8 nad starým): vyměněno 5 z 30 (topol; vrba, branka, mlýn; lavička 9), top 50 na 8+: 15/50. Od dávky 2 zadání a, b, c, c (`c` = plné tvary bez tenkých dílů, pohled zepředu; mlýn vyhrál s `c`). Kolo 2 s opravou podle soudce přidalo 1 výměnu z 26 id. GPU generovalo 22. 10. 09:13–14:27 UTC (dávky 2–3).

### Oprava sítě místo zahození (T8r, bod 1) – nezapojena

Změřeno bez grafiky na 43 kandidátech dávek 1–3, které padly na bráně „inconsistent face winding“ (`D:/caches/p57/t8r-repair/report.json`): trimesh `merge_vertices` + `fix_winding` + `fix_normals` jich bránou pustí 36/43, ale do starého boxu se vejde jen 18 a Opus je na týchž slepých mřížkách 3×3 hodnotí průměrně 2,56 proti 5,79 u neodmítnutých kandidátů týchž id (o 3,0 bodu hůř, nejhůř −5; žádné z 9 srovnatelných id do 1 bodu, žádný opravený 8+). Příčina: ~32 % hran odmítnutých sítí sdílí víc než dvě plochy (u zdravých ~4 %) – brána zachytává skutečně roztrhanou síť, ne jen otočené plochy. Pravidlo plánu (≥ 1/3 projde **a** soud nespadne o víc než 1 bod) nesplněno → brána zůstává beze změny.
