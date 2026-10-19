# Měření feedu `/play` (P54A)

## Spuštění

```
npm run build
PLAY_STORE_DIR=<prázdný adresář> node node_modules/next/dist/bin/next start -H 127.0.0.1 -p 3291
FALLBACK_SMOKE_URL=http://127.0.0.1:3291 npx playwright test e2e/play-feed-perf.spec.ts --project=chromium --grep @measure
```

Zúžení: `PERF_REPEATS=1`, `PERF_PROFILES=desktop|pixel7-cpu4`, `PERF_OUT=<soubor>`. Výchozí výstup `evals/play/feed/baseline-<datum>.json`.

## Co se měří

Šest her z `src/play/arcade/__fixtures__` publikovaných skutečnými dveřmi, řádky feedu z `page.route`. Desktop 1440×900 a Pixel 7 (412×915, dotyk) s CPU ×4 přes CDP, 3 běhy po 10 přechodech (5× dolů, 5× nahoru). Souhrn = medián, min a max přes všechny přechody všech běhů.

| Pole | Význam |
|---|---|
| `posterMs` | klik na „next“ → plakát nové hry ve slidu |
| `tapToFirstDrawMs` | ťuk na plakát → první `draw*` na WebGL kontextu vzniklém po ťuku |
| `swapToFirstDrawMs` | klik na „next“ → týž první `draw*` (dnes včetně ťuku sondy) |
| `longTasksAfterSwap` / `AfterTap` | long tasks > 50 ms v 500 ms po kliku / po ťuku |
| `longestTaskAfterTapMs` | nejdelší z nich |
| `fpsP50` / `fpsP5` / `drawnFps` | 2 s hraní po startu hry: fps z mediánu a 95. percentilu rAF intervalů, snímky s aspoň jedním `draw*` za sekundu |
| `getContextCalls` / `contextsCreated` | volání `getContext('webgl2'|'webgl')` a různé kontexty za běh |
| `heapBeforeMb` / `heapAfterMb` | `usedJSHeapSize` po `gc()` před prvním a po desátém přechodu |

Test nic netvrdí, padá jen na chybě stránky.

## Baseline 19. 10. 2026 (`baseline-2026-10-19.json`, build `5d741740`)

Skutečné GPU tohoto stroje (přepínače `browserRenderer()` jako ostatní e2e), feed odrolovaný do záběru, 3 běhy × 10 přechodů na profil. Stroj vytížený souběžnými relacemi – srovnání před/po (T8) pustit ve stejném stavu.

| | Desktop 1440×900 | Pixel 7 CPU ×4 |
|---|---|---|
| klik → plakát nové hry | 22 ms (12–46) | 138 ms (85–8346) |
| ťuk → první snímek | 133 ms (107–252) | 524 ms (232–11003) |
| **klik → první snímek** (dnes včetně ťuku) | **161 ms** (130–276) | **666 ms** (336–19360) |
| long tasks > 50 ms po ťuku | 2 (1–4), nejdelší 139 ms (86–416) | 2,5 (1–4), nejdelší 179 ms (73–677) |
| FPS p50 / p5 při hraní | 60 / 60 | 45 / 20 (p50 15–60) |
| WebGL kontexty za 10 přechodů | **11** | **11** (11–12) |
| heap po `gc()` | 35 → 45 MB | 36 → 43 MB |

- Každá hra dostane nový WebGL kontext (remount přes `key`); v DOM je vždy jedno plátno. Cíl P54A: 1.
- Telefon má dlouhý chvost (max 8–19 s): přechody, které se potkaly se špičkou zátěže stroje; mediány jsou stabilní.
- Dnes se hra připojí až po ťuku na plakát – feed bez náhledu robota; T8 měří dosednutí → první snímek **náhledu** bez ťuku.
- Rozhodnutí P54A: první běh měření (stejný den) kreslil přes SwiftShader (~3 FPS), protože vlastní `launchOptions` specu přepsaly přepínače GPU z konfigurace; spec je teď skládá a čísla výše jsou z opraveného běhu.
