# P70A – verdikt: jedna hra na větu a obtížnost

Přepočteno ze surových souborů (`result.ts`, test `__tests__/result.test.ts`). Začátečník před: commit 0d3fa930, po: commit f94cf27c.

## Verdikt

- **Jedna hra na větu – splněno.** Řetězce na rychlé cestě 107/260 před → 0/260 po. V prohlížeči 6/6 vět dalo jednu hru.
- **Začátečník vyhraje – nesplněno.** Žánry, kde přežije ≥ 20 s a vyhraje ≥ 50 %: 7/28 před → 7/28 po. Vítězný robot vyhraje nejméně 100 % v každém žánru.
- **Prohlížeč, hráč o 400 ms pozdě (430x900 touch):** 3/6 vět přežije 20 s. Ne: quest (18.42 s), flap (5.73 s), rhythm (6.27 s).

**Odhad (inference):** ochrana prvních 3 s (T3) začátečníkovi nepomohla, protože neprohrává na začátku. Prohrává později – na odpočtu, na cílovém skóre a v úzkých oknech načasování (flap, rytmus, timing). Další krok musí měnit obtížnost samotnou: delší čas, nižší cílové skóre, širší okna pro stisk.

## Žánry před a po

| Žánr | Přežití před (s) | Přežití po (s) | Výhry před | Výhry po | Robot po | Cíl před | Cíl po |
|---|---|---|---|---|---|---|---|
| runner | 48.22 | 48.22 | 14 % | 14 % | 100 % | ne | ne |
| platformer | 59.93 | 59.93 | 4 % | 4 % | 100 % | ne | ne |
| arena | 79.38 | 79.38 | 48 % | 48 % | 100 % | ne | ne |
| voyage | 23.27 | 23.27 | 10 % | 10 % | 100 % | ne | ne |
| quest | 89.01 | 89.01 | 50 % | 50 % | 100 % | ano | ano |
| shooter | 90 | 90 | 82 % | 82 % | 100 % | ano | ano |
| throw | 40.92 | 40.92 | 34 % | 34 % | 100 % | ne | ne |
| timing | 4.81 | 5.18 | 0 % | 0 % | 100 % | ne | ne |
| rhythm | 6.04 | 6.04 | 0 % | 0 % | 100 % | ne | ne |
| duel | 16.67 | 18.93 | 0 % | 0 % | 100 % | ne | ne |
| flap | 11.78 | 12.33 | 0 % | 0 % | 100 % | ne | ne |
| catch | 30.21 | 32.34 | 0 % | 0 % | 100 % | ne | ne |
| whack | 30.53 | 30.53 | 0 % | 0 % | 100 % | ne | ne |
| defense | 43.29 | 43.29 | 20 % | 20 % | 100 % | ne | ne |
| slice | 35.41 | 35.41 | 10 % | 10 % | 100 % | ne | ne |
| hop | 6.88 | 8.93 | 0 % | 0 % | 100 % | ne | ne |
| crowd | 34.25 | 34.25 | 0 % | 0 % | 100 % | ne | ne |
| merge | 69.02 | 69.02 | 0 % | 0 % | 100 % | ne | ne |
| push | 89.02 | 89.02 | 0 % | 0 % | 100 % | ne | ne |
| survivor | 29.41 | 29.41 | 20 % | 20 % | 100 % | ne | ne |
| hole | 90 | 90 | 100 % | 100 % | 100 % | ano | ano |
| steal | 37.92 | 37.92 | 0 % | 0 % | 100 % | ne | ne |
| sort | 90 | 90 | 80 % | 80 % | 100 % | ano | ano |
| arrows | 19.8 | 19.8 | 40 % | 40 % | 100 % | ne | ne |
| minigolf | 90 | 90 | 90 % | 90 % | 100 % | ano | ano |
| railfps | 33.37 | 33.37 | 30 % | 30 % | 100 % | ne | ne |
| buildshift | 90 | 90 | 100 % | 100 % | 100 % | ano | ano |
| drawsave | 90 | 90 | 100 % | 100 % | 100 % | ano | ano |

## Výjimky po změnách

- **runner** – přežije (medián 48.22 s), ale vyhraje jen 14 %
- **platformer** – přežije (medián 59.93 s), ale vyhraje jen 4 %
- **arena** – přežije (medián 79.38 s), ale vyhraje jen 48 %
- **voyage** – přežije (medián 23.27 s), ale vyhraje jen 10 %
- **throw** – přežije (medián 40.92 s), ale vyhraje jen 34 %
- **timing** – prohraje do 20 s (medián 5.18 s, první život ztratí v 5.13 s)
- **rhythm** – prohraje do 20 s (medián 6.04 s, první život ztratí v 4.56 s)
- **duel** – prohraje do 20 s (medián 18.93 s, první život ztratí v 7.35 s)
- **flap** – prohraje do 20 s (medián 12.33 s, první život ztratí v 5.4 s)
- **catch** – přežije (medián 32.34 s), ale vyhraje jen 0 %
- **whack** – přežije (medián 30.53 s), ale vyhraje jen 0 %
- **defense** – přežije (medián 43.29 s), ale vyhraje jen 20 %
- **slice** – přežije (medián 35.41 s), ale vyhraje jen 10 %
- **hop** – prohraje do 20 s (medián 8.93 s, první život ztratí v 7.12 s)
- **crowd** – přežije (medián 34.25 s), ale vyhraje jen 0 %
- **merge** – přežije (medián 69.02 s), ale vyhraje jen 0 %
- **push** – přežije (medián 89.02 s), ale vyhraje jen 0 %
- **survivor** – přežije (medián 29.41 s), ale vyhraje jen 20 %
- **steal** – přežije (medián 37.92 s), ale vyhraje jen 0 %
- **arrows** – prohraje do 20 s (medián 19.8 s, první život ztratí v 19.75 s)
- **railfps** – přežije (medián 33.37 s), ale vyhraje jen 30 %

## Prohlížeč – šest vět

Snímky v `shots/` (karta, 20. sekunda, konec). Průchod: `browser.spec.ts`.

| Věta | Žánr | Jedna hra | Konec | Čas (s) | 1. život (s) | Prohra na | ≥ 20 s |
|---|---|---|---|---|---|---|---|
| help the rabbit jump | platformer | ano | lost | 88.02 | 88.02 | čas nebo cíl, život neztratil | ano |
| feed the rabbits | quest | ano | lost | 18.42 | 10.42 | došly životy | ne |
| a cat jumps over boxes and eats fish | platformer | ano | lost | 88.02 | 88.02 | čas nebo cíl, život neztratil | ano |
| a little bird flaps between the pipes | flap | ano | lost | 5.73 | 3.23 | došly životy | ne |
| a cat drums to the beat of the song | rhythm | ano | lost | 6.27 | 4.63 | došly životy | ne |
| a fox runs through the forest and jumps over logs | runner | ano | lost | 37.15 | 26.88 | došly životy | ano |
