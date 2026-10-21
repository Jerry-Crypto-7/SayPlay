# P55 – slepý soud zábavy pruhových žánrů

Soudce P45 (`pairwise`, Codex, prázdný adresář jen se `sheet.png`) vidí dva klipy průběhu téže věty a řekne, která hra by ho víc bavila. Strana A je `origin/main` (`ada7dd8b`, P54C), strana B HEAD s vrstvou událostí. Klipy bez modelu (`draft-only`), věty jsou cíle dev sady P54C. Skript: `evals/play/p55/fun.mjs`.

## T6 – catch, 3 páry (21. 10. 2026)

**Výsledek: P55 vyhrál 3/3** (cíl ≥ 2/3, `fun-catch.json`). Levá strana vyhrála 1/3, takže soud netáhne pozice. Směr platí, T7 může začít.

| Věta | Vítěz | Co soudce jmenoval |
|---|---|---|
| catch the falling apples but dodge the rotten ones | P55 | víc věcí naráz, hrozby blíž hráči, plno v pozdních scénách; stará hra řídká, dlouhé prázdné úseky |
| a penguin catches fish raining from the sky on an iceberg | P55 | hustší vlny bonusů a bomb, nové shluky ke konci; stará hra s dlouhými mezerami |
| catch falling stars with a bucket before they hit the ground | P55 | busier finish s bombami a bonusy s kroužkem v různých výškách; stará hra ke konci řídne |

**Co si odnést do T7:** soudce pokaždé jmenoval hustotu a stupňování ke konci – přesně to, co vrstva přidává (spěch v poslední třetině). Bonusy s kroužkem si všiml. 3 páry jsou slabý signál; rozhoduje 4/6 v T8.

## T8 – čtyři žánry, 6 párů (21. 10. 2026)

**Výsledek: P55 vyhrál 6/6** (cíl ≥ 4/6, `fun.json`, strana B = `5788124c`). Levá strana vyhrála 3/6, soud netáhne pozice. Obě strany postavily z každé věty týž žánr (stejný generátor).

| Věta | Žánr | Vítěz | Co soudce jmenoval |
|---|---|---|---|
| catch the falling apples but dodge the rotten ones | catch | P55 | víc odměn a bomb naráz, hustší konec; stará hra řídká |
| catch raindrops in a cup but not the lightning bolts | catch | P55 | hustší vlny se žlutými bonusy a bombami; **ke konci obě stejně řídké** |
| place cannons to hold the lanes against invading crabs on the beach | defense | P55 | střely a bonus s kroužkem v pruzích, efekty ke konci |
| a ninja slices fruit tossed in the air but avoids the bombs | slice | P55 | rušnější finále, bonus s kroužkem, hrdina častěji mění pruh |
| smash the aliens that pop out of craters on the moon | whack | P55 | souvislejší dění, bonusoví vetřelci s kroužkem; stará hra s prázdnými děrami |
| a hammer game where goblins peek out of barrels and you whack them | whack | P55 | stupňování a zvýrazněný bonus u hráče ke konci |

**Ostatní brány T8:**

- **E2e na telefonu** (`play-catch`, `play-whack`, `play-defense`, `play-slice`): 12/12; vítězná cesta prstem teď čeká ohlášení události (`data-testid="play-lane-event"`) do 10 s a mezi nimi spěch.
- **FPS** (Pixel 7, CPU 4×, d3d11, A/B prokládaně, 4 opakování, mediány; `fps-before.json` = `origin/main`, `fps-after.json` = HEAD): catch 57,2 → 58,1, whack 57,9 → 55,6, slice 57,2 → 55,2, defense 49,5 → 48,0. Všechny nad 30, nejhorší změna −4 % (v šumu ±10 %).
- **P45 fun meter** (`fun-meter.json`, cíle dev sady P54C po 8 na žánr, robot `intermediate`): hratelné 32/32; mrtvý čas (medián) catch 1,74 s, whack 1,77 s, slice 2,59 s, defense 1,62 s; růst 1,00 ve všech čtyřech.
- **Replay brána** (7 souborů z P54C): 80/80.

**Slabé místo (odvozeno):** u c07 soudce viděl řídký konec na obou stranách – spěch v poslední třetině není u každého semínka vidět v klipu. Rozhodlo to i tak dění v první polovině.
