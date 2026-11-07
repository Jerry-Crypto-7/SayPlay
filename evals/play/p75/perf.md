# P75 T7 – výkon telefonu a první snímek

Měřeno 7. 11. 2026. **A** = `main` `e8998770` (P74, bez P75; worktree `D:/caches/p75/main`, vlastní build, port 3207), **B** = větev `c1a9f225` po T6 (port 3206). Oba produkční build (`next start`), lokálně, bez modelu.

## Výsledek

| Brána | Mez | Výsledek |
|---|---|---|
| FPS telefonu, medián | ≥ 40 u všech 8 her | **drží** – nejnižší B 43,8 (sopka) |
| p95 doby snímku telefonu | ≤ 33,4 ms nebo stejné jako `main` | **drží** – B nejvýš 33,4 ms |
| věta → hra, desktop | medián B ≤ 3,0 s, párově ≤ +0,2 s | **drží** – 2,95 s, párově +0,08 s |
| věta → hra, telefon | párově ≤ +0,2 s | **nedrží** – párově +0,58 s, závod pod vodou 3/3 nehratelný |
| věta → hra, telefon po T7b | párově ≤ +0,2 s, 0 selhání | **těsně nedrží** – párově +0,215 s; závod pod vodou 1× nehratelný na A i na B (viz oddíl T7b) |

## FPS telefonu

`scripts/play/p73d-perf.mjs`, data `perf-fps.json`. Pixel 7, okno 390×844, CPU 4×, ANGLE d3d11, OpenXR vypnuté; 4 opakování prokládaně A B, B A; 10 s ukázky robota. Mediány:

| Hra | FPS A | FPS B | p95 A (ms) | p95 B (ms) | volání A → B | kvalita B |
|---|---|---|---|---|---|---|
| honička město (s3) | 56,7 | 55,3 | 16,8 | 33,3 | 90 → 94 | 4× medium |
| quest hrad (s8) | 46,6 | 46,5 | 33,4 | 33,4 | 89 → 81 | 3× medium, 1× low |
| závod pod vodou (s2) | 47,5 | 46,8 | 33,4 | 33,4 | 108 → 108 | 4× medium |
| stohování (s4) | 58,7 | 56,4 | 16,8 | 33,3 | 68 → 67 | 4× medium (A 3× high) |
| golf (s7) | 54,5 | 54,3 | 33,3 | 33,3 | 69 → 66 | 4× medium |
| chytání (s10) | 59,2 | 58,4 | 16,8 | 16,8 | 49 → 49 | 2× medium, 2× high |
| běh sopka (s1) | 43,1 | 43,8 | 33,4 | 33,4 | 69 → 58 | 3× low, 1× medium |
| plošinovka (s5) | 48,1 | 46,6 | 33,4 | 33,4 | 84 → 83 | 4× medium |

- B ztrácí nejvýš 2,3 FPS (stohování), sopka je o 0,7 FPS rychlejší (T6 vyndal kužele sopek, volání 69 → 58).
- p95 33,3–33,4 ms = dva takty 60 Hz (viz P73D `evals/play/p73/sceny/perf.md`). Honička a stohování mají na B p95 na dvou taktech, na A na jednom; mez 33,4 ms drží.
- Stohování: A třikrát vystoupalo na `high`, B zůstal na `medium` – P75 na telefonu snímek o kus zdražuje (rozostření 6 vzorků, husté popředí), FPS ale drží.

## Věta → hra

`scripts/measure/first-playable-ab.mjs`, nastavení `first-playable.config.json`, data `perf-first-playable.json`. Stejných 8 vět psaných na `/play`, desktop 1280×720 a Pixel 7 CPU 4×, 3 běhy na větu a stranu, dvojice A+B se střídáním pořadí. 93/96 běhů hratelných.

| Profil | Metrika | A medián | B medián | B − A párově |
|---|---|---|---|---|
| desktop | hratelná | 2 640 ms | 2 953 ms | +81 ms |
| desktop | první snímek | 1 786 ms | 1 933 ms | +58 ms |
| telefon | hratelná | 8 027 ms | 8 575 ms | **+580 ms** |
| telefon | první snímek | 5 076 ms | 5 189 ms | **+614 ms** |

Telefon po hrách (medián 3 běhů, hratelná / první snímek, ms):

| Hra | A | B | rozdíl |
|---|---|---|---|
| honička město | 7 766 / 4 575 | 8 575 / 5 152 | +809 / +577 |
| quest hrad | 8 925 / 5 505 | 9 342 / 6 155 | +417 / +650 |
| závod pod vodou | 10 634 / 5 387 | 3× nehratelný | – |
| stohování | 6 717 / 4 486 | 7 259 / 5 009 | +542 / +523 |
| golf | 6 097 / 3 752 | 6 597 / 4 254 | +500 / +502 |
| chytání | 6 933 / 4 741 | 6 765 / 4 783 | −168 / +42 |
| běh sopka | 9 767 / 6 166 | 10 117 / 6 809 | +350 / +643 |
| plošinovka | 8 245 / 5 384 | 9 301 / 6 092 | +1 056 / +708 |

## Rozbor

