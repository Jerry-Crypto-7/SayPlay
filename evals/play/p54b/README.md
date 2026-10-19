# P54B – scény a modely: měřidlo

Cíl: plná scéna, živé postavy a světlo z věty, a přitom hra hraje stejně (otisk beze změny).

## Sčítání scény

```
node --experimental-strip-types --import ./scripts/ts-paths.mjs scripts/play-scene-census.mjs --out evals/play/p54b/census-before.json
```

Dev sada `evals/play/p30/dev.json` (60 vět) přes `draftGameSpec` – rychlá verze bez režiséra. Věta `d01` (míč) mimo prohlížeč padá na `loadRapier()` a je v `skipped`.

- **Odlišné modely** = obsazení (hrdina, nepřítel, pronásledovatel, rekvizity rolí) + rekvizity sady (`landmarks`) + druhy vegetace. Orientační bod a život na pozadí se přičtou, až je sada bude mít (T8, T10).
- **Nepřítel s kostrou** se počítá přes všech 59 vět (`enemyModel`, i výchozí robot).
- **Světlo změněné** = `sceneLook` se od výchozí sady liší v obloze, polokouli, slunci, záři, mlze nebo expozici. **Věta jmenuje světlo** = slovo denní doby, počasí nebo nálady (`NAMES_LIGHT` ve skriptu).

**Před (`census-before.json`, 19. 10. 2026, `5d741740`):** hrdina s kostrou 18/59 (31 %), nepřítel s kostrou 1/59, odlišných modelů medián 12 (min 7, max 25), světlo změněné 4/59. Světlo jmenuje 7 vět, změní se jen u 4 – chybí `j10` („dark forest“ v hradu), `d03` („during a thunderstorm“), `d16` („snowy mountain village“). Čísla sedí přesně na výzkum.

**T7 (`census-t7.json`, výplň sad bez vegetace):** odlišných modelů medián 19 (min 13, max 25) – cíl ≥ 15 / ≥ 10 splněn. Výplň (`look/fill.ts`) má všech 12 sad bez vegetace, 7–11 druhů na sadu; řada kulis vedle ní zůstane hustá (`sparseLandmarks`). Hrdina s kostrou a světlo beze změny (18/59, 4/59).

**T11 (`census-t11.json`, nálada, počasí a denní doba z celé věty):** světlo jmenuje 7 vět, změní se u všech 7 (dřív 4) – přibyly `d03` (bouřka → déšť), `d16` („snowy“ → sněžení), `j10` (šero mimo místo věty → noc); světlo změněné celkem 7/59, žádná věta bez slov světla. Odlišných modelů beze změny (medián 19, min 13). 30 ručně označených vět (`p54b-sentence-mood.test.ts`): precision 1,0, recall 1,0 (36 štítků). Pozn.: měřeno nad commitem T3 (import riggovaných postav) – obsazení `d10` (pirát místo kostlivce) se od `census-t7.json` liší kvůli T3, ne kvůli T11.

## Důkaz, že vzhled není v hashi

`src/play/arcade/__tests__/p54b-look-not-hashed.test.ts`: šest vět ze šesti žánrů, týž spec s jinou sadou, náladou, počasím a denní dobou postaví svět se stejným `canonicalHash`, stejným počátečním stavem a robot ho za 600 tiků dohraje se stejným hashem. Zelené na `5d741740`; mutace (`theme.look` přimíchaný do semínka v `arcadeWorldOf`) test zčervená. `theme` do hashe nevstupuje – architektura P54B platí.

## Snímky

```
node scripts/play-look-shots.mjs shots --base http://127.0.0.1:3351 --set genres --out evals/play/p54b/before
node scripts/play-look-shots.mjs shots --base http://127.0.0.1:3351 --set genres --profile pixel7 --out evals/play/p54b/before-phone
```

18 vět na žánr (`evals/play/p46g/genres.json`), tik 150, SwiftShader. `before/` 1280×800, `before-phone/` emulace Pixel 7 (scéna startuje na úrovni `low`). Build `5d741740` + T1 (jen komentáře), 19. 10. 2026.

## Výkon

**Základ zatím nezměřen.** 19. 10. 2026 běžel stroj na 100 % CPU (81 procesů Node, souběžné autopiloty): emulace Pixel 7 dala 18–20 FPS a pak 0,1 FPS (zamrzlý prohlížeč), takže běh byl zastaven a čísla se nezapsala. Výkonová brána se měří A/B hned po sobě proti buildu `features/P54B` na commitu T2 (vzhled beze změny), až bude stroj v klidu; `perf-before.json` vznikne tím prvním během.

- **T7:** perf A/B T7 odložen do klidného stroje (CPU 81 %). Výplň je proto střídmá: město hustota 0,22 bez linie v dálce (louka 0,45 se třemi vrstvami), interiéry 0,25 bez linie v dálce; každý druh je jedno kreslicí volání (nejvýš 11 na sadu, město 9).
