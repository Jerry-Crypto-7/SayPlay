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

## Po T8 – přednačtení sousedů a snímky karet (`after-t8.json`, 19. 10. 2026)

Harness od T8 (`p54a-feed-perf-v2`): bez ťuku – aktivní karta hraje náhled robota sama; 20 přechodů (2× tam a zpět), 3 běhy na profil. `swapToPreviewMs` = klik na „next“/„previous“ → první snímek, ve kterém se tik náhledu posunul a kreslilo se. Aktivní karta se přepne hned po kliku, plynulý posun dobíhá za ní – klik je tu dosednutí.

| | Desktop 1440×900 | Pixel 7 CPU ×4 | Cíl T8 |
|---|---|---|---|
| **klik → běžící náhled, p50** | **165 ms** (83–434) ✅ | **894 ms** (355–9019) ❌ | ≤ 300 / ≤ 500 ms |
| klik → karta v `preview` | 75 ms (25–365) | 590 ms (183–8815) | |
| přechody s long task > 50 ms do 500 ms | 47/60 ❌, nejdelší 73 ms (0–404) | 60/60 ❌, nejdelší 328 ms (89–7883) | 0 |
| WebGL plátna feedu (`__playFeed().contexts`) | 1 ✅ | 1 ✅ | 1 |
| heap po `gc()` po 20 přechodech | 36,7 → 48,7 MB (+12) ✅ | 36,5 → 51,8 MB (+12) ✅ | ≤ baseline + 30 MB |
| FPS náhledu p50 / p5 | 60 / 60 | 30 / 10 | |

- Proti baseline T1 (klik → plakát → ťuk → první `draw*` nového kontextu: 161 / 666 ms): na desktopu stejný čas, ale bez ťuku a s jedním kontextem místo jedenácti. Telefon je o ~230 ms pomalejší – teď se čeká na běžící náhled (tik se posunul), ne na první `draw*`, a do přechodu přibyl snímek odcházející scény.
- Snímky odcházejících karet ukazují skutečnou scénu (kontrola očima 19. 10.: plošinovka s ostrovy, rytmus se čtyřmi pruhy; JPEG 31–42 KB), v DOM po 20 přechodech 3 (okno ±3 kolem aktivní karty), `toBlob` 3–16 ms.
- **Rozhodnutí P54A:** snímek se nebere v `addAfterEffect`, jak říkal plán – scénu odcházející karty vymění tentýž commit, takže žádný další snímek s ní už nepřijde a `addAfterEffect` by zachytil další hru. Tunel při `release` vykreslí jeden snímek navíc (`advance`) a v témž úkolu zavolá `toBlob`, bez `preserveDrawingBuffer`.
- **Rozhodnutí P54A:** feed API kurátorskou hru neoznačuje (`curated` v odpovědi není a kontrakt `docs/play/feed.md` mimo eligibility P54A nemění), proto klient zná id her se snímky z `src/components/play/feed/feed-thumbs.json`; shodu s vestavěným poolem drží `builtin-preview.test.ts`.
- Jeden z 6 běhů na telefonu vytvořil 2 WebGL kontexty, ale feed ukázal jedno plátno – druhý patří plátnu mimo DOM (pravděpodobně test schopností prohlížeče; neověřeno).

**Proč long tasks a telefon nesplnily cíl** (Long Animation Frames API, desktop, 4 přechody): přechod tvoří commit Reactu, který připojí kartu (25–108 ms, `MessagePort.onmessage` plánovače), a pak 1–3 snímky smyčky R3F po 100–235 ms, z toho 95 % ve fázi vykreslení. Při druhém průchodu toutéž hrou dlouhé snímky smyčky mizí. Odvozeno, ne změřeno po funkcích (produkční build je minifikovaný): jde o kompilaci shaderů a nahrání textur nové scény při prvním `gl.render`. Na telefonu (CPU ×4) se obojí násobí.

**Nejbližší krok:** předkompilovat scénu souseda ve sdíleném rendereru (`renderer.compileAsync(scene, camera)` s `KHR_parallel_shader_compile`) a nahrát její textury (`renderer.initTexture`) během přednačtení, mimo snímek. Vyžaduje sestavit scénu souseda bez vykreslení – to je zásah do `ArcadeStage` (vlastní P54B), proto zapsáno, ne uděláno. Commit Reactu zkrátí totéž přesunutí stavby relace (dopočet do `startTick`) do přednačtení.

## Kurátorský pool a snímky karet (T3)

```
node --experimental-strip-types scripts/p37c/seed-feed.mjs --builtin
npm run build
PLAY_STORE_DIR=<prázdný adresář> node node_modules/next/dist/bin/next start -H 127.0.0.1 -p 3291
FEED_THUMBS_URL=http://127.0.0.1:3291 node --experimental-strip-types scripts/p37c/feed-thumbs.mjs
```

- Pool 40 her z 8 žánrů (aréna 22, úkol 7, plavba 3, běžec 3, střelnice 2, poletování, rytmus, načasování po 1), každá s náhledem robota (`preview`, nejdelší 735 B).
- **Rozhodnutí P54A:** zmrazená sada P37C (`builtin-games.json`, 30 her `arcade-v2`) zůstává beze změny světů i id – zamyká ji `legacy-replay-v2` (soubor P54A neupravuje) a odkazy na ty hry už kolují; dostala jen náhled. Nových 10 her z dnešního jádra je v `builtin-feed-games.json`, `BUILTIN_GAMES` spojuje obě. Úplné přestavění sady by smazalo všech 30 starých id a shodilo zámek přehrání.
- `seed-feed.mjs` na `main` padal („No playable assembly … needs loadRapier()“): skládání ze slov krokuje fyzikální sestavy dřív, než se Rapier načetl – teď se načte před návrhem.
- Snímky: `public/feed-thumbs/<versionId>-{p,l}.webp`, 80 souborů, 7,7–39,8 KB, scéna v `startTick + 120` (nebo poslední tik okna, když robot vyhraje dřív), skutečné GPU, HUD skrytý. Spodní mez 3 KB v testu chytí prázdné plátno.
- Kontrola očima 19. 10. (5 náhodných + nejmenší): kuchyň s pánvemi (na šířku), podmořské poletování s rourami, bambusová řeka, úkol se strážcem u podstavců (na výšku), zamlžená poušť s pronásledovatelem (nejmenší) – všechny ukazují scénu hry, žádné prázdné plátno.
