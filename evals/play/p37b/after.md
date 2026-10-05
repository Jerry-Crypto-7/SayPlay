# P37B T9 – po proti před (4. 10. 2026)

**Měřeno:** `features/p37b-feel` (`73b53108`, T1–T8 + opravy z T9), `next start` na :3372 s `PLAY_LAB=1`, offline režisér (bez klíčů).
Klipy a FPS stejně jako „před“ (`gaps.md`): `node scripts/p37b/clips.mjs --set evals/play/p32/sentences.json --set evals/play/p37b/verbs.json --fps-seconds 20` pod `scripts/p32/heavy.mjs`, sám na stroji. „fix“ přeměřen po opravě nápřahu (`--only fix`).
Klipy, archy a `result.json`: `D:/caches/p37b/after/` (mimo repo), „před“ v `D:/caches/p37b/before/`.

## Cíle plánu

| Cíl | Výsledek | Splněno |
|---|---|---|
| Slepý soudce vybere „po“ u ≥ 9/12 her přejímky | **8/12** (soudce 1), **11/12** (soudce 2, nezávislý běh nad týmiž dvojicemi); spolu 19/24 | jen soudce 2 |
| Sloveso poznané z klipu u ≥ 7/10 her s `heroAction` | **9/10** | ano |
| Medián FPS Pixel 7 (CPU 4×) ≥ 40 u všech 12 vět | nejnižší **54,1** (penguin); všech 22 her ≥ 54 | ano |
| Stavový hash ani replay se nepohne | jádro beze změny (`git diff features/p37...HEAD` nad kernel/pieces/rules/physics/spec = 0 řádků), celá sada zelená | ano |
| Hra ovladatelná do 1,5 s i s nástupem scény | T6: medián 630 ms, všechny ≤ 960 ms (beze změny od T6) | ano |

Soudce je subagent Claude, ne astra: běh šel s `--no-codex`. Viděl jen dvojice archů s neutrálními jmény v prázdné dočasné složce, A/B prohozené pevným vzorem, klíč mimo složku.

## Slepé srovnání po/před (archy 4×2 snímků, desktop)

| Hra | Soudce 1 | Soudce 2 | Proč prohrálo „po“ |
|---|---|---|---|
| penguin | po | po | |
| firefighter | po | po | |
| wizard | po | po | |
| pirate | po | po | |
| cat | po | po | |
| chef | **před** | po | s. 1: „mléčný béžový závoj“ |
| dog | **před** | po | s. 1: „silnice a rekvizity propadnou do černé“ |
| knights | po | po | |
| rocket | **před** | **před** | s. 1: „zamlžené modrým oparem“, s. 2: „blátivější, do modra“ |
| rabbit | po | po | |
| robot | po | po | |
| turtle | **před** | po | s. 1: „zamlžené, útesy do růžova“; s. 2 naopak „kupole světlejší, želva čitelnější“ |

**Čtení (inference):** psí a kuchařská dvojice jsou okem skoro totožné (ladění `indoor` je jemné) – soudci se v nich rozešli, je to šum. U želvy se rozešli taky. Jediná shoda proti „po“ je **raketa (vesmír)**: zvednutá černá z T3 drží hrdinu vidět, ale obzor s modrou mlhou nad červenou půdou oba soudci čtou jako opar a dávají přednost černé obloze „před“. Je to vkus proti čitelnosti, ne chyba vykreslení – rozhodne zahrání na telefonu (HALT po T9).

## Sloveso z klipu (arch + výřez hrdiny, uzavřený seznam 12 sloves)

| Klip | Má být | Soudce | Jistota |
|---|---|---|---|
| dig | dig | dig | nízká |
| stir | stir | **sweep** | střední |
| fix | fix | fix | střední |
| sweep | sweep | sweep | střední |
| carry | carry | carry | vysoká |
| water | water | water | vysoká |
| stack | stack | stack | střední – hrdina ve věži není, soudce poznal padající bednu |
| chop | chop | chop | vysoká |
| spray | spray | spray | střední |
| paint | paint | paint | střední |

**9/10.** Míchání (dlouhá vařečka krouživě u země) se plete se zametáním.

## FPS telefonu (medián, Pixel 7, CPU 4×, 20 s ukázky robota)

| Hra | Před | Po | | Hra | Před | Po |
|---|---|---|---|---|---|---|
| penguin | 59 | 54,1 | | stir | 58 | 60 |
| firefighter | 49,1 | 59 | | spray | 55,1 | 58 |
| wizard | 59 | 58 | | stack | 60 | 60 |
| pirate | 40,8 | 59 | | carry | 59 | 60 |
| cat | 56 | 59 | | sweep | 59 | 60 |
| chef | 60 | 60 | | dig | 55,1 | 59 |
| dog | 45,2 | 56 | | paint | 56 | 58 |
| knights | 51,2 | 58 | | chop | 45,2 | 60 |
| rocket | 60 | 60 | | water | 59 | 60 |
| rabbit | 32,5 | 60 | | fix | 59 | 58 |
| robot | 59 | 59 | | | | |
| turtle | 59 | 60 | | | | |

## Zvuk a hrdina za 3 s hraní

- **Bez jediného zvuku:** 16/22 → 14/22. Zvuk navíc má cat (zánik a zrod) a fix. Aréna `move_free` a řízení `steer` v 3s okně dál mlčí: pevný vzor kláves nesebere nic a klidový pracovní takt hrdiny je záměrně tichý (T5) – zvuk dostane až nápřah z události hry.
- **„fix“ hrál 185 zvuků za 3 s** (opravář v továrně dostává událost `count` skoro každý tik, nápřah se restartoval každý snímek). Opraveno v T9 (`73b53108`): nový nápřah až po doběhnutí předchozího; po opravě 7 zvuků.
- **Hrdina:** v aréně 52–98 px z 720 (před ~25 px, T2 + T6); běžec 159, kuchař 219, souboj 214.
- **Hudba** hraje ve všech 22 hrách a mění se s napětím (T5, piny `tension`).

## Sady

| Sada | Výsledek |
|---|---|
| `npx vitest run` (celá, `heavy.mjs`) | 536 souborů, 10 374 ✓, 3 přeskočené, 0 ✗ |
| `tsc --noEmit` | 0 chyb |
| `license-gate` | 7/7 |
| e2e `p32-voyage`, `p32-look`, `p35-perf`, `play-phone` | 34/36, raketa 2× červená: **4,5 % fialových pixelů** na obzoru → opraveno v T9 (`00aa9240`), znovu raketa 2/2 (0,00 % / 0,05 %), `p32-look` 6/6 |
| e2e `play-*` (vč. `play-touch` na Pixel 7), `p36-dare`, `interface-language` | 179 ✓, 12 přeskočeno, 19 ✗; na čistém serveru znovu 2 ✓ (offline vytvoření, ECONNRESET) a **17 ✗ – stejných 17 padá i na buildu `5e438f0e` bez práce B** (posun kompilace vět po sloučení C+D a prostředí bez panoramat a lokálního modelu), viz nález T9 v plánu |
| Brána hashů | jádro beze změny, 0 řádků |

## Opravy z T9

- `00aa9240` – noční ladění zvedalo tmavou směs červené půdy a modré mlhy do fialové; shader stáhne tmavé tóny v pásmu 250–320° na jeho okraj. Světlou fialovou z věty nepřebarví.
- `73b53108` – nápřah a zvuk hrdiny jednou za nápřah, ne každý tik.
- `1083d1f0` – pin `PromptSpot` (zápisy stylu a hledání hrdiny jen při změně), nález z ověření T7.
