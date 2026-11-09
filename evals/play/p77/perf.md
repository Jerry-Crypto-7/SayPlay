# P77 T5 – výkon telefonu (9. 11. 2026)

**Výsledek:** FPS drží ve všech 8 hrách (nejníž běh na sopce 40,5), věta → hra je na telefonu párově o 152 ms **rychlejší** než `main`. Cena: telefon nemá rámující řadu z T4 (`bb449a96`). Podmínku „0 selhání“ doslova nesplňuje ani `main`: závod pod vodou občas nenakreslí první snímek, na obou stranách stejně (níž).

- A = `main` v bodě odbočení P77 (`cecccbe1`, worktree `D:/caches/p77/base-wt`, port 3207), B = větev (port 3208). P78 se mezitím sloučil do `main` (`e1e0d7d7`); porovnání s ním dělá T7 po sloučení.
- Stroj byl celou dobu vytížený jinými relacemi (zátěž CPU 42–100 %). Měřeno prokládaně A/B, v tabulkách mediány.

## FPS – Pixel 7, CPU 4×, 8 her, 4 opakování

`scripts/play/p73d-perf.mjs` (postup `evals/play/p73/sceny/perf.md`).

| Hra | A `main` | B po T5 | Zdroj B |
|---|---|---|---|
| honička město (s3) | 46,0 | 49,1 | `perf-fps.json` |
| quest hrad (s8) | 43,7 | 42,7 | `perf-fps-t5b.json` |
| závod pod vodou (s2) | 41,6 | 42,5 | `perf-fps-t5.json` |
| stohování (s4) | 55,0 | 52,8 | `perf-fps.json` |
| golf (s7) | 50,9 | 48,7 | `perf-fps.json` |
| chytání (s10) | 51,8 | 54,6 | `perf-fps.json` |
| běh sopka (s1) | 40,8 | 40,5 | `perf-fps-t5.json` |
| plošinovka (s5) | 44,5 | 45,7 | `perf-fps-t5b.json` |

**Medián ≥ 40: drží všech 8.** Oprava `bb449a96` mění jen hry s kamerou po trati (s1, s2), proto se ostatní nemusely měřit znovu.

Jak se k tomu došlo:
- **1. běh (neplatný, nezapsaný):** souběžný `find /` jiné relace a desítky prohlížečů jiných běhů. I nezměněný `main` měl golf 1,8 FPS a chytání 14,8 FPS (P73: 57,6 a 59,6).
- **2. běh** (`perf-fps.json`, kód `1b2e9ebf`): závod pod vodou B 34,5 proti A 43,4, v prvním běhu −4,4 FPS ve stejném směru. Běh na sopce B 35,2 proti A 37,8. Ztrácely jen hry s rámující řadou z T4, ostatní byly v šumu ±3 FPS. Plošinovka 17,9 / 19,0 zachytila špičku zátěže na obou stranách.
- **Levnější varianta** (pravidlo plánu: přetažený rozpočet znamená levnější variantu, ne výjimku): telefon (hrubý ukazatel) řadu po trati nedostane, počítač má dál 4 kopie. Pin `p77-framing-row.test.ts`. Po ní je závod 42,5 proti 41,6 a sopka 40,5 proti 40,8.
- Inference: ztrátu nedělala kreslicí volání (závod má 73 i po opravě), ale nejspíš přestavba kopií při posunu řady (klon modelu, obálka, zahřátí shaderu každých 14 m). Neověřeno profilem; počítač to při 4 kopiích zvládá (snímky T4).

## Věta → hra – telefon Pixel 7, CPU 4×

`scripts/measure/first-playable-ab.mjs evals/play/p77/first-playable.config.json`: 8 vět × 3 běhy, A a B prokládaně, kód `bb449a96` → `perf-first-playable.json`.

| | A medián | B medián | párově B − A | Mez |
|---|---|---|---|---|
| věta → hratelná | 8426 ms | 8330 ms | **−152 ms** | ≤ +200 ms, drží |
| první snímek | 5143 ms | 5233 ms | −61 ms | – |

**Selhání: A 1, B 1**, oba v témže páru (závod pod vodou, 1. běh, hned po sobě). Opakování jen této věty (`first-playable-race.config.json` → `perf-first-playable-race.json`): A 0 ze 3, B 1 ze 3. Celkem u závodu A 1 ze 6, B 2 ze 6.

Fakta o selhání:
- Všechna tři mají stejný otisk: stránka žije, všechny soubory se stáhnou (HAR v `D:/tmp/p77-t5-raw*`), ale plátno do 120 s nenakreslí první snímek a hra netiká. Skript mezitím klepe ~60× a každé klepnutí pošle `/api/play/events`.
- Stalo se to i na `main` (A), který kód P77 nemá. P76 (7. 11.) a P73D (6. 11.) měly na tomtéž skriptu 0 selhání, tehdy ale bez souběžné zátěže jiných relací.
- Inference: pravděpodobně se nevytvoří nebo ztratí kontext WebGL, když GPU drží desítky prohlížečů jiných běhů. P77 mění jen vzhled scény, ne start hry. Neověřeno – na prázdném stroji to zopakovat nejde.

## Do příště

- Selhání závodu změřit znovu po sloučení (T7) na klidnějším stroji. Pokud zůstane i na prázdném stroji, je to vada `main` pro samostatný úkol mimo P77 (start hry, ne vzhled).
