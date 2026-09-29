# P32 baseline – čas do ovladatelné hry na dnešním kódu

**Kód:** `features/p32d-measure` @ `73713cd0` (před sloučením `p32-base`), `next start` (webpack build), offline – živý režisér se nevolal, měří se rychlá verze.
**Sada:** `evals/play/p32/baseline-sentences.json` (9 vět, lokální kopie sady P32-0 T7).
**Běhy (29. 9. 2026):**
- `runs/baseline/` – čistý Chromium, desktop 1280×720 bez zpomalení, telefon Pixel 7 se 4× zpomaleným CPU, FPS 20 s.
- `runs/baseline-loaded/` – totéž, ale desktop se 6× zpomaleným CPU (napodobí přetížený prohlížeč). Telefon zůstává na 4×, FPS jen 1 s, proto se FPS z tohoto běhu neuvádí. Snímky obrazovky z něj nejsou v gitu, ukazují tutéž scénu.

## Odpověď: 15–20 s z 29. 9. je přetížený prohlížeč, ne kód

- **Fakt:** na čistém Chromu je každá z 9 her ovladatelná za 0,3–1,0 s od kliknutí (medián 0,67 s). Studené otevření odkazu hry (od začátku navigace) 0,47–0,87 s. Žádná věta se 3 s ani nepřiblíží.
- **Fakt:** se 6× zpomaleným CPU trvá totéž 6,6–13,1 s od kliknutí (medián 11,8 s).
- **Fakt:** ani pod zátěží nečeká stránka na síť déle než 0,64 s: vytvoření hry (`POST /api/play/games`) doběhne do 0,46 s a data stránky hry do 0,64 s. Dalších 5–9 s se po síti nic neděje (první GLB startuje v 6,4–9,8 s). Ten čas je práce procesoru: spuštění JS, vykreslení Reactu, stavba scény.
- **Inference:** čas roste zhruba úměrně zpomalení CPU. 15–20 s tedy odpovídá prohlížeči zhruba 8–10× pomalejšímu než čistý, což stroj s buildem, Playwrightem a několika worktree najednou udělá. Kód zátěž zhoršuje hlavně u mřížkových her, viz níže.

## Po větách (ms)

„Ovladatelná“ = první vstup hráče, který hra zpracovala (sonda `arcade-stage` u arkádových her, záznam vstupů mřížky `grid-input-log` u ostatních). „První snímek“ = první vykreslení WebGL na plátně nové hry. Telefon měří jen studené otevření odkazu, první snímek.

| věta | sonda | kliknutí → ovladatelná | kliknutí → první snímek | studené otevření: ovladatelná / první snímek | telefon: první snímek | FPS telefon | zátěž 6×: kliknutí → ovladatelná | zátěž 6×: první snímek | zátěž 6×: studené otevření |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| penguin | grid-input-log | 767 | 951 | 870 / 1112 | 4318 | 58 | 11571 | 9122 | 7292 / 7481 |
| firefighter | grid-input-log | 880 | 1034 | 579 / 802 | 4656 | 52 | 12121 | 9098 | 4968 / 6753 |
| wizard | grid-input-log | 787 | 725 | 689 / 943 | 4780 | 59 | 12730 | 9976 | 10996 / 7885 |
| pirate | grid-input-log | 994 | 937 | 519 / 746 | 5499 | 57.1 | 12429 | 9579 | 11775 / 8212 |
| cat | grid-input-log | 667 | 816 | 556 / 742 | 4535 | 47.2 | 13078 | 9343 | 10437 / 6752 |
| chef | grid-input-log | 488 | 687 | 473 / 677 | 3613 | 60 | 11822 | 9428 | 4875 / 6676 |
| dog | arcade-stage | 353 | 329 | 522 / 503 | 1773 | 60 | 6930 | 6611 | 4164 / 3788 |
| knights | arcade-stage | 581 | 258 | 479 / 441 | 2224 | 58 | 6663 | 6223 | 4185 / 3981 |
| rocket | arcade-stage | 299 | 282 | 482 / 439 | 1821 | 59 | 6586 | 6377 | 3978 / 3639 |
| **medián** | | 667 | 725 | 522 / 742 | 4318 | 58 | 11822 | 9122 | 4968 / 6752 |

