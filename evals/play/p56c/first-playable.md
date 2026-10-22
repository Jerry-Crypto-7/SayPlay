# P56C T13 – za jak dlouho jde řetěz hrát (desktop) a přechod kol na telefonu

**Telefon po T13a – brána splněná, na hraně:** `phone.json` je teď měření po `0c67a169`. Bez robota je nejhorší přechod kola **100 a 99,9 ms** ve dvou bězích po sobě (medián 66,7 ms), FPS kol 60. Nejdelší zbývající snímek je začátek karty po prohraném kole 1 (83–100 ms). S robotem je nejhůř 300 ms, z toho bez snímku se spuštěním robota 150 ms. Pomohlo: kolo staví jen scénu žánru (`374ce5d8`), novou scénu React staví odloženě po kouscích (`3b2bed9d`), a plátno ji nakreslí až s přeloženými shadery a načtenými modely (`b3a71b87`, `0c67a169`). Původní stav níž platí pro T13.

**Telefon – brána NESPLNĚNÁ (T13):** při přechodu mezi koly se obraz na emulovaném Pixelu 7 (CPU 4×) zasekne na **175–183 ms** bez robota a na 225 ms v mediánu (nejhůř 417 ms bez snímku samotného spuštění robota) s robotem. Limit je 100 ms. FPS uvnitř kol je v pořádku: 51–60 proti 47,5 u jedné hry. Měří `phone.mjs` → `phone.json`, A,B,A0 třikrát prokládaně, kód s jedním trvalým plátnem pro všechna kola (`3739d815`).
- **Příčina** (CDP profil): každé kolo staví scénu znovu. three.js znovu kompiluje 6–18 shaderů (70–265 ms) a React montuje scénu kola (100–150 ms; nejvíc `buildFieldGround`, `HorizonBackdrop`, `HopScene`, popisky davu).
- **Co nepomohlo:** trvalé plátno (jeden WebGL kontext) samo nic měřitelného nepřineslo. Pokus o udržení programů three.js, stavbu v `startTransition` a předkompilaci za kartou dal 133–217 ms, tedy v šumu měření. Navíc by kartu prodloužil o 0,3–0,9 s, proto se nevzal. Kód leží mimo repo v `~/.claude/logs/p56c-t13/ChainStageHost.experiment.tsx`.
- **Co zbývá:** zbytek je v souborech, které vlastní P56B (`genres/crowd/CrowdScene.tsx` materiály v cyklu snímků, `look/rig/Post.tsx` efekt přestavovaný každé kolo, výbuch částic při prohře). Úloha T13a.
- Desktopová čísla níž jsou změřená na buildu před trvalým plátnem. E2e `play-chain.spec.ts` na finálním buildu dál drží kolo 1 hratelné do 1500 ms od navigace.

**Co to znamená:** brána je splněná. Věta, ze které vznikne řetěz her, jde na desktopu hrát v mediánu za **650 ms** od kliknutí na „Play it“. Sada vět z dnešní baseline měřená hned vedle dává medián **833 ms**, takže řetěz je pod hranicí 1,1 × 833 = 916 ms. Nejpomalejší věta řetězu (d01) byla hratelná za **952 ms**, každá tedy pod limitem 1500 ms. Proti historické baseline 2488 ms (T1) je to zhruba čtvrtina. Jedna výhrada: 4 z 9 vět baseline (penguin, wizard, pirate, cat) jsou teď samy řetězy. Kdybychom srovnávali jen s 5 větami, které zůstaly jednou hrou (medián 547 ms), vyšel by řetěz na 1,19× a hranici 1,1× by nesplnil. Rozdíl ale dělá hlavně server: věty jedné hry v sadě mají dvě nejkratší hry (rocket a knights, server za méně než 100 ms). Část v prohlížeči je u řetězu i jedné hry stejná, 170–460 ms.

## Výsledek po větách

Běh 2 (platný), 21. 10. 2026 18:22–18:31. „Server“ = kdy od kliknutí doběhl požadavek `POST /api/play/games` (složení a ověření hry), zbytek do „hratelné“ je prohlížeč. „Hratelná“ = sonda `data-input-tick` / `data-input-at` na `arcade-stage`, tedy tik, ve kterém hra zpracovala první skutečný stisk (u řetězu v kole 1).

### Sada řetězu (`evals/play/p56c/chain-sentences.json`, dev `multi_verb` bez d03)

| id | věta (zkráceno) | řetěz | kol | desktop od kliknutí | z toho server | studené otevření |
|---|---|---|---|---|---|---|
| d01 | a penguin mail carrier slides down icy hills… | ano | 5 | **952** | 627 | 684 |
| d02 | ok so ur a raccoon, sneak past the guard dog… | ano | 5 | 655 | 424 | 568 |
| d04 | can u make one where a robot hops over lava… | ano | 5 | 576 | 336 | 571 |
| d05 | three rounds: catch falling apples, juggle… | ano | 5 | 372 | 202 | 527 |
| d06 | Grandma Rosa on her scooter weaving through… | ano | 5 | 697 | 364 | 613 |
| d07 | fish for glowing eels on a frozen lake, then… | ano | 5 | 882 | 512 | 671 |
| d08 | ninja cat wall-jumps up a skyscraper… | ano | 5 | 645 | 390 | 694 |
| d09 | i want a whole party night with like four… | ano | 5 | 555 | 384 | 1216 |
| d10 | steer a paper boat down the gutter… | ano | 5 | 819 | 437 | 676 |
| d11 | the wizard Pip mixes potions… | ano | 5 | 554 | 222 | 789 |
| **medián** | | 10/10 | | **650** | 387 | **673,5** |

