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

- **Stroj byl plně vytížený** souběžnými relacemi (CPU 100 %, 69 procesů `node`); jeden z telefonních běhů se navíc překryl s během vitestu. Čísla berte jako horní odhad, srovnání před/po (T8) musí běžet ve stejném stavu stroje.
- Desktop: klik → první snímek nové hry medián 156 ms (134–264), ale po ťuku vždy long task, medián 1,18 s (0,98–1,81 s) – kompilace a start nové hry na hlavním vlákně.
- Pixel 7 CPU ×4: klik → první snímek medián 912 ms (462–2743), 3 long tasks po přechodu, nejdelší medián 494 ms.
- Kontexty: 11 na 10 přechodů – každá hra dostane nový WebGL kontext (remount přes `key`). V DOM je vždy jedno plátno.
- Heap: +8 MB po 10 přechodech (35 → 43 MB).
- **`fpsP50`/`drawnFps` v tomto souboru neplatí:** feed stojí pod polem pro větu a hra hraje, jen když je feed z poloviny vidět – měřené okno nevykreslilo žádný snímek. Spec teď feed nejdřív odroluje do záběru; baseline je potřeba pustit znovu (předávka v plánu).