Snímky rychlé verze: `runs/baseline/<věta>-draft-desktop.png` a `<věta>-draft-phone.png`. Scéna je na všech vidět, žádný není černý. Barvu úplně prvního snímku baseline neměří, to přidá T6.

## Fáze načítání od kliknutí (síťový log)

Okna jsou mediány přes 9 vět: začátek první a konec poslední žádosti dané fáze, v ms od kliknutí na „Play it“.

| fáze | čistý Chrome | zátěž 6× | co v ní je |
|---|---|---|---|
| HTML | – | – | Po kliknutí žádné: přechod na hru je v prohlížeči. Stránka hry přijde jako data Reactu (RSC, do 6 kB), okno 44–482 ms, pod zátěží 349–639 ms. |
| JS chunky | 271–703, 21 žádostí, 315 kB | 756–8917 | Mřížkové hry (6 z 9) stahují po kliknutí 21 chunků kódu mřížky, poslední končí v 611–1005 ms, pod zátěží v 8762–9762 ms. Arkádové hry jen 2 chunky (1 kB), jejich kód už načetla stránka `/play`. |
| API | 3–668, 4 žádosti | 22–11801 | `POST /api/play/games` (vytvoření hry) 42–457 ms, pod zátěží 50–407 ms. Pak jen `/api/play/events` a u arkád `…/voice`, na nic z toho hra nečeká. |
| GLB modely | 708–773, 8 žádostí, 124 kB | 8977–9442 | První GLB startuje v 317–1011 ms, pod zátěží 6358–9810 ms. U 6 z 9 vět končí až po tom, co je hra ovladatelná. |
| panorama | 812–842, 2 žádosti, 178 kB | 9936–10489 | Obloha dorazí u 8 z 9 vět až po ovladatelnosti. Hra na ni nečeká. |
| Rapier WASM | – | – | Nestáhla ho ani jedna z 9 her: žádná dnešní rychlá verze nemá fyzikální tělesa. Chunk `f739f9f4.*.js` (2,2 MB) se neobjevil v žádném logu. |
| zvuk | 0–472, 10 žádostí, 343 kB | 6695–6744 | Souběžně, hra na něj nečeká. |

Pod zátěží je mezi příchodem dat stránky (≤ 0,64 s) a první žádostí o model (≥ 6,4 s) síť prázdná. Tuhle mezeru dělá procesor, ne server.

## Co z toho plyne pro fázi 2 (inference)

Plán říká: když čistý Chrome dá ≤ 3 s, fáze 2 se zúží na černou obrazovku a Rapier a zbytek se zapíše jako nepotřebný. Čistý Chrome dává ≤ 1 s, takže:

- **T4 (Rapier):** na téhle sadě se nic nezrychlí, žádná hra Rapier nestahuje. Smysl má jen tehdy, když po sloučení `p32-base` budou věty s tělesy. Jinak se AC „klesne u vět s tělesy“ nemá na čem ověřit.
- **T5 (jeden požadavek):** dnes jdou za sebou dva požadavky, vytvoření hry a data stránky hry. Druhý trvá 10–50 ms na čistém Chromu, pod zátěží ~10 ms. Sloučení ušetří desítky ms – na těchto číslech zbytné.
- **T6 (≤ 3 s na desktopu):** brána je dnes splněná s rezervou (nejhorší věta 994 ms). Skutečné mezery jsou jinde:
  - **Telefon:** studené otevření mřížkové hry do prvního snímku 3,6–5,5 s (arkády 1,8–2,2 s). Profil Pixel 7 se 4× CPU je jen napodobenina, skutečné zařízení změří O10.
  - **Kód mřížky:** 21 chunků, které se stahují až po kliknutí, pod zátěží zaberou ~8 s. Arkádové hry, jejichž kód je načtený předem, jsou pod zátěží skoro 2× rychlejší (6,6 s proti 11,6–13,1 s).
  - **Černá obrazovka:** baseline ji neměří, T6 ji ověří.