Všech 10 vět je opravdu řetěz: zveřejněná stránka má `main[data-chain-round]` a počítadlo kol ukazuje 5.

### Sada baseline (`evals/play/p32/baseline-sentences.json`)

| id | věta (zkráceno) | řetěz | kol | desktop od kliknutí | z toho server | studené otevření |
|---|---|---|---|---|---|---|
| penguin | A penguin slides down an icy mountain… | **ano** | 5 | 1528 | 1149 | 947 |
| firefighter | A firefighter robot sprays water… | ne | – | 1315 | 1064 | 666 |
| wizard | A tiny wizard rides a broom… | **ano** | 5 | 1176 | 828 | 673 |
| pirate | A pirate ship dodges cannonballs… | **ano** | 5 | 833 | 477 | 659 |
| cat | A cat collects glowing fish… | **ano** | 5 | 741 | 547 | 665 |
| chef | A chef cooks pancakes | ne | – | 547 | 363 | 594 |
| dog | A dog walks through a city | ne | – | 1575 | 1113 | 844 |
| knights | Two knights duel in a castle | ne | – | 541 | 98 | 759 |
| rocket | A rocket lands on Mars | ne | – | 366 | 94 | 579 |
| **medián (9)** | | 4/9 | | **833** | 547 | **666** |
| medián jen jedné hry (5) | | | | 547 | 363 | 666 |

## Brána

| Podmínka | Hodnota | Výsledek |
|---|---|---|
| Medián řetězu ≤ 1,1 × medián baseline změřené teď (1,1 × 833 = 916 ms) | 650 ms (0,78×) | **splněno** |
| Každá věta řetězu ≤ 1500 ms | nejhorší 952 ms (d01) | **splněno** |
| Pro srovnání: proti historické baseline 2488 ms (T1) | 650 ms (0,26×) | splněno |
| Pro srovnání: proti 5 větám baseline, které zůstaly jednou hrou (1,1 × 547 = 602 ms) | 650 ms (1,19×) | nesplněno |

Studené otevření odkazu `/play/<id>` (čas od začátku načtení stránky do prvního zpracovaného stisku): medián řetězu **673,5 ms**, baseline **666 ms**. Tady rozdíl prakticky není.

**Odhad (z času serveru v síťovém logu):** to, o kolik je věta hratelná později, určuje hlavně server, ne prohlížeč. Prohlížeči zabere doba od odpovědi serveru po hratelnou hru u řetězů 170–382 ms a u jedné hry 184–462 ms. Server u řetězů z dev sady potřebuje 202–627 ms. Nejrychlejší jednotlivé hry (rocket, knights) jsou hotové za méně než 100 ms. Nejpomalejší věty baseline (jednotlivé hry dog a firefighter a řetěz penguin) trvají přes 1 s.

## První pokus (neplatný, jen pro úplnost)

První běh šel proti serveru na `127.0.0.1:3111`. Ten v 18:17 přestal odpovídat, přesně 10 minut po spuštění a bez chyby v logu. Nejspíš ho ukončil časový limit úlohy na pozadí v hlavní relaci. Zbylo z něj 9 vět baseline a 5 vět řetězu (d01–d06), d07–d11 skončily chybou spojení. Výsledky téhož běhu: baseline medián 1092 ms, řetěz (5 vět) medián 910 ms, nejhorší d06 **1474 ms**, tedy jen 26 ms pod limitem. Stroj byl v tu chvíli vytížený víc. Verdikt je stejný, ale rezerva u nejpomalejší věty je pod zátěží malá. Data jsou v `runs/t13-baseline/attempt1-server-3111-died/` a `runs/t13-chain/attempt1-server-3111-died/`.

## Jak se měřilo

- Datum 21. 10. 2026. Server: `next start -p 3112 --hostname 127.0.0.1` nad buildem pracovního stromu (`.next/BUILD_ID` z 18:06:58, HEAD `8f633841` plus necommitnutá změna sondy v `ChainPlay.tsx`). Úložiště her bylo prázdné (`PLAY_STORE_DIR` v `$TEMP`), bez čtecího modelu. Na stroji souběžně běží další autopiloty, v klidu nikdy není.
- Sady se střídaly po polovinách: baseline 1–5, řetěz 1–5, baseline 6–9, řetěz 6–10. Příkaz pro každou polovinu:
  `node scripts/p32/shots.mjs --base http://127.0.0.1:3112 --set <polovina>.json --out evals/play/p56c/runs/t13-{baseline,chain}/part{1,2} --fps-seconds 10`
  Soubory polovin leží mimo repo v `~/.claude/logs/p56c-t13/`, obsahově jde o výřezy obou sad.
- Výstupy: `runs/t13-baseline/part1|part2/result.json` a `runs/t13-chain/part1|part2/result.json` včetně PNG. Řetěz poznán otevřením každé zveřejněné hry (`main[data-chain-round]`, počítadlo `hud-counter-round`).
- Část telefonu v `shots.mjs` proběhla bez chyby, ale její FPS (všude kolem 60) **nic neříká**. „Show me how“ je u jedné hry jen na kartě pauzy a `measureFps` ji neotevře, takže robot nehraje. U řetězu tlačítko vůbec není. Telefon proto měří samostatně `phone.mjs` (`phone.json`).
