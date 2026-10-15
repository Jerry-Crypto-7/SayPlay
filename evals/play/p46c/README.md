# P46C – power-upy, kombo, juice (15. 10. 2026)

Měřeno na panelu P45 (40 vět, robot intermediate), větev `features/P46C-powerupy-kombo-juice-2026-10-12`.

## Zábava (`fun-after.json` proti `../p46/fun-baseline.json`)

| Měření | Před P46 | Po P46A | Po P46C |
|---|---|---|---|
| Mrtvý čas, medián | 5,36 s | 4,96 s | 4,00 s |
| Gradace (podíl) | 0,55 | 0,55 | 0,63 |
| Finále (podíl) | 0,23 | 0,23 | 0,38 |
| Události za sekundu, medián | 1,09 | 1,09 | 1,18 |

## Power-upy a kombo (`after.json`, `powerups.measure.ts`)

- Power-upy má 11 ze 40 her, robot sebere aspoň jeden v 8 (podíl 0,20 ze všech).
- Medián nejvyššího násobiče je 0: kombo mají jen hry s počítadlem komba.
- Cíl plánu (≥ 80 % her se sebraným power-upem, medián ×2) **není splněný**. Power-upy a kombo nové verze má jen žánrová hra `genre.v3` se základním ovládáním běžec, skákačka, řízení a aréna. Panel je z velké části jiné žánry (střelec, souboj, rytmus, let, časování, míč) a hry mimo žánr.
- Rozhodnutí majitele 15. 10.: P46C se sloučí s tímto rozsahem, další žánry přijdou jako samostatný krok po P46.

Po žánrech (hratelné hry, s power-upy, sebral, násobič ≥ ×2):

| Žánr | Her | S power-upy | Sebral | ×2+ |
|---|---|---|---|---|
| platformer | 3 | 2 | 2 | 3 |
| runner | 2 | 1 | 1 | 2 |
| arena.collect | 3 | 2 | 1 | 0 |
| arena.escape | 3 | 3 | 1 | 0 |
| quest.spatial | 3 | 3 | 3 | 0 |
| shooter, flap, throw | 5 | 0 | 0 | 5 |
| ostatní | 21 | 0 | 0 | 0 |

## Obtížnost

Všech 54 živých receptů `../p41/difficulty.json` je v pásmu (začátečník 0,3–0,7, pokročilý ≥ 0,8). Běžec nemá power-up zrychlení: začátečník s ním v run.escape spadl z 6/20 na 5/20.
