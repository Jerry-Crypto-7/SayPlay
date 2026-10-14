# P46G – prostředí jako místo: měřidlo

Cíl (plán `P46G-immersive-prostredi-2026-10-13`, spec `docs/specs/2026-10-13-immersive-prostredi.md`): stejná věta vypadá jako místo – cesta bez schodů, les jako les, „dark forest“ je tmavý – a hraje se stejně (hash beze změny).

## Sada

`sentences.json`: 12 vět, 4 prostředí (les, džungle, poušť, město) × 3 žánry (běžec, závod, skákačka). Mezi nimi „A race car speeds through a dark forest“ a „A fox runs through a forest away from a bear“. Všech 12 dá v rychlé verzi čekaný žánr (`before/manifest.json`, pole `genre`).

## Snímky

```
node scripts/play-look-shots.mjs shots --base http://127.0.0.1:3251 --out evals/play/p46g/before
node scripts/play-look-shots.mjs diff <dirA> <dirB>
```

Rychlá verze přes `POST /api/play/games` (server bez režiséra), plátno 1280×800 bez textu stránky, SwiftShader. Ukázka robota se odtiká ručními hodinami sondy (`__playShell.byHand`) do tiku 150, pak hodiny stojí a snímek čeká, až se dotáhnou modely.

- `before/` – build `17750622` (P46 + P46D, před P46G), 13. 10. 2026.
- `after/` – build `34cfac65` (integrační větev P46: A + B + D + G, k tomu břehy skákaček, domy a ulice města), 14. 10. 2026, stejné volby (tik 150, SwiftShader, 1280×800). Hry **nejsou** tytéž jako v `before/` (0 z 12 `versionId` shodných): P46B přidal novým hrám úseky a bosse, takže se změnil i spec. Snímek tedy srovnává celý P46 proti stavu před ním, ne jen vzhled. Předchozí běh nad `005ac461` (jen P46G + P46D, stejné hry) také vyhrál 12 z 12.
- **`sheet-all.png`** – pro majitele: všech 12 dvojic vedle sebe s popisky „before“ / „after“ a větou (2560×2952 px).
- **Cesta bez schodů** (prohlédnuto ručně, T9): ve všech 8 snímcích závodu a běžce je okraj cesty i zábradlí hladké, bez schodu. Před P46G mělo schody zábradlí v `forest-race`, `jungle-race` a `city-race`. Zbývá jedna vada, kterou P46G nezavedl: v `city-race` stojí domy vpravo přes zábradlí (stejně jako na snímku před).

## Slepý soud

```
node scripts/play-p46g-blind.mjs judge [--seed 46009]
node scripts/play-p46g-blind.mjs sheet
```

Každá dvojice (před a po vedle sebe, bez popisků, strana losovaná ze seedu) jde jako `sheet.png` sama v prázdném adresáři soudci Opus 5.5 (`claude -p`, jen nástroj Read). Otázka: která strana vypadá víc jako uvěřitelné, pohlcující a čitelné herní místo pro tu větu.

- **Výsledek: „po“ vyhrálo 12 z 12** (seed `46009`, hranice 10 z 12), jeden běh, žádné přeptání. Důvody soudce: hustší les a džungle, duny a skály v poušti, panorama města, čitelná cesta (`judge.json`). Přesnímáno 14. 10. nad `34cfac65`: znovu 12 z 12, navíc „střecha domu“ u kočky ve městě a jasná cesta u psa.
- **Výkon telefonu:** A/B na PC 14. 10. nepoužitelné (stroj přetížený, nová strana 0,1–0,3 FPS = zamrzlý prohlížeč). Vodítkem jsou kreslicí volání z `after/manifest.json` (skákačky +2–14 % proti `005ac461`); skutečnou plynulost ověří majitel na telefonu.

## Výkon „po“

`perf-after.json` – A/B hned po sobě, základ T1 (`2c95c85c`, :3252) proti „po“ (`005ac461`, :3251), 12 vět + 18 vět na žánr, Pixel 7, 2 opakování. **Žádný řádek pod −10 %**: nejhorší `city-race` −5,4 %, `g-duel` −3,6 %, `g-rhythm` −3,4 %. Závody a běžci s hladkou cestou zrychlili (`forest-race` +34,7 %, `desert-race` +31,8 %). Server základu po sadě vět spadl; sada žánrů se po jeho restartu změřila znovu na obou stranách.
- **Opakovatelnost** (dva běhy po sobě, podíl pixelů lišících se o víc než 8 v kanálu): 9 z 12 snímků 0,00–0,74 %, tři 2,0–2,5 % (`city-runner`, `jungle-platform`, `city-platform`). Rozdíl tam dělá jen animace podle skutečného času – vlnky vody pod ostrovy a nečinná póza hrdiny –, ne stav hry: tik, poloha těl i kamera jsou stejné.

## Výkon

```
node scripts/play-look-shots.mjs perf --base http://127.0.0.1:3251 --out evals/play/p46g/perf-before.json --repeats 2
```

Emulace Pixel 7 se 4× pomalejším CPU, skutečné GPU (D3D11), FPS z rAF za 10 s hry robota, kreslicí volání ze sondy `__playRender`. Stroj je vytížený souběžnými autopiloty, proto se „po“ měří A/B hned po sobě se základem, ne proti starému číslu (hranice −10 %).
