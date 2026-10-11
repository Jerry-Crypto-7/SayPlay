# P45G – kolo rekvizit pro prostředí

**Vstup:** 159 jmen z `evals/play/p45g/kit-nouns.json` (8 nezpracovaných jmen P45F, pak 151 rekvizit pro 74 prostředí) s ručním znakem v `ops/gen3d/features.toml`, dávky po 10 v pořadí seznamu (`D:/caches/p45g/round<n>/list.json`). Stejná cesta jako `evals/play/p45e/gen-round.md`, RTX 3090 pod `gpu-lock.mjs`, nová mezipaměť `D:/claude/_gen3d-cache-p45g`. Surová data, listy a odpovědi soudce: `D:/caches/p45g/round<n>/` (mimo repo).

```
GEN3D_CACHE_DIR=D:/claude/_gen3d-cache-p45g node D:/claude/_shared/gpu-lock.mjs -- uv run python batch.py --from D:/caches/p45g/round<n>/list.json --precheck --start-comfy --no-quarantine --record D:/caches/p45g/round<n>/batch.json --sheet D:/caches/p45g/round<n>/batch-sheet.png --limit 10
node scripts/p37d/judge-sheet.mjs --record D:/caches/p45g/round<n>/batch.json --out D:/caches/p45g/round<n>/judge --aliases evals/play/p37d/aliases.json --batch-out D:/caches/p45g/round<n>/catalog-batch.json
node scripts/p37d/promote-batch.mjs --batch D:/caches/p45g/round<n>/catalog-batch.json
node scripts/p45d/motion-class.mjs
```

Generování další dávky běží souběžně se soudem a povýšením předchozí. Úloha na pozadí Claude Code končí po 10 minutách – zabije jen obal skriptu, dávka pod `gpu-lock` běží dál; proto se dávky spouští jako odpojený proces (`Start-Process`).

| Dávka | Jmen | Předkontrola a brána | Soud | Povýšeno | Codex (předkontrola + soud) |
|---|---|---|---|---|---|
| 1 (14:07–14:27) | 10 | 6 | 4 | 4 | 19 + 6 |
| 2 (14:23–14:58) | 10 | 9 | 7 | 6 | 14 + 9 |

**Dávka 1** (8 jmen P45F, ice fishing hole, ice fishing hut):
- Povýšeno (4): top1 swing („swing set“); top3 singer („woman“, female singer ve výčtu), torpedo („bomb“), ice fishing hut („shack“, hut ve výčtu).
- Soudce poznal něco jiného: tablet: crate · tape: ring sculpture.
- Předkontrola odmítla všechny tři obrázky: space station: satellite ×3 · tea: teacup ×3, označený jako rozbitý · ice fishing hole: **ice fishing hole** ×3 – správné jméno, ale obrázek označený jako rozbitý (díra v ledu není samostatný předmět).
- Bránou kvality neprošel: rhino (3× `inconsistent face winding`).

**Dávka 2** (frozen lake, highway, supermarket, underwater):
- Povýšeno (6): top1 ice floe, toll booth, highway sign („directional sign“), checkout counter, shopping basket; top3 sea anemone („coral“, sea anemone ve výčtu).
- Přijatý, nepovýšený: sea urchin (top3 „cactus“, sea urchin ve výčtu) – `normalize: LOD1 cannot be made lighter than LOD0 at the same size` (stejná třída jako dynamite v P45E).
- Soudce poznal něco jiného: overpass: trampoline · diving bell: hanging lantern.
- Předkontrola odmítla všechny tři obrázky: grocery shelf: store shelf ×3, označený jako rozbitý (vizuálně správně – synonymum by ho pustilo).
