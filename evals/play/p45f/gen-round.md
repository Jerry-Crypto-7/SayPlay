# P45F – druhé kolo pro jména, která v P45E neprošla

**Vstup:** 58 jmen z `evals/play/p45f/retry-nouns.json` s novým ručním znakem v `ops/gen3d/features.toml`, dávky po 10 v pořadí seznamu (`D:/caches/p45f/round<n>/list.json`). Stejná cesta jako `evals/play/p45e/gen-round.md`, RTX 3090 pod `gpu-lock.mjs`, nová mezipaměť `D:/claude/_gen3d-cache-p45f` (žádný pokus z P45E se nepřebírá). Surová data, listy a odpovědi soudce: `D:/caches/p45f/round<n>/` (mimo repo).

```
GEN3D_CACHE_DIR=D:/claude/_gen3d-cache-p45f node D:/claude/_shared/gpu-lock.mjs -- uv run python batch.py --from D:/caches/p45f/round<n>/list.json --precheck --start-comfy --no-quarantine --record D:/caches/p45f/round<n>/batch.json --sheet D:/caches/p45f/round<n>/batch-sheet.png --limit 10
node scripts/p37d/judge-sheet.mjs --record D:/caches/p45f/round<n>/batch.json --out D:/caches/p45f/round<n>/judge --aliases evals/play/p37d/aliases.json --batch-out D:/caches/p45f/round<n>/catalog-batch.json
node scripts/p37d/promote-batch.mjs --batch D:/caches/p45f/round<n>/catalog-batch.json
node scripts/p45d/motion-class.mjs
```

Modely a náhledy povýšení zapisuje do `public/assets/worldstream/gen3d-p37d/` (cesta `promote-batch.mjs`, stejně jako P45E).

Listy pro soud renderuje `scripts/assets/qa-sheets.mjs` s three.js z `node_modules` worktree – bez junction na `node_modules` hlavního checkoutu (stejný `package-lock.json`) skončí všech 8 listů na `waitForFunction: Timeout` a soud nemá co hodnotit. Junction je založená před prvním soudem, jako v P45E.

| Dávka | Jmen | Předkontrola a brána | Soud | Povýšeno | Codex (předkontrola + soud) |
|---|---|---|---|---|---|
| 1 (07:43–08:08) | 10 | 8 | 4 | 4 | 17 + 8 |

**Dávka 1** (robber … mahjong tile; v P45E 0/10 prošlo soudem, 5/10 předkontrolou a branou):
- Povýšeno (4): top1 coffin; top3 bank manager („banker“), chimney („factory“, komín ve výčtu), firefly („fly“, světluška ve výčtu).
- Soudce poznal něco jiného: ammo: trash can · financial advisor: businesswoman (role lidí jako v P45E) · mahjong tile: pedestal · robber: person, označený jako rozbitý model.
- Předkontrola odmítla všechny tři obrázky: frisbee: ashtray / ashtray / plate · cyclops: **cyclops** třikrát – obrázek je správně, ale dávka jméno normalizuje na „cyclop“ (`ops/gen3d/cache.py`, množné číslo) a předkontrola porovnává s ním. Znak teď do zadání dojde (klíč `cyclop`), shodu zablokuje až porovnání; oprava patří do `IRREGULAR` v `cache.py` (kód generátoru, mimo P45F).
