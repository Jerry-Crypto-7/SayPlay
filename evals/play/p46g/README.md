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
- **Opakovatelnost** (dva běhy po sobě, podíl pixelů lišících se o víc než 8 v kanálu): 9 z 12 snímků 0,00–0,74 %, tři 2,0–2,5 % (`city-runner`, `jungle-platform`, `city-platform`). Rozdíl tam dělá jen animace podle skutečného času – vlnky vody pod ostrovy a nečinná póza hrdiny –, ne stav hry: tik, poloha těl i kamera jsou stejné.

## Výkon

```
node scripts/play-look-shots.mjs perf --base http://127.0.0.1:3251 --out evals/play/p46g/perf-before.json --repeats 2
```

Emulace Pixel 7 se 4× pomalejším CPU, skutečné GPU (D3D11), FPS z rAF za 10 s hry robota, kreslicí volání ze sondy `__playRender`. Stroj je vytížený souběžnými autopiloty, proto se „po“ měří A/B hned po sobě se základem, ne proti starému číslu (hranice −10 %).