**Fakta:**
- **Samotná stránka hry na B pomalejší není.** CPU profil od navigace na `/play/<id>` po první snímek (plošinovka, Pixel 7 CPU 4×, 4× prokládaně): první snímek A 5 519 / 5 317 / 5 126 / 5 240 ms, B 3 728 / 3 827 / 5 242 / 5 095 ms; čekání na překlad shaderů (`getProgramInfoLog`) A 365 ms, B 185 ms.
- **Zpoždění vzniká na přechodu z `/play` do hry.** HAR honičky (telefon, běh 1): odeslání věty → navigace do hry A 1 988 ms, B 1 993 ms (server stejně rychlý); navigace → start hry (`/api/play/events`) **A 550 ms, B 1 044 ms**.
- Na B si těsně před navigací stáhne `/play` vlastní obraz oblohy `diorama-meadow-low.webp` (6 018 ms od načtení stránky, navigace 6 087 ms). `/play` už na A stahuje modely a panoramata her z feedu (`/api/play/games/<id>` ×3, `.glb`, `env/*.webp`), tedy kreslí 3D scénu hry; obraz oblohy se v ní stahuje až po jejím prvním snímku (`paintFade`, snímek 2).
- **Závod pod vodou 3/3 nehratelný jen v A/B běhu.** Samostatně stejná sonda (stejná věta, telefon, i s HAR a `surfaceSelector: canvas`) najde hru na B hratelnou za 11,0 a 10,9 s (A v A/B běhu 10,3–10,7 s, vždy 3. pokus). Hra vstup přijímá na A i B stejně (klepnutí + mezerník + šipka: `data-inputs` roste od 1. pokusu).

**Inference:** sonda odešle větu hned po načtení `/play`, takže přechod do hry trefí právě rozjezd scény na `/play` (stažení obrazu, nahrání textury, 0,8 s prolínání s překreslováním). Cenu na telefonu nese ten rozjezd (P75 vzhled v ní: malovaná obloha po prvním snímku, rozostření, husté popředí), ne první snímek hry. Selhání závodu v A/B běhu je nejspíš tentýž souběh (pokusy sondy se trefují do okna, kdy počítadla ještě nerostou), ne chyba hry – samostatně se nezopakovalo. Ověří až oprava rozjezdu a nové měření.

**Další krok:** směrovaný úkol T7b v plánu – malovanou oblohu (a dražší vrstvy P75) nestartovat v náhledech feedu na `/play`, jen ve hře; pak znovu `first-playable-ab.mjs` jen na telefonu (`first-playable.config.json` s `profiles: ["pixel7-cpu4"]`). Dokud T7b nedoběhne, brána „telefon ≤ `main` + 0,2 s“ **neplatí**.

## T7b – náhled feedu na telefonu bez malované oblohy

**Změna:** jeviště v kartě feedu (`[data-testid="feed-card"]`) na telefonu (startovní úroveň `low`/`medium`) malovaný obraz nestahuje ani neprolíná; zůstává dnešní obloha. Desktop feed a hra beze změny. Ověřeno sondou (Pixel 7, `/play` a `/play/<id>`, požadavky na `/play/env/diorama-*`): telefon feed 0 obrazů, desktop feed `diorama-meadow.webp`, telefon hra `diorama-meadow-low.webp`.

**Měření:** `first-playable-ab.mjs` s `first-playable-t7b.config.json` (jen `pixel7-cpu4`, stejných 8 vět, 3 běhy na větu a stranu), data `perf-first-playable-t7b.json`. A = `main` `e8998770` (port 3207, týž build jako T7), B = větev po T7b (port 3206). Sonda po 33 ze 48 běhů spadla bez hlášky; zbylých 15 běhů doběhlo stejným pořadím přes obal, který pád sondy zapíše jako selhání (žádný nenastal), souhrn je stejné funkce skriptu (`summarize`, `gate`).

| Metrika | A medián | B medián | B − A párově | T7 párově |
|---|---|---|---|---|
| hratelná | 7 349 ms | 7 500 ms | **+215 ms** | +580 ms |
| první snímek | 4 558 ms | 4 706 ms | +113 ms | +614 ms |

Po větách (párově, hratelná): honička +106, quest +312, závod pod vodou +384 (2 páry), stohování −30, golf +409, chytání +152, sopka +272, plošinovka +131. Jednotlivé páry kolísají od −1 317 do +1 093 ms.

**Fakta (HAR všech 48 běhů):**
- **Přechod `/play` → hra je teď na obou stranách stejný:** navigace → start hry (`/api/play/events`) medián A 588 ms, B 579 ms (v T7 550 proti 1 044 ms).
- Odeslání věty → navigace A 2 485, B 2 561 ms; start hry → hratelná A 4 224, B 4 140 ms. Žádný úsek není na B soustavně pomalejší.
- Malovaný obraz se na `/play` před navigací stáhl v 1 ze 24 běhů B (`diorama-city-low.webp`, stohování); jednou ho sonda viděla i na čerstvě spuštěném serveru bez věty. Které jeviště ho chce, se nepodařilo zachytit – ve všech kontrolách DOM bylo jediné jeviště v kartě feedu.
- **Závod pod vodou:** nehratelný v 1. běhu na A i na B (stejná hláška: plocha se mění, hra vstup nepřijala), 2. a 3. běh hratelné na obou. Selhání tedy není z P75.

**Inference:** příčina z T7 (rozjezd malované oblohy v náhledu na `/play` ve chvíli odeslání věty) je pryč – přechod do hry je stejně rychlý jako na `main`. Zbylých +215 ms je rozložených po hrách a v úsecích se neukáže; nejspíš je to dražší scéna hry samotné (husté popředí, rozostření) ve spojení s šumem párů. Mez +200 ms o 15 ms nedrží a brána „0 selhání“ nedrží kvůli závodu, který selhává stejně i na `main`.

**Další krok:** podle plánu se pokračuje T8. Kdyby majitel chtěl mez telefonu držet přesně, další páka je ve hře (husté popředí nebo rozostření na telefonu), ne na `/play` – to T7b měnit nesmělo.