## T4 – hry s fyzikálními tělesy (Rapier)

Offline věta tělesa nedá, proto dvě hotové hry ze specu (`baseline-physics.json`: kámen k hodu a bedna k posunu, `things[].physics`). Harness je publikuje `POST /api/play/games {spec}` a měří jen studené otevření odkazu a telefon – kliknutí na „Play it“ tu není. Jeden běh na hru, čistý Chromium.

| hra | studené otevření: ovladatelná (před → po) | první snímek (před → po) | telefon: první snímek (před → po) |
|---|---:|---:|---:|
| rock-physics | 1078 → 642 | 966 → 561 | 2183 → 2053 |
| crate-physics | 823 → 470 | 797 → 446 | 2240 → 2168 |

- **Fakt:** před T4 se scéna začala stavět až po stažení a spuštění Rapieru (chunk `f739f9f4.*.js`, 831 kB, stažený do 0,26–0,38 s); modely scény startovaly v 0,83–1,05 s. Po T4 se plátno a HUD vykreslí hned a modely jdou souběžně s Rapierem (bedna: první GLB v 0,48 s místo 0,83 s).
- **Fakt:** s Rapierem uměle zdrženým o 3 s ukáže stránka scénu a HUD, tik stojí na 0 a stisk z čekání padne do tiku 0 po načtení; chyba hydratace v konzoli žádná.
- **Inference:** zisk ~0,35–0,45 s na desktopu je souběh scény s Rapierem; na telefonu je menší, protože tam čas bere hlavně procesor. Jeden běh na hru – rozptyl mezi běhy je desítky ms.

Běhy: `runs/t4-before/` (kód `5b23a253`) a `runs/t4/`.

## Telefon: kam jde čas do prvního snímku (rozhodnutí o T5 a T6)

Běh `runs/t5-phone/` (kód po T4 `3c7371a1`, 9 vět offline, Pixel 7 se 4× CPU): síťový log studeného otevření odkazu od navigace do prvního snímku.

| hry | první snímek | JS do prvního snímku | API do prvního snímku | GLB do prvního snímku |
|---|---:|---|---|---|
| mřížkové (6) | 3112–4167 ms | 37 žádostí, 837 kB, poslední končí v 2896–3898 ms | jen `/api/play/events` (hra na něj nečeká) | 0 |
| arkádové (3) | 1840–2312 ms | 18 žádostí, 523 kB, poslední končí v 790–912 ms | jen `/api/play/events` | 0 |

- **Fakt:** studené otevření nemá druhý požadavek na data hry – HTML ze serveru nese celou hru. Žádný GLB nezačne dřív než první snímek.
- **Fakt:** u mřížek padá první snímek 0,2–0,3 s po posledním chunku kódu mřížky, u arkád je JS hotový do 0,9 s a zbytek do 1,8–2,3 s je práce procesoru.
- **Rozhodnutí podle řídicí session (21:10):** T5 (jeden požadavek) a přednačtení kitu z T6 se nedělají – telefonní čas nejde na druhý požadavek API ani na GLB. Zbývá černá obrazovka (T6).

## Jak zopakovat

```
node node_modules/next/dist/bin/next start -p 3354 -H 127.0.0.1
node scripts/p32/heavy.mjs -- node scripts/p32/shots.mjs --base http://127.0.0.1:3354 --set evals/play/p32/baseline-sentences.json --out evals/play/p32/runs/baseline
node scripts/p32/heavy.mjs -- node scripts/p32/shots.mjs --base http://127.0.0.1:3354 --set evals/play/p32/baseline-sentences.json --desktop-cpu-throttle 6 --fps-seconds 1 --out evals/play/p32/runs/baseline-loaded
```
