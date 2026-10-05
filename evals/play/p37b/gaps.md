# P37B T1 – kde hry ještě působí ploše (stav „před“, 3. 10. 2026)

**Měřeno:** build `ae2b8eb9` (`p37-base`), `next start` na :3372, offline režisér (bez klíčů – AI verze se nevyrobí a hra ukáže toast „Couldn't make the full-detail version“).
`node scripts/p37b/clips.mjs --set evals/play/p32/sentences.json --set evals/play/p37b/verbs.json --fps-seconds 20` pod `scripts/p32/heavy.mjs` (sám na stroji).
22 her: 12 vět přejímky P32 (9 otevřených + 3 slepé) a 10 vět z různých rodin sloves (`verbs.json`, `heroAction` vepsaná do specu).
Klipy, archy snímků a `result.json`: `D:/caches/p37b/before/` (mimo repo). Okno klipu = 3 s hraní pevným vzorem kláves a ťuků od studeného otevření; FPS = Pixel 7, CPU 4×, 20 s ukázky robota.

## Seřazeno podle počtu her

| # | Co chybí | Her | Které |
|---|---|---|---|
| 1 | **Akce bez zvuku** – 3 s hraní bez jediného zvuku (hraje jen hudba) | **16/22** | celá aréna `move_free` (13: firefighter, wizard, cat, chef, stir, spray, carry, sweep, dig, paint, chop, water, fix), řízení `steer` (3: pirate, dog, rocket) |
| 2 | **Akce bez efektu** – žádná vizuální událost sběrnice za 3 s | **15/22** | aréna kromě cat (12), steer (3) |
| 3 | **Hudba stejná celou hru** – jedna smyčka zvolená z tématu, nereaguje na poslední život, poslední sekundy ani soupeře, žádné ztišení pod výhrou/prohrou | **22/22** | všechny (hudba je zapnutá všude) |
| 4 | **Hrdina daleko, sloveso nejde vidět** – aréna z vysoké kamery, hrdina ~25 px z 720 (3–4 % výšky obrazu) | **13/22** | celá aréna; 9 z 10 vět sloves skončí v aréně a 5 z nich ve stejné zelené louce s mlýny |
| 5 | **Sloveso se nekreslí vůbec** – `heroAction` dojde do scény, ale nic ho nekreslí | **10/10** vět sloves | vše z `verbs.json` |
| 6 | **Bez nástupu scény** (kamera začíná rovnou v záběru) | 2/22 | knights (souboj), stack (věž); kódem i střelba, hod, rytmus |
| 7 | **Mrtvá kamera** – pevná po celou hru | 1/22 | knights (souboj); kódem i hod a rytmus |
| 8 | **Telefon pod 40 FPS** (medián, Pixel 7, CPU 4×) | 1/22 | rabbit 32,5; těsně nad: pirate 40,8, dog 45,2, chop 45,2 |
| 9 | **Prázdný první snímek** | 0/22 | žádný; rocket (vesmír) je skoro černý, robot a turtle tmavé noční |

## Podle žánru

| Ovládání (`data-control`) | Her | Zvuky za 3 s | Efekty za 3 s | Kamera (kód) | Co chybí |
|---|---|---|---|---|---|
| `move_free` aréna (i úkol) | 13 | 0 | 0 (cat: 2× zánik, 2× zrod) | sleduje hrdinu z výšky, nástup 1,5 s | pohyb nezní, sebrání zní až při bodu, hrdina drobný, chybí hitstop mimo `fight`, změna stavu cíle (úkol) nezní |
| `steer` (loď, pes, raketa) | 3 | 0 | 0 | sleduje (chase/voyage/lander), nástup | řízení nezní (zvuk pruhu má jen běžec), žádný efekt jízdy |
| `platform` | 3 | 3–4 | 3× dopad | z boku, sleduje | dopad má prach, ale nezní; rabbit 32,5 FPS |
| `runner` | 1 | 6 | 4× dopad | za zády, bez vyhlazení | nejživější žánr; dopad nezní |
| `duel` | 1 | 7 | 1× zásah | **pevná z boku, bez nástupu** | bez hitstopu, úhyb nezní, postavy z primitiv (modrá kapsle) |
| `timing` (věž) | 1 | 3 | 3× zásah, prohra | stoupá s věží, bez nástupu | samotný ťuk/pád bloku nezní, zní jen bod nebo zásah |

## Zvuk a efekty – co v kódu nemá pár

- **Vidět, ale neslyšet:** dopad (`land`, prach), zásah jiného těla než hráče, zánik nepřítele/překážky bez bodu, změna stavu cíle (`stateChange`).
- **Slyšet, ale nevidět:** kombo, změna pruhu, skluz, výstřel, švih, odraz skoku.
- **Ani jedno:** zrod těla (`spawn`), pohyb v aréně a řízení, ťuk věže, úhyb v souboji.
- Hudba: `playMusic(musicFor(spec.theme))` jednou na hru (`ArcadePlay.tsx`), hlasitost pevná 0,35, mění ji jen ztlumení. Napjatá smyčka (`tense`) existuje u všech 18 vzhledů, jen ji nic nezapne podle stavu hry.

## FPS Pixel 7 (medián / nejhorší sekunda)

| Hra | Medián | Min | | Hra | Medián | Min |
|---|---|---|---|---|---|---|
| penguin | 59 | 17,3 | | stir | 58 | 50,2 |
| firefighter | 49,1 | 0,9 | | spray | 55,1 | 25 |
| wizard | 59 | 35,7 | | stack | 60 | 52,1 |
| pirate | 40,8 | 15,4 | | carry | 59 | 49 |
| cat | 56 | 47,2 | | sweep | 59 | 46,2 |
| chef | 60 | 54 | | dig | 55,1 | 42 |
| dog | 45,2 | 12 | | paint | 56 | 39,3 |
| knights | 51,2 | 33,9 | | chop | 45,2 | 35,4 |
| rocket | 60 | 49,2 | | water | 59 | 46 |
| rabbit | **32,5** | 13 | | fix | 59 | 54,1 |
| robot | 59 | 48,3 | | | | |
| turtle | 59 | 54,1 | | | | |

Nejhorší sekunda pod 20 FPS (firefighter 0,9, dog 12, rabbit 13, pirate 15,4, penguin 17,3) je zaseknutí v prvních sekundách ukázky – kandidát na kompilaci shaderů nebo dočítání modelů (T7).

## Co z toho plyne pro další úlohy (inference)

- **T2 (sloveso):** rekvizita sama nestačí – v aréně je hrdina tak malý, že ji porotce neuvidí. Bez bližší kamery v aréně (T6) cíl „sloveso z klipu ≥ 7/10“ nevyjde; rekvizity proto kreslit spíš přehnaně velké.
- **T5 (zvuk):** největší díra je aréna a řízení – 16 her mlčí; každý typ události sběrnice potřebuje zvuk (dopad, zánik, zrod, změna stavu) a hudba přepnutí na `tense` podle stavu.
- **T6 (kamera):** aréna blíž k hrdinovi; souboj a věž bez nástupu; nástup dnes trvá 1,5 s (plán chce 0,6–1,0 s).
- **T3 (vzhled):** 5 z 10 vět sloves vypadá stejně (zelená louka s mlýny) – barevné ladění podle rodiny prostředí pomůže rozlišit jen napůl, větší rozdíl udělá blízká kamera a činnost hrdiny.
- **T7 (výkon):** rabbit (plošinovka, louka) jediný pod 40; zaseknutí na začátku ukázky u 5 her.
